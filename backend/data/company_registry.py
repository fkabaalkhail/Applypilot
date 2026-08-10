"""
Company registry loader, single source of truth for ATS boards to scrape.

The canonical registry lives in ``backend/data/ats_companies.json`` and ships
with the backend package (so it is available in serverless deploys). Each entry:

    {
      "company_name": "Shopify",
      "ats_platform": "lever",
      "board_slug": "shopify",
      "company_logo_url": "https://...",
      "enabled": true
    }

To add coverage, edit that JSON file, no code changes required.
"""

from __future__ import annotations

import json
import logging
import os
import zlib
from functools import lru_cache

logger = logging.getLogger(__name__)

# Platforms the ATS scraper can actually fetch today. Workday entries are
# supported only when they carry a ``workday_url_template`` (the tenant's CxS
# endpoint base), the tenant host/site can't be derived from a bare slug, so
# template-less workday entries stay listed but unscraped.
SUPPORTED_PLATFORMS = {"greenhouse", "lever", "ashby", "smartrecruiters", "workday"}

# One cron-ats invocation scrapes its whole slice inside a single Vercel
# request capped at 300 s by the workflow. This is roughly how many boards
# fit that budget with headroom.
CRON_ATS_SHARD_TARGET = 150

_REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "ats_companies.json")


@lru_cache(maxsize=1)
def _load_raw() -> list[dict]:
    """Load and cache the raw registry entries from disk."""
    try:
        with open(_REGISTRY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        companies = data.get("companies", [])
        if not isinstance(companies, list):
            logger.error("ats_companies.json: 'companies' is not a list")
            return []
        return companies
    except FileNotFoundError:
        logger.error("Registry file not found at %s", _REGISTRY_PATH)
        return []
    except (json.JSONDecodeError, OSError) as e:
        logger.error("Failed to load registry: %s", e)
        return []


def load_companies(
    include_disabled: bool = False,
    supported_only: bool = True,
) -> list[tuple[str, str, str]]:
    """Return registry entries as (platform, slug, company_name) tuples.

    Args:
        include_disabled: include entries with ``enabled: false``.
        supported_only: only return platforms the scraper can fetch.

    Deduplicates on (platform, slug). Skips malformed rows.
    """
    out: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    for entry in _load_raw():
        try:
            platform = (entry.get("ats_platform") or "").strip().lower()
            slug = (entry.get("board_slug") or "").strip()
            name = (entry.get("company_name") or "").strip()
            enabled = entry.get("enabled", True)
        except AttributeError:
            continue

        if not platform or not slug or not name:
            continue
        if not include_disabled and not enabled:
            continue
        if supported_only and platform not in SUPPORTED_PLATFORMS:
            continue
        if supported_only and platform == "workday" and not (
            entry.get("workday_url_template") or ""
        ).strip():
            continue

        key = (platform, slug)
        if key in seen:
            continue
        seen.add(key)
        out.append((platform, slug, name))

    return out


def shard_for_hour(
    companies: list[tuple[str, str, str]],
    hour: int,
) -> tuple[int, int, list[tuple[str, str, str]]]:
    """Return (shard_index, shard_count, subset) for this hour's cron run.

    Shard count comes from ``CRON_ATS_SHARDS`` when set, otherwise it is sized
    so a run scrapes ~CRON_ATS_SHARD_TARGET companies. Assignment hashes the
    board slug with crc32, Python's ``hash()`` is salted per process, and the
    assignment must be stable across serverless invocations so every board
    lands in exactly one shard and gets refreshed every ``shard_count`` hours.
    """
    shard_count = 0
    raw = os.getenv("CRON_ATS_SHARDS", "").strip()
    if raw:
        try:
            shard_count = int(raw)
        except ValueError:
            logger.warning("CRON_ATS_SHARDS=%r is not an integer; ignoring", raw)
    if shard_count < 1:
        shard_count = max(1, -(-len(companies) // CRON_ATS_SHARD_TARGET))

    shard_index = hour % shard_count
    if shard_count == 1:
        return 0, 1, list(companies)

    subset = [
        entry
        for entry in companies
        if zlib.crc32(entry[1].lower().encode("utf-8")) % shard_count == shard_index
    ]
    return shard_index, shard_count, subset


def load_workday_bases() -> dict[str, str]:
    """Return {board_slug: CxS endpoint base} for workday entries that carry a
    ``workday_url_template``, the connector can't fetch a tenant without it."""
    out: dict[str, str] = {}
    for entry in _load_raw():
        if (entry.get("ats_platform") or "").strip().lower() != "workday":
            continue
        slug = (entry.get("board_slug") or "").strip()
        template = (entry.get("workday_url_template") or "").strip()
        if slug and template:
            out[slug] = template.rstrip("/")
    return out


def load_logo_map() -> dict[str, str]:
    """Return {company_name_lower: company_logo_url} for enrichment."""
    return {
        (e.get("company_name") or "").strip().lower(): (e.get("company_logo_url") or "")
        for e in _load_raw()
        if e.get("company_name")
    }
