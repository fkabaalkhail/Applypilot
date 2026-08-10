"""
Deterministic structured extraction for job listings.

Everything here is regex/taxonomy based, NO model calls. This runs inside the
hourly ingest crons across thousands of listings, and the match-sweep incident
(see openai-cost history) is why the ingest hot path must never bill per job.

Extractors:
    parse_salary          → (min, max, currency, period) from free text
    detect_employment_type→ full_time | part_time | contract | internship
    detect_visa_sponsorship → yes | no | unknown (explicit statements only)
    extract_skills        → capped tag list from a curated taxonomy
    compute_raw_hash      → change-detection fingerprint for re-crawls
    looks_evergreen       → ghost-job description patterns
"""

from __future__ import annotations

import hashlib
import re

# ─── Salary ──────────────────────────────────────────────────────────────────

# "$120,000 - $150,000", "USD 120k–150k", "CA$45/hr", "£30,000 per annum",
# "$85,000+", "120,000 - 150,000 CAD". Currency defaults to USD for bare "$".
_CURRENCY_BEFORE = r"(?P<cur>(?:US|CA|AU|NZ)?\$|USD|CAD|EUR|GBP|€|£)"
_AMOUNT = r"(?P<lo>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?P<lok>[kK])?"
_AMOUNT_HI = r"(?P<hi>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?P<hik>[kK])?"

_SALARY_RANGE_RE = re.compile(
    _CURRENCY_BEFORE + r"\s*" + _AMOUNT
    + r"\s*(?:-|–|—|to|and)\s*(?:" + _CURRENCY_BEFORE.replace("cur", "cur2") + r"\s*)?"
    + _AMOUNT_HI,
    re.IGNORECASE,
)
_SALARY_SINGLE_RE = re.compile(_CURRENCY_BEFORE + r"\s*" + _AMOUNT + r"\s*\+?", re.IGNORECASE)
# "120,000 - 150,000 CAD" (currency after the numbers)
_SALARY_CUR_AFTER_RE = re.compile(
    _AMOUNT + r"\s*(?:-|–|—|to)\s*" + _AMOUNT_HI + r"\s*(?P<cur>USD|CAD|EUR|GBP)\b",
    re.IGNORECASE,
)

_PERIOD_RE = re.compile(
    r"(?:per\s+|/\s*|an?\s+)(?P<period>hour|hr|year|yr|annum|annually|month|mo|week|wk|day)",
    re.IGNORECASE,
)

_CURRENCY_MAP = {
    "$": "USD", "us$": "USD", "usd": "USD",
    "ca$": "CAD", "cad": "CAD",
    "au$": "AUD", "nz$": "NZD",
    "€": "EUR", "eur": "EUR",
    "£": "GBP", "gbp": "GBP",
}

_PERIOD_MAP = {
    "hour": "hour", "hr": "hour",
    "year": "year", "yr": "year", "annum": "year", "annually": "year",
    "month": "month", "mo": "month",
    "week": "week", "wk": "week",
    "day": "day",
}


def _to_amount(raw: str, k_suffix: str | None) -> int | None:
    try:
        value = float(raw.replace(",", ""))
    except (TypeError, ValueError):
        return None
    if k_suffix:
        value *= 1000
    if value <= 0:
        return None
    return int(round(value))


def _infer_period(text: str, span_end: int, amount: int) -> str:
    """Period stated near the match wins; otherwise infer from magnitude,
    two-digit rates are hourly, five-digit-and-up figures are annual."""
    window = text[span_end:span_end + 40]
    m = _PERIOD_RE.search(window)
    if m:
        return _PERIOD_MAP.get(m.group("period").lower(), "year")
    if amount < 200:
        return "hour"
    if amount < 20000:
        return "month" if amount < 10000 else "year"
    return "year"


def parse_salary(text: str) -> tuple[int, int, str, str] | None:
    """Extract (salary_min, salary_max, currency, period) from free text.

    Returns None when no credible salary is present. Single figures produce
    min == max. Amounts under $10 (hourly or not) and 4-digit "years" like
    2026 are rejected, job text is full of numbers that are not pay.
    """
    if not text:
        return None
    # Salary statements live near the top or bottom of postings; scanning the
    # whole of a 10 KB description mostly finds product metrics.
    sample = text[:4000] + ("\n" + text[-1500:] if len(text) > 5500 else "")

    m = _SALARY_RANGE_RE.search(sample)
    if m:
        lo = _to_amount(m.group("lo"), m.group("lok"))
        hi = _to_amount(m.group("hi"), m.group("hik"))
        if lo and hi:
            # "$120-150k", the shared k suffix only decorates the upper bound.
            if not m.group("lok") and m.group("hik") and lo < 1000 <= hi:
                lo *= 1000
            if lo > hi:
                lo, hi = hi, lo
            currency = _CURRENCY_MAP.get((m.group("cur") or "$").strip().lower(), "USD")
            period = _infer_period(sample, m.end(), hi)
            if _credible(lo, hi, period):
                return lo, hi, currency, period

    m = _SALARY_CUR_AFTER_RE.search(sample)
    if m:
        lo = _to_amount(m.group("lo"), m.group("lok"))
        hi = _to_amount(m.group("hi"), m.group("hik"))
        if lo and hi:
            if lo > hi:
                lo, hi = hi, lo
            currency = _CURRENCY_MAP.get(m.group("cur").lower(), "USD")
            period = _infer_period(sample, m.end(), hi)
            if _credible(lo, hi, period):
                return lo, hi, currency, period

    m = _SALARY_SINGLE_RE.search(sample)
    if m:
        amount = _to_amount(m.group("lo"), m.group("lok"))
        if amount:
            currency = _CURRENCY_MAP.get((m.group("cur") or "$").strip().lower(), "USD")
            period = _infer_period(sample, m.end(), amount)
            if _credible(amount, amount, period):
                return amount, amount, currency, period
    return None


def _credible(lo: int, hi: int, period: str) -> bool:
    """Reject figures that are numbers in the text but not pay."""
    if period == "hour":
        return 10 <= lo <= 500 and hi <= 1000
    if period == "year":
        return 10000 <= lo <= 2_000_000 and hi <= 3_000_000
    if period == "month":
        return 800 <= lo <= 100_000
    return 100 <= lo <= 50_000  # week / day


# ─── Employment type ─────────────────────────────────────────────────────────

_INTERN_RE = re.compile(r"\bintern(?:ship)?\b|\bco-?op\b", re.IGNORECASE)
_CONTRACT_RE = re.compile(r"\bcontract(?:or)?\b|\bfixed[- ]term\b|\btemporary\b|\bfreelance\b", re.IGNORECASE)
_PART_TIME_RE = re.compile(r"\bpart[- ]time\b", re.IGNORECASE)
_FULL_TIME_RE = re.compile(r"\bfull[- ]time\b|\bpermanent\b", re.IGNORECASE)


def detect_employment_type(title: str, description: str = "", commitment: str = "") -> str:
    """Classify employment type. The source's own commitment field (Lever,
    Workday timeType) wins over text inference; the title outranks the
    description (descriptions mention "full-time students" etc.)."""
    for source in (commitment or "", title or ""):
        if _INTERN_RE.search(source):
            return "internship"
        if _PART_TIME_RE.search(source):
            return "part_time"
        if _CONTRACT_RE.search(source):
            return "contract"
        if _FULL_TIME_RE.search(source):
            return "full_time"
    head = (description or "")[:2000]
    if _INTERN_RE.search(head):
        return "internship"
    if _PART_TIME_RE.search(head):
        return "part_time"
    if _CONTRACT_RE.search(head):
        return "contract"
    if _FULL_TIME_RE.search(head):
        return "full_time"
    return ""


# ─── Visa sponsorship ────────────────────────────────────────────────────────

# Negative statements are checked first: "we are unable to sponsor" contains
# the word "sponsor" and must not read as positive.
_VISA_NO_RE = re.compile(
    r"(?:unable|not able|cannot|can't|will not|won't|do(?:es)? not|no)\s+"
    r"(?:\w+\s+){0,4}?sponsor"
    r"|without\s+(?:the\s+)?need\s+for\s+(?:visa\s+)?sponsorship"
    r"|not\s+(?:offer|provide|available)[^.]{0,40}sponsorship"
    r"|sponsorship\s+is\s+not\s+(?:available|offered|provided)"
    r"|must\s+be\s+(?:legally\s+)?(?:authorized|eligible)\s+to\s+work[^.]{0,80}without\s+sponsorship",
    re.IGNORECASE,
)
_VISA_YES_RE = re.compile(
    r"(?:visa|h-?1b|immigration|work\s+permit)\s+sponsorship\s+"
    r"(?:is\s+)?(?:available|offered|provided|possible)"
    r"|(?:will|can|do(?:es)?|happy\s+to|able\s+to)\s+(?:\w+\s+){0,2}?sponsor"
    r"|sponsorship\s+(?:for|of)\s+(?:employment\s+)?visas?"
    r"|we\s+sponsor\b",
    re.IGNORECASE,
)


def detect_visa_sponsorship(text: str) -> str:
    """'yes' / 'no' only on an explicit statement; anything else is 'unknown'.

    Never inferred from citizenship/clearance requirements, "US citizens
    preferred" postings often still sponsor for other roles' text blocks, and a
    wrong "no" hides a job from exactly the user who needed it.
    """
    if not text:
        return "unknown"
    if _VISA_NO_RE.search(text):
        return "no"
    if _VISA_YES_RE.search(text):
        return "yes"
    return "unknown"


# ─── Skills ──────────────────────────────────────────────────────────────────

# Curated taxonomy, matched on word boundaries against title + description.
# Keys are canonical tags; values are alternative surface forms. Kept small on
# purpose: precision beats recall for match-ranking inputs.
_SKILL_SYNONYMS: dict[str, list[str]] = {
    "python": [], "java": [], "javascript": ["js"], "typescript": ["ts"],
    "c++": ["cpp"], "c#": ["csharp"], "go": ["golang"], "rust": [],
    "ruby": [], "php": [], "swift": [], "kotlin": [], "scala": [],
    "r": [], "matlab": [], "sql": [], "html": [], "css": [], "bash": [],
    "perl": [], "objective-c": [], "dart": [], "elixir": [], "haskell": [],
    "react": ["react.js", "reactjs"], "angular": [], "vue": ["vue.js", "vuejs"],
    "next.js": ["nextjs"], "svelte": [], "node.js": ["nodejs", "node"],
    "django": [], "flask": [], "fastapi": [], "rails": ["ruby on rails"],
    "spring": ["spring boot"], ".net": ["dotnet", "asp.net"],
    "express": ["express.js"], "graphql": [], "rest": ["restful"],
    "grpc": [], "react native": [], "flutter": [], "electron": [],
    "aws": ["amazon web services"], "azure": [], "gcp": ["google cloud"],
    "docker": [], "kubernetes": ["k8s"], "terraform": [], "ansible": [],
    "jenkins": [], "ci/cd": ["cicd"], "git": [], "linux": [], "unix": [],
    "serverless": [], "cloudformation": [], "helm": [],
    "postgresql": ["postgres"], "mysql": [], "mongodb": ["mongo"],
    "redis": [], "elasticsearch": [], "cassandra": [], "dynamodb": [],
    "sqlite": [], "oracle": [], "snowflake": [], "bigquery": [],
    "kafka": [], "rabbitmq": [], "spark": ["apache spark", "pyspark"],
    "hadoop": [], "airflow": [], "dbt": [], "databricks": [],
    "machine learning": ["ml"], "deep learning": [],
    "pytorch": [], "tensorflow": [], "keras": [], "scikit-learn": ["sklearn"],
    "pandas": [], "numpy": [], "nlp": ["natural language processing"],
    "computer vision": [], "llm": ["llms", "large language models"],
    "data science": [], "data engineering": [], "etl": [],
    "data analysis": ["data analytics"], "statistics": [],
    "tableau": [], "power bi": ["powerbi"], "excel": [], "looker": [],
    "jira": [], "figma": [], "salesforce": [], "sap": [],
    "selenium": [], "cypress": [], "playwright": [], "jest": [], "pytest": [],
    "junit": [], "unit testing": [], "qa": ["quality assurance"],
    "agile": [], "scrum": [], "kanban": [],
    "cybersecurity": ["cyber security"], "penetration testing": ["pentesting"],
    "networking": [], "tcp/ip": [], "verilog": [], "vhdl": [], "fpga": [],
    "embedded": ["embedded systems"], "arduino": [], "raspberry pi": [],
    "autocad": [], "solidworks": [], "cad": [], "plc": [],
    "ios": [], "android": [], "unity": [], "unreal": ["unreal engine"],
    "blockchain": [], "solidity": [],
    "product management": [], "project management": [],
    "ux": ["user experience"], "ui": ["user interface"], "accessibility": ["a11y"],
    "seo": [], "marketing": [], "financial modeling": [], "accounting": [],
    "supply chain": [], "lean": ["lean manufacturing"], "six sigma": [],
}

MAX_SKILLS = 20

# Bare "r"/"go"/"ui" match prose too easily; these only count in the title or
# in list-ish contexts (comma/slash separated runs) within the description.
_AMBIGUOUS = {"r", "go", "rest", "excel", "spring", "lean", "ui", "qa", "sap", "cad"}


def _boundary_pattern(term: str) -> re.Pattern:
    escaped = re.escape(term).replace(r"\ ", r"[\s-]+")
    # Terms edged with symbols (c++, .net, c#) can't use \b on that edge.
    left = r"(?<![\w+#.])" if not term[0].isalnum() else r"\b"
    right = r"(?![\w+#])" if not term[-1].isalnum() else r"\b"
    return re.compile(left + escaped + right, re.IGNORECASE)


_SKILL_PATTERNS: list[tuple[str, str, re.Pattern]] = [
    (canon, surface, _boundary_pattern(surface))
    for canon, synonyms in _SKILL_SYNONYMS.items()
    for surface in [canon, *synonyms]
]


def extract_skills(title: str, description: str) -> list[str]:
    """Match the taxonomy against title + description. Canonical tags,
    first-mention order, capped at MAX_SKILLS."""
    title = title or ""
    description = (description or "")[:12000]
    haystack = f"{title}\n{description}"

    found: dict[str, int] = {}
    for canon, surface, pattern in _SKILL_PATTERNS:
        if canon in found:
            continue
        # Ambiguity is a property of the surface form: bare "go" only counts
        # in the title, but its synonym "golang" is safe anywhere.
        m = pattern.search(title) if surface in _AMBIGUOUS else pattern.search(haystack)
        if not m:
            continue
        found[canon] = m.start()

    ordered = sorted(found.items(), key=lambda kv: kv[1])
    return [canon for canon, _ in ordered[:MAX_SKILLS]]


# ─── Change detection ────────────────────────────────────────────────────────

def compute_raw_hash(title: str, location: str, description: str, salary_text: str = "") -> str:
    """Stable fingerprint of listing content for re-crawl diffing. Whitespace
    is collapsed so cosmetic re-rendering by the source doesn't count as an
    edit."""
    parts = []
    for piece in (title, location, description, salary_text):
        parts.append(re.sub(r"\s+", " ", (piece or "").strip().lower()))
    blob = "|".join(parts)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ─── Ghost-job text patterns ─────────────────────────────────────────────────

_EVERGREEN_RE = re.compile(
    r"always\s+(?:accepting|looking\s+for|hiring)"
    r"|accepting\s+applications\s+on\s+an?\s+(?:ongoing|rolling|continuous)\s+basis"
    r"|applications?\s+(?:\w+\s+){0,3}?on\s+an?\s+(?:ongoing|rolling|continuous)\s+basis"
    r"|(?:ongoing|rolling|continuous)\s+basis[^.]{0,60}applications"
    r"|evergreen\s+(?:requisition|posting|role)"
    r"|talent\s+(?:pool|pipeline|community|network)"
    r"|future\s+(?:openings|opportunities|positions|roles)"
    r"|general\s+(?:application|interest|consideration)"
    r"|this\s+is\s+a\s+pipeline\s+(?:role|requisition|posting)"
    r"|no\s+specific\s+(?:role|position|opening)",
    re.IGNORECASE,
)


def looks_evergreen(text: str) -> bool:
    """True when the description reads like a standing/pipeline posting rather
    than a real opening, one of the ghost-risk factors."""
    if not text:
        return False
    return bool(_EVERGREEN_RE.search(text))
