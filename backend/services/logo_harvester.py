"""
Server-side logo harvesting for companies whose favicon is tiny or missing.

Two free, attribution-safe sources, tried in order:
1. The company homepage's own icon declarations (apple-touch-icon, og:image,
   large rel=icon) — the source of truth when present.
2. Wikidata's logo claim (P154) rendered through Wikimedia Commons — covers
   large public companies (Agnico Eagle, Textron, …) whose sites only ship a
   16px favicon.

Every candidate is downloaded and its pixel width decoded from the bytes; only
images >= MIN_WIDTH are accepted, so a harvested URL can never be an upscaled
blur. Callers store the winning URL in scraped_jobs.company_logo, where the
frontend chain prefers it over favicon services.
"""

from __future__ import annotations

import logging
import re
import struct
from urllib.parse import quote, urljoin

import httpx

logger = logging.getLogger(__name__)

MIN_WIDTH = 64
_MAX_IMAGE_BYTES = 1_500_000

_HARVEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en",
}

_ICON_LINK = re.compile(
    r'<link[^>]+rel=["\'](?P<rel>[^"\']*(?:apple-touch-icon|icon)[^"\']*)["\'][^>]*>',
    re.IGNORECASE,
)
_HREF = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
_SIZES = re.compile(r'sizes=["\'](\d+)x\d+["\']', re.IGNORECASE)
_OG_IMAGE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']'
    r'|<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
    re.IGNORECASE,
)


def image_width(data: bytes) -> int:
    """Pixel width decoded from raw bytes (PNG/JPEG/ICO/GIF); 0 if unknown."""
    if len(data) < 24:
        return 0
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">I", data[16:20])[0]
    if data[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                return struct.unpack(">H", data[i + 7:i + 9])[0]
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
        return 0
    if data[:4] == b"\x00\x00\x01\x00" and len(data) > 6:
        width = data[6]
        return 256 if width == 0 else width
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<H", data[6:8])[0]
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return MIN_WIDTH  # good enough: webp logos are never 16px favicons
    return 0


async def _probe(client: httpx.AsyncClient, url: str) -> int:
    """Download an image candidate and return its width (0 on any failure)."""
    try:
        resp = await client.get(url, headers=_HARVEST_HEADERS)
        if resp.status_code != 200 or len(resp.content) > _MAX_IMAGE_BYTES:
            return 0
        return image_width(resp.content)
    except Exception:
        return 0


def _homepage_candidates(html: str, base_url: str) -> list[str]:
    """Icon URLs declared by a homepage, best-first."""
    touch: list[tuple[int, str]] = []
    plain: list[tuple[int, str]] = []
    for link in _ICON_LINK.finditer(html):
        href_m = _HREF.search(link.group(0))
        if not href_m:
            continue
        url = urljoin(base_url, href_m.group(1))
        size_m = _SIZES.search(link.group(0))
        size = int(size_m.group(1)) if size_m else 0
        if "apple-touch" in link.group("rel").lower():
            touch.append((size or 180, url))
        else:
            plain.append((size, url))
    og = _OG_IMAGE.search(html)
    og_urls = [urljoin(base_url, og.group(1) or og.group(2))] if og else []
    ordered = [u for _, u in sorted(touch, reverse=True)]
    ordered += og_urls
    ordered += [u for _, u in sorted(plain, reverse=True) if _ != 0 and _ >= MIN_WIDTH]
    ordered += [u for _, u in sorted(plain, reverse=True) if _ == 0]
    seen: set[str] = set()
    return [u for u in ordered if not (u in seen or seen.add(u))][:4]


async def harvest_from_homepage(client: httpx.AsyncClient, domain: str) -> str:
    """Best >=64px icon a company's own homepage declares, or ''."""
    for base in (f"https://www.{domain}/", f"https://{domain}/"):
        try:
            resp = await client.get(base, headers=_HARVEST_HEADERS)
        except Exception:
            continue
        if resp.status_code != 200:
            continue
        for candidate in _homepage_candidates(resp.text, str(resp.url)):
            if await _probe(client, candidate) >= MIN_WIDTH:
                return candidate
        return ""
    return ""


async def harvest_from_wikidata(client: httpx.AsyncClient, company: str) -> str:
    """Wikidata P154 logo (rendered via Commons at 256px), or ''.

    Precision guard: the matched entity's label must start with the company
    name's first word — a wrong logo is worse than a letter avatar.
    """
    company = (company or "").strip()
    if len(company) < 3:
        return ""
    first_word = company.lower().split()[0]
    try:
        search = await client.get(
            "https://www.wikidata.org/w/api.php",
            params={
                "action": "wbsearchentities", "search": company,
                "language": "en", "type": "item", "limit": 5, "format": "json",
            },
            headers=_HARVEST_HEADERS,
        )
        hits = search.json().get("search", [])
    except Exception:
        return ""
    for hit in hits:
        label = (hit.get("label") or "").lower()
        if not label.startswith(first_word):
            continue
        try:
            claims_resp = await client.get(
                "https://www.wikidata.org/w/api.php",
                params={
                    "action": "wbgetclaims", "entity": hit["id"],
                    "property": "P154", "format": "json",
                },
                headers=_HARVEST_HEADERS,
            )
            claims = claims_resp.json().get("claims", {}).get("P154", [])
        except Exception:
            continue
        if not claims:
            continue
        try:
            filename = claims[0]["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
        url = (
            "https://commons.wikimedia.org/wiki/Special:FilePath/"
            + quote(filename) + "?width=256"
        )
        if await _probe(client, url) >= MIN_WIDTH:
            return url
    return ""


async def harvest_logo(client: httpx.AsyncClient, domain: str, company: str) -> str:
    """Best real logo URL for a company, or '' when none can be verified."""
    logo = await harvest_from_homepage(client, domain) if domain else ""
    if not logo:
        logo = await harvest_from_wikidata(client, company)
    return logo
