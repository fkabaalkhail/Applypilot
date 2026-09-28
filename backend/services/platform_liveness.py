"""
Platform-aware listing liveness: is this posting still open?

A plain GET can't answer that for most of the catalogue. Workday serves the
same ~6.5 KB app shell (HTTP 200) for live, closed and made-up job ids;
SmartRecruiters' careers links 302 to the company careers home either way;
Ashby and Oracle HCM pages are SPAs. So every known ATS is asked through its
own public API, which answers honestly both ways, and only unknown hosts fall
back to the page itself, where a death signal (404/410, a redirect to an
error page, a "no longer available" message in the VISIBLE text) is trusted
but a bare 200 proves nothing.

Three verdicts:
  - ``dead``: the platform (or an honest page) says the posting is gone
  - ``alive``: the posting is open. ``authoritative`` only when the
    platform's own API/board said so, the one case allowed to revive a row
  - ``unknown``: bot walls (401/403/429/999), network noise, SPA shells,
    anything inconclusive. Never evidence either way.

The one 403 read as death is Workday's CXS JSON ``errorCode: "S22"``, an
API-level "posting unpublished" signal (85/85 agreement with a board search
by requisition id); a bot wall never answers with that JSON.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import time
from collections import defaultdict
from typing import NamedTuple
from urllib.parse import parse_qs, quote, unquote, urlparse

import httpx

from backend.services.description_extractor import BROWSER_HEADERS, workday_cxs_url

logger = logging.getLogger(__name__)

ALIVE = "alive"
DEAD = "dead"
UNKNOWN = "unknown"


class LivenessResult(NamedTuple):
    verdict: str  # 'alive' | 'dead' | 'unknown'
    reason: str  # short machine-ish reason, e.g. 'workday_cxs_S22', 'http_404'
    authoritative: bool = False  # the platform's own API/board said so


JSON_HEADERS = dict(BROWSER_HEADERS, Accept="application/json, text/plain, */*")

# Per request. The per-URL wall clock below also bounds slow-drip bodies,
# which a read timeout alone doesn't (it resets on every chunk).
REQUEST_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_PER_URL_SECONDS = 25.0

_PER_HOST_CONCURRENCY = 2
# Consecutive network errors / rate limits before a host is skipped for the
# rest of the run, one hanging career site must not eat the time box.
_HOST_FAILURE_LIMIT = 3

_MAX_HTML_BYTES = 600_000  # LinkedIn guest pages run ~350 KB
_MAX_JSON_BYTES = 12_000_000  # an Ashby board embeds every description

# Pages answering these are bot walls or rate limits, a real browser usually
# gets through, so they are never evidence of death.
BOT_WALL_STATUSES = (401, 403, 429, 999)
_RATE_LIMIT_STATUSES = (429, 999)
DEAD_HTTP_STATUSES = (404, 410)

# Phrases that appear only on a dead posting, matched against VISIBLE text
# (script/style/noscript/template stripped first, so an SPA bundle's i18n
# strings or a Next.js "This page could not be found" template can't trip
# them). Kept specific so a live page's boilerplate never matches: no bare
# "not found" / "page not found" (live Roblox and Lucid pages carry those),
# and "the job you're looking for" only with a gone-verb after it (career
# footers say "can't find the job you're looking for?").
DEAD_BODY_RE = re.compile(
    r"no longer accepting applications"
    r"|this (?:job|position|posting|role|requisition) is no longer (?:available|active|open)"
    r"|job (?:posting )?(?:is )?no longer (?:available|active|open)"
    # "not available" only when nothing qualifies it: a live posting may say
    # "this position is not available for relocation / to remote candidates".
    r"|this (?:job|position|requisition) (?:is )?(?:no longer|not) (?:available|accepting)"
    r"(?! (?:for|to|in|on|at|as|with|outside|remotely|remote)\b)"
    r"|(?:job|position|posting) (?:has been|has) (?:filled|closed)"
    r"|(?:job|posting) is closed"
    r"|position (?:has been )?(?:filled|closed)"
    r"|the job you(?:'re| are| were)? (?:looking for|requested) (?:is no longer|no longer exists"
    r"|has (?:been )?(?:expired|removed|closed|filled)|could not be found|was not found|does not exist)"
    r"|this posting has (?:closed|expired|been removed)"
    r"|this job has expired"
    r"|(?:job|posting|position) has expired"
    r"|career section unavailable",
    re.IGNORECASE,
)

# Live descriptions say "open until the position is filled"; strip those
# before the dead-phrase scan so they can't read as "position filled".
_BENIGN_FILLED_RE = re.compile(
    r"(?:until|till|once|after|before|when|unless)\s+(?:the\s+|this\s+)?"
    r"(?:position|job|role|posting|vacancy|opening)s?\s+"
    r"(?:is\s+|are\s+|has\s+been\s+|have\s+been\s+|gets\s+|has\s+)?(?:filled|closed)",
    re.IGNORECASE,
)

# LinkedIn's own closed markers: the "no longer accepting" figcaption class,
# and the trk token an expired job's redirect stamps into the nav links.
_LINKEDIN_DEAD_MARKERS = ("expired_jd_redirect", "closed-job__flavor--closed")
# A live guest page carries the apply CTA; a closed one keeps the top card
# but drops the button.
_LINKEDIN_LIVE_MARKERS = ("apply-button", "sign-up-modal__outlet")

# A redirect landing here means the posting was taken down.
_ERROR_URL_RE = re.compile(
    r"[?&](?:error|err)=(?:404|true)\b|[?&]errortype=404\b|/errorpage\b|/404(?:[/?#.]|$)",
    re.IGNORECASE,
)

_INVISIBLE_BLOCK_RE = re.compile(
    r"<(script|style|noscript|template)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL,
)
# A block the byte cap cut off mid-way has no closing tag; drop it to the end.
_UNCLOSED_BLOCK_RE = re.compile(
    r"<(?:script|style|noscript|template)\b.*\Z", re.IGNORECASE | re.DOTALL,
)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

_SR_PATH_RE = re.compile(
    r"^/([^/]+)/(\d{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_GH_BOARD_PATH_RE = re.compile(r"^/([^/]+)/jobs/(\d+)")
_LEVER_PATH_RE = re.compile(r"^/([^/]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                            re.IGNORECASE)
_ASHBY_PATH_RE = re.compile(r"^/([^/]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                            re.IGNORECASE)
_ORACLE_PATH_RE = re.compile(
    r"/hcmUI/CandidateExperience/(?:[^/]+/)*?sites/([^/?#]+)/"
    r"(?:job|jobs/job|jobs/preview|requisitions/preview)/(\d+)",
    re.IGNORECASE,
)
_WORKDAY_SITE_RE = re.compile(
    r"^https?://([^/]+\.myworkdaysite\.com)/(?:[a-z]{2}-[A-Za-z]{2}/)?recruiting/([^/]+)/([^/]+)(/job/.+)$",
)

# Hosts whose job pages sit on a career-site pattern: only for these does a
# redirect to another company's careers home read as "posting gone".
_CAREER_HOST_LABEL_RE = re.compile(r"^(?:careers?|jobs?|apply|join|talent|recruiting|hiring)\b",
                                   re.IGNORECASE)
_CAREER_PLATFORM_HOSTS = (
    "smartrecruiters.com", "bamboohr.com", "jobvite.com", "breezy.hr", "recruitee.com",
    "workable.com", "icims.com", "taleo.net", "successfactors.com", "successfactors.eu",
    "jazzhr.com", "applytojob.com", "teamtailor.com", "pinpointhq.com", "rippling-ats.com",
)
_HOME_SEGMENTS = {"careers", "career", "jobs", "join-us", "joinus", "opportunities",
                  "openings", "search", "job-search", "search-results"}
_LOCALE_SEGMENT_RE = re.compile(r"^[a-z]{2}(?:[-_][a-z]{2})?$", re.IGNORECASE)
_MULTI_PART_SUFFIXES = {"co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "co.in", "com.br",
                        "co.nz", "com.mx", "co.za", "com.sg", "com.cn", "com.hk", "co.kr"}
_JOB_QUERY_KEYS = ("gh_jid", "jobid", "job_id", "job", "jk", "id", "pid", "req", "reqid",
                   "requisitionid", "jobreqid")


# ─── HTTP plumbing ───────────────────────────────────────────────────────────

def make_client(**kw) -> httpx.AsyncClient:
    """An AsyncClient set up for liveness probing: browser-like headers,
    redirects followed, bounded timeouts. Keyword args override (tests pass
    ``transport=``)."""
    options = {
        "headers": dict(BROWSER_HEADERS),
        "follow_redirects": True,
        "timeout": REQUEST_TIMEOUT,
        "limits": httpx.Limits(max_connections=32, max_keepalive_connections=16),
    }
    options.update(kw)
    return httpx.AsyncClient(**options)


class _Page(NamedTuple):
    status: int
    url: str  # final URL after redirects
    text: str
    redirected: bool


class _RunState:
    """Per-run politeness and memo: at most _PER_HOST_CONCURRENCY requests in
    flight per host, hosts that keep failing get skipped, and an Ashby board
    is fetched once per org however many of its rows are checked."""

    def __init__(self):
        self.gates: dict[str, asyncio.Semaphore] = {}
        self.failures: dict[str, int] = defaultdict(int)
        self.ashby_boards: dict[str, asyncio.Task] = {}

    def gate(self, host: str) -> asyncio.Semaphore:
        if host not in self.gates:
            self.gates[host] = asyncio.Semaphore(_PER_HOST_CONCURRENCY)
        return self.gates[host]


_STATE_KEY = "__liveness_run_state__"


def _run_state(cache: dict | None) -> _RunState:
    if cache is None:
        return _RunState()
    state = cache.get(_STATE_KEY)
    if state is None:
        state = cache[_STATE_KEY] = _RunState()
    return state


async def _read_capped(response: httpx.Response, limit: int) -> str:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
        size += len(chunk)
        if size >= limit:
            break
    raw = b"".join(chunks)[:limit]
    try:
        return raw.decode(response.charset_encoding or "utf-8", errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


async def _get(client, url: str, state: _RunState, *, headers: dict,
               max_bytes: int = _MAX_HTML_BYTES) -> _Page | None:
    """One polite GET (redirects followed, body capped). None on network
    errors or when the host has been failing all run."""
    host = (urlparse(url).hostname or "").lower()
    async with state.gate(host):
        # checked inside the gate: requests queued behind a failing one see it
        if state.failures[host] >= _HOST_FAILURE_LIMIT:
            return None
        try:
            async with client.stream("GET", url, headers=headers, follow_redirects=True,
                                     timeout=REQUEST_TIMEOUT) as response:
                text = await _read_capped(response, max_bytes)
                page = _Page(response.status_code, str(response.url), text,
                             bool(response.history))
        except Exception as exc:
            state.failures[host] += 1
            logger.debug("liveness GET failed for %s: %s", url, exc)
            return None
    if page.status in _RATE_LIMIT_STATUSES:
        state.failures[host] += 1
    else:
        state.failures[host] = 0
    return page


def _json(page: _Page):
    try:
        return json.loads(page.text)
    except (ValueError, TypeError):
        return None


def visible_text(body: str, limit: int = _MAX_HTML_BYTES) -> str:
    """The text a user would actually see: invisible blocks, comments and
    tags stripped, entities decoded, whitespace collapsed."""
    text = _INVISIBLE_BLOCK_RE.sub(" ", body[:limit])
    text = _UNCLOSED_BLOCK_RE.sub(" ", text)
    text = _COMMENT_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    return _WS_RE.sub(" ", html.unescape(text)).strip()


def says_dead(body: str) -> bool:
    """True when the visible text of a page announces the posting is gone."""
    text = _BENIGN_FILLED_RE.sub(" ", visible_text(body))
    return bool(DEAD_BODY_RE.search(text))


def _unknown_for_status(status: int) -> LivenessResult:
    if status in BOT_WALL_STATUSES:
        return LivenessResult(UNKNOWN, f"bot_wall_{status}")
    return LivenessResult(UNKNOWN, f"http_{status}")


_NETWORK_ERROR = LivenessResult(UNKNOWN, "network_error")


# ─── Platform checks ─────────────────────────────────────────────────────────

def _workday_api_url(url: str) -> str:
    clean = url.split("#")[0].split("?")[0]
    if clean.startswith("http://"):
        clean = "https://" + clean[len("http://"):]
    api = workday_cxs_url(clean)
    if api:
        return api
    m = _WORKDAY_SITE_RE.match(clean)
    if m:
        return f"https://{m.group(1)}/wday/cxs/{m.group(2)}/{m.group(3)}{m.group(4)}"
    return ""


async def _check_workday(client, api_url: str, state: _RunState) -> LivenessResult:
    """Workday's CXS job endpoint: 200 + jobPostingInfo = open, errorCode S21
    (never existed) / S22 (unpublished) = gone. The public page can't tell."""
    page = await _get(client, api_url, state, headers=JSON_HEADERS, max_bytes=_MAX_JSON_BYTES)
    if page is None:
        return _NETWORK_ERROR
    data = _json(page)
    if page.status == 200:
        if isinstance(data, dict) and data.get("jobPostingInfo"):
            return LivenessResult(ALIVE, "workday_cxs_200", True)
        return LivenessResult(UNKNOWN, "workday_cxs_no_posting")
    code = data.get("errorCode") if isinstance(data, dict) else None
    if code in ("S21", "S22"):
        return LivenessResult(DEAD, f"workday_cxs_{code}", True)
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, f"workday_cxs_{page.status}", True)
    return _unknown_for_status(page.status)


async def _check_smartrecruiters(client, company: str, posting_id: str,
                                 state: _RunState) -> LivenessResult:
    """SmartRecruiters' postings API. The careers.* page 302s to the company
    careers home for live and closed postings alike."""
    api = (f"https://api.smartrecruiters.com/v1/companies/{quote(company, safe='')}"
           f"/postings/{posting_id}")
    page = await _get(client, api, state, headers=JSON_HEADERS, max_bytes=_MAX_JSON_BYTES)
    if page is None:
        return _NETWORK_ERROR
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, "sr_api_404", True)
    if page.status == 200:
        data = _json(page)
        if not isinstance(data, dict):
            return LivenessResult(UNKNOWN, "sr_api_unreadable")
        if data.get("active") is False:
            return LivenessResult(DEAD, "sr_inactive", True)
        return LivenessResult(ALIVE, "sr_api_200", True)
    return _unknown_for_status(page.status)


async def _check_greenhouse_board(client, token: str, job_id: str,
                                  state: _RunState) -> LivenessResult:
    api = f"https://boards-api.greenhouse.io/v1/boards/{quote(token, safe='')}/jobs/{job_id}"
    page = await _get(client, api, state, headers=JSON_HEADERS, max_bytes=_MAX_JSON_BYTES)
    if page is None:
        return _NETWORK_ERROR
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, "gh_api_404", True)
    if page.status == 200:
        if isinstance(_json(page), dict):
            return LivenessResult(ALIVE, "gh_api_200", True)
        return LivenessResult(UNKNOWN, "gh_api_unreadable")
    return _unknown_for_status(page.status)


async def _check_greenhouse_embed(client, job_id: str, state: _RunState) -> LivenessResult:
    """Token-less Greenhouse check for gh_jid links on custom career domains
    (whose own pages are often Cloudflare-walled): the embed form is 404 for a
    closed posting and a 'Job Application for ...' page for an open one."""
    embed = f"https://boards.greenhouse.io/embed/job_app?token={job_id}"
    page = await _get(client, embed, state, headers=BROWSER_HEADERS)
    if page is None:
        return _NETWORK_ERROR
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, "gh_embed_404", True)
    if page.status == 200 and "Job Application for" in page.text:
        return LivenessResult(ALIVE, "gh_embed_200", True)
    return _unknown_for_status(page.status)


async def _check_lever(client, api_host: str, company: str, posting_id: str,
                       state: _RunState) -> LivenessResult:
    api = f"https://{api_host}/v0/postings/{quote(company, safe='')}/{posting_id}"
    page = await _get(client, api, state, headers=JSON_HEADERS, max_bytes=_MAX_JSON_BYTES)
    if page is None:
        return _NETWORK_ERROR
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, "lever_api_404", True)
    if page.status == 200:
        if isinstance(_json(page), dict):
            return LivenessResult(ALIVE, "lever_api_200", True)
        return LivenessResult(UNKNOWN, "lever_api_unreadable")
    return _unknown_for_status(page.status)


async def _fetch_ashby_board(client, org: str, state: _RunState):
    """(status, set of listed job ids | None) for one Ashby org."""
    api = f"https://api.ashbyhq.com/posting-api/job-board/{quote(org, safe='')}"
    page = await _get(client, api, state, headers=JSON_HEADERS, max_bytes=_MAX_JSON_BYTES)
    if page is None:
        return None, None
    data = _json(page)
    if page.status == 200 and isinstance(data, dict) and isinstance(data.get("jobs"), list):
        return 200, {str(job.get("id", "")).lower() for job in data["jobs"] if isinstance(job, dict)}
    return page.status, None


async def _check_ashby(client, org: str, job_id: str, state: _RunState) -> LivenessResult:
    """Ashby job pages are an SPA shell for any id; the posting API's board
    listing is the truth, fetched once per org per run."""
    key = org.lower()
    task = state.ashby_boards.get(key)
    if task is None:
        task = asyncio.ensure_future(_fetch_ashby_board(client, org, state))
        state.ashby_boards[key] = task
    # shield: one caller timing out must not cancel the fetch the others share
    status, listed = await asyncio.shield(task)
    if status is None:
        return _NETWORK_ERROR
    if listed is None:
        if status in DEAD_HTTP_STATUSES:
            return LivenessResult(DEAD, "ashby_board_404", True)
        if status == 200:
            return LivenessResult(UNKNOWN, "ashby_board_unreadable")
        return _unknown_for_status(status)
    if not listed:
        # An empty board is more often an API hiccup than every job closing
        # at once; leave it to the lifecycle age-out.
        return LivenessResult(UNKNOWN, "ashby_board_empty")
    if job_id.lower() in listed:
        return LivenessResult(ALIVE, "ashby_listed", True)
    return LivenessResult(DEAD, "ashby_not_listed", True)


async def _check_oracle(client, host: str, site: str, job_id: str,
                        state: _RunState) -> LivenessResult:
    """Oracle HCM Candidate Experience is an SPA; its requisition REST finder
    returns the posting while open and an empty item list once it's gone."""
    api = (f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
           f"?expand=all&onlyData=true&finder=ById;Id=%22{job_id}%22,siteNumber={quote(site, safe='')}")
    page = await _get(client, api, state, headers=JSON_HEADERS, max_bytes=_MAX_JSON_BYTES)
    if page is None:
        return _NETWORK_ERROR
    data = _json(page)
    if page.status == 200:
        if not (isinstance(data, dict) and isinstance(data.get("items"), list)):
            return LivenessResult(UNKNOWN, "oracle_api_unreadable")
        if data["items"]:
            return LivenessResult(ALIVE, "oracle_api_item", True)
        return LivenessResult(DEAD, "oracle_items_0", True)
    return _unknown_for_status(page.status)


async def _check_linkedin(client, url: str, state: _RunState) -> LivenessResult:
    """LinkedIn's public guest page: closed jobs carry the 'No longer
    accepting applications' banner or the expired_jd_redirect trk token
    (LinkedIn serves either variant), an honest 404 also happens. A page
    without them is at best weakly alive, never enough to revive a row."""
    page = await _get(client, url, state, headers=BROWSER_HEADERS)
    if page is None:
        return _NETWORK_ERROR
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, f"http_{page.status}", True)
    if page.status != 200:
        return _unknown_for_status(page.status)
    if "expired_jd_redirect" in page.url or any(m in page.text for m in _LINKEDIN_DEAD_MARKERS):
        return LivenessResult(DEAD, "linkedin_closed", True)
    if says_dead(page.text):
        return LivenessResult(DEAD, "body_closed", True)
    final_path = urlparse(page.url).path
    if "/authwall" in final_path or "/login" in final_path or "/signup" in final_path:
        return LivenessResult(UNKNOWN, "linkedin_authwall")
    if any(m in page.text for m in _LINKEDIN_LIVE_MARKERS):
        return LivenessResult(ALIVE, "linkedin_apply_cta")
    return LivenessResult(UNKNOWN, "http_200")


# ─── Generic pages ───────────────────────────────────────────────────────────

def registrable_domain(host: str) -> str:
    """'jobs.bosch.com' → 'bosch.com', 'careers.acme.co.uk' → 'acme.co.uk'.
    A small suffix list, not the PSL: only used to tell 'same company site'
    from 'somewhere else entirely'."""
    labels = [label for label in (host or "").lower().strip(".").split(".") if label]
    if len(labels) >= 3 and ".".join(labels[-2:]) in _MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _is_career_host(host: str) -> bool:
    host = (host or "").lower()
    if any(host == h or host.endswith("." + h) for h in _CAREER_PLATFORM_HOSTS):
        return True
    return bool(_CAREER_HOST_LABEL_RE.match(host))


def _job_token(parsed) -> str:
    """The posting's own id as it appears in its URL (query id, a 4+ digit
    run, a UUID, or failing those the last path slug)."""
    query = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
    for key in _JOB_QUERY_KEYS:
        if query.get(key) and query[key][0].strip():
            return query[key][0].strip()
    segments = [unquote(s) for s in parsed.path.split("/") if s]
    for segment in reversed(segments):
        uuid = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                         segment, re.IGNORECASE)
        if uuid:
            return uuid.group(0)
        digits = re.findall(r"\d{4,}", segment)
        if digits:
            return max(digits, key=len)
    if segments and len(segments[-1]) >= 6:
        return segments[-1]
    return ""


def _is_careers_home(parsed) -> bool:
    segments = [s for s in parsed.path.split("/") if s]
    while segments and _LOCALE_SEGMENT_RE.match(segments[0]):
        segments = segments[1:]
    if not segments:
        return True
    return len(segments) == 1 and segments[0].lower() in _HOME_SEGMENTS


def _offsite_home_redirect(original_url: str, final_url: str) -> bool:
    """A job URL on a career-site host that redirected to ANOTHER company
    domain's root / careers home, with the posting id nowhere in the final
    URL: the posting was taken down and the ATS bounced to the employer site.
    Deliberately narrow; same-site bounces are left to the age-out rules."""
    original, final = urlparse(original_url), urlparse(final_url)
    if not _is_career_host(original.hostname or ""):
        return False
    if registrable_domain(original.hostname or "") == registrable_domain(final.hostname or ""):
        return False
    token = _job_token(original)
    if not token or token.lower() in final_url.lower():
        return False
    return _is_careers_home(final)


async def _check_page(client, url: str, state: _RunState) -> LivenessResult:
    """Unknown hosts: trust death signals, never a bare 200."""
    page = await _get(client, url, state, headers=BROWSER_HEADERS)
    if page is None:
        return _NETWORK_ERROR
    if page.status in DEAD_HTTP_STATUSES:
        return LivenessResult(DEAD, f"http_{page.status}")
    if page.status != 200:
        return _unknown_for_status(page.status)
    if _ERROR_URL_RE.search(page.url):
        return LivenessResult(DEAD, "error_redirect")
    if page.redirected and _offsite_home_redirect(url, page.url):
        return LivenessResult(DEAD, "offsite_home_redirect")
    if says_dead(page.text):
        return LivenessResult(DEAD, "body_closed")
    return LivenessResult(UNKNOWN, "http_200")


# ─── Routing ─────────────────────────────────────────────────────────────────

def _host_is(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


async def _route(client, url: str, state: _RunState) -> LivenessResult:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https"):
        return LivenessResult(UNKNOWN, "unsupported_url")
    if not host or "." not in host:
        # "https:/.workable.com/..."-style rows: no browser can open them.
        return LivenessResult(DEAD, "malformed_url")

    if _host_is(host, "indeed.com"):
        # Cloudflare walls every probe (401 "Authenticating..."); never judge it.
        return LivenessResult(UNKNOWN, "indeed_unprobeable")

    gh_jid = (parse_qs(parsed.query).get("gh_jid") or [""])[0].strip()
    if gh_jid.isdigit():
        return await _check_greenhouse_embed(client, gh_jid, state)

    if _host_is(host, "myworkdayjobs.com") or _host_is(host, "myworkdaysite.com"):
        api = _workday_api_url(url)
        if api:
            return await _check_workday(client, api, state)

    if host in ("careers.smartrecruiters.com", "jobs.smartrecruiters.com"):
        m = _SR_PATH_RE.match(parsed.path)
        if m:
            return await _check_smartrecruiters(client, unquote(m.group(1)), m.group(2), state)

    if host in ("boards.greenhouse.io", "job-boards.greenhouse.io"):
        m = _GH_BOARD_PATH_RE.match(parsed.path)
        if m and m.group(1) != "embed":
            return await _check_greenhouse_board(client, unquote(m.group(1)), m.group(2), state)
        token = (parse_qs(parsed.query).get("token") or [""])[0].strip()
        if parsed.path.startswith("/embed/") and token.isdigit():
            return await _check_greenhouse_embed(client, token, state)

    if host in ("jobs.lever.co", "jobs.eu.lever.co"):
        m = _LEVER_PATH_RE.match(parsed.path)
        if m:
            api_host = "api.eu.lever.co" if host == "jobs.eu.lever.co" else "api.lever.co"
            return await _check_lever(client, api_host, unquote(m.group(1)), m.group(2), state)

    if host == "jobs.ashbyhq.com":
        m = _ASHBY_PATH_RE.match(parsed.path)
        if m:
            return await _check_ashby(client, unquote(m.group(1)), m.group(2), state)

    if _host_is(host, "oraclecloud.com"):
        m = _ORACLE_PATH_RE.search(parsed.path)
        if m:
            return await _check_oracle(client, host, unquote(m.group(1)), m.group(2), state)

    if _host_is(host, "linkedin.com"):
        return await _check_linkedin(client, url, state)

    return await _check_page(client, url, state)


async def check_listing(client, url: str, *, cache: dict | None = None) -> LivenessResult:
    """Is this posting still open? Never raises. ``cache`` carries per-run
    state (host politeness, Ashby boards) across calls; pass the same dict
    for every URL of one run."""
    url = (url or "").strip()
    if not url:
        return LivenessResult(UNKNOWN, "no_url")
    try:
        return await _route(client, url, _run_state(cache))
    except Exception as exc:
        logger.debug("liveness check failed for %s: %s", url, exc)
        return LivenessResult(UNKNOWN, "error")


def _interleave_by_host(urls: list[str]) -> list[str]:
    """Round-robin across hosts so eight workers don't all queue behind one
    host's two-request gate (a stale backlog is often one big Workday board)."""
    by_host: dict[str, list[str]] = {}
    for url in urls:
        by_host.setdefault((urlparse(url).hostname or "").lower(), []).append(url)
    queues = list(by_host.values())
    ordered: list[str] = []
    depth = 0
    while len(ordered) < len(urls):
        for queue in queues:
            if depth < len(queue):
                ordered.append(queue[depth])
        depth += 1
    return ordered


async def check_listings(client, urls: list[str], *, concurrency: int = 8,
                         deadline: float | None = None,
                         cache: dict | None = None) -> dict[str, LivenessResult]:
    """Check many URLs concurrently (``concurrency`` in flight overall, at
    most two per host). Never raises. ``deadline`` (a time.monotonic() value)
    stops STARTING new checks once passed: URLs not started are simply absent
    from the result, so the caller leaves them for the next run. ``cache`` lets
    chunked callers share per-run state."""
    unique = _interleave_by_host(list(dict.fromkeys(u for u in urls if u)))
    results: dict[str, LivenessResult] = {}
    if not unique:
        return results
    cache = {} if cache is None else cache
    pending = iter(unique)

    async def worker():
        for url in pending:
            if deadline is not None and time.monotonic() >= deadline:
                return
            try:
                results[url] = await asyncio.wait_for(
                    check_listing(client, url, cache=cache), _PER_URL_SECONDS,
                )
            except asyncio.TimeoutError:
                results[url] = LivenessResult(UNKNOWN, "timeout")
            except Exception:
                results[url] = LivenessResult(UNKNOWN, "error")

    await asyncio.gather(*(worker() for _ in range(max(1, min(concurrency, len(unique))))))
    return results
