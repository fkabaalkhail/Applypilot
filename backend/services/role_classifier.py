"""Canonical role-category taxonomy + classifier.

A single source of truth for the role categories the dashboard supports, so
that every scrape path (GitHub aggregator, ATS cron, LinkedIn) and the frontend
filter agree on the exact same strings.

``classify(title, department)`` returns one of CANONICAL_CATEGORIES. Keyword
groups are evaluated in priority order so that, e.g., "Software Engineer" maps
to Software Engineering rather than the broader Engineering and Development, and
"ML Engineer" maps to Machine Learning and AI rather than Software Engineering.
"""

from __future__ import annotations

import re

# The canonical category names. Order here is also the order the frontend shows
# them in (the user's nine priority categories first, then supporting buckets).
CANONICAL_CATEGORIES: list[str] = [
    "Software Engineering",
    "Engineering and Development",
    "Data Analysis",
    "Machine Learning and AI",
    "Accounting and Finance",
    "Management and Executive",
    "Sales",
    "Marketing",
    "Human Resources",
    # Supporting buckets (kept so non-priority roles remain filterable).
    "Product Management",
    "Business Analyst",
    "Creatives and Design",
    "Legal and Compliance",
    "Customer Service and Support",
    "Operations",
    "Consultant",
    "Other",
]

# Maps assorted legacy / alternate spellings to their canonical name. Used by
# the DB backfill and to normalise values coming from older scrape paths.
LEGACY_ALIASES: dict[str, str] = {
    "machine learning/ai": "Machine Learning and AI",
    "machine learning / ai": "Machine Learning and AI",
    "ml/ai": "Machine Learning and AI",
    "ai/ml": "Machine Learning and AI",
    "accounting/finance": "Accounting and Finance",
    "accounting / finance": "Accounting and Finance",
    "finance": "Accounting and Finance",
    "accounting": "Accounting and Finance",
    "hardware engineering": "Engineering and Development",
    "devops/infrastructure": "Engineering and Development",
    "devops": "Engineering and Development",
    "cybersecurity": "Engineering and Development",
    "security": "Engineering and Development",
    "design": "Creatives and Design",
    "creatives and design": "Creatives and Design",
    "legal": "Legal and Compliance",
    "legal and compliance": "Legal and Compliance",
    "customer support": "Customer Service and Support",
    "customer service and support": "Customer Service and Support",
    "customer service": "Customer Service and Support",
    "operations": "Operations",
    "consultant": "Consultant",
    "consulting": "Consultant",
    "product management": "Product Management",
    "business analyst": "Business Analyst",
    "software engineering": "Software Engineering",
    "engineering and development": "Engineering and Development",
    "data analysis": "Data Analysis",
    "data science": "Data Analysis",
    "sales": "Sales",
    "marketing": "Marketing",
    "human resources": "Human Resources",
    "management and executive": "Management and Executive",
    # jobright sections that don't map to a priority bucket.
    "arts and entertainment": "Creatives and Design",
    "education and training": "Other",
    "public sector and government": "Other",
}

# Ordered (category, keywords) pairs. First keyword hit wins, so more specific
# categories must come before broader ones.
_KEYWORD_GROUPS: list[tuple[str, list[str]]] = [
    ("Machine Learning and AI", [
        "machine learning", "ml engineer", "ml scientist", "ai engineer",
        "ai/ml", "ml/ai", "ai & ml", " ml ", "ml intern", "artificial intelligence",
        "deep learning", "nlp", "natural language", "computer vision",
        "data scientist", "research scientist", "applied scientist",
        "applied science", "generative ai", " llm", "ai agent", "ai intern",
        "ai developer", "ai data", "ai research",
    ]),
    ("Data Analysis", [
        "data analyst", "data analysis", "data analytics", "business intelligence",
        "bi analyst", "bi developer", "analytics", "data engineer",
        "data warehouse", "data science", "quantitative analyst",
        "reporting analyst", "data governance", "data quality",
        "data and business intelligence",
    ]),
    ("Software Engineering", [
        "software", "developer", "swe", " sde", "full stack", "fullstack",
        "full-stack", "back end", "backend", "front end", "frontend",
        "web developer", "mobile developer", "ios developer",
        "android developer", "programmer", "applications engineer",
        "application developer", ".net", "java developer", "python developer",
    ]),
    ("Engineering and Development", [
        "mechanical engineer", "electrical engineer", "civil engineer",
        "hardware", "firmware", "embedded", "fpga", "asic", "rf engineer",
        "optical", "photonics", "validation", "manufacturing engineer",
        "process engineer", "systems engineer", "network engineer",
        "devops", "site reliability", "sre", "infrastructure",
        "platform engineer", "cloud engineer", "security engineer",
        "cybersecurity", "qa engineer", "quality engineer", "test engineer",
        "quality assurance", "qa ", "automation engineer", "controls engineer",
        "industrial engineer", "chemical engineer", "aerospace engineer",
        "structural engineer", "engineer", "engineering", "technician",
    ]),
    ("Management and Executive", [
        "chief", " ceo ", " cfo ", " coo ", " cto ", " ciso ",
        "vice president", " vp ", "executive director", "managing director",
        "general manager", "head of",
    ]),
    ("Accounting and Finance", [
        "accountant", "accounting", "finance", "financial", "audit",
        "auditor", "tax", "treasury", "controller", "bookkeep", "payroll",
        "fp&a", "investment", "actuarial", "mergers", "mergers and acquisitions",
        "m&a", "private equity", "venture capital", "private client", "wealth",
        "asset management", "capital markets", "assurance", "underwriting",
        "financial reporting",
        # Retail / commercial banking roles (common on bank Workday boards). Dev
        # and engineering titles are matched by earlier groups, so "... Banking
        # Developer" still lands in Software, not here. " teller" keeps the leading
        # space so it matches "Bank Teller" but not "Storyteller" (substring match).
        "banker", "banking", " teller", "mortgage", "loan officer",
    ]),
    ("Sales", [
        "sales", "account executive", "account manager", "bdr", "sdr",
        "business development", "account representative", "inside sales",
        "sales development", "sales enablement", "partner enablement",
        "customer development", "account services", "field sales",
    ]),
    ("Marketing", [
        "marketing", "growth", "seo", "sem", "brand", "communications",
        "social media", "content strategist", "content marketing",
        "content creation", "content management", "public relations",
        "publicity", "demand generation", "copywriter",
    ]),
    ("Human Resources", [
        "human resources", "recruiter", "recruiting", "talent acquisition",
        "people operations", "people & culture", "people and culture",
        "hr ", "hris", "compensation", "organizational development",
        "organizational learning", "talent development", "employee experience",
        "talent and culture", "talent et culture", "change management",
    ]),
    ("Product Management", [
        "product manager", "product owner", "program manager",
        "technical program", "product management", "project manager",
    ]),
    ("Business Analyst", [
        "business analyst", "strategy analyst", "business systems analyst",
    ]),
    ("Creatives and Design", [
        "designer", "ux", "ui ", " ui", "graphic", "visual design",
        "product design", "interaction design", "creative", "illustrator",
        "animator", "artist", "video editor",
    ]),
    ("Legal and Compliance", [
        "legal", "counsel", "attorney", "paralegal", "compliance",
        "regulatory", "lawyer",
    ]),
    ("Customer Service and Support", [
        "customer support", "customer success", "customer service",
        "support engineer", "technical support", "help desk", "service desk",
        "client support", "client service", "call center", "call centre",
        "contact center", "contact centre",
    ]),
    ("Operations", [
        "operations", "supply chain", "logistics", "procurement",
        "project coordinator", "warehouse", "fulfillment", "inventory",
        "buyer", "planner",
    ]),
    ("Consultant", [
        "consultant", "consulting", "advisory",
    ]),
]


def normalize_category(value: str) -> str | None:
    """Return the canonical name for an existing/legacy category string.

    Returns the value unchanged if it is already canonical, the mapped name if
    it is a known alias, or None if it can't be normalised (caller should then
    fall back to classifying by title).
    """
    if not value:
        return None
    v = value.strip()
    if v in CANONICAL_CATEGORIES:
        return v
    return LEGACY_ALIASES.get(v.lower())


def expand_filter_values(categories: list[str]) -> list[str]:
    """Expand selected canonical categories to every stored spelling.

    Lets the dashboard filter match rows written by older scrape paths (e.g.
    "Machine Learning/AI", "Accounting/Finance") without a DB migration. Returns
    the union of the canonical names plus any legacy aliases that map to them.
    """
    selected = {c.strip() for c in categories if c and c.strip()}
    out = set(selected)
    for alias_lower, canonical in LEGACY_ALIASES.items():
        if canonical in selected:
            out.add(alias_lower)
            # also add a title-cased variant of the alias as stored historically
            out.add(alias_lower.title())
    # Known historical exact spellings that don't lowercase-match cleanly.
    extra = {
        "Machine Learning and AI": ["Machine Learning/AI"],
        "Accounting and Finance": ["Accounting/Finance"],
        "Engineering and Development": [
            "Hardware Engineering", "DevOps/Infrastructure", "Cybersecurity",
        ],
        "Creatives and Design": ["Design"],
        "Legal and Compliance": ["Legal"],
        "Customer Service and Support": ["Customer Support"],
    }
    for canonical, spellings in extra.items():
        if canonical in selected:
            out.update(spellings)
    return sorted(out)


def classify(title: str, department: str = "") -> str:
    """Classify a job into a canonical role category from its title/department."""
    title_lower = f" {(title or '').lower()} "
    for category, keywords in _KEYWORD_GROUPS:
        for kw in keywords:
            if kw in title_lower:
                return category

    # Fall back to department text.
    dept = (department or "").strip()
    if dept:
        mapped = normalize_category(dept)
        if mapped:
            return mapped
        dept_lower = f" {dept.lower()} "
        for category, keywords in _KEYWORD_GROUPS:
            for kw in keywords:
                if kw in dept_lower:
                    return category

    return "Other"
