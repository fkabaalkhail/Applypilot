"""Shared helpers for dashboard job list filtering."""

from __future__ import annotations

import datetime

# UI filter values → stored experience_level spellings in scraped_jobs.
#
# The catalogue only ever contains "internship" and "new_grad" (jobs are seeded from
# GitHub internship / new-grad repos), so the UI now uses those spellings directly and
# the canonical entries are identities.
#
# The legacy keys are the pre-2026-07 taxonomy. They are kept so a stale client, an
# open tab, or a bookmarked /jobs?experience_level=… URL still resolves. Legacy
# "mid"/"senior"/"lead"/"director" are intentionally absent: they never matched a row,
# and the fall-through below expands an unknown key to itself, which keeps their
# behaviour (zero results) exactly as it was.
EXPERIENCE_FILTER_MAP: dict[str, list[str]] = {
    "internship": ["internship"],
    "new_grad": ["new_grad"],
    "intern_new_grad": ["internship", "new_grad"],
    "entry": ["new_grad", "internship"],
}


def expand_experience_filter_values(levels: list[str]) -> list[str]:
    """Expand UI experience filters to DB values (OR within the filter)."""
    out: set[str] = set()
    for level in levels:
        key = (level or "").strip().lower()
        if not key:
            continue
        mapped = EXPERIENCE_FILTER_MAP.get(key)
        if mapped:
            out.update(mapped)
        else:
            out.add(key)
    return sorted(out)


def date_posted_cutoff(value: str) -> datetime.datetime | None:
    """Return UTC cutoff for a date_posted filter token."""
    token = (value or "").strip().lower()
    if not token:
        return None
    now = datetime.datetime.utcnow()
    if token == "24h":
        return now - datetime.timedelta(hours=24)
    if token == "3d":
        return now - datetime.timedelta(days=3)
    if token == "week":
        return now - datetime.timedelta(days=7)
    if token == "month":
        return now - datetime.timedelta(days=30)
    return None
