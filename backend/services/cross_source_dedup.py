"""
Cross-source job dedup: the same posting scraped from LinkedIn/Indeed AND from
the employer's own board (ats/github sources).

The direct row is strictly better — real description, direct apply link — so
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

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from backend.db.models import ScrapedJob
from backend.services.location_parser import fold

DIRECT_SOURCES = ("ats", "github")
INFERIOR_SOURCES = ("linkedin", "indeed")

# Lower is better. Direct rows beat aggregator rows; LinkedIn beats Indeed
# (richer metadata) when no direct row exists.
_SOURCE_TIER = {"ats": 0, "github": 0, "linkedin": 1, "indeed": 2}

_SEASON_WORDS = re.compile(r"\b(summer|fall|autumn|winter|spring)\b")
_YEARS = re.compile(r"\b20\d{2}\b")
_PARENTHETICAL = re.compile(r"\([^)]*\)")
_COMPANY_SUFFIX = re.compile(
    r"\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\b"
)


def normalize_title(title: str) -> str:
    """Fold a title for twin matching. Season/year decorations vary across
    boards and are stripped; role-level words (intern, new grad, senior) are
    kept — different levels are different jobs."""
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


def _cities_compatible(loser_city: str, winner_city: str, winner_search: str) -> bool:
    loser_city = fold(loser_city or "")
    winner_city = fold(winner_city or "")
    if not loser_city and not winner_city:
        return True
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
) -> bool:
    """True when a direct (ats/github) row for the same employer, title, and
    city already exists — the ingest guard for LinkedIn/Indeed sources."""
    title_norm = normalize_title(title)
    if not title_norm:
        return False
    city = fold(city or "")

    query = (
        db.query(ScrapedJob.id, ScrapedJob.city, ScrapedJob.location_search)
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            ScrapedJob.source_platform.in_(DIRECT_SOURCES),
            ScrapedJob.title_norm == title_norm,
            _employer_filter(company, company_domain),
        )
        .limit(20)
    )
    for _id, winner_city, winner_search in query.all():
        if _cities_compatible(city, winner_city or "", winner_search or ""):
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
            ScrapedJob.source_platform.in_(INFERIOR_SOURCES),
            ScrapedJob.title_norm == title_norm,
            ScrapedJob.id != winner.id,
            _employer_filter(winner.company, winner.company_domain or ""),
        )
        .limit(50)
        .all()
    )

    marked = 0
    for twin in candidates:
        if not _cities_compatible(twin.city or "", winner.city or "", winner.location_search or ""):
            continue
        twin.duplicate_of = winner.id
        if winner.applicant_count is None and twin.applicant_count is not None:
            winner.applicant_count = twin.applicant_count
        if not (winner.salary_range or "") and (twin.salary_range or ""):
            winner.salary_range = twin.salary_range
        if len(winner.description or "") < 50 and len(twin.description or "") >= 50:
            winner.description = twin.description
            winner.description_sections = None
        marked += 1
    if marked:
        db.commit()
    return marked


@dataclass
class _Row:
    id: int
    source: str
    company: str
    domain: str
    title_norm: str
    city: str
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
            ScrapedJob.company,
            ScrapedJob.company_domain,
            ScrapedJob.title,
            ScrapedJob.title_norm,
            ScrapedJob.city,
            ScrapedJob.location_search,
            func.length(func.coalesce(ScrapedJob.description, "")),
            ScrapedJob.applicant_count,
            ScrapedJob.salary_range,
        )
        .filter(ScrapedJob.duplicate_of.is_(None))
        .all()
    )

    groups: dict[tuple[str, str], list[_Row]] = {}
    for (rid, source, company, domain, title, title_norm, city,
         location_search, desc_len, applicant_count, salary_range) in raw:
        norm = title_norm or normalize_title(title or "")
        employer = normalize_company(company or "")
        if not norm or norm == "\x01" or not employer:
            continue  # unnormalizable titles must never form a group
        groups.setdefault((employer, norm), []).append(_Row(
            id=rid, source=source or "", company=company or "",
            domain=(domain or "").strip(), title_norm=norm,
            city=fold(city or ""), location_search=location_search or "",
            desc_len=desc_len or 0, applicant_count=applicant_count,
            salary_range=salary_range or "",
        ))

    stats = {"groups": 0, "marked": 0, "winners_enriched": 0, "descriptions_copied": 0}

    for rows in groups.values():
        if len(rows) < 2:
            continue
        stats["groups"] += 1
        rows.sort(key=lambda r: (_SOURCE_TIER.get(r.source, 3), -r.desc_len, r.id))

        winners: list[_Row] = []
        for row in rows:
            home = None
            for winner in winners:
                domains_ok = not row.domain or not winner.domain or row.domain == winner.domain
                if domains_ok and _cities_compatible(row.city, winner.city, winner.location_search):
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
            if home.desc_len < 50 and row.desc_len >= 50:
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
