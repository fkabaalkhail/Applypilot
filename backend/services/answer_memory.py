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
