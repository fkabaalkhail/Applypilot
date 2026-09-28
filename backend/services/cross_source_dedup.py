"""
Cross-source job dedup: the same posting scraped from LinkedIn/Indeed AND from
the employer's own board (ats/github sources).

The direct row is strictly better (real description, direct apply link) so
inferior twins are soft-hidden (`duplicate_of` = winner id, never deleted:
saved-job and application records may reference them) and the winner inherits
whatever the twin knew that it doesn't (applicant_count, salary_range, a
description when the winner has none, and a real logo when the winner's is
generated).

Matching is deliberately exact, never fuzzy: normalized employer + normalized
title + city containment. "Software Engineer Intern, Infrastructure" is a
different job from "Software Engineer Intern" and must never merge.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from urllib.parse import parse_qsl, urlsplit

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, aliased

from backend.db.models import ScrapedJob
from backend.services.listing_freshness import (
    HIDDEN_LISTING_STATUSES,
    LISTING_ACTIVE,
    LISTING_REMOVED,
    LISTING_STALE,
)
from backend.services.location_parser import fold
from backend.services.logo_cache import logo_quality

logger = logging.getLogger(__name__)

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
    from urllib.parse import urlencode, urlunsplit

    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not k.lower().startswith("utm_")]
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(kept), "")
    ).rstrip("/")


_LINKEDIN_JOB_ID_RE = re.compile(r"(\d{6,})(?!.*\d{6,})")


def posting_key(url: str) -> str:
    """The posting a URL names, host spelling aside: LinkedIn's numeric job
    id ('ca.linkedin.com/jobs/view/dev-at-ibm-4462216626' and
    'www.linkedin.com/jobs/view/4462216626' are one posting), Indeed's jk,
    otherwise the utm-free URL. Two rows with different keys are different
    postings, even when employer, title and city match (a repost)."""
    raw = (url or "").strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw.lower()
    host = (parts.hostname or "").lower()
    query = {k.lower(): v for k, v in parse_qsl(parts.query)}
    if host == "linkedin.com" or host.endswith(".linkedin.com"):
        job_id = (query.get("currentjobid") or "").strip()
        if not job_id:
            match = _LINKEDIN_JOB_ID_RE.search(parts.path)
            job_id = match.group(1) if match else ""
        if job_id:
            return f"linkedin:{job_id}"
    if host == "indeed.com" or host.endswith(".indeed.com"):
        job_key = (query.get("jk") or query.get("vjk") or "").strip().lower()
        if job_key:
            return f"indeed:{job_key}"
    return canonical_url(raw).lower()


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


# ─── Which rows may stand in for their twins ────────────────────────────────
#
# A row hides (absorbs) its twins, and answers for them on a deep link, only
# while it is visible. A closed aggregator row speaks for its own posting id
# alone: LinkedIn/Indeed reposts carry new ids, and the 21-day age-out says
# nothing about a newer copy. The one closed row that still speaks for its
# mirrors is a direct (ats/github) row the board or the platform check
# REMOVED: that is a death verdict on the employer's own requisition, and
# LinkedIn keeps "apply on company site" mirrors of closed requisitions open
# (their apply link lands on the employer's 404). ``expired`` is only age or
# missing evidence, never a death verdict, so an expired row speaks for no
# one.

_VISIBLE_LISTING_STATUSES = (LISTING_ACTIVE, LISTING_STALE)


def stands_in_for_twins(listing_status: str | None, source_platform: str, url: str) -> bool:
    """True when a row may hide its twins or answer for them (see above)."""
    if listing_status not in HIDDEN_LISTING_STATUSES:
        return True
    return (listing_status == LISTING_REMOVED
            and effective_source(source_platform or "", url or "") in DIRECT_SOURCES)


def _stands_in_filter():
    """SQL side of stands_in_for_twins. Loose on one point: a rogue-era 'ats'
    row with an aggregator URL passes here and is rejected in Python."""
    return or_(
        ScrapedJob.listing_status.is_(None),
        ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES),
        and_(ScrapedJob.listing_status == LISTING_REMOVED,
             ScrapedJob.source_platform.in_(DIRECT_SOURCES)),
    )


# Column-only view of a possible absorber: id, source_platform, url,
# description length, city, location_search, country, title_norm, status.
_TWIN_COLUMNS = (
    ScrapedJob.id, ScrapedJob.source_platform, ScrapedJob.url,
    func.length(func.coalesce(ScrapedJob.description, "")),
    ScrapedJob.city, ScrapedJob.location_search, ScrapedJob.country,
    ScrapedJob.title_norm, ScrapedJob.listing_status,
)


def _find_absorber(db: Session, *, row_id: int, source: str, title_norm: str,
                   company: str, company_domain: str, city: str, country: str,
                   desc_len: int) -> int | None:
    """The id of the row that should hide this aggregator row: a better twin
    (a direct row, or a same-tier aggregator row that has a description when
    this one doesn't, the older one when both do) for the same employer,
    title and city, among the rows that may stand in for it. Exact title
    first; failing that, a near-identical DIRECT title only (fuzzy-merging
    two aggregator copies risks eating a genuinely different posting).
    Column-only."""
    row_tier = _SOURCE_TIER.get(source, 3)

    def pick(twins) -> int | None:
        for (twin_id, twin_source, twin_url, twin_desc_len, twin_city,
             twin_search, twin_country, _norm, twin_status) in twins:
            if not stands_in_for_twins(twin_status, twin_source, twin_url):
                continue
            twin_tier = _SOURCE_TIER.get(effective_source(twin_source or "", twin_url or ""), 3)
            better = twin_tier < row_tier or (
                twin_tier == row_tier
                and (twin_desc_len or 0) >= 50
                and (desc_len < 50 or twin_id < row_id)
            )
            if not better:
                continue
            if not _cities_compatible(city, twin_city or "", twin_search or "",
                                      country, twin_country or ""):
                continue
            return twin_id
        return None

    twins = (
        db.query(*_TWIN_COLUMNS)
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            _stands_in_filter(),
            ScrapedJob.title_norm == title_norm,
            ScrapedJob.id != row_id,
            _employer_filter(company, company_domain),
        )
        .limit(20)
        .all()
    )
    best = pick(twins)
    if best is not None:
        return best
    near = (
        db.query(*_TWIN_COLUMNS)
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            _stands_in_filter(),
            ScrapedJob.source_platform.in_(DIRECT_SOURCES),
            ScrapedJob.title_norm != title_norm,
            ScrapedJob.title_norm != "",
            ScrapedJob.id != row_id,
            _employer_filter(company, company_domain),
        )
        .limit(40)
        .all()
    )
    return pick([twin for twin in near if titles_fuzzy_match(title_norm, twin[7] or "")])


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
    city already exists, the ingest guard for LinkedIn/Indeed sources. An
    expired direct row doesn't count (no death verdict, the new copy may be
    live); a removed one does (stands_in_for_twins)."""
    title_norm = normalize_title(title)
    if not title_norm:
        return False
    city = fold(city or "")

    query = (
        db.query(
            ScrapedJob.id, ScrapedJob.city, ScrapedJob.location_search,
            ScrapedJob.country, ScrapedJob.url, ScrapedJob.source_platform,
            ScrapedJob.listing_status,
        )
        .filter(
            ScrapedJob.duplicate_of.is_(None),
            ScrapedJob.source_platform.in_(DIRECT_SOURCES),
            _stands_in_filter(),
            ScrapedJob.title_norm == title_norm,
            _employer_filter(company, company_domain),
        )
        .limit(20)
    )
    for _id, winner_city, winner_search, winner_country, url, source, status in query.all():
        if effective_source(source, url) not in DIRECT_SOURCES:
            continue  # rogue-era mislabel: an aggregator URL is not a direct twin
        if not stands_in_for_twins(status, source, url):
            continue
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
        _inherit_logo(winner, twin)
        marked += 1
    if marked:
        db.commit()
    return marked


def _inherit_logo(winner: ScrapedJob, twin: ScrapedJob) -> None:
    """A LinkedIn twin often carries the employer's real logo while the direct
    winner has only a generated favicon; hiding the twin must not hide the
    logo too."""
    if logo_quality(winner.company_logo) == 0 and logo_quality(twin.company_logo) > 0:
        winner.company_logo = twin.company_logo


def release_from_closed_winners(db: Session, *, clear_probe: bool = True) -> list[tuple]:
    """Give back the LinkedIn/Indeed rows hidden behind a winner that has
    since closed and can no longer stand in for them (stands_in_for_twins):
    an older copy that aged out or whose own posting died, while this copy,
    a repost with a posting id of its own, may well be live.

    Each such row (active or stale itself, a different posting_key from its
    winner) either moves under a better twin that is still visible, or
    comes back to the feed with ``last_probed_at`` cleared, so the
    least-recently-probed-first verifier checks it before anything else and
    the dead share leaves again quickly. Rows sharing the winner's posting
    id stay hidden: that posting's closure is theirs too. ``clear_probe``
    False skips the probe stamp (a database without the column yet).

    Order-proof: rows go best first, in _find_absorber's own ``better``
    order, so a copy released early is the better twin its later same-job
    rows find; and one posting (posting_key) comes back once, its other
    copies going under the one released, even when neither copy is
    ``better`` (no description on either).

    Returns (row id, old winner id, new winner id or None) per row moved.
    Column-only reads; one UPDATE per row by id. Commits."""
    winner = aliased(ScrapedJob)
    rows = (
        db.query(
            ScrapedJob.id, ScrapedJob.url, ScrapedJob.source_platform,
            ScrapedJob.company, ScrapedJob.company_domain, ScrapedJob.title,
            ScrapedJob.title_norm, ScrapedJob.city, ScrapedJob.country,
            func.length(func.coalesce(ScrapedJob.description, "")),
            winner.id, winner.url, winner.source_platform, winner.listing_status,
        )
        .join(winner, winner.id == ScrapedJob.duplicate_of)
        .filter(
            ScrapedJob.listing_status.in_(_VISIBLE_LISTING_STATUSES),
            winner.listing_status.in_(HIDDEN_LISTING_STATUSES),
        )
        .all()
    )
    # Mirrors ``better`` in _find_absorber: lower tier, then a description,
    # then the older id. Not the longer description: the older of two
    # described copies is the better one, so it must come back first.
    rows.sort(key=lambda r: (
        _SOURCE_TIER.get(effective_source(r[2] or "", r[1] or ""), 3),
        0 if (r[9] or 0) >= 50 else 1,
        r[0],
    ))

    moved: list[tuple] = []
    released: dict[str, int] = {}  # posting_key -> the copy this pass released
    for (row_id, url, source, company, domain, title, title_norm, city, country,
         desc_len, winner_id, winner_url, winner_source, winner_status) in rows:
        row_source = effective_source(source or "", url or "")
        if row_source not in INFERIOR_SOURCES:
            continue  # direct rows are only ever hidden as URL twins
        if stands_in_for_twins(winner_status, winner_source, winner_url):
            continue
        key = posting_key(url)
        if key == posting_key(winner_url):
            continue
        norm = title_norm or normalize_title(title or "")
        new_home = released.get(key) if key else None
        if new_home is None and norm and norm != "\x01":
            new_home = _find_absorber(
                db, row_id=row_id, source=row_source, title_norm=norm,
                company=company or "", company_domain=domain or "",
                city=city or "", country=country or "", desc_len=desc_len or 0,
            )
        values: dict = {"duplicate_of": new_home}
        if new_home is None and clear_probe:
            values["last_probed_at"] = None
        db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(values)
        moved.append((row_id, winner_id, new_home))
        if new_home is None and key:
            released[key] = row_id
    if moved:
        db.commit()
    return moved


def absorb_new_aggregator_rows(db: Session, limit: int = 300) -> int:
    """Incremental dedup for rows the one-time sweep never saw: the newest
    unmarked LinkedIn/Indeed rows get absorbed by any better existing twin
    that may stand in for them (_find_absorber). Rows hidden behind a winner
    that has since closed are given back first (release_from_closed_winners).
    Called from the hourly backfill cron. Commits. Returns rows absorbed."""
    moved = release_from_closed_winners(db)
    if moved:
        logger.info(
            "dedup: %d rows left closed winners (%d back in the feed, %d under a live twin)",
            len(moved), sum(1 for m in moved if m[2] is None),
            sum(1 for m in moved if m[2] is not None),
        )

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
        best_id = _find_absorber(
            db, row_id=row.id, source=row_source, title_norm=title_norm,
            company=row.company, company_domain=row.company_domain or "",
            city=row.city or "", country=row.country or "",
            desc_len=len(row.description or ""),
        )
        best = db.get(ScrapedJob, best_id) if best_id is not None else None
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
        _inherit_logo(best, row)
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
    stands_in: bool  # may hide its twins (stands_in_for_twins)


def dedup_sweep(db: Session) -> dict:
    """Collapse cross-source twins across the whole catalogue (one-time /
    maintenance pass). A closed row never becomes the winner that hides a
    live copy (stands_in_for_twins). Column-only reads; descriptions are only
    fetched for the rare copy onto a description-less winner. Commits.
    Idempotent."""
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
            ScrapedJob.listing_status,
        )
        .filter(ScrapedJob.duplicate_of.is_(None))
        .all()
    )

    stats = {"groups": 0, "marked": 0, "winners_enriched": 0,
             "descriptions_copied": 0, "url_twins_marked": 0}

    # Phase A: identical canonical URL = the same posting, whatever the tier.
    # (GitHub lists append utm_* params, so the URL-unique constraint lets the
    # same job in twice.) Keep the best copy, a live one first; hide the rest.
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
                1 if r[13] in HIDDEN_LISTING_STATUSES else 0,
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
         location_search, desc_len, applicant_count, salary_range, status) in raw:
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
            stands_in=stands_in_for_twins(status, source or "", url or ""),
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
                if row.stands_in:
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
