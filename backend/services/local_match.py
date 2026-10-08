"""
Free, deterministic resume-to-job match scores. No LLM, no network.

Why this exists: the match sweep paid one gpt-4o-mini call per (user, job), so
the bill grew as users x jobs, and opening any job in the feed bought another
call for its breakdown. This scorer runs on the same signals the catalogue
already stores and is cheap enough to score every job for every user.

Calibration (2026-10-08): fitted by least squares against 5,211 banked
gpt-4o-mini scores across 5 real resumes (3 tech, 2 non-tech). Leave-one-user-
out Pearson r = 0.53 overall, 0.60-0.70 on the tech resumes; for the two tech
users, the jobs this scorer ranks highest averaged ~75 on the LLM's own scale
against an overall mean of ~45. Good for ranking and badges; the sweep can
still ask the LLM to confirm a handful of top candidates before an alert email
(match_notifier, MATCH_AI_DAILY_PER_USER).

Features, each 0..1:
  skill      share of the job's skill tags the resume shows (taxonomy on both
             sides, with implied skills: PostgreSQL implies SQL)
  title      share of the job title's meaningful words found in the resume
  title_exp  share found in the resume's own job titles
  keywords   share of the posting's 40 most frequent content words in the resume
  category   the job's role category matches one inferred from resume titles
  degree     a degree-field word is among the posting's top words
"""

import datetime
import hashlib
import math
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Iterable, Optional

from backend.services.role_classifier import classify
from backend.services.structured_extraction import _SKILL_SYNONYMS, extract_skills

# Bumped whenever the model changes, so stale local scores are recomputed
# (they are free) instead of mixing two scales.
LOCAL_MODEL_VERSION = "local1"

# Knowing the left implies the right, so a resume that lists PostgreSQL is
# never told it is "missing" SQL.
IMPLIES: dict[str, tuple[str, ...]] = {
    "postgresql": ("sql",), "mysql": ("sql",), "sqlite": ("sql",), "oracle": ("sql",),
    "snowflake": ("sql",), "bigquery": ("sql",),
    "typescript": ("javascript",), "react": ("javascript",), "vue": ("javascript",),
    "angular": ("javascript",), "svelte": ("javascript",), "node.js": ("javascript",),
    "next.js": ("react", "javascript"), "react native": ("react", "javascript"),
    "express": ("node.js", "javascript"),
    "django": ("python",), "flask": ("python",), "fastapi": ("python",),
    "pandas": ("python",), "numpy": ("python",), "pytorch": ("python",),
    "scikit-learn": ("python",), "spring": ("java",), "rails": ("ruby",),
    "kubernetes": ("docker",), "helm": ("kubernetes",),
}

_STOP = frozenset("""
a an the and or of to in for on with at by from as is are be been being this that these those it its our
your you we they their them us will would can could should may might must shall not no nor but if then
than so such into over under about above across after against along among around before behind below
beneath beside between beyond during except inside near off onto out outside since through throughout
till toward upon within without per via etc
experience experiences work working works team teams teammates role roles job jobs position positions
opportunity opportunities company companies candidate candidates ability abilities skills skill strong
excellent good great new grad graduate graduates intern interns internship internships student students
university college degree bachelor bachelors master masters program programs year years month months
time full part fulltime parttime including include includes required requirements require requires
preferred plus knowledge understanding familiarity proficiency proficient using use used help helping
support supporting ensure provide providing based also other others more most one two three all any
each every some many able looking join joining apply applicants applicant employer employment equal
status gender race religion disability veteran age sexual orientation national origin benefits salary
pay range compensation location remote hybrid onsite office summer fall winter spring 2025 2026 2027
term co op coop day days week weeks hours environment culture mission people make making build building
develop developing development responsibilities responsible qualifications what who how why where when
which while you'll we're you're it's we'll let's get like e g i ii iii iv senior junior jr sr level
entry early career associate
""".split())

_TITLE_GENERIC = frozenset("""
intern internship new grad graduate junior senior i ii iii co op coop summer fall winter spring 2025 2026
2027 program early career entry level associate trainee student part time full term university campus
hire hires
""".split())

_TOKEN = re.compile(r"[a-z][a-z0-9+#.]*[a-z0-9+#]|[a-z]")
_YEAR = re.compile(r"(19|20)\d{2}")
_PRESENT = re.compile(r"present|current|now|ongoing", re.I)

# Least-squares weights, see the module docstring. Order matches _design().
_WEIGHTS = (27.0, 19.1, -2.9, 10.8, 6.1, 14.4, 9.4, 2.5, 4.8, -6.2)

# Least squares regresses toward the mean, so raw outputs bunch in 24..77 and
# nothing would ever read as a strong match. This monotonic map (rank order
# untouched) stretches them onto the LLM's score distribution, kept deliberately
# conservative at the top: only about the top 1% of pairs reach 80, because a
# local 80 tracked an LLM ~76 for tech resumes but only ~55 for non-tech ones.
_CAL_RAW = (0.0, 24.0, 26.0, 29.0, 32.0, 42.0, 53.0, 60.0, 64.0, 68.0, 72.0, 77.0, 90.0, 100.0)
_CAL_OUT = (5.0, 10.0, 15.0, 25.0, 35.0, 45.0, 60.0, 66.0, 72.0, 78.0, 82.0, 88.0, 95.0, 97.0)


def _calibrate(raw: float) -> float:
    if raw <= _CAL_RAW[0]:
        return _CAL_OUT[0]
    for (x0, y0), (x1, y1) in zip(zip(_CAL_RAW, _CAL_OUT), zip(_CAL_RAW[1:], _CAL_OUT[1:])):
        if raw <= x1:
            return y0 + (y1 - y0) * (raw - x0) / (x1 - x0)
    return _CAL_OUT[-1]


# Display names for tags whose title case would be wrong. Twin of the web
# app's frontend/src/lib/skillLabel.ts.
_DISPLAY = {
    "sql": "SQL", "html": "HTML", "css": "CSS", "aws": "AWS", "gcp": "GCP", "php": "PHP",
    "c++": "C++", "c#": "C#", ".net": ".NET", "ci/cd": "CI/CD", "tcp/ip": "TCP/IP",
    "nlp": "NLP", "llm": "LLMs", "etl": "ETL", "dbt": "dbt", "ios": "iOS", "ui": "UI",
    "ux": "UX", "qa": "QA", "seo": "SEO", "sap": "SAP", "cad": "CAD", "plc": "PLC",
    "fpga": "FPGA", "vhdl": "VHDL", "grpc": "gRPC", "rest": "REST", "graphql": "GraphQL",
    "matlab": "MATLAB", "mysql": "MySQL", "postgresql": "PostgreSQL", "mongodb": "MongoDB",
    "dynamodb": "DynamoDB", "bigquery": "BigQuery", "javascript": "JavaScript",
    "typescript": "TypeScript", "node.js": "Node.js", "next.js": "Next.js",
    "pytorch": "PyTorch", "tensorflow": "TensorFlow", "scikit-learn": "scikit-learn",
    "numpy": "NumPy", "power bi": "Power BI", "autocad": "AutoCAD", "solidworks": "SolidWorks",
    "objective-c": "Objective-C", "cloudformation": "CloudFormation", "rabbitmq": "RabbitMQ",
    "fastapi": "FastAPI", "r": "R", "go": "Go",
}


def display_skill(tag: str) -> str:
    key = (tag or "").strip().lower()
    return _DISPLAY.get(key) or " ".join(w[:1].upper() + w[1:] for w in key.split(" "))


def ai_fingerprint(raw_text: str) -> str:
    """The LLM score's resume fingerprint (match_notifier's, unchanged)."""
    return hashlib.sha256(raw_text.encode("utf-8", "replace")).hexdigest()


def local_fingerprint(raw_text: str) -> str:
    """Fingerprint for a local score: same resume, different scorer. Fits the
    64-char column: "local1:" + 57 hex chars."""
    prefix = LOCAL_MODEL_VERSION + ":"
    return prefix + ai_fingerprint(raw_text)[: 64 - len(prefix)]


def current_fingerprints(raw_text: str) -> list[str]:
    """Every fingerprint whose score is current for this resume text."""
    return [ai_fingerprint(raw_text), local_fingerprint(raw_text)]


def scoring_mode() -> str:
    """"local" (default, free) or "ai" (the legacy per-job LLM scoring)."""
    mode = (os.getenv("MATCH_SCORING") or "local").strip().lower()
    return "ai" if mode == "ai" else "local"


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall((text or "").lower())


def _content(text: str) -> list[str]:
    return [w for w in _tokens(text) if w not in _STOP and len(w) > 1]


def skill_tags(raw_text: str, declared: Iterable[Any] = ()) -> list[str]:
    """Canonical taxonomy tags a resume shows, implied skills included."""
    tags = extract_skills("", raw_text or "")
    seen = set(tags)
    for raw in declared or ():
        if not isinstance(raw, str):
            continue
        key = raw.strip().lower()
        if key in _SKILL_SYNONYMS and key not in seen:
            seen.add(key)
            tags.append(key)
    for tag in list(tags):
        for implied in IMPLIES.get(tag, ()):
            if implied not in seen:
                seen.add(implied)
                tags.append(implied)
    return tags


def _years_of_experience(experience: Any, now_year: int) -> float:
    """Rough total years across experience entries, from the years in their
    dates ("Present" counts as this year). Overlaps are not merged; it only
    feeds an entry-level experience check, where precision barely matters."""
    total = 0.0
    for entry in experience or ():
        if not isinstance(entry, dict):
            continue
        start = _YEAR.search(str(entry.get("start_date") or ""))
        end_raw = str(entry.get("end_date") or "")
        end = _YEAR.search(end_raw)
        if not start:
            continue
        start_year = int(start.group(0))
        end_year = now_year if (_PRESENT.search(end_raw) or not end) else int(end.group(0))
        total += max(0.25, min(10, end_year - start_year))
    return total


@dataclass(frozen=True)
class ResumeSignals:
    tags: frozenset
    words: frozenset
    title_words: frozenset
    degree_words: frozenset
    categories: frozenset
    years: float


@dataclass
class JobSignals:
    tags: set
    top_words: list
    title_words: list
    category: str
    years_required: Optional[int] = None


@dataclass
class LocalMatch:
    overall: int
    skill_score: int
    role_score: int
    experience_score: int
    matched_skills: list = field(default_factory=list)
    missing_skills: list = field(default_factory=list)


@lru_cache(maxsize=64)
def _resume_signals_cached(
    raw_text: str, declared: tuple, titles: tuple, degrees: str, experience_key: tuple, now_year: int
) -> ResumeSignals:
    categories = {classify(t) for t in titles if t and t.strip()}
    categories.discard("Other")
    categories.discard("")
    experience = [{"start_date": s, "end_date": e} for s, e in experience_key]
    return ResumeSignals(
        tags=frozenset(skill_tags(raw_text, declared)),
        words=frozenset(_content(raw_text)),
        title_words=frozenset(w for t in titles for w in _content(t)),
        degree_words=frozenset(_content(degrees)),
        categories=frozenset(categories),
        years=_years_of_experience(experience, now_year),
    )


def resume_signals(profile: Any, now: Optional[datetime.datetime] = None) -> ResumeSignals:
    """Signals from a ResumeProfileDB row (or anything with the same fields).
    Memoized on the inputs, so the sweep pays for a resume once per run."""
    now = now or datetime.datetime.utcnow()
    experience = [e for e in (getattr(profile, "experience", None) or []) if isinstance(e, dict)]
    titles = tuple(
        [str(e.get("title") or "") for e in experience]
        + [getattr(profile, "target_job_title", None) or "", getattr(profile, "summary_title", None) or ""]
    )
    degrees = " ".join(
        str(e.get("degree") or "")
        for e in (getattr(profile, "education", None) or [])
        if isinstance(e, dict)
    )
    declared = tuple(s for s in (getattr(profile, "skills", None) or []) if isinstance(s, str))
    experience_key = tuple((str(e.get("start_date") or ""), str(e.get("end_date") or "")) for e in experience)
    return _resume_signals_cached(
        getattr(profile, "raw_text", "") or "", declared, titles, degrees, experience_key, now.year
    )


def job_signals(
    title: str,
    description: str,
    skills: Any = None,
    role_category: str = "",
    years_required: Optional[int] = None,
) -> JobSignals:
    tags = {s for s in (skills or []) if isinstance(s, str)} or set(
        extract_skills(title or "", description or "")
    )
    freq: dict[str, int] = {}
    for w in _content((description or "")[:6000]):
        freq[w] = freq.get(w, 0) + 1
    top = [w for w, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:40]]
    title_words = [w for w in _content(title) if w not in _TITLE_GENERIC]
    return JobSignals(tags, top, title_words, role_category or "", years_required)


def job_signals_for(job: Any) -> JobSignals:
    """Signals from a ScrapedJob row (or anything with the same fields)."""
    return job_signals(
        getattr(job, "title", "") or "",
        getattr(job, "description", "") or "",
        getattr(job, "skills", None),
        getattr(job, "role_category", "") or "",
        getattr(job, "experience_years_required", None),
    )


def _design(skill: float, has_tags: float, title: float, title_exp: float,
            keywords: float, category: float, degree: float) -> tuple:
    s = math.sqrt
    return (1.0, s(skill), has_tags, s(title), title_exp, s(keywords), category, degree,
            s(skill) * category, s(title) * category)


def score(resume: ResumeSignals, job: JobSignals) -> LocalMatch:
    matched = sorted(job.tags & resume.tags)
    missing = sorted(job.tags - resume.tags)
    skill = len(matched) / len(job.tags) if job.tags else 0.0
    n_title = len(job.title_words)
    title = sum(1 for w in job.title_words if w in resume.words) / n_title if n_title else 0.0
    title_exp = sum(1 for w in job.title_words if w in resume.title_words) / n_title if n_title else 0.0
    keywords = (
        sum(1 for w in job.top_words if w in resume.words) / len(job.top_words) if job.top_words else 0.0
    )
    category = 1.0 if job.category and job.category in resume.categories else 0.0
    degree = 1.0 if resume.degree_words & set(job.top_words) else 0.0

    x = _design(skill, 1.0 if job.tags else 0.0, title, title_exp, keywords, category, degree)
    overall = sum(w * v for w, v in zip(_WEIGHTS, x))

    # Sub-scores for the detail view's breakdown, each on 0..100.
    skill_score = round(100 * skill) if job.tags else round(100 * math.sqrt(keywords))
    role_score = round(100 * max(category, math.sqrt(title)))
    if job.years_required:
        gap = job.years_required - resume.years
        experience_score = 100 if gap <= 0 else max(20, round(100 - 30 * gap))
    else:
        # The catalogue is internships and new-grad roles (see
        # experience-taxonomy notes): no stated requirement is a good sign.
        experience_score = 90

    return LocalMatch(
        overall=max(0, min(100, round(_calibrate(overall)))),
        skill_score=max(0, min(100, skill_score)),
        role_score=max(0, min(100, role_score)),
        experience_score=experience_score,
        matched_skills=matched,
        missing_skills=missing,
    )


def score_profile_job(profile: Any, job: Any) -> LocalMatch:
    return score(resume_signals(profile), job_signals_for(job))


# ─── Stored per-job terms (scraped_jobs.match_terms) ─────────────────────────

TERMS_VERSION = 1


def compute_terms(title: str, description: str, skills: Any = None) -> dict:
    """What the scorer needs from a posting, small enough to store per job."""
    sig = job_signals(title, description, skills)
    return {"v": TERMS_VERSION, "top": sig.top_words, "tags": sorted(sig.tags)}


def signals_from_terms(
    title: str, terms: dict, role_category: str = "", years_required: Optional[int] = None
) -> JobSignals:
    title_words = [w for w in _content(title) if w not in _TITLE_GENERIC]
    return JobSignals(
        set(terms.get("tags") or []), list(terms.get("top") or []), title_words,
        role_category or "", years_required,
    )


def _terms_current(terms: Any) -> bool:
    return isinstance(terms, dict) and terms.get("v") == TERMS_VERSION


def ensure_terms(db, job_ids: list[int], batch: int = 50) -> int:
    """Compute match_terms for any of these jobs that lack them. Reads each
    missing job's description once, ever. Returns how many were computed."""
    from backend.db.models import ScrapedJob

    if not job_ids:
        return 0
    missing = [
        row[0]
        for row in db.query(ScrapedJob.id, ScrapedJob.match_terms)
        .filter(ScrapedJob.id.in_(job_ids))
        .all()
        if not _terms_current(row[1])
    ]
    done = 0
    for i in range(0, len(missing), batch):
        chunk = missing[i : i + batch]
        rows = (
            db.query(ScrapedJob.id, ScrapedJob.title, ScrapedJob.description, ScrapedJob.skills)
            .filter(ScrapedJob.id.in_(chunk))
            .all()
        )
        for job_id, title, description, skills in rows:
            terms = compute_terms(title or "", description or "", skills)
            db.query(ScrapedJob).filter(ScrapedJob.id == job_id).update(
                {ScrapedJob.match_terms: terms}, synchronize_session=False
            )
            done += 1
        db.commit()
    return done


def score_jobs(db, profile: Any, job_ids: list[int]) -> dict[int, LocalMatch]:
    """Local scores for these jobs against this resume. Reads small columns
    only (title, category, years, stored terms); computes missing terms first."""
    from backend.db.models import ScrapedJob

    if not job_ids:
        return {}
    ensure_terms(db, job_ids)
    resume = resume_signals(profile)
    rows = (
        db.query(
            ScrapedJob.id, ScrapedJob.title, ScrapedJob.role_category,
            ScrapedJob.experience_years_required, ScrapedJob.match_terms,
        )
        .filter(ScrapedJob.id.in_(job_ids))
        .all()
    )
    out: dict[int, LocalMatch] = {}
    for job_id, title, category, years, terms in rows:
        if not _terms_current(terms):
            continue
        out[job_id] = score(resume, signals_from_terms(title or "", terms, category or "", years))
    return out


def bank_local_scores(db, user_id: int, profile: Any, job_ids: list[int]) -> dict[int, int]:
    """Score these jobs locally and store them in job_match_scores, without
    touching any row that already holds a current score for this resume (an
    LLM-confirmed score always wins). Returns {job_id: score} for new rows."""
    from backend.db.models import JobMatchScore

    raw = getattr(profile, "raw_text", "") or ""
    fps = current_fingerprints(raw)
    have_current = {
        row[0]
        for row in db.query(JobMatchScore.job_id)
        .filter(
            JobMatchScore.user_id == user_id,
            JobMatchScore.job_id.in_(job_ids),
            JobMatchScore.resume_fingerprint.in_(fps),
        )
        .all()
    } if job_ids else set()
    todo = [j for j in job_ids if j not in have_current]
    if not todo:
        return {}
    scores = score_jobs(db, profile, todo)
    if not scores:
        return {}
    existing = {
        row.job_id: row
        for row in db.query(JobMatchScore)
        .filter(JobMatchScore.user_id == user_id, JobMatchScore.job_id.in_(list(scores)))
        .all()
    }
    fp = local_fingerprint(raw)
    now = datetime.datetime.utcnow()
    for job_id, match in scores.items():
        row = existing.get(job_id)
        if row is None:
            db.add(JobMatchScore(
                user_id=user_id, job_id=job_id, score=match.overall,
                resume_fingerprint=fp, scored_at=now,
            ))
        else:
            # A stale row (older resume or older local model) is overwritten.
            row.score = match.overall
            row.resume_fingerprint = fp
            row.scored_at = now
    db.commit()
    return {job_id: m.overall for job_id, m in scores.items()}
