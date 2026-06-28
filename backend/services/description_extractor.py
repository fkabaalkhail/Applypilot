"""
Job description extraction from apply URLs.

Follows redirects (Simplify, company career pages, etc.) and tries ATS APIs
first, then structured data, then HTML fallbacks.
"""

from __future__ import annotations

import json
import logging
import re
from html import unescape
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

MAX_DESC_LEN = 6000


def sanitize_description(text: str) -> str:
    """Strip HTML from job descriptions to prevent stored XSS."""
    import nh3
    return nh3.clean(text, tags=set())


def workday_cxs_url(public_url: str) -> str:
    """Convert a public Workday job URL into its CXS detail-API endpoint."""
    m = re.match(r"(https://([^.]+)\.[^/]*myworkdayjobs\.com)(/.*)", public_url)
    if not m:
        return ""
    host_root, tenant, path = m.group(1), m.group(2), m.group(3)
    idx = path.find("/job/")
    if idx == -1:
        return ""
    segments = [s for s in path[:idx].split("/") if s]
    if segments and re.match(r"^[a-z]{2}-[A-Za-z]{2}$", segments[0]):
        segments = segments[1:]
    if not segments:
        return ""
    site = segments[0]
    external_path = path[idx:]
    return f"{host_root}/wday/cxs/{tenant}/{site}{external_path}"


def compose_jobright_description(job_result: dict[str, Any]) -> str:
    """Build plain text from a jobright.ai jobResult payload."""

    def _clean(value: str) -> str:
        value = re.sub(r"<[^>]+>", " ", value or "")
        value = value.replace("\u2022", " ").strip()
        return re.sub(r"\s{2,}", " ", value)

    def _as_bullets(value: Any) -> list[str]:
        items: list[str] = []
        if isinstance(value, list):
            items = [str(v) for v in value]
        elif isinstance(value, str) and value.strip():
            items = re.split(r"[\n\u2022]+", value)
        return [b for b in (_clean(i) for i in items) if b]

    sections: list[str] = []
    summary = _clean(job_result.get("jobSummary", "") if isinstance(job_result.get("jobSummary"), str) else "")
    if summary:
        sections.append(summary)

    responsibilities = _as_bullets(job_result.get("coreResponsibilities"))
    if responsibilities:
        sections.append("Responsibilities:\n" + "\n".join(f"• {b}" for b in responsibilities))

    qualifications = _as_bullets(job_result.get("qualifications")) or _as_bullets(
        job_result.get("detailQualifications")
    )
    if qualifications:
        sections.append("Qualifications:\n" + "\n".join(f"• {b}" for b in qualifications))

    return "\n\n".join(sections).strip()


def _clean_html(html: str) -> str:
    text = re.sub(r"<[^>]+>", "\n", unescape(html or ""))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _cap(text: str) -> str:
    text = text.strip()
    return text[:MAX_DESC_LEN] if len(text) > MAX_DESC_LEN else text


async def _get_json(client: httpx.AsyncClient, api_url: str) -> dict[str, Any] | None:
    try:
        resp = await client.get(api_url, headers={"Accept": "application/json"})
        if resp.status_code == 200:
            data = resp.json()
            return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None


def _urls_blob(original_url: str, final_url: str) -> str:
    return f"{original_url or ''} {final_url or ''}"


def _is_job_posting(item: dict[str, Any]) -> bool:
    job_type = item.get("@type")
    if job_type == "JobPosting":
        return True
    if isinstance(job_type, list):
        return "JobPosting" in job_type
    return False


def _iter_json_ld_job_postings(html: str) -> list[dict[str, Any]]:
    postings: list[dict[str, Any]] = []
    for blk in re.findall(
        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    ):
        try:
            data = json.loads(blk)
        except (json.JSONDecodeError, TypeError):
            continue
        candidates: list[Any]
        if isinstance(data, list):
            candidates = data
        elif isinstance(data, dict):
            if _is_job_posting(data):
                candidates = [data]
            elif isinstance(data.get("@graph"), list):
                candidates = data["@graph"]
            else:
                candidates = [data]
        else:
            continue
        for item in candidates:
            if isinstance(item, dict) and _is_job_posting(item):
                postings.append(item)
    return postings


def _greenhouse_slug_candidates(original_url: str, final_url: str, blob: str, html: str) -> list[str]:
    from urllib.parse import urlparse

    slugs: list[str] = []
    seen: set[str] = set()

    def add(slug: str) -> None:
        slug = (slug or "").strip()
        if slug and slug not in seen:
            seen.add(slug)
            slugs.append(slug)

    for param in re.finditer(r"[?&]for=([^&]+)", blob):
        add(param.group(1))

    for m in re.finditer(r"boards-api\.greenhouse\.io/v1/boards/([^/\"'\s]+)", html):
        add(m.group(1))
    for m in re.finditer(r'greenhouse\.io/embed/job_app\?for=([^&"\']+)', html):
        add(m.group(1))
    for m in re.finditer(r'"boardToken"\s*:\s*"([^"]+)"', html):
        add(m.group(1))

    for url in (final_url, original_url):
        host = urlparse(url).hostname or ""
        if not host or "greenhouse.io" in host:
            continue
        add(host.removeprefix("www.").split(".")[0])

    return slugs


async def _fetch_greenhouse_job(
    client: httpx.AsyncClient, slug: str, job_id: str
) -> str:
    data = await _get_json(
        client,
        f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{job_id}",
    )
    if data and data.get("content"):
        text = _clean_html(data["content"])
        if len(text) > 50:
            return _cap(text)
    return ""


async def _extract_greenhouse(
    client: httpx.AsyncClient,
    original_url: str,
    final_url: str,
    blob: str,
    html: str,
) -> str:
    patterns = [
        r"boards(?:-api)?\.greenhouse\.io/(?:v1/boards/)?([^/]+)/jobs/(\d+)",
        r"job-boards\.greenhouse\.io/([^/]+)/jobs/(\d+)",
        r"boards\.greenhouse\.io/([^/]+)/jobs/(\d+)",
        r"greenhouse\.io/embed/job_app\?for=([^&]+)&token=(\d+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, blob)
        if m:
            text = await _fetch_greenhouse_job(client, m.group(1), m.group(2))
            if text:
                return text

    gh_jid = re.search(r"[?&]gh_jid=(\d+)", blob)
    if gh_jid:
        job_id = gh_jid.group(1)
        for slug in _greenhouse_slug_candidates(original_url, final_url, blob, html):
            text = await _fetch_greenhouse_job(client, slug, job_id)
            if text:
                return text

    api_ref = re.search(
        r"boards-api\.greenhouse\.io/v1/boards/([^/]+)/jobs/(\d+)",
        html,
    )
    if api_ref:
        text = await _fetch_greenhouse_job(client, api_ref.group(1), api_ref.group(2))
        if text:
            return text

    return ""


async def _extract_lever(client: httpx.AsyncClient, blob: str) -> str:
    m = re.search(r"(?:jobs\.)?lever\.co/([^/]+)/([a-f0-9-]{8,})", blob, re.IGNORECASE)
    if not m:
        return ""
    data = await _get_json(client, f"https://api.lever.co/v0/postings/{m.group(1)}/{m.group(2)}")
    if not data:
        return ""
    text = data.get("descriptionPlain") or _clean_html(data.get("description", ""))
    for lst in data.get("lists", []) or []:
        title = lst.get("text", "")
        content = _clean_html(lst.get("content", ""))
        if content:
            text += f"\n\n{title}\n{content}"
    text = text.strip()
    return _cap(text) if len(text) > 50 else ""


async def _extract_workday(client: httpx.AsyncClient, blob: str, final_url: str) -> str:
    if "myworkdayjobs.com" not in blob:
        return ""
    target = final_url if "myworkdayjobs.com" in final_url else ""
    if not target:
        m = re.search(r'https?://[^\s"\']+myworkdayjobs\.com[^\s"\']*', blob)
        target = m.group(0) if m else ""
    if not target:
        return ""
    cxs = workday_cxs_url(target)
    if not cxs:
        return ""
    data = await _get_json(client, cxs)
    if not data:
        return ""
    text = _clean_html((data.get("jobPostingInfo") or {}).get("jobDescription", ""))
    return _cap(text) if len(text) > 50 else ""


async def _extract_smartrecruiters(client: httpx.AsyncClient, blob: str) -> str:
    m = re.search(
        r"smartrecruiters\.com/([^/?#]+)/(\d{5,})",
        blob,
        re.IGNORECASE,
    )
    if not m:
        return ""
    company_id, posting_id = m.group(1), m.group(2)
    data = await _get_json(
        client,
        f"https://api.smartrecruiters.com/v1/companies/{company_id}/postings/{posting_id}",
    )
    if not data:
        return ""
    sections = (data.get("jobAd") or {}).get("sections", {}) or {}
    parts = [
        (sections.get(k) or {}).get("text", "")
        for k in ("companyDescription", "jobDescription", "qualifications", "additionalInformation")
    ]
    text = _clean_html("\n".join(p for p in parts if p))
    return _cap(text) if len(text) > 50 else ""


async def _extract_ashby(client: httpx.AsyncClient, blob: str) -> str:
    m = re.search(r"(?:jobs\.)?ashbyhq\.com/([^/?#]+)/([a-f0-9-]{8,})", blob, re.IGNORECASE)
    if not m:
        return ""
    org, posting_id = m.group(1), m.group(2)
    data = await _get_json(client, f"https://api.ashbyhq.com/posting-api/job-board/{org}")
    if not data:
        return ""
    for jd in data.get("jobs", []) or []:
        if posting_id in (jd.get("jobId", ""), jd.get("id", "")):
            text = _clean_html(jd.get("descriptionHtml") or jd.get("descriptionPlain") or "")
            return _cap(text) if len(text) > 50 else ""
    return ""


async def _extract_recruitee(client: httpx.AsyncClient, blob: str) -> str:
    m = re.search(r"https?://([^.]+)\.recruitee\.com/o/([^/?#]+)", blob)
    if not m:
        return ""
    data = await _get_json(client, f"https://{m.group(1)}.recruitee.com/api/offers/{m.group(2)}")
    if not data:
        return ""
    offer = data.get("offer") or {}
    text = _clean_html((offer.get("description") or "") + "\n" + (offer.get("requirements") or ""))
    return _cap(text) if len(text) > 50 else ""


async def _extract_workable(client: httpx.AsyncClient, blob: str) -> str:
    m = re.search(r"apply\.workable\.com/([^/]+)/j/([A-Za-z0-9]+)", blob)
    if not m:
        return ""
    account, shortcode = m.group(1), m.group(2)
    for api_url in (
        f"https://apply.workable.com/api/v1/jobs/{shortcode}",
        f"https://apply.workable.com/api/v3/accounts/{account}/jobs/{shortcode}",
    ):
        data = await _get_json(client, api_url)
        if not data:
            continue
        desc = data.get("description") or data.get("full_description") or ""
        if isinstance(desc, str) and desc.strip():
            text = _clean_html(desc)
            if len(text) > 50:
                return _cap(text)
    return ""


def _extract_linkedin_html(html: str) -> str:
    m = re.search(r"show-more-less-html__markup[^>]*>(.*?)</div>", html, re.DOTALL)
    if m:
        text = _clean_html(m.group(1))
        if len(text) > 50:
            return _cap(text)
    og = re.search(
        r'(?:og:description|name="description")[^>]*content="([^"]*)"',
        html,
        re.IGNORECASE,
    )
    if og:
        desc = og.group(1).strip()
        desc = re.sub(r"^Posted [^.]+\.\s*", "", desc)
        desc = re.sub(r"…See this and similar jobs on LinkedIn\.", "", desc)
        if len(desc) > 30:
            return _cap(desc)
    return ""


def _extract_next_data(html: str) -> str:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return ""
    try:
        next_data = json.loads(m.group(1))
    except (json.JSONDecodeError, TypeError):
        return ""
    job_result = (
        next_data.get("props", {}).get("pageProps", {}).get("dataSource", {}).get("jobResult", {})
    ) or {}
    if job_result:
        composed = compose_jobright_description(job_result)
        if len(composed) > 50:
            return _cap(composed)
    return ""


def _extract_json_ld(html: str) -> str:
    for posting in _iter_json_ld_job_postings(html):
        text = _clean_html(posting.get("description", ""))
        if len(text) > 50:
            return _cap(text)
    return ""


def _extract_generic_html(html: str) -> str:
    for posting in _iter_json_ld_job_postings(html):
        text = _clean_html(posting.get("description", ""))
        if len(text) > 50:
            return _cap(text)

    main = re.search(
        r'<(?:main|article|div\s+(?:class|id)="[^"]*(?:content|description|job|detail|posting)[^"]*")[^>]*>(.*?)</(?:main|article|div)>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if main:
        body = re.sub(r"<(?:script|style)[^>]*>.*?</(?:script|style)>", "", main.group(1), flags=re.DOTALL)
        text = _clean_html(body)
        if len(text) > 120:
            return _cap(text)

    meta = re.search(
        r'<meta\s+(?:name|property)="(?:description|og:description)"[^>]*content="([^"]*)"',
        html,
        re.IGNORECASE,
    )
    if meta and len(meta.group(1).strip()) > 80:
        return _cap(meta.group(1).strip())
    return ""


async def extract_description_from_html(
    client: httpx.AsyncClient,
    original_url: str,
    html: str,
    final_url: str,
) -> str:
    """Extract a job description from an already-fetched page."""
    blob = _urls_blob(original_url, final_url)

    if "linkedin.com/jobs" in blob:
        text = _extract_linkedin_html(html)
        if text:
            return text

    for extractor in (
        lambda: _extract_greenhouse(client, original_url, final_url, blob, html),
        lambda: _extract_lever(client, blob),
        lambda: _extract_workday(client, blob, final_url),
        lambda: _extract_smartrecruiters(client, blob),
        lambda: _extract_ashby(client, blob),
        lambda: _extract_recruitee(client, blob),
        lambda: _extract_workable(client, blob),
    ):
        text = await extractor()
        if text:
            return text

    text = _extract_next_data(html)
    if text:
        return text

    text = _extract_json_ld(html)
    if text:
        return text

    return _extract_generic_html(html)


async def extract_description_from_url(client: httpx.AsyncClient, url: str) -> str:
    """Fetch a job URL (following redirects) and extract its description."""
    if not url:
        return ""
    try:
        resp = await client.get(url, headers=BROWSER_HEADERS)
    except Exception as exc:
        logger.debug("Description fetch failed for %s: %s", url, exc)
        return ""
    return await extract_description_from_html(client, url, resp.text, str(resp.url))
