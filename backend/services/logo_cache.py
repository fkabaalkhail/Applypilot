"""
Self-hosted company logos: one validated, squared image per employer.

Every hotlinked source the feed used had a failure mode users could see:
favicons built from name-guessed domains that don't exist or are parked,
og:image banners, Commons wordmarks, CORP/ORB-blocked assets and
quota-limited fallbacks that end in a letter avatar. The harvester
(services/logo_harvester.py) downloads a real logo once and normalizes it
(services/logo_image.py); this module stores those bytes in ``company_logos``
keyed by a normalized company name, serves them from our own origin
(GET /jobs/logo/{sha}.png, immutable cache), and points every row of that
employer at the stored copy.

Rows reference a logo by content hash ('/jobs/logo/<sha1>.png'), so a
re-harvest that changes the image changes the URL, and the year-long CDN
cache can never serve a stale one.

Nothing a store replaces is lost: the real hotlinks propagation overwrites
are kept on the record (prior_logo_urls), a re-harvest tries them first, and
demote_logo undoes a wrong pick. A pick the cron made while LinkedIn was
rate-limiting it is provisional until a later run had LinkedIn's answer.

Reads are column-only (Neon egress): logo bytes are only ever selected by the
serving endpoint, one row at a time.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import re
import socket
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, NamedTuple

from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.db.models import CompanyLogo, ScrapedJob
from backend.services.location_parser import fold
from backend.services.logo_resolver import (
    curated_domain,
    domain_from_logo_url,
    domain_from_name,
    domain_from_url,
)

logger = logging.getLogger(__name__)

LOGO_PATH_PREFIX = "/jobs/logo/"
STATUS_OK = "ok"
STATUS_MISS = "miss"

# A miss is retried after 14 days per failed attempt, capped: new evidence (a
# LinkedIn posting, a registry domain, a fixed harvester) keeps arriving for
# most employers, so no company is ever written off for good.
RETRY_STEP = datetime.timedelta(days=14)
RETRY_CAP = datetime.timedelta(days=90)
# A result LinkedIn had no say in (it rate-limited the cron first) is looked
# at again soon: see recheck_delay.
RECHECK_STEP = datetime.timedelta(days=1)

# cron-backfill Phase 3 budget. The "hourly" workflow really fires ~6x/day at
# irregular gaps, so each run has to make real progress on its own; busiest
# companies go first and the miss backoff rotates through the rest.
HARVEST_BUDGET_S = 150.0
HARVEST_CONCURRENCY = 6
HARVEST_MAX_COMPANIES = 150
# Backstop only: the harvester's own cap (logo_harvester.HARVEST_TIME_CAP,
# 30s) ends a slow company first, and that reads as a miss.
HARVEST_PER_COMPANY_TIMEOUT_S = 45.0
_REPROPAGATE_MAX_COMPANIES = 200
_SUSPECT_DOMAINS_PER_COMPANY = 3

_IN_CHUNK = 400


# ─── Company identity ────────────────────────────────────────────────────────

_MARKDOWN = re.compile(r"\*\*|__|`")
_EDGE_EMPHASIS = re.compile(r"^[*_]+|[*_]+$")
# Registry display names like "Notion (Ashby)" carry the ATS they came from.
_ATS_TAG = re.compile(
    r"\s*\((?:ashby|greenhouse|lever|workday|smartrecruiters|icims|taleo|jobvite|"
    r"bamboohr|workable|recruitee|breezy|successfactors|oracle|eightfold|phenom)\)\s*$",
    re.IGNORECASE,
)
_LEGAL_SUFFIXES = {
    "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation",
    "co", "company", "plc", "gmbh", "sa", "ag", "lp", "llp",
}
# Placeholders scrapers write when the employer is missing ('nan' is pandas'
# NaN as text). They name nobody, so they get no key: no stored logo, no
# harvest, and no logo shared across unrelated postings.
_PLACEHOLDER_KEYS = frozenset({
    "nan", "none", "null", "nil", "na", "n a", "unknown", "unknown company",
    "undisclosed", "undisclosed company", "confidential", "confidential company",
    "company confidential", "not disclosed", "not specified", "anonymous",
})


def clean_company_name(name: str | None) -> str:
    """Display form of a company name: markdown emphasis ('**Tesla**') and an
    ATS tag ('Notion (Ashby)') removed, whitespace collapsed."""
    text = _MARKDOWN.sub("", name or "").strip()
    text = _EDGE_EMPHASIS.sub("", text)
    text = _ATS_TAG.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def company_key(name: str | None) -> str:
    """Normalized employer identity: "**Tesla**", "Tesla" and "Tesla, Inc."
    all map to "tesla". Lowercase, diacritics folded, punctuation to spaces,
    trailing legal suffixes dropped (never the last remaining word). ""
    for a blank or placeholder name ('nan', 'N/A', 'Unknown', ...)."""
    text = re.sub(r"[^a-z0-9]+", " ", fold(clean_company_name(name)))
    tokens = text.split()
    while len(tokens) > 1 and tokens[-1] in _LEGAL_SUFFIXES:
        tokens.pop()
    key = " ".join(tokens)
    return "" if key in _PLACEHOLDER_KEYS else key


def logo_path(sha: str, fmt: str) -> str:
    """The relative URL a stored logo is served at."""
    return f"{LOGO_PATH_PREFIX}{sha}.{'svg' if fmt == 'svg' else 'png'}"


# ─── Stored-logo classification ──────────────────────────────────────────────

# URLs minted by favicon/logo services from a (usually guessed) domain; nobody
# ever looked at the image.
_GENERATED_LOGO_MARKERS = (
    "google.com/s2/favicons", "gstatic.com/favicon", "clearbit.com",
    "icon.horse", "apistemic", "hunter.io", "unavatar.io", "duckduckgo.com/ip3",
)
# Known-bad hotlinks: parked/for-sale landers, and social-share art (og:image,
# share.jpg, 1200x630 heroes) that renders as a strip or a photo at 40px. An
# icon file that merely lives in a /social/ folder is still an icon.
_PARKED_LOGO = re.compile(
    r"hugedomains|aftermarket\.com|spaceship-cdn|sedoparking|afternic|parkingcrew|"
    r"bodis\.com|[/.]forsale\.",
    re.IGNORECASE,
)
_BANNER_LOGO = re.compile(
    r"1200x6[23]\d|generic-image|header_collage|"
    r"(?:^|[/_.\-=])(?:og|share|sharing|social|socialpost|hero|banner|preview|"
    r"opengraph|open_graph|thumbnail|twitter-card)(?=[/_.\-?%&=]|$)",
    re.IGNORECASE,
)
_ICON_FILE = re.compile(r"apple-touch|favicon|touch-icon", re.IGNORECASE)
# Hotlinks that already are the employer's square logo and load everywhere:
# LinkedIn company images (signed, never-expiring) and Indeed's squarelogo CDN.
_TRUSTED_LOGO_PREFIXES = (
    "https://media.licdn.com/dms/image/",
    "https://d2q79iu7y748jz.cloudfront.net/s/_squarelogo/",
)


def logo_quality(url: str | None) -> int:
    """Rank a stored company_logo: 3 self-hosted, 2 trusted hotlink (LinkedIn
    or Indeed square logo), 1 any other real image URL, 0 missing, generated
    or known-bad."""
    url = (url or "").strip()
    if not url:
        return 0
    if url.startswith(LOGO_PATH_PREFIX):
        return 3
    lowered = url.lower()
    if not lowered.startswith(("https://", "http://")):
        return 0
    if any(marker in lowered for marker in _GENERATED_LOGO_MARKERS):
        return 0
    if url.startswith(_TRUSTED_LOGO_PREFIXES):
        return 2
    if _PARKED_LOGO.search(url):
        return 0
    if _BANNER_LOGO.search(url) and not _ICON_FILE.search(url):
        return 0
    return 1


def _replaceable_logo(path: str):
    """SQL: rows whose logo the stored one should replace. Only trusted
    hotlinks and the current stored path survive; every other hotlink is
    unverified (banners, wordmarks, CORP-blocked or other companies' icons)
    while the stored copy was validated and squared."""
    keep = or_(
        *[ScrapedJob.company_logo.like(prefix + "%") for prefix in _TRUSTED_LOGO_PREFIXES],
        ScrapedJob.company_logo == path,
    )
    return or_(ScrapedJob.company_logo.is_(None), ~keep)


def _visible():
    """SQL: rows the feed shows."""
    # Imported here: the dedup and freshness modules import this one.
    from backend.services.listing_freshness import HIDDEN_LISTING_STATUSES

    return and_(
        ScrapedJob.duplicate_of.is_(None),
        or_(
            ScrapedJob.listing_status.is_(None),
            ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES),
        ),
        ScrapedJob.company.isnot(None),
        func.trim(ScrapedJob.company) != "",
        ScrapedJob.company != "Unknown",
    )


def _chunks(items: list, size: int = _IN_CHUNK):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


# ─── Lookups for insert paths ────────────────────────────────────────────────

class CompanyBranding(NamedTuple):
    logo: str  # self-hosted path, "" while nothing is stored
    domain: str  # verified registrable domain, "" when unknown
    rejected: frozenset  # name-guessed domains proven bogus
    # The logo is a lower-tier pick stored while LinkedIn was rate-limited,
    # due for a re-check (next_retry_at is set on an 'ok' record).
    provisional: bool = False


def load_branding(db: Session, companies: Iterable[str]) -> dict[str, CompanyBranding]:
    """Stored branding for these companies, keyed by company_key. One
    column-only query per ~400 keys; companies with no record are absent."""
    keys = sorted({company_key(c) for c in companies if c} - {""})
    out: dict[str, CompanyBranding] = {}
    for chunk in _chunks(keys):
        rows = (
            db.query(
                CompanyLogo.company_key, CompanyLogo.status, CompanyLogo.sha,
                CompanyLogo.fmt, CompanyLogo.domain, CompanyLogo.rejected_domains,
                CompanyLogo.next_retry_at,
            )
            .filter(CompanyLogo.company_key.in_(chunk))
            .all()
        )
        for key, status, sha, fmt, domain, rejected, next_retry_at in rows:
            stored = status == STATUS_OK and bool(sha)
            out[key] = CompanyBranding(
                logo_path(sha, fmt or "png") if stored else "",
                domain or "",
                frozenset(rejected or ()),
                stored and next_retry_at is not None,
            )
    return out


def lookup_logo(db: Session, company: str) -> str | None:
    """The self-hosted logo path for a company, or None."""
    record = load_branding(db, [company]).get(company_key(company))
    return (record.logo or None) if record else None


def brand(
    branding: dict[str, CompanyBranding], company: str, logo: str, domain: str
) -> tuple[str, str]:
    """Final (company_logo, company_domain) for a row about to be inserted.

    The stored logo and verified domain beat whatever the insert path
    resolved (a provisional logo only beats a missing, generated or known-bad
    one, as in propagate_logo); a guessed domain the harvester proved bogus
    is dropped, along with any favicon URL built from it."""
    logo, domain = logo or "", domain or ""
    record = branding.get(company_key(company))
    if record is None:
        return logo, domain
    if record.domain:
        domain = record.domain
    elif domain in record.rejected:
        domain = ""
        if logo_quality(logo) == 0:
            logo = ""
    if record.logo and not (record.provisional and logo_quality(logo) in (1, 2)):
        logo = record.logo
    return logo, domain


# ─── Store + propagate ───────────────────────────────────────────────────────

def company_names_by_key(db: Session) -> dict[str, list[str]]:
    """Every distinct company spelling in scraped_jobs (visible or not),
    grouped by company_key. One column-only DISTINCT scan; bulk callers
    compute this once and pass `names=` to the functions below."""
    out: dict[str, list[str]] = {}
    for (name,) in db.query(ScrapedJob.company).distinct().all():
        key = company_key(name)
        if key:
            out.setdefault(key, []).append(name)
    return out


def _names_for(db: Session, company: str, names: list[str] | None) -> list[str]:
    if names is not None:
        return names
    return company_names_by_key(db).get(company_key(company), [])


# Displaced hotlinks remembered per employer (company_logos.prior_logo_urls),
# and how many of them a re-harvest tries first.
_PRIOR_MAX = 8
_PRIOR_SEEDS = 2
_MAX_URL = 2000


def _remember_prior_urls(db: Session, key: str, current, displaced: Counter) -> None:
    """Append the real hotlinks propagation is about to replace (most rows
    first) to the record's prior_logo_urls. No commit."""
    urls = [u for u in (current or []) if u]
    for url, _count in displaced.most_common():
        if url and len(url) <= _MAX_URL and url not in urls:
            urls.append(url)
    urls = urls[:_PRIOR_MAX]
    if urls != list(current or []):
        db.query(CompanyLogo).filter(CompanyLogo.company_key == key).update(
            {"prior_logo_urls": urls}, synchronize_session=False
        )


def propagate_logo(
    db: Session, company: str, *, names: list[str] | None = None, dry_run: bool = False
) -> int:
    """Point every row of this employer (visible or hidden) at its stored
    logo, unless the row already has it or a trusted square hotlink; write
    the verified domain too. The real hotlinks it replaces (logo_quality 1)
    are saved on the record first (prior_logo_urls): a re-harvest tries them
    before anything else and demote_logo puts them back. A provisional logo
    replaces only missing, generated or known-bad logos; real hotlinks stay
    until it is final. Returns the number of logos replaced. Commits, except
    with dry_run, which only counts the rows it would replace."""
    key = company_key(company)
    record = (
        db.query(
            CompanyLogo.status, CompanyLogo.sha, CompanyLogo.fmt, CompanyLogo.domain,
            CompanyLogo.next_retry_at, CompanyLogo.prior_logo_urls,
        )
        .filter(CompanyLogo.company_key == key)
        .first()
    ) if key else None
    if record is None or record.status != STATUS_OK or not record.sha:
        return 0
    path = logo_path(record.sha, record.fmt or "png")
    provisional = record.next_retry_at is not None

    replaced = 0
    displaced: Counter = Counter()
    for chunk in _chunks(_names_for(db, company, names)):
        stale = db.query(ScrapedJob).filter(ScrapedJob.company.in_(chunk), _replaceable_logo(path))
        hotlinks = {
            url: count
            for url, count in (
                stale.with_entities(ScrapedJob.company_logo, func.count(ScrapedJob.id))
                .group_by(ScrapedJob.company_logo)
                .all()
            )
            if logo_quality(url) == 1
        }
        if provisional and hotlinks:
            stale = stale.filter(or_(
                ScrapedJob.company_logo.is_(None),
                ScrapedJob.company_logo.notin_(list(hotlinks)),
            ))
        elif not provisional:
            displaced.update(hotlinks)
        if dry_run:
            replaced += stale.with_entities(func.count(ScrapedJob.id)).scalar() or 0
            continue
        replaced += stale.update({"company_logo": path}, synchronize_session=False)
        if record.domain:
            # A verified domain fixes the name guesses (notionashby.com ->
            # notion.so) that every domain-keyed fallback depends on.
            db.query(ScrapedJob).filter(
                ScrapedJob.company.in_(chunk),
                or_(
                    ScrapedJob.company_domain.is_(None),
                    ScrapedJob.company_domain != record.domain,
                ),
            ).update({"company_domain": record.domain}, synchronize_session=False)
    if not dry_run:
        if displaced:
            _remember_prior_urls(db, key, record.prior_logo_urls, displaced)
        db.commit()
    return replaced


def _upsert(db: Session, key: str, fields: dict) -> None:
    """Insert or update the company_logos row for `key` without ever loading
    its bytes. Commits."""
    existing = db.query(CompanyLogo.id).filter(CompanyLogo.company_key == key).first()
    if existing is None:
        db.add(CompanyLogo(company_key=key, created_at=_now(), **fields))
        try:
            db.commit()
            return
        except IntegrityError:
            # A concurrent writer created it first; fall through to update.
            db.rollback()
    db.query(CompanyLogo).filter(CompanyLogo.company_key == key).update(
        fields, synchronize_session=False
    )
    db.commit()


def _store(
    db: Session, company: str, result, names: list[str] | None, *, provisional: bool = False
) -> tuple[str, int]:
    key = company_key(company)
    logo = result.logo
    if not key or logo is None or not logo.sha or not logo.data:
        return "", 0
    fmt = "svg" if logo.fmt == "svg" else "png"
    now = _now()
    attempts, next_retry_at = 0, None  # final
    if provisional:
        # attempts counts provisional picks in a row, for the re-check backoff.
        row = (
            db.query(CompanyLogo.status, CompanyLogo.attempts, CompanyLogo.next_retry_at)
            .filter(CompanyLogo.company_key == key)
            .first()
        )
        was_provisional = (
            row is not None and row.status == STATUS_OK and row.next_retry_at is not None
        )
        attempts = (row.attempts or 0) + 1 if was_provisional else 1
        next_retry_at = now + recheck_delay(attempts)
    fields = {
        "display_name": clean_company_name(company),
        "status": STATUS_OK,
        "sha": logo.sha,
        "fmt": fmt,
        "data": bytes(logo.data),
        "source": (result.source or "")[:100],
        "source_url": (result.source_url or "")[:2000],
        "width": logo.width,
        "height": logo.height,
        "attempts": attempts,
        "checked_at": now,
        "next_retry_at": next_retry_at,
        "updated_at": now,
    }
    if result.verified_domain:
        fields["domain"] = result.verified_domain.strip().lower()
    _upsert(db, key, fields)
    replaced = propagate_logo(db, company, names=names)
    return logo_path(logo.sha, fmt), replaced


def store_logo(
    db: Session, company: str, result, *, names: list[str] | None = None,
    provisional: bool = False,
) -> str:
    """Save a harvested logo (a logo_harvester.HarvestResult) for this
    employer, then propagate it to the employer's rows. Returns the served
    path ('' when the result carries no usable image). Commits.

    provisional: a lower-tier pick made while LinkedIn was rate-limited. It
    is served and fills rows with no real logo, but stays due for a re-check
    (recheck_delay) and replaces real hotlinks only once final."""
    return _store(db, company, result, names, provisional=provisional)[0]


def retry_delay(attempts: int) -> datetime.timedelta:
    """Backoff before re-harvesting a company after `attempts` misses."""
    return min(RETRY_STEP * max(attempts, 1), RETRY_CAP)


def recheck_delay(attempts: int) -> datetime.timedelta:
    """Backoff before re-harvesting a company whose last result LinkedIn had
    no say in (rate-limited first): a day, doubling per repeat, capped like
    any miss. LinkedIn blocks pass within hours."""
    return min(RECHECK_STEP * 2 ** min(max(attempts, 1) - 1, 7), RETRY_CAP)


def record_miss(
    db: Session,
    company: str,
    *,
    rejected_domains: Iterable[str] = (),
    names: list[str] | None = None,
    linkedin_skipped: bool = False,
) -> None:
    """Remember that nothing usable was found, and when to try again. Guessed
    domains proven bogus are cleared from the employer's rows (with the
    favicon URLs built from them) so the frontend stops rendering a parked
    domain's icon. Commits.

    linkedin_skipped: LinkedIn was rate-limited before this employer's turn,
    so the miss proves little and is retried after recheck_delay instead of
    retry_delay. A stored logo is never demoted by a miss: a final one is
    left alone; a provisional one is re-checked later again (LinkedIn
    skipped) or becomes final (LinkedIn answered and had nothing better)."""
    key = company_key(company)
    if not key:
        return
    row = (
        db.query(
            CompanyLogo.status, CompanyLogo.attempts, CompanyLogo.rejected_domains,
            CompanyLogo.next_retry_at,
        )
        .filter(CompanyLogo.company_key == key)
        .first()
    )
    now = _now()
    if row is not None and row.status == STATUS_OK:
        if row.next_retry_at is None:
            return
        if linkedin_skipped:
            attempts = (row.attempts or 0) + 1
            _upsert(db, key, {
                "attempts": attempts, "checked_at": now,
                "next_retry_at": now + recheck_delay(attempts), "updated_at": now,
            })
            return
        _upsert(db, key, {"attempts": 0, "checked_at": now, "next_retry_at": None, "updated_at": now})
        propagate_logo(db, company, names=names)  # final now: real hotlinks too
        return
    bogus = sorted({d.strip().lower() for d in rejected_domains if d})
    previous_attempts, previous_rejected = (
        (row.attempts or 0, set(row.rejected_domains or ())) if row is not None else (0, set())
    )
    attempts = previous_attempts + 1
    delay = recheck_delay(attempts) if linkedin_skipped else retry_delay(attempts)
    _upsert(db, key, {
        "display_name": clean_company_name(company),
        "status": STATUS_MISS,
        "attempts": attempts,
        "rejected_domains": sorted(previous_rejected | set(bogus)),
        "checked_at": now,
        "next_retry_at": now + delay,
        "updated_at": now,
    })
    if not bogus:
        return
    # '' rather than NULL: ScrapedJobOut.company_domain is a plain str.
    for chunk in _chunks(_names_for(db, company, names)):
        rows = db.query(ScrapedJob).filter(
            ScrapedJob.company.in_(chunk), ScrapedJob.company_domain.in_(bogus)
        )
        rows.filter(
            or_(*[ScrapedJob.company_logo.like(f"%{m}%") for m in _GENERATED_LOGO_MARKERS])
        ).update({"company_logo": ""}, synchronize_session=False)
        rows.update({"company_domain": ""}, synchronize_session=False)
    db.commit()


def demote_logo(
    db: Session, company: str, *, names: list[str] | None = None, dry_run: bool = False
) -> dict | None:
    """Undo a wrong stored logo. The record becomes a miss that is due now,
    with its verified domain forgotten and its image blocked for good (the
    harvester skips any candidate that normalizes to it); rows still showing
    it get back the first real hotlink it replaced, or '' when it replaced
    none (the endpoint stops serving a demoted image). The next harvest
    tries the remembered hotlinks first. Returns what was done (with
    dry_run: what would be), None when nothing is stored for the company.
    Commits, except with dry_run."""
    key = company_key(company)
    record = (
        db.query(
            CompanyLogo.status, CompanyLogo.sha, CompanyLogo.fmt, CompanyLogo.source,
            CompanyLogo.source_url, CompanyLogo.prior_logo_urls, CompanyLogo.blocked_shas,
        )
        .filter(CompanyLogo.company_key == key)
        .first()
    ) if key else None
    if record is None or record.status != STATUS_OK or not record.sha:
        return None
    path = logo_path(record.sha, record.fmt or "png")
    prior = [u for u in (record.prior_logo_urls or []) if logo_quality(u) > 0]
    restore = prior[0] if prior else ""
    rows = 0
    for chunk in _chunks(_names_for(db, company, names)):
        showing = db.query(ScrapedJob).filter(
            ScrapedJob.company.in_(chunk), ScrapedJob.company_logo == path
        )
        if dry_run:
            rows += showing.with_entities(func.count(ScrapedJob.id)).scalar() or 0
        else:
            rows += showing.update({"company_logo": restore}, synchronize_session=False)
    if not dry_run:
        now = _now()
        db.query(CompanyLogo).filter(CompanyLogo.company_key == key).update({
            "status": STATUS_MISS,
            "attempts": 0,
            "domain": None,
            "next_retry_at": None,
            "blocked_shas": sorted(set(record.blocked_shas or ()) | {record.sha}),
            "checked_at": now,
            "updated_at": now,
        }, synchronize_session=False)
        db.commit()
    return {
        "key": key,
        "sha": record.sha,
        "source": record.source or "",
        "source_url": record.source_url or "",
        "restored_to": restore,
        "rows": rows,
    }


# ─── Seeding from logos already in the catalogue ─────────────────────────────

# Real logos already stored on some row, best first: LinkedIn company images
# with a never-expiring signature, other LinkedIn images, Indeed squarelogos,
# ATS-board branding, then Wikimedia. Generated URLs are never seeds.
_SEED_TIERS = (
    re.compile(r"^https://media\.licdn\.com/dms/image/.*[?&]e=2147483647(?:&|$)"),
    re.compile(r"^https://media\.licdn\.com/dms/image/"),
    re.compile(r"^https://d2q79iu7y748jz\.cloudfront\.net/s/_squarelogo/"),
    re.compile(
        r"^https://(?:recruiting\.cdn\.greenhouse\.io/|lever-client-logos\.s3[\w.-]*/|"
        r"app\.ashbyhq\.com/api/images/org-theme-logo|c\.smartrecruiters\.com/|"
        r"[\w-]+\.bamboohr\.com/|[\w.-]+\.myworkdayjobs\.com/.*assets/logo)"
    ),
    re.compile(r"^https://(?:commons|upload)\.wikimedia\.org/"),
)
_SEED_SQL = (
    "https://media.licdn.com/dms/image/%",
    "https://d2q79iu7y748jz.cloudfront.net/s/%",
    "%recruiting.cdn.greenhouse.io%",
    "%lever-client-logos%",
    "%org-theme-logo%",
    "%c.smartrecruiters.com%",
    "%bamboohr.com%",
    "%myworkdayjobs.com%",
    "%wikimedia.org%",
)


def _seed_tier(url: str) -> int | None:
    for tier, pattern in enumerate(_SEED_TIERS):
        if pattern.match(url):
            return tier
    return None


def seed_logo_urls(
    db: Session, names_by_key: dict[str, list[str]], per_key: int = 4
) -> dict[str, list[str]]:
    """Best real logo URLs already stored on any row (visible or hidden) of
    each employer, best first. No network: these become the harvester's
    existing_logo_urls, which it downloads and normalizes before anything
    else. Column-only, grouped (one row per distinct URL)."""
    key_of = {name: key for key, names in names_by_key.items() for name in names}
    ranked: dict[str, list[tuple[int, int, str]]] = {}
    for chunk in _chunks(list(key_of)):
        rows = (
            db.query(ScrapedJob.company, ScrapedJob.company_logo, func.count(ScrapedJob.id))
            .filter(
                ScrapedJob.company.in_(chunk),
                or_(*[ScrapedJob.company_logo.like(p) for p in _SEED_SQL]),
            )
            .group_by(ScrapedJob.company, ScrapedJob.company_logo)
            .all()
        )
        for company, url, count in rows:
            tier = _seed_tier((url or "").strip())
            if tier is not None:
                ranked.setdefault(key_of[company], []).append((tier, -count, url.strip()))
    out: dict[str, list[str]] = {}
    for key, entries in ranked.items():
        seen: list[str] = []
        for _, _, url in sorted(entries):
            if url not in seen:
                seen.append(url)
        out[key] = seen[:per_key]
    return out


# ─── Bogus-domain proof ──────────────────────────────────────────────────────

_NXDOMAIN_ERRNOS = {
    getattr(socket, name) for name in ("EAI_NONAME", "EAI_NODATA") if hasattr(socket, name)
}
_PARKING_HOSTS = {
    "hugedomains.com", "afternic.com", "sedo.com", "sedoparking.com", "dan.com",
    "spaceship.com", "spaceship-cdn.com", "aftermarket.com", "bodis.com",
    "parkingcrew.net", "above.com", "undeveloped.com", "buydomains.com",
    "domainmarket.com", "atom.com", "squadhelp.com", "namecheap.com",
}
_PARKED_PAGE = re.compile(
    r"window\.location\.href\s*=\s*[\"']/lander|"
    r"this domain (?:name )?(?:is|may be) for sale|buy this domain|"
    r"domain (?:is )?parked|parked free|sedoparking|parkingcrew",
    re.IGNORECASE,
)


async def _dns_resolves(domain: str) -> bool | None:
    """True when the name resolves, False on a definite NXDOMAIN/no-address
    answer, None when the lookup itself failed (proves nothing)."""
    loop = asyncio.get_running_loop()
    try:
        await asyncio.wait_for(loop.getaddrinfo(domain, 443), timeout=5)
        return True
    except socket.gaierror as exc:
        return False if exc.errno in _NXDOMAIN_ERRNOS else None
    except Exception:
        return None


async def domain_is_bogus(client, domain: str) -> bool:
    """True only on proof that a domain is not a company site: NXDOMAIN, or a
    parked/for-sale landing page. Timeouts, bot walls and TLS errors prove
    nothing and return False."""
    resolves = await _dns_resolves(domain)
    if resolves is not True:
        return resolves is False
    try:
        resp = await client.get(f"http://{domain}/", timeout=8)
    except Exception:
        return False
    landed = domain_from_url(str(resp.url))
    if landed in _PARKING_HOSTS and landed != domain_from_url(domain):
        return True
    return resp.status_code == 200 and bool(_PARKED_PAGE.search(resp.text[:20000]))


# ─── Longer names of the same employer ───────────────────────────────────────

# Seeds taken from an employer's longer name ('Magna International' rows for
# 'Magna'), tried after the employer's own.
_ALIAS_SEEDS = 2


def alias_keys(keys: Iterable[str]) -> dict[str, list[str]]:
    """{company_key: keys of the same employer's longer names}: the key plus
    one or two generic corporate words ('magna' -> ['magna international'],
    'bmo' -> ['bmo financial group'], 'bell' -> ['bell canada']), never
    'bell flight' or 'the bell company' (logo_harvester.ALIAS_SUFFIXES).
    One direction only: a bare name is too thin to lend its logo to a
    longer one ('Magna' rows would pass for 'Magna Global')."""
    from backend.services.logo_harvester import is_suffix_variant_words

    keyset = {k for k in keys if k}
    out: dict[str, list[str]] = {}
    for key in sorted(keyset):
        words = key.split()
        for extra in (1, 2):
            base = words[:-extra]
            base_key = " ".join(base)
            if base_key in keyset and is_suffix_variant_words(words, base):
                out.setdefault(base_key, []).append(key)
    return out


def _trusted_domains(
    db: Session,
    keys: Iterable[str],
    names_by_key: dict[str, list[str]],
    registry: dict[str, str],
    has_store: bool = True,
) -> dict[str, str]:
    """{company_key: domain} proven for an employer: the curated registry's,
    the one the harvester verified, or the curated KNOWN_DOMAINS entry.
    Never the name guess on its rows ('bell.com' for Bell Canada)."""
    keys = sorted({k for k in keys if k})
    verified: dict[str, str] = {}
    if has_store:
        for chunk in _chunks(keys):
            for key, domain in (
                db.query(CompanyLogo.company_key, CompanyLogo.domain)
                .filter(
                    CompanyLogo.company_key.in_(chunk),
                    CompanyLogo.domain.isnot(None),
                    CompanyLogo.domain != "",
                )
                .all()
            ):
                verified[key] = domain.strip().lower()
    out: dict[str, str] = {}
    for key in keys:
        names = names_by_key.get(key) or []
        domain = (
            registry.get(key)
            or verified.get(key)
            or (curated_domain(clean_company_name(names[0])) if names else None)
        )
        if domain:
            out[key] = domain.strip().lower()
    return out


def _accepted_aliases(key: str, candidates: list[str], trusted: dict[str, str]) -> list[str]:
    """The longer names allowed to seed `key`. A proven domain that disagrees
    vetoes one (Magna Global's own site is not magna.com). When two or more
    are left, only those sharing the key's proven domain stay: otherwise
    'Magna International' and 'Magna Global' are two employers as far as
    anything shows, the name is ambiguous, and none is used."""
    own = trusted.get(key)
    kept = [a for a in candidates if not (own and trusted.get(a) and trusted[a] != own)]
    if len(kept) > 1:
        kept = [a for a in kept if own and trusted.get(a) == own]
    return kept


def _alias_stored_urls(db: Session, keys: list[str]) -> dict[str, str]:
    """Where each of these employers' stored logos was downloaded from. A
    stored logo already passed normalize_logo, so its source is the best
    seed the shorter name can borrow ('Bell Canada' for 'Bell'). Never a
    provisional one: it would come back as a final 'existing' pick."""
    out: dict[str, str] = {}
    for chunk in _chunks(sorted(keys)):
        for key, url in (
            db.query(CompanyLogo.company_key, CompanyLogo.source_url)
            .filter(
                CompanyLogo.company_key.in_(chunk),
                CompanyLogo.status == STATUS_OK,
                CompanyLogo.next_retry_at.is_(None),
            )
            .all()
        ):
            url = (url or "").strip()
            if url.startswith(("https://", "http://")) and logo_quality(url) > 0:
                out[key] = url
    return out


# ─── cron-backfill Phase 3 (and scripts/backfill_logos_v2.py) ────────────────

@dataclass
class _Plan:
    key: str
    display: str
    names: list[str]
    hints: object
    suspect_domains: list[str] = field(default_factory=list)
    rows: int = 0  # visible rows, for ordering and reports
    aliases: list[str] = field(default_factory=list)  # longer names that seeded it


class HarvestOutcome(NamedTuple):
    plan: _Plan
    # ok | miss | timeout | skipped (budget) | error; after_linkedin_block
    # adds provisional (ok, stored for a re-check) and retry (a miss retried
    # soon); the backfill adds deferred (not written at all)
    status: str
    result: object  # a logo_harvester.HarvestResult when ok/provisional
    bogus: list[str]  # name-guessed domains proven bogus on a miss


class _Record(NamedTuple):
    """The company_logos columns planning reads for one employer."""
    status: str | None = None
    next_retry_at: datetime.datetime | None = None
    domain: str = ""
    rejected: frozenset = frozenset()
    prior: tuple = ()
    blocked: frozenset = frozenset()
    sha: str = ""

    @property
    def provisional(self) -> bool:
        return self.status == STATUS_OK and self.next_retry_at is not None


def repropagate_known_logos(
    db: Session,
    names_by_key: dict[str, list[str]],
    *,
    max_companies: int | None = _REPROPAGATE_MAX_COMPANIES,
    dry_run: bool = False,
) -> int:
    """Rows planted with a generated or unverified logo after their employer's
    logo was stored (writers that don't consult the store) get it now. No
    network. Returns the number of rows updated (with dry_run: that would
    be, nothing written)."""
    stray = (
        db.query(ScrapedJob.company)
        .filter(
            _visible(),
            or_(
                ScrapedJob.company_logo.is_(None),
                ~or_(
                    *[ScrapedJob.company_logo.like(p + "%") for p in _TRUSTED_LOGO_PREFIXES],
                    ScrapedJob.company_logo.like(LOGO_PATH_PREFIX + "%"),
                ),
            ),
        )
        .distinct()
        .all()
    )
    stored = load_branding(db, [name for (name,) in stray])
    updated = 0
    # A provisional logo leaves real hotlinks alone, so its employer looks
    # stray on every run: those only get what the final ones leave of the cap.
    keys = sorted(
        (k for k, record in stored.items() if record.logo),
        key=lambda k: (stored[k].provisional, k),
    )
    for key in keys[:max_companies]:
        names = names_by_key.get(key, [])
        if names:
            updated += propagate_logo(db, names[0], names=names, dry_run=dry_run)
    return updated


def _recent_urls(db: Session, names: list[str], condition, per_company: int = 3) -> dict[str, list[str]]:
    """Up to `per_company` newest URLs per company matching `condition`,
    visible or hidden. A window function keeps the transfer to a few rows
    per employer however many postings it has."""
    out: dict[str, list[str]] = {}
    for chunk in _chunks(names):
        rn = func.row_number().over(
            partition_by=ScrapedJob.company, order_by=ScrapedJob.id.desc()
        ).label("rn")
        sub = (
            db.query(ScrapedJob.company.label("company"), ScrapedJob.url.label("url"), rn)
            .filter(ScrapedJob.company.in_(chunk), condition)
            .subquery()
        )
        for company, url in db.query(sub.c.company, sub.c.url).filter(sub.c.rn <= per_company).all():
            if url:
                out.setdefault(company, []).append(url)
    return out


def _registry_domains() -> dict[str, str]:
    """{company_key: domain} from the curated ATS registry's favicon URLs."""
    from backend.data import company_registry

    out: dict[str, str] = {}
    for name, logo_url in company_registry.load_logo_map().items():
        domain = domain_from_logo_url(logo_url)
        key = company_key(name)
        if domain and key:
            out.setdefault(key, domain)
    return out


def _pick_companies(
    db: Session,
    names_by_key: dict[str, list[str]],
    limit: int | None,
    *,
    only: set[str] | None = None,
    retry_misses: bool = False,
    has_store: bool = True,
    force: set[str] | None = None,
) -> tuple[list[tuple[str, str, int]], dict[str, _Record]]:
    """[(key, display name, visible rows)] of employers with visible rows and
    no stored logo whose retry is due (any miss with retry_misses), most
    visible rows first, then provisional logos due for a re-check; `force`
    keys are due whatever is stored. Optionally only the `only` keys. Plus
    their records."""
    force = force or set()
    counts: Counter = Counter()
    spellings: dict[str, Counter] = {}
    rows = (
        db.query(ScrapedJob.company, func.count(ScrapedJob.id))
        .filter(_visible())
        .group_by(ScrapedJob.company)
        .all()
    )
    for name, count in rows:
        key = company_key(name)
        if not key or (only is not None and key not in only):
            continue
        counts[key] += count
        spellings.setdefault(key, Counter())[name] += count

    records: dict[str, _Record] = {}
    # Without the table (a dry run before the deploy) nothing is stored yet.
    for chunk in _chunks(sorted(counts) if has_store else []):
        for key, status, next_retry_at, domain, rejected, prior, blocked, sha in (
            db.query(
                CompanyLogo.company_key, CompanyLogo.status, CompanyLogo.next_retry_at,
                CompanyLogo.domain, CompanyLogo.rejected_domains,
                CompanyLogo.prior_logo_urls, CompanyLogo.blocked_shas, CompanyLogo.sha,
            )
            .filter(CompanyLogo.company_key.in_(chunk))
            .all()
        ):
            records[key] = _Record(
                status, next_retry_at, domain or "", frozenset(rejected or ()),
                tuple(prior or ()), frozenset(blocked or ()), sha or "",
            )

    now = _now()

    def is_due(key: str) -> bool:
        record = records.get(key)
        if record is None or key in force:
            return True
        if record.status == STATUS_OK:  # final never; provisional once due
            return record.provisional and (retry_misses or record.next_retry_at <= now)
        return retry_misses or record.next_retry_at is None or record.next_retry_at <= now

    def recheck_only(key: str) -> bool:
        return key in records and records[key].provisional and key not in force

    due = [key for key in counts if is_due(key)]
    # Employers showing no stored logo first; a provisional one already shows one.
    due.sort(key=lambda k: (recheck_only(k), -counts[k], k))
    picked = [
        (key, clean_company_name(spellings[key].most_common(1)[0][0]), counts[key])
        for key in (due if limit is None else due[:limit])
    ]
    return picked, records


def _build_plans(
    db: Session, picked, records, names_by_key, hints_type, *,
    has_store: bool = True, force: set[str] | None = None,
) -> list[_Plan]:
    """Harvest hints per employer, from column-only reads: candidate domains
    (registry/verified first, company website, proven domains of its longer
    names, employer-hosted apply links, stored non-guess domains, the name
    guess last), a few job URLs (LinkedIn postings from any row, hidden
    duplicates included, then ATS/direct), and real logos already known:
    the hotlinks an earlier store replaced on its rows (prior_logo_urls)
    first, then the employer's own rows, then its longer name's ('Magna
    International' rows for 'Magna'). Demoted images are passed as
    blocked_shas; a forced (re-harvested) employer's current one too."""
    force = force or set()
    scope = {key: names_by_key.get(key) or [display] for key, display, _rows in picked}
    all_names = sorted({name for names in scope.values() for name in names})

    stored_domains: dict[str, Counter] = {}
    company_urls: dict[str, list[str]] = {}
    for chunk in _chunks(all_names):
        for company, domain, count in (
            db.query(ScrapedJob.company, ScrapedJob.company_domain, func.count(ScrapedJob.id))
            .filter(
                ScrapedJob.company.in_(chunk),
                ScrapedJob.company_domain.isnot(None),
                ScrapedJob.company_domain != "",
            )
            .group_by(ScrapedJob.company, ScrapedJob.company_domain)
            .all()
        ):
            stored_domains.setdefault(company, Counter())[domain.strip().lower()] += count
        for company, url in (
            db.query(ScrapedJob.company, ScrapedJob.company_url)
            .filter(
                ScrapedJob.company.in_(chunk),
                ScrapedJob.company_url.isnot(None),
                ScrapedJob.company_url != "",
            )
            .group_by(ScrapedJob.company, ScrapedJob.company_url)
            .all()
        ):
            company_urls.setdefault(company, []).append(url)

    linkedin_urls = _recent_urls(
        db, all_names, ScrapedJob.url.ilike("%linkedin.com/jobs/view/%")
    )
    direct_urls = _recent_urls(
        db, all_names,
        and_(
            ScrapedJob.url.isnot(None),
            ScrapedJob.url != "",
            ~ScrapedJob.url.ilike("%linkedin.com%"),
            ~ScrapedJob.url.ilike("%indeed.com%"),
        ),
    )
    seeds = seed_logo_urls(db, scope)
    registry = _registry_domains()

    # Longer names of the same employer: their proven domains and logos.
    longer_names = alias_keys(names_by_key)
    candidates = {key: longer_names.get(key, []) for key in scope}
    trusted = _trusted_domains(
        db, set(scope) | {a for found in candidates.values() for a in found},
        names_by_key, registry, has_store,
    )
    accepted = {
        key: _accepted_aliases(key, found, trusted) for key, found in candidates.items() if found
    }
    used = sorted({a for found in accepted.values() for a in found})
    alias_seeds = seed_logo_urls(db, {a: names_by_key.get(a, []) for a in used}, per_key=_ALIAS_SEEDS)
    alias_stored = _alias_stored_urls(db, used) if has_store and used else {}

    plans: list[_Plan] = []
    for key, display, visible_rows in picked:
        names = scope[key]
        record = records.get(key, _Record())
        verified, rejected = record.domain, record.rejected
        guesses = {domain_from_name(n) for n in names} | {domain_from_name(display)}
        guesses.discard(None)
        aliases = accepted.get(key, [])

        domains: list[str] = []

        def add(domain):
            domain = (domain or "").strip().lower()
            if domain and domain not in rejected and domain not in domains:
                domains.append(domain)

        add(registry.get(key))
        add(verified)
        for name in names:
            for url in company_urls.get(name, []):
                add(domain_from_url(url))
        add(curated_domain(display))
        for alias in aliases:
            add(trusted.get(alias))
        for name in names:
            for url in direct_urls.get(name, []):
                add(domain_from_url(url))
        stored = Counter()
        for name in names:
            stored.update(stored_domains.get(name, Counter()))
        for domain, _count in stored.most_common():
            if domain not in guesses:
                add(domain)
        add(domain_from_name(display))

        job_urls: list[str] = []
        for source in (linkedin_urls, direct_urls):
            found: list[str] = []
            for name in names:
                for url in source.get(name, []):
                    if url not in found:
                        found.append(url)
            job_urls += found[:3]

        borrowed: list[str] = []
        for alias in aliases:
            for url in [alias_stored.get(alias, "")] + alias_seeds.get(alias, []):
                if url and url not in borrowed:
                    borrowed.append(url)
        prior = [
            u for u in record.prior
            if isinstance(u, str) and u.startswith(("https://", "http://")) and logo_quality(u) > 0
        ][:_PRIOR_SEEDS]
        own = [u for u in seeds.get(key, []) if u not in prior]
        existing = prior + own + [u for u in borrowed if u not in prior and u not in own][:_ALIAS_SEEDS]
        blocked = set(record.blocked)
        if key in force and record.status == STATUS_OK and record.sha:
            blocked.add(record.sha)  # a re-harvest must not land on the same image

        trusted_here = {registry.get(key), verified, curated_domain(display)} | {
            domain_from_url(url) for name in names for url in company_urls.get(name, [])
        }
        suspects = [
            d for d, _count in stored.most_common()
            if d in guesses and d not in trusted_here and d not in rejected
        ]
        guess = domain_from_name(display)
        if guess and guess not in trusted_here and guess not in rejected and guess not in suspects:
            suspects.append(guess)

        plans.append(_Plan(
            key=key,
            display=display,
            names=names,
            hints=hints_type(
                company=display,
                domains=domains,
                job_urls=job_urls,
                existing_logo_urls=existing,
                blocked_shas=sorted(blocked),
            ),
            suspect_domains=suspects[:_SUSPECT_DOMAINS_PER_COMPANY],
            rows=visible_rows,
            aliases=aliases,
        ))
    return plans


def plan_harvest(
    db: Session,
    names_by_key: dict[str, list[str]],
    hints_type,
    *,
    limit: int | None = HARVEST_MAX_COMPANIES,
    only: Iterable[str] | None = None,
    retry_misses: bool = False,
    has_store: bool = True,
    reharvest: Iterable[str] = (),
) -> list[_Plan]:
    """The work list, busiest employer first, each with the hints the
    harvester gets. Read-only (column-only queries); shared by cron-backfill
    Phase 3 and the one-time backfill script so both harvest identically.
    `only` takes company names; has_store=False plans against a database
    whose company_logos table does not exist yet (a dry run). `reharvest`
    names are planned as if demote_logo had run: due whatever is stored,
    and never landing on their current image."""
    keys = {company_key(name) for name in only} - {""} if only is not None else None
    force = {company_key(name) for name in reharvest} - {""}
    picked, records = _pick_companies(
        db, names_by_key, limit, only=keys, retry_misses=retry_misses, has_store=has_store,
        force=force,
    )
    if not picked:
        return []
    return _build_plans(
        db, picked, records, names_by_key, hints_type, has_store=has_store, force=force
    )


async def run_harvest(
    client,
    plans: list[_Plan],
    harvest,
    *,
    budget_s: float = HARVEST_BUDGET_S,
    concurrency: int = HARVEST_CONCURRENCY,
    per_company_timeout: float = HARVEST_PER_COMPANY_TIMEOUT_S,
    on_done=None,
) -> list[HarvestOutcome]:
    """Network only, never touches the database: harvest every plan with
    bounded concurrency inside a wall-clock budget, and on a miss test the
    employer's guessed domains for proof they are bogus. `harvest` is
    logo_harvester.harvest_company_logo (or a stand-in); `on_done` is called
    with each outcome as it lands (progress output)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget_s
    semaphore = asyncio.Semaphore(concurrency)

    async def attempt(plan: _Plan) -> HarvestOutcome:
        async with semaphore:
            remaining = deadline - loop.time()
            if remaining <= 1:
                return HarvestOutcome(plan, "skipped", None, [])
            cut_by_budget = remaining < per_company_timeout
            try:
                result = await asyncio.wait_for(
                    harvest(client, plan.hints),
                    timeout=min(remaining, per_company_timeout),
                )
            except asyncio.TimeoutError:
                # The run ran out (skipped, retried next run), or the company did.
                return HarvestOutcome(plan, "skipped" if cut_by_budget else "timeout", None, [])
            except Exception:
                logger.exception("logo harvest failed for %r", plan.display)
                return HarvestOutcome(plan, "error", None, [])
            if result is not None and getattr(result, "logo", None) is not None:
                return HarvestOutcome(plan, "ok", result, [])
            bogus = []
            for domain in plan.suspect_domains:
                if deadline - loop.time() <= 0:
                    break
                try:
                    if await asyncio.wait_for(domain_is_bogus(client, domain), timeout=15):
                        bogus.append(domain)
                except Exception:
                    continue
            return HarvestOutcome(plan, "miss", None, bogus)

    async def tracked(plan: _Plan) -> HarvestOutcome:
        outcome = await attempt(plan)
        if on_done is not None:
            on_done(outcome)
        return outcome

    return list(await asyncio.gather(*[tracked(plan) for plan in plans]))


def new_harvest_stats() -> dict:
    return {
        "harvester_available": True,
        "repropagated_rows": 0,
        "companies_considered": 0,
        "companies_attempted": 0,
        "stored": 0,
        "provisional": 0,  # of stored: lower-tier picks made after a LinkedIn 429
        "missed": 0,
        "linkedin_deferred": 0,  # of missed: retried soon, LinkedIn had no say
        "timeouts": 0,
        "errors": 0,
        "skipped_budget": 0,
        "rows_updated": 0,
        "domains_rejected": 0,
    }


# Picks a LinkedIn rate limit cannot have made worse: found before LinkedIn
# is asked (existing), by LinkedIn, or on the employer's own ATS board.
_FINAL_AFTER_LINKEDIN_BLOCK = ("existing", "linkedin_job", "linkedin_search")


def after_linkedin_block(
    outcomes: Iterable[HarvestOutcome], finished: dict[str, float], blocked_at: float | None
) -> list[HarvestOutcome]:
    """Outcomes that finished once LinkedIn was given up on for the run
    (the harvester's gate time `blocked_at`; `finished` maps plan keys to
    time.monotonic() at completion) never had LinkedIn's say, and LinkedIn
    is the best source. A homepage/Wikidata/s2 pick becomes 'provisional'
    (stored and shown, re-checked after recheck_delay); a miss or a timeout
    becomes 'retry' (retried after recheck_delay, not the 14-day step).
    Existing, LinkedIn and ATS-board picks, and anything that finished
    earlier, stand. Nothing is dropped: dropping would re-harvest the same
    busiest employers on every run while LinkedIn keeps refusing."""
    out: list[HarvestOutcome] = []
    for outcome in outcomes:
        if blocked_at is None or finished.get(outcome.plan.key, float("-inf")) < blocked_at:
            out.append(outcome)
        elif outcome.status == "ok":
            source = getattr(outcome.result, "source", "") or ""
            final = source in _FINAL_AFTER_LINKEDIN_BLOCK or source.startswith("ats_")
            out.append(outcome if final else outcome._replace(status="provisional"))
        elif outcome.status in ("miss", "timeout"):
            out.append(outcome._replace(status="retry"))
        else:
            out.append(outcome)
    return out


def apply_outcomes(
    db: Session,
    outcomes: Iterable[HarvestOutcome],
    stats: dict,
    *,
    record_timeouts: bool = True,
) -> None:
    """Write harvest outcomes, one at a time (the Session is not task safe):
    store + propagate each hit (provisionally for 'provisional'), record
    each miss with its backoff (short for 'retry') and its proven-bogus
    domains. A company that ran out of time is recorded as a miss only with
    record_timeouts (the cron; the backfill retries it on the next run
    instead). Budget skips are never recorded."""
    for outcome in outcomes:
        plan = outcome.plan
        if outcome.status == "skipped":
            stats["skipped_budget"] += 1
            continue
        stats["companies_attempted"] += 1
        if outcome.status == "error":
            stats["errors"] += 1
            continue
        if outcome.status == "timeout":
            stats["timeouts"] += 1
            if not record_timeouts:
                continue
        try:
            if outcome.status in ("ok", "provisional"):
                provisional = outcome.status == "provisional"
                path, replaced = _store(
                    db, plan.display, outcome.result, plan.names, provisional=provisional
                )
                if path:
                    stats["stored"] += 1
                    stats["provisional"] += provisional
                    stats["rows_updated"] += replaced
                    continue
            skipped = outcome.status == "retry"
            record_miss(db, plan.display, rejected_domains=outcome.bogus, names=plan.names,
                        linkedin_skipped=skipped)
            stats["missed"] += 1
            stats["linkedin_deferred"] += skipped
            stats["domains_rejected"] += len(outcome.bogus)
        except Exception:
            db.rollback()
            logger.exception("logo store failed for %r", plan.display)
            stats["errors"] += 1


async def harvest_missing_logos(
    db: Session,
    client,
    *,
    budget_s: float = HARVEST_BUDGET_S,
    concurrency: int = HARVEST_CONCURRENCY,
    max_companies: int = HARVEST_MAX_COMPANIES,
) -> dict:
    """One bounded harvest pass: re-point rows at logos already stored, then
    harvest employers that have visible rows and no stored logo (most rows
    first, misses only once their backoff is due) with bounded concurrency
    inside a wall-clock budget. Network happens concurrently; every DB write
    happens afterwards, sequentially (the Session is not task safe).

    The harvester's own per-company cap (logo_harvester.HARVEST_TIME_CAP)
    ends a slow company first and reads as a miss here (retried after the
    backoff); HARVEST_PER_COMPANY_TIMEOUT_S is the backstop around it.

    A LinkedIn 429 makes the harvester skip LinkedIn for the rest of the run
    (LINKEDIN_BLOCK_COOLDOWN is None here); what finished after that is
    written through after_linkedin_block, so no lower-tier pick is final
    before LinkedIn had its say."""
    stats = new_harvest_stats()
    try:
        from backend.services.logo_harvester import (
            LogoHints,
            harvest_company_logo,
            linkedin_stats,
        )
    except ImportError:  # the harvester contract is not deployed yet
        stats["harvester_available"] = False
        return stats

    names_by_key = company_names_by_key(db)
    stats["repropagated_rows"] = repropagate_known_logos(db, names_by_key)

    plans = plan_harvest(db, names_by_key, LogoHints, limit=max_companies)
    stats["companies_considered"] = len(plans)
    # The reads are done: end the transaction before up to HARVEST_BUDGET_S
    # of network work, or the pooled connection sits idle in transaction
    # (holding locks that queue DDL behind it). apply_outcomes checks out a
    # fresh one. commit, not rollback: nothing of ours is pending, and a
    # caller's unflushed change would have been committed by our next write.
    db.commit()
    if not plans:
        return stats

    finished: dict[str, float] = {}

    def mark(outcome: HarvestOutcome) -> None:
        finished[outcome.plan.key] = time.monotonic()

    outcomes = await run_harvest(
        client, plans, harvest_company_logo, budget_s=budget_s, concurrency=concurrency,
        on_done=mark,
    )
    linkedin = linkedin_stats(client)
    if linkedin["blocked"]:
        outcomes = after_linkedin_block(outcomes, finished, linkedin["blocked_at"])
    apply_outcomes(db, outcomes, stats)
    return stats
