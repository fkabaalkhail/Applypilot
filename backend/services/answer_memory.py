"""
Question Memory — pure logic for reusing previously approved application answers.

No I/O and no DB here: canonicalizing a question (so the same question is
recognized across applications regardless of company/role wording), assigning it
a coarse category, and cosine-matching a query embedding against stored rows.
The embedding API call lives in ``embeddings.py``; persistence lives in the
``saved_answers`` table and the ``/api/answers`` router.
"""
import math
import re

# Cosine thresholds (tunable). At/above MATCH we reuse a stored answer; at/above
# DEDUP a save updates the existing row instead of inserting a near-duplicate.
# 0.80 is empirically tuned for text-embedding-3-small: a reworded-but-same
# question ("why work at X" vs "why interested in joining X") scores ~0.81,
# while a merely-topical question scores ~0.55 — so 0.80 captures true matches
# with margin above near-misses. Company-specific matches route to review
# regardless, so silent-fill precision does not hinge on this alone.
MATCH_THRESHOLD = 0.80
DEDUP_THRESHOLD = 0.97

# Coarse categories. ``company_specific`` answers are routed to review on a match
# (they shouldn't be pasted blind into a different company's form).
CATEGORIES = (
    "salary",
    "work_authorization",
    "availability",
    "behavioral",
    "company_specific",
    "general",
)

# Checked in order; first category with any phrase present wins.
_CATEGORY_PHRASES: list[tuple[str, tuple[str, ...]]] = [
    ("company_specific", (
        "work here", "working here", "join us", "join our", "about us",
        "our company", "our team", "our mission", "our product", "this company",
        "why us", "interest you about", "interests you about",
        "want to work for us", "why do you want to work",
    )),
    ("behavioral", (
        "tell us about a time", "tell me about a time", "describe a time",
        "describe a situation", "give an example of a time", "a time when",
        "a time you", "a situation where",
    )),
    ("work_authorization", (
        "authorized to work", "authorised to work", "work authorization",
        "work authorisation", "sponsorship", "sponsor", "visa", "right to work",
        "eligible to work", "work permit", "legally authorized", "legally entitled",
    )),
    ("salary", (
        "salary", "compensation", "expected pay", "desired pay",
        "pay expectation", "hourly rate", "rate expectation",
    )),
    ("availability", (
        "when can you start", "start date", "notice period",
        "available to start", "availability", "how soon can you",
    )),
]


def canonicalize_question(question: str, company: str = "", job_title: str = "") -> str:
    """Strip the known company/role tokens (→ placeholders), lowercase, and
    collapse whitespace. Run identically at save and search time so the query
    and stored vectors are comparable."""
    text = question or ""
    if company and company.strip():
        text = re.sub(re.escape(company.strip()), "{company}", text, flags=re.IGNORECASE)
    if job_title and job_title.strip():
        text = re.sub(re.escape(job_title.strip()), "{role}", text, flags=re.IGNORECASE)
    text = text.lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def categorize_question(question: str) -> str:
    """Map a question to one of CATEGORIES via deterministic keyword matching."""
    q = (question or "").lower()
    for category, phrases in _CATEGORY_PHRASES:
        if any(phrase in q for phrase in phrases):
            return category
    return "general"


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity of two equal-length vectors; 0.0 if either is empty."""
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def best_match(query_embedding: list[float], rows):
    """Return ``(row, score)`` for the highest-cosine row (rows without an
    embedding are skipped); ``(None, 0.0)`` when nothing scores."""
    best_row = None
    best_score = 0.0
    for row in rows:
        emb = getattr(row, "embedding", None)
        if not emb:
            continue
        score = cosine(query_embedding, emb)
        if score > best_score:
            best_score = score
            best_row = row
    return best_row, best_score


# ── Key health ───────────────────────────────────────────────────────────────
#
# A stored answer is keyed by its question text and recalled by matching that
# text. So a key that names no question is not merely a cosmetic problem: it can
# never match the question it came from, and it matches VERBATIM — at cosine
# 1.0 — every future field whose label harvests to the same boilerplate.
#
# Production, 2026-08-09, bmo.wd3.myworkdayjobs.com: Workday writes
# `aria-label="<question> <displayed value> Required"`, and for a yes/no radio
# group with no question in the attribute that collapses to "Yes Required".
# Every such group on the page canonicalized to one key, so they all shared a
# single row and the last answer saved became the answer to all of them.
#
# Mirrors chrome-extension/src/shared/questionText.ts, which stops such keys
# being minted. This is the other half: finding the ones already banked.

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HEX_BLOB_RE = re.compile(r"^[0-9a-f]{12,}$", re.I)

# What a widget says about ITSELF: the value it currently displays, plus the
# required marker. A key made only of these words carries no question.
_WIDGET_WORDS = (
    r"yes|no|select|selected|one|an?|the|option|choose|pick|please|"
    r"required|optional|value|click|here|none|other|n/a"
)
_BOILERPLATE_RE = re.compile(rf"^(?:(?:{_WIDGET_WORDS})[\s\-–—,:*.…?()]*)+$", re.IGNORECASE)

UNLABELED_FIELD = "Unlabeled field"


def is_machine_id(text: str) -> bool:
    """An opaque widget id rather than a name (mirrors questionText.isMachineId)."""
    t = (text or "").strip()
    if not t or re.search(r"\s", t):
        return False
    if _UUID_RE.match(t):
        return True
    parts = re.split(r"[-_:.]", t)
    return bool(parts) and all(_HEX_BLOB_RE.match(p) for p in parts)


def key_health(question: str) -> str:
    """"" when the key names a question; otherwise a reason slug.

    Terseness is NOT a fault — "Ethnicity" is a perfectly good key. What is
    flagged is a key that says nothing about the question at all.
    """
    t = (question or "").strip()
    if not t:
        return "empty_key"
    if t.casefold() == UNLABELED_FIELD.casefold():
        return "unlabeled"
    if is_machine_id(t):
        return "machine_id"
    if _BOILERPLATE_RE.match(t):
        return "widget_boilerplate"
    return ""


def attractor_neighbours(rows, threshold: float = MATCH_THRESHOLD):
    """``{row_id: [(other_id, score), …]}`` for keys that sit within the reuse
    threshold of OTHER stored keys.

    A stored question should be the nearest neighbour of itself and of nothing
    else in the bank. A row that is this close to several unrelated rows will
    win recall for their questions too — which is what "attracts unrelated
    questions" means, measured on data we actually hold rather than inferred
    from a hit counter.
    """
    out: dict[int, list[tuple[int, float]]] = {}
    scored = [(r, getattr(r, "embedding", None)) for r in rows]
    for row, emb in scored:
        if not emb:
            continue
        near = [
            (other.id, cosine(emb, other_emb))
            for other, other_emb in scored
            if other_emb and other.id != row.id and cosine(emb, other_emb) >= threshold
        ]
        if near:
            out[row.id] = sorted(near, key=lambda t: -t[1])
    return out
