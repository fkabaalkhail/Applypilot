"""Shared helpers for dashboard job list filtering."""

from __future__ import annotations

import datetime

# UI filter values → stored experience_level spellings in scraped_jobs.
EXPERIENCE_FILTER_MAP: dict[str, list[str]] = {
    "intern_new_grad": ["internship", "new_grad", "intern_new_grad"],
    "entry": ["new_grad", "entry", "internship"],
    "mid": ["mid", "associate"],
    "senior": ["senior", "sr"],
    "lead": ["lead", "staff", "principal"],
    "director": ["director", "executive", "vp"],
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
