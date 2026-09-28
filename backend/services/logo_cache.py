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

Reads are column-only (Neon egress): logo bytes are only ever selected by the
serving endpoint, one row at a time.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import re
import socket
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

# cron-backfill Phase 3 budget. The "hourly" workflow really fires ~6x/day at
# irregular gaps, so each run has to make real progress on its own; busiest
# companies go first and the miss backoff rotates through the rest.
HARVEST_BUDGET_S = 150.0
HARVEST_CONCURRENCY = 6
HARVEST_MAX_COMPANIES = 150
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
    trailing legal suffixes dropped (never the last remaining word)."""
    text = re.sub(r"[^a-z0-9]+", " ", fold(clean_company_name(name)))
    tokens = text.split()
    while len(tokens) > 1 and tokens[-1] in _LEGAL_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


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
            )
            .filter(CompanyLogo.company_key.in_(chunk))
            .all()
        )
        for key, status, sha, fmt, domain, rejected in rows:
            logo = logo_path(sha, fmt or "png") if status == STATUS_OK and sha else ""
            out[key] = CompanyBranding(logo, domain or "", frozenset(rejected or ()))
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
    resolved; a guessed domain the harvester proved bogus is dropped, along
    with any favicon URL built from it."""
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
    if record.logo:
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


def propagate_logo(db: Session, company: str, *, names: list[str] | None = None) -> int:
    """Point every row of this employer (visible or hidden) at its stored
    logo, unless the row already has it or a trusted square hotlink; write
    the verified domain too. Returns the number of logos replaced. Commits."""
    key = company_key(company)
    record = (
        db.query(CompanyLogo.status, CompanyLogo.sha, CompanyLogo.fmt, CompanyLogo.domain)
        .filter(CompanyLogo.company_key == key)
        .first()
    ) if key else None
    if record is None or record.status != STATUS_OK or not record.sha:
        return 0
    path = logo_path(record.sha, record.fmt or "png")

    replaced = 0
    for chunk in _chunks(_names_for(db, company, names)):
        replaced += (
            db.query(ScrapedJob)
            .filter(ScrapedJob.company.in_(chunk), _replaceable_logo(path))
            .update({"company_logo": path}, synchronize_session=False)
        )
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


def _store(db: Session, company: str, result, names: list[str] | None) -> tuple[str, int]:
    key = company_key(company)
    logo = result.logo
    if not key or logo is None or not logo.sha or not logo.data:
        return "", 0
    fmt = "svg" if logo.fmt == "svg" else "png"
    now = _now()
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
        "attempts": 0,
        "checked_at": now,
        "next_retry_at": None,
        "updated_at": now,
    }
    if result.verified_domain:
        fields["domain"] = result.verified_domain.strip().lower()
    _upsert(db, key, fields)
    replaced = propagate_logo(db, company, names=names)
    return logo_path(logo.sha, fmt), replaced


def store_logo(db: Session, company: str, result, *, names: list[str] | None = None) -> str:
    """Save a harvested logo (a logo_harvester.HarvestResult) for this
    employer, then propagate it to the employer's rows. Returns the served
    path ('' when the result carries no usable image). Commits."""
    return _store(db, company, result, names)[0]


def retry_delay(attempts: int) -> datetime.timedelta:
    """Backoff before re-harvesting a company after `attempts` misses."""
    return min(RETRY_STEP * max(attempts, 1), RETRY_CAP)


def record_miss(
    db: Session,
    company: str,
    *,
    rejected_domains: Iterable[str] = (),
    names: list[str] | None = None,
) -> None:
    """Remember that nothing usable was found, and when to try again. Guessed
    domains proven bogus are cleared from the employer's rows (with the
    favicon URLs built from them) so the frontend stops rendering a parked
    domain's icon. A stored logo is never demoted by a later miss. Commits."""
    key = company_key(company)
    if not key:
        return
    row = (
        db.query(CompanyLogo.status, CompanyLogo.attempts, CompanyLogo.rejected_domains)
        .filter(CompanyLogo.company_key == key)
        .first()
    )
    if row is not None and row.status == STATUS_OK:
        return
    bogus = sorted({d.strip().lower() for d in rejected_domains if d})
    previous_attempts, previous_rejected = (
        (row.attempts or 0, set(row.rejected_domains or ())) if row is not None else (0, set())
    )
    attempts = previous_attempts + 1
    now = _now()
    _upsert(db, key, {
        "display_name": clean_company_name(company),
        "status": STATUS_MISS,
        "attempts": attempts,
        "rejected_domains": sorted(previous_rejected | set(bogus)),
        "checked_at": now,
        "next_retry_at": now + retry_delay(attempts),
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


# ─── cron-backfill Phase 3 ───────────────────────────────────────────────────

@dataclass
class _Plan:
    key: str
    display: str
    names: list[str]
    hints: object
    suspect_domains: list[str] = field(default_factory=list)


def repropagate_known_logos(db: Session, names_by_key: dict[str, list[str]]) -> int:
    """Rows planted with a generated or unverified logo after their employer's
    logo was stored (writers that don't consult the store) get it now. No
    network. Returns the number of rows updated."""
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
    for key in sorted(k for k, record in stored.items() if record.logo)[:_REPROPAGATE_MAX_COMPANIES]:
        names = names_by_key.get(key, [])
        if names:
            updated += propagate_logo(db, names[0], names=names)
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
    db: Session, names_by_key: dict[str, list[str]], limit: int
) -> tuple[list[tuple[str, str]], dict[str, tuple]]:
    """[(key, display name)] of employers with visible rows and no stored
    logo whose retry is due, most visible rows first; plus their records."""
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
        if not key:
            continue
        counts[key] += count
        spellings.setdefault(key, Counter())[name] += count

    records: dict[str, tuple] = {}
    for chunk in _chunks(sorted(counts)):
        for key, status, next_retry_at, domain, rejected in (
            db.query(
                CompanyLogo.company_key, CompanyLogo.status, CompanyLogo.next_retry_at,
                CompanyLogo.domain, CompanyLogo.rejected_domains,
            )
            .filter(CompanyLogo.company_key.in_(chunk))
            .all()
        ):
            records[key] = (status, next_retry_at, domain or "", set(rejected or ()))

    now = _now()
    due = [
        key for key in counts
        if key not in records
        or (records[key][0] != STATUS_OK
            and (records[key][1] is None or records[key][1] <= now))
    ]
    due.sort(key=lambda k: (-counts[k], k))
    picked = [
        (key, clean_company_name(spellings[key].most_common(1)[0][0]))
        for key in due[:limit]
    ]
    return picked, records


def _build_plans(db: Session, picked, records, names_by_key, hints_type) -> list[_Plan]:
    """Harvest hints per employer, from column-only reads: candidate domains
    (registry/verified first, company website, employer-hosted apply links,
    stored non-guess domains, the name guess last), a few job URLs (LinkedIn
    postings from any row, hidden duplicates included, then ATS/direct), and
    real logos already stored somewhere in the catalogue."""
    scope = {key: names_by_key.get(key) or [display] for key, display in picked}
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

    plans: list[_Plan] = []
    for key, display in picked:
        names = scope[key]
        _status, _retry, verified, rejected = records.get(key, (None, None, "", set()))
        guesses = {domain_from_name(n) for n in names} | {domain_from_name(display)}
        guesses.discard(None)

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

        trusted = {registry.get(key), verified, curated_domain(display)} | {
            domain_from_url(url) for name in names for url in company_urls.get(name, [])
        }
        suspects = [
            d for d, _count in stored.most_common()
            if d in guesses and d not in trusted and d not in rejected
        ]
        guess = domain_from_name(display)
        if guess and guess not in trusted and guess not in rejected and guess not in suspects:
            suspects.append(guess)

        plans.append(_Plan(
            key=key,
            display=display,
            names=names,
            hints=hints_type(
                company=display,
                domains=domains,
                job_urls=job_urls,
                existing_logo_urls=seeds.get(key, []),
            ),
            suspect_domains=suspects[:_SUSPECT_DOMAINS_PER_COMPANY],
        ))
    return plans


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
    happens afterwards, sequentially (the Session is not task safe)."""
    stats = {
        "harvester_available": True,
        "repropagated_rows": 0,
        "companies_considered": 0,
        "companies_attempted": 0,
        "stored": 0,
        "missed": 0,
        "errors": 0,
        "skipped_budget": 0,
        "rows_updated": 0,
        "domains_rejected": 0,
    }
    try:
        from backend.services.logo_harvester import LogoHints, harvest_company_logo
    except ImportError:  # the harvester contract is not deployed yet
        stats["harvester_available"] = False
        return stats

    names_by_key = company_names_by_key(db)
    stats["repropagated_rows"] = repropagate_known_logos(db, names_by_key)

    picked, records = _pick_companies(db, names_by_key, max_companies)
    stats["companies_considered"] = len(picked)
    if not picked:
        return stats
    plans = _build_plans(db, picked, records, names_by_key, LogoHints)

    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget_s
    semaphore = asyncio.Semaphore(concurrency)

    async def attempt(plan: _Plan):
        async with semaphore:
            remaining = deadline - loop.time()
            if remaining <= 1:
                return plan, "skipped", None, []
            cut_by_budget = remaining < HARVEST_PER_COMPANY_TIMEOUT_S
            try:
                result = await asyncio.wait_for(
                    harvest_company_logo(client, plan.hints),
                    timeout=min(remaining, HARVEST_PER_COMPANY_TIMEOUT_S),
                )
            except asyncio.TimeoutError:
                if cut_by_budget:
                    return plan, "skipped", None, []  # the run ran out, not the company
                result = None
            except Exception:
                logger.exception("logo harvest failed for %r", plan.display)
                return plan, "error", None, []
            if result is not None and getattr(result, "logo", None) is not None:
                return plan, "ok", result, []
            bogus = []
            for domain in plan.suspect_domains:
                if deadline - loop.time() <= 0:
                    break
                try:
                    if await asyncio.wait_for(domain_is_bogus(client, domain), timeout=15):
                        bogus.append(domain)
                except Exception:
                    continue
            return plan, "miss", None, bogus

    outcomes = await asyncio.gather(*[attempt(plan) for plan in plans])

    for plan, outcome, result, bogus in outcomes:
        if outcome == "skipped":
            stats["skipped_budget"] += 1
            continue
        stats["companies_attempted"] += 1
        if outcome == "error":
            stats["errors"] += 1
            continue
        try:
            if outcome == "ok":
                path, replaced = _store(db, plan.display, result, plan.names)
                if path:
                    stats["stored"] += 1
                    stats["rows_updated"] += replaced
                    continue
            record_miss(db, plan.display, rejected_domains=bogus, names=plan.names)
            stats["missed"] += 1
            stats["domains_rejected"] += len(bogus)
        except Exception:
            db.rollback()
            logger.exception("logo store failed for %r", plan.display)
            stats["errors"] += 1
    return stats
