"""
Company registry loader — single source of truth for ATS boards to scrape.

The canonical registry lives in ``backend/data/ats_companies.json`` and ships
with the backend package (so it is available in serverless deploys). Each entry:

    {
      "company_name": "Shopify",
      "ats_platform": "lever",
      "board_slug": "shopify",
      "company_logo_url": "https://...",
      "enabled": true
    }

To add coverage, edit that JSON file — no code changes required.
"""

from __future__ import annotations

import json
import logging
import os
from functools import lru_cache

logger = logging.getLogger(__name__)

# Platforms the ATS scraper can actually fetch today. Entries on other
# platforms (e.g. workday, which needs a tenant host) are kept in the registry
# for reference but skipped by the scraper until support is added.
SUPPORTED_PLATFORMS = {"greenhouse", "lever", "ashby", "smartrecruiters"}

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

        key = (platform, slug)
        if key in seen:
            continue
        seen.add(key)
        out.append((platform, slug, name))

    return out


def load_workday_boards(include_disabled: bool = False) -> list[tuple[str, str, str]]:
    """Return enabled Workday boards that carry a usable CXS URL template.

    Workday is not part of :data:`SUPPORTED_PLATFORMS` because it needs a
    per-tenant host + site path that the generic ``(platform, slug, name)``
    tuple can't express. This loader returns the extra piece the scraper needs:

        (board_slug, company_name, cxs_base)

    where ``cxs_base`` is the Workday CXS API base
    (``https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}``)
    taken from each entry's ``workday_url_template``, with any trailing ``/`` or
    ``/jobs`` stripped so callers can safely append ``/jobs``. Entries without a
    template are skipped (the scraper has no way to reach them). Deduplicates on
    ``cxs_base``.
    """
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()

    for entry in _load_raw():
        try:
            platform = (entry.get("ats_platform") or "").strip().lower()
            slug = (entry.get("board_slug") or "").strip()
            name = (entry.get("company_name") or "").strip()
            template = (entry.get("workday_url_template") or "").strip()
            enabled = entry.get("enabled", True)
        except AttributeError:
            continue

        if platform != "workday" or not slug or not name or not template:
            continue
        if not include_disabled and not enabled:
            continue

        base = template.rstrip("/")
        if base.lower().endswith("/jobs"):
            base = base[: -len("/jobs")]
        if "/wday/cxs/" not in base:
            # Not a CXS endpoint we know how to call; skip rather than 404.
            continue
        if base in seen:
            continue
        seen.add(base)
        out.append((slug, name, base))

    return out


def load_logo_map() -> dict[str, str]:
    """Return {company_name_lower: company_logo_url} for enrichment."""
    return {
        (e.get("company_name") or "").strip().lower(): (e.get("company_logo_url") or "")
        for e in _load_raw()
        if e.get("company_name")
    }
