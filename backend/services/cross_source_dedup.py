"""
Cross-source job dedup: the same posting scraped from LinkedIn/Indeed AND from
the employer's own board (ats/github sources).

The direct row is strictly better (real description, direct apply link) so
inferior twins are soft-hidden (`duplicate_of` = winner id, never deleted:
saved-job and application records may reference them) and the winner inherits
whatever the twin knew that it doesn't (applicant_count, salary_range, and a
description when the winner has none).

Matching is deliberately exact, never fuzzy: normalized employer + normalized
title + city containment. "Software Engineer Intern, Infrastructure" is a
different job from "Software Engineer Intern" and must never merge.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from backend.db.models import ScrapedJob
from backend.services.location_parser import fold

DIRECT_SOURCES = ("ats", "github")
INFERIOR_SOURCES = ("linkedin", "indeed")

# Lower is better. Direct rows beat aggregator rows; LinkedIn beats Indeed
# (richer metadata) when no direct row exists.
_SOURCE_TIER = {"ats": 0, "github": 0, "linkedin": 1, "indeed": 2}

# Only aggregator copies may ever be hidden. Two direct-board rows with the
# same title are distinct requisitions (per-country variants, multiple
# openings), their dedup key is the URL, nothing else.
_MIN_COPY_DESC_LEN = 300  # og:description snippets (~186 chars) must not spread

# Secondary fuzzy matcher for aggregator rows whose normalized title differs
# from the direct row's by punctuation-scale noise ("Software Engineer Intern
# Payments" vs "Software Engineer Intern - Payments Team"). Deliberately NOT
# embeddings: deterministic, free, and conservative, a wrong merge hides a
# real job. Both titles must be substantial and near-identical.
FUZZY_TITLE_THRESHOLD = 0.93
_FUZZY_MIN_TITLE_LEN = 12


def titles_fuzzy_match(a: str, b: str) -> bool:
    """True when two ALREADY-NORMALIZED titles are near-identical."""
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b or a == b:
        return a == b and len(a) >= 1
    if len(a) < _FUZZY_MIN_TITLE_LEN or len(b) < _FUZZY_MIN_TITLE_LEN:
        return False
    # One title extending the other with a new qualifier ("… infrastructure")
    # is a DIFFERENT job; require the length gap itself to be small.
    if abs(len(a) - len(b)) > max(len(a), len(b)) * 0.2:
        return False
    return SequenceMatcher(None, a, b).ratio() >= FUZZY_TITLE_THRESHOLD


def effective_source(source: str, url: str) -> str:
    """The rogue-scraper era mislabeled LinkedIn/Indeed rows as source='ats';
    the URL is the truth."""
    blob = (url or "").lower()
    if "linkedin.com" in blob:
        return "linkedin"
    if "indeed.com" in blob:
        return "indeed"
    return source or ""


def canonical_url(url: str) -> str:
    """Strip tracking params so 'jobs/86588?utm_source=vansh' and 'jobs/86588'
    dedupe as one posting. ONLY utm_* is stripped, ATS URLs carry functional
    params (gh_jid, jobid, token) that must survive."""
    raw = (url or "").strip()
    if not raw or "?" not in raw:
        return raw.rstrip("/") if raw else ""
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not k.lower().startswith("utm_")]
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(kept), "")
    ).rstrip("/")

_SEASON_WORDS = re.compile(r"\b(summer|fall|autumn|winter|spring)\b")
_YEARS = re.compile(r"\b20\d{2}\b")
_PARENTHETICAL = re.compile(r"\([^)]*\)")
_COMPANY_SUFFIX = re.compile(
    r"\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\b"
)


def normalize_title(title: str) -> str:
    """Fold a title for twin matching. Season/year decorations vary across
    boards and are stripped; role-level words (intern, new grad, senior) are
    kept, different levels are different jobs."""
    text = fold(_PARENTHETICAL.sub(" ", title or ""))
    text = _SEASON_WORDS.sub(" ", text)
    text = _YEARS.sub(" ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_company(company: str) -> str:
    """Fold a company name for grouping ("Acme Widgets Inc." == "Acme Widgets")."""
    text = fold(company or "")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = _COMPANY_SUFFIX.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def _cities_compatible(
    loser_city: str,
    winner_city: str,
    winner_search: str,
    loser_country: str = "",
    winner_country: str = "",
) -> bool:
    loser_city = fold(loser_city or "")
    winner_city = fold(winner_city or "")
    if not loser_city and not winner_city:
        # Both remote/unlocated: same-country only ("Remote US" and
        # "Remote Canada" are different postings).
        return (loser_country or "") == (winner_country or "")
    if not loser_city or not winner_city:
        return False
    return loser_city == winner_city or f"|{loser_city}|" in (winner_search or "")


def _employer_filter(company: str, company_domain: str):
    """SQL predicate: same employer by resolved domain OR case-folded name."""
    conditions = [func.lower(ScrapedJob.company) == (company or "").strip().lower()]
    domain = (company_domain or "").strip()
    if domain:
        conditions.append(ScrapedJob.company_domain == domain)
    return or_(*conditions)


def has_direct_twin(
    db: Session,
    *,
    company: str,
    company_domain: str,
    title: str,
    city: str,
    country: str = "",
) -> bool:
    """True when a direct (ats/github) row for the same employer, title, and
    city already exists, the ingest guard for LinkedIn/Indeed sources."""
    title_norm = normalize_title(title)
    if not title_norm:
        return False
    city = fold(city or "")

    query = (
        db.query(
            ScrapedJob.id, ScrapedJob.city, ScrapedJob.location_search,
            ScrapedJob.country, ScrapedJob.url, ScrapedJob.source_platform,
        )
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            ScrapedJob.source_platform.in_(DIRECT_SOURCES),
            ScrapedJob.title_norm == title_norm,
            _employer_filter(company, company_domain),
        )
        .limit(20)
    )
    for _id, winner_city, winner_search, winner_country, url, source in query.all():
        if effective_source(source, url) not in DIRECT_SOURCES:
            continue  # rogue-era mislabel: an aggregator URL is not a direct twin
        if _cities_compatible(city, winner_city or "", winner_search or "",
                              country or "", winner_country or ""):
            return True
    return False


def mark_inferior_twins(db: Session, winner: ScrapedJob) -> int:
    """Hide pre-existing LinkedIn/Indeed twins of a freshly inserted direct
    row, pulling their enrichment fields onto the winner. Returns the number
    of rows hidden. Commits."""
    title_norm = winner.title_norm or normalize_title(winner.title)
    if not title_norm or winner.id is None:
        return 0

    candidates = (
        db.query(ScrapedJob)
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            or_(
                ScrapedJob.source_platform.in_(INFERIOR_SOURCES),
                # Rogue-era rows are labeled 'ats' but carry aggregator URLs.
                ScrapedJob.url.ilike("%linkedin.com%"),
                ScrapedJob.url.ilike("%indeed.com%"),
            ),
            ScrapedJob.title_norm == title_norm,
            ScrapedJob.id != winner.id,
            _employer_filter(winner.company, winner.company_domain or ""),
        )
        .limit(50)
        .all()
    )

    marked = 0
    for twin in candidates:
        if effective_source(twin.source_platform, twin.url) not in INFERIOR_SOURCES:
            continue
        if not _cities_compatible(twin.city or "", winner.city or "",
                                  winner.location_search or "",
                                  twin.country or "", winner.country or ""):
            continue
        twin.duplicate_of = winner.id
        if winner.applicant_count is None and twin.applicant_count is not None:
            winner.applicant_count = twin.applicant_count
        if not (winner.salary_range or "") and (twin.salary_range or ""):
            winner.salary_range = twin.salary_range
        if (len(winner.description or "") < 50
                and len(twin.description or "") >= _MIN_COPY_DESC_LEN):
            winner.description = twin.description
            winner.description_sections = None
        marked += 1
    if marked:
        db.commit()
    return marked


def absorb_new_aggregator_rows(db: Session, limit: int = 300) -> int:
    """Incremental dedup for rows the one-time sweep never saw: the newest
    unmarked LinkedIn/Indeed rows get absorbed by any better existing twin
    (direct row, or a higher/equal-tier aggregator row that has a description
    when this one doesn't). Called from the hourly backfill cron. Commits."""
    candidates = (
        db.query(ScrapedJob)
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            or_(
                ScrapedJob.source_platform.in_(INFERIOR_SOURCES),
                ScrapedJob.url.ilike("%linkedin.com%"),
                ScrapedJob.url.ilike("%indeed.com%"),
            ),
        )
        .order_by(ScrapedJob.id.desc())
        .limit(limit)
        .all()
    )

    marked = 0
    for row in candidates:
        row_source = effective_source(row.source_platform, row.url)
        if row_source not in INFERIOR_SOURCES:
            continue
        title_norm = row.title_norm or normalize_title(row.title)
        if not title_norm or title_norm == "\x01":
            continue
        row_tier = _SOURCE_TIER.get(row_source, 3)

        def _pick_better_twin(twins: list[ScrapedJob]) -> ScrapedJob | None:
            for twin in twins:
                twin_tier = _SOURCE_TIER.get(
                    effective_source(twin.source_platform, twin.url), 3
                )
                better = twin_tier < row_tier or (
                    twin_tier == row_tier
                    and len(twin.description or "") >= 50
                    and (len(row.description or "") < 50 or twin.id < row.id)
                )
                if not better:
                    continue
                if not _cities_compatible(row.city or "", twin.city or "",
                                          twin.location_search or "",
                                          row.country or "", twin.country or ""):
                    continue
                return twin
            return None

        twins = (
            db.query(ScrapedJob)
            .filter(
                ScrapedJob.duplicate_of.is_(None),
                ScrapedJob.title_norm == title_norm,
                ScrapedJob.id != row.id,
                _employer_filter(row.company, row.company_domain or ""),
            )
            .limit(20)
            .all()
        )
        best = _pick_better_twin(twins)

        if best is None:
            # Fuzzy fallback: same employer, near-identical title. Only
            # DIRECT rows may absorb here, fuzzy-merging two aggregator
            # copies risks eating a genuinely different posting.
            near = (
                db.query(ScrapedJob)
                .filter(
                    ScrapedJob.duplicate_of.is_(None),
                    ScrapedJob.source_platform.in_(DIRECT_SOURCES),
                    ScrapedJob.title_norm != title_norm,
                    ScrapedJob.title_norm != "",
                    ScrapedJob.id != row.id,
                    _employer_filter(row.company, row.company_domain or ""),
                )
                .limit(40)
                .all()
            )
            best = _pick_better_twin([
                twin for twin in near
                if titles_fuzzy_match(title_norm, twin.title_norm or "")
            ])
        if best is None:
            continue
        row.duplicate_of = best.id
        if best.applicant_count is None and row.applicant_count is not None:
            best.applicant_count = row.applicant_count
        if not (best.salary_range or "") and (row.salary_range or ""):
            best.salary_range = row.salary_range
        if (len(best.description or "") < 50
                and len(row.description or "") >= _MIN_COPY_DESC_LEN):
            best.description = row.description
            best.description_sections = None
        marked += 1

    # A row absorbed early in the pass may itself absorb later (A→B, B→C):
    # flatten so every duplicate points at a visible survivor.
    if marked:
        for row in candidates:
            hops = 0
            while row.duplicate_of is not None and hops < 5:
                target = db.get(ScrapedJob, row.duplicate_of)
                if target is None or target.duplicate_of is None:
                    break
                row.duplicate_of = target.duplicate_of
                hops += 1
        db.commit()
    return marked


@dataclass
class _Row:
    id: int
    source: str  # effective source (URL-derived)
    company: str
    domain: str
    title_norm: str
    city: str
    country: str
    location_search: str
    desc_len: int
    applicant_count: int | None
    salary_range: str


def dedup_sweep(db: Session) -> dict:
    """Collapse cross-source twins across the whole catalogue (one-time /
    maintenance pass). Column-only reads; descriptions are only fetched for
    the rare copy onto a description-less winner. Commits. Idempotent."""
    raw = (
        db.query(
            ScrapedJob.id,
            ScrapedJob.source_platform,
            ScrapedJob.url,
            ScrapedJob.company,
            ScrapedJob.company_domain,
            ScrapedJob.title,
            ScrapedJob.title_norm,
            ScrapedJob.city,
            ScrapedJob.country,
            ScrapedJob.location_search,
            func.length(func.coalesce(ScrapedJob.description, "")),
            ScrapedJob.applicant_count,
            ScrapedJob.salary_range,
        )
        .filter(ScrapedJob.duplicate_of.is_(None))
        .all()
    )

    stats = {"groups": 0, "marked": 0, "winners_enriched": 0,
             "descriptions_copied": 0, "url_twins_marked": 0}

    # Phase A: identical canonical URL = the same posting, whatever the tier.
    # (GitHub lists append utm_* params, so the URL-unique constraint lets the
    # same job in twice.) Keep the best copy; hide the rest.
    by_canonical: dict[str, list] = {}
    for row in raw:
        canon = canonical_url(row[2] or "")
        if canon:
            by_canonical.setdefault(canon, []).append(row)
    url_hidden: set[int] = set()
    for canon, rows in by_canonical.items():
        if len(rows) < 2:
            continue
        rows = sorted(
            rows,
            key=lambda r: (
                _SOURCE_TIER.get(effective_source(r[1] or "", r[2] or ""), 3),
                -(r[10] or 0),  # desc_len
                r[0],
            ),
        )
        keeper = rows[0]
        for extra in rows[1:]:
            db.query(ScrapedJob).filter(ScrapedJob.id == extra[0]).update(
                {"duplicate_of": keeper[0]}
            )
            url_hidden.add(extra[0])
            stats["url_twins_marked"] += 1

    # Phase B: aggregator copies of direct postings (employer+title+location).
    groups: dict[tuple[str, str], list[_Row]] = {}
    for (rid, source, url, company, domain, title, title_norm, city, country,
         location_search, desc_len, applicant_count, salary_range) in raw:
        if rid in url_hidden:
            continue
        norm = title_norm or normalize_title(title or "")
        employer = normalize_company(company or "")
        if not norm or norm == "\x01" or not employer:
            continue  # unnormalizable titles must never form a group
        groups.setdefault((employer, norm), []).append(_Row(
            id=rid, source=effective_source(source or "", url or ""),
            company=company or "",
            domain=(domain or "").strip(), title_norm=norm,
            city=fold(city or ""), country=country or "",
            location_search=location_search or "",
            desc_len=desc_len or 0, applicant_count=applicant_count,
            salary_range=salary_range or "",
        ))

    for rows in groups.values():
        if len(rows) < 2:
            continue
        stats["groups"] += 1
        rows.sort(key=lambda r: (_SOURCE_TIER.get(r.source, 3), -r.desc_len, r.id))

        winners: list[_Row] = []
        for row in rows:
            home = None
            # Only aggregator copies may be absorbed; a direct row is always
            # its own posting (distinct requisitions share titles).
            if row.source in INFERIOR_SOURCES:
                for winner in winners:
                    domains_ok = not row.domain or not winner.domain or row.domain == winner.domain
                    if domains_ok and _cities_compatible(
                        row.city, winner.city, winner.location_search,
                        row.country, winner.country,
                    ):
                        home = winner
                        break
            if home is None:
                winners.append(row)
                continue

            updates: dict = {"duplicate_of": home.id}
            db.query(ScrapedJob).filter(ScrapedJob.id == row.id).update(updates)
            stats["marked"] += 1

            winner_updates: dict = {}
            if row.applicant_count is not None:
                current = db.query(ScrapedJob.applicant_count).filter(ScrapedJob.id == home.id).scalar()
                if current is None:
                    winner_updates["applicant_count"] = row.applicant_count
            if row.salary_range:
                current = db.query(ScrapedJob.salary_range).filter(ScrapedJob.id == home.id).scalar()
                if not (current or ""):
                    winner_updates["salary_range"] = row.salary_range
            if home.desc_len < 50 and row.desc_len >= _MIN_COPY_DESC_LEN:
                description = db.query(ScrapedJob.description).filter(ScrapedJob.id == row.id).scalar()
                if description:
                    winner_updates["description"] = description
                    winner_updates["description_sections"] = None
                    home.desc_len = row.desc_len
                    stats["descriptions_copied"] += 1
            if winner_updates:
                db.query(ScrapedJob).filter(ScrapedJob.id == home.id).update(winner_updates)
                stats["winners_enriched"] += 1

    db.commit()
    return stats
