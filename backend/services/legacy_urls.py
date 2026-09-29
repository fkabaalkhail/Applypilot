"""Stored apply URLs that no longer reach their posting, and their repair.

SmartRecruiters: rows stored before the crawl's URL fix point at
careers.smartrecruiters.com/<Company>/<id>, which now redirects to the
company's careers home (Bosch: jobs.bosch.com/en) while the posting is still
open at jobs.smartrecruiters.com/<Company>/<id>, the URL cron-ats builds
today. cron-ats migrates a legacy row only when its board's crawl lists the
posting (github_sources._migrate_smartrecruiters_urls), and the page-capped
crawl of a huge board (BoschGroup) never lists most of them, so cron-backfill
migrates the rest from the URL alone (migrate_legacy_smartrecruiters), and
the API hands out the posting URL for any row still waiting (apply_url).
"""

import logging
import re

from sqlalchemy.orm import Session

from backend.db.models import ScrapedJob
from backend.services.ats_scraper import (
    SMARTRECRUITERS_LEGACY_BASE,
    SMARTRECRUITERS_POSTING_BASE,
    smartrecruiters_legacy_url,
)
from backend.services.cross_source_dedup import effective_source, stands_in_for_twins

logger = logging.getLogger(__name__)

MIGRATE_LEGACY_SR_LIMIT = 500

# <Company>/<posting id>: the company's page alone is not a posting.
_LEGACY_POSTING_RE = re.compile(re.escape(SMARTRECRUITERS_LEGACY_BASE) + r"[^/?#]+/[^/?#]+")


def smartrecruiters_posting_url(url: str) -> str:
    """careers.smartrecruiters.com/<Company>/<id> → the jobs.smartrecruiters.com
    posting URL, or "" for any other URL. The exact inverse of
    ats_scraper.smartrecruiters_legacy_url, so a row this rewrites is the row
    cron-ats would have rewritten had its crawl listed the posting."""
    if not _LEGACY_POSTING_RE.match(url or ""):
        return ""
    posting = SMARTRECRUITERS_POSTING_BASE + url[len(SMARTRECRUITERS_LEGACY_BASE):]
    return posting if smartrecruiters_legacy_url(posting) == url else ""


def apply_url(url: str) -> str:
    """Where to send an applicant: a legacy SmartRecruiters row's posting
    page, any other URL unchanged. Never written back (see the migration)."""
    return smartrecruiters_posting_url(url) or url


def migrate_legacy_smartrecruiters(db: Session, limit: int = MIGRATE_LEGACY_SR_LIMIT) -> dict:
    """Point legacy SmartRecruiters rows at their posting page, crawl or not.

    DB-only and bounded: a column-only SELECT of at most ``limit`` unhidden
    rows on the legacy host (an index range scan on the url prefix), one of
    the rows already holding their new URLs (url is UNIQUE), then one UPDATE
    per row by id. A row whose new URL is free takes it. A row whose new URL
    another row holds becomes that row's hidden twin (duplicate_of), so saved
    jobs and applications that reference it still resolve, but only behind a
    board row (effective source 'ats') that is itself unhidden and may stand
    in for it (cross_source_dedup.stands_in_for_twins). Never behind a
    GitHub-list or LinkedIn/Indeed copy, even a live one: nothing releases a
    board row once that copy expires (release_from_closed_winners frees only
    aggregator rows, release_list_copies_of_lapsed_board_rows only list
    copies), so the posting would leave the feed for good. Nor behind a row
    hidden behind it. Such a row keeps its URL (``blocked``) and apply_url
    still sends applicants to the posting. Commits when it changes anything.
    Returns counts.
    """
    stats = {"checked": 0, "migrated": 0, "hidden_as_twin": 0, "blocked": 0}
    rows = (
        db.query(ScrapedJob.id, ScrapedJob.url)
        .filter(
            ScrapedJob.url.like(SMARTRECRUITERS_LEGACY_BASE + "%/%"),
            ScrapedJob.duplicate_of.is_(None),
        )
        .order_by(ScrapedJob.id.asc())
        .limit(limit)
        .all()
    )
    stats["checked"] = len(rows)
    wanted = {row_id: smartrecruiters_posting_url(url) for row_id, url in rows}
    wanted = {row_id: url for row_id, url in wanted.items() if url}
    if not wanted:
        return stats

    holders = {
        url: (holder_id, duplicate_of, listing_status, source_platform)
        for holder_id, url, duplicate_of, listing_status, source_platform in (
            db.query(ScrapedJob.id, ScrapedJob.url, ScrapedJob.duplicate_of,
                     ScrapedJob.listing_status, ScrapedJob.source_platform)
            .filter(ScrapedJob.url.in_(sorted(set(wanted.values()))))
            .all()
        )
    }
    for row_id, new_url in wanted.items():
        holder = holders.get(new_url)
        if holder is None:
            values = {"url": new_url}
            stats["migrated"] += 1
        else:
            holder_id, duplicate_of, listing_status, source_platform = holder
            if (duplicate_of is not None
                    or effective_source(source_platform or "", new_url) != "ats"
                    or not stands_in_for_twins(listing_status, source_platform or "", new_url)):
                stats["blocked"] += 1
                continue
            values = {"duplicate_of": holder_id}
            stats["hidden_as_twin"] += 1
        db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
            values, synchronize_session=False,
        )
    if stats["migrated"] or stats["hidden_as_twin"]:
        db.commit()
        logger.info("migrate_legacy_smartrecruiters: %s", stats)
    return stats
