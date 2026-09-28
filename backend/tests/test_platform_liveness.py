"""Platform-aware liveness: every ATS is asked through its own API, a page is
only trusted for death signals, and bot walls are never evidence."""

import asyncio
import json

import httpx
import pytest

from backend.services import platform_liveness
from backend.services.platform_liveness import (
    LivenessResult,
    check_listing,
    check_listings,
    make_client,
    registrable_domain,
    says_dead,
)

# The ~6.5 KB app shell Workday serves for EVERY job id, live, closed or
# made up. No JobPosting data, no closed message: the page can't tell.
WORKDAY_SHELL = (
    "<!DOCTYPE html><html><head><title>Workday</title>"
    "<script>window.workday = {tenant: 'bmo'};</script></head>"
    "<body><div id='root'></div>" + "<!-- pad -->" * 500 + "</body></html>"
)


class Routes(httpx.AsyncBaseTransport):
    """Answers by URL fragment (first match wins, so list specific fragments
    first); records every requested URL. A route value is a (status, body)
    tuple, (status, body, headers), an Exception to raise, or a callable
    taking the request."""

    def __init__(self, routes: dict, default=(599, "no route")):
        self.routes = routes
        self.default = default
        self.requested: list[str] = []

    async def handle_async_request(self, request):
        url = str(request.url)
        self.requested.append(url)
        spec = self.default
        for fragment, candidate in self.routes.items():
            if fragment in url:
                spec = candidate
                break
        if callable(spec) and not isinstance(spec, tuple):
            spec = spec(request)
        if isinstance(spec, Exception):
            raise spec
        status, body, *rest = spec
        headers = rest[0] if rest else {}
        if isinstance(body, (dict, list)):
            headers = {"content-type": "application/json", **headers}
            body = json.dumps(body)
        return httpx.Response(status, content=body.encode() if isinstance(body, str) else body,
                              headers=headers, request=request)


def _client(routes: dict, **kw):
    transport = Routes(routes, **kw)
    return make_client(transport=transport), transport


async def _check(routes: dict, url: str, **kw) -> tuple[LivenessResult, list[str]]:
    client, transport = _client(routes)
    async with client:
        result = await check_listing(client, url, **kw)
    return result, transport.requested


# ─── Workday ─────────────────────────────────────────────────────────────────

WD_URL = "https://bmo.wd3.myworkdayjobs.com/external/job/Calgary-AB-CAN/Client-Service-Associate_R260019629"
WD_API = "https://bmo.wd3.myworkdayjobs.com/wday/cxs/bmo/external/job/Calgary-AB-CAN/Client-Service-Associate_R260019629"


class TestWorkday:
    @pytest.mark.asyncio
    async def test_shell_200_page_is_never_read_the_api_is(self):
        """The public page answers 200 for a made-up id; only CXS knows."""
        result, requested = await _check({
            "/wday/cxs/": (404, {"errorCode": "S21", "httpStatus": 404}),
            "myworkdayjobs.com/external/job/": (200, WORKDAY_SHELL),
        }, WD_URL)
        assert result == LivenessResult("dead", "workday_cxs_S21", True)
        assert requested == [WD_API]

    @pytest.mark.asyncio
    async def test_s22_403_json_is_dead(self):
        result, _ = await _check({
            "/wday/cxs/": (403, {"errorCode": "S22", "httpStatus": 403,
                                 "message": "permission denied"}),
        }, WD_URL)
        assert result == LivenessResult("dead", "workday_cxs_S22", True)

    @pytest.mark.asyncio
    async def test_live_posting_is_authoritative_alive(self):
        result, _ = await _check({
            "/wday/cxs/": (200, {"jobPostingInfo": {"id": "x", "title": "Associate"}}),
        }, WD_URL)
        assert result == LivenessResult("alive", "workday_cxs_200", True)

    @pytest.mark.asyncio
    async def test_bare_403_without_the_json_code_is_a_bot_wall(self):
        result, _ = await _check({"/wday/cxs/": (403, "<html>Access denied</html>")}, WD_URL)
        assert result.verdict == "unknown"
        assert result.reason == "bot_wall_403"

    @pytest.mark.asyncio
    async def test_200_without_posting_info_is_unknown(self):
        result, _ = await _check({"/wday/cxs/": (200, {"something": "else"})}, WD_URL)
        assert result.verdict == "unknown"

    @pytest.mark.asyncio
    async def test_locale_and_tracking_params_are_stripped(self):
        url = ("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Ottawa/"
               "Intern_R123?utm_source=vansh#top")
        _result, requested = await _check({"/wday/cxs/": (200, {"jobPostingInfo": {"id": 1}})}, url)
        assert requested == ["https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Ottawa/Intern_R123"]

    @pytest.mark.asyncio
    async def test_myworkdaysite_host(self):
        url = ("https://wd3.myworkdaysite.com/en-US/recruiting/pwc/Global_Careers/job/"
               "Toronto/Associate_752290WD")
        result, requested = await _check({"/wday/cxs/": (200, {"jobPostingInfo": {"id": 1}})}, url)
        assert result.verdict == "alive"
        assert requested == ["https://wd3.myworkdaysite.com/wday/cxs/pwc/Global_Careers/job/"
                             "Toronto/Associate_752290WD"]

    @pytest.mark.asyncio
    async def test_apply_step_link_asks_about_the_posting(self):
        """CXS answers 422 for '/job/<slug>/apply', so an apply-step link
        could never be proven alive; the posting is '/job/<slug>'."""
        base = ("https://roche.wd3.myworkdayjobs.com/roche-ext/job/Mississauga/"
                "Business-Analyst---RDT-Pharma-Technical-Operations_202606-115566")
        api = ("https://roche.wd3.myworkdayjobs.com/wday/cxs/roche/roche-ext/job/Mississauga/"
               "Business-Analyst---RDT-Pharma-Technical-Operations_202606-115566")
        routes = {"/apply": (422, {"errorCode": "HTTP_422"}),
                  "/wday/cxs/": (200, {"jobPostingInfo": {"id": "x"}})}
        for url in (base + "/apply", base + "/apply/applyManually?source=x"):
            result, requested = await _check(routes, url)
            assert result == LivenessResult("alive", "workday_cxs_200", True), url
            assert requested == [api]

    def test_strip_workday_apply(self):
        base = "https://acme.wd5.myworkdayjobs.com/Careers/job/Ottawa/Intern_R1"
        assert platform_liveness.strip_workday_apply(base + "/apply") == base
        assert platform_liveness.strip_workday_apply(base + "/apply/applyManually") == base
        assert platform_liveness.strip_workday_apply(base + "/apply?s=1") == base + "?s=1"
        assert platform_liveness.strip_workday_apply(base) == base
        # only Workday hosts: another ATS's '/apply' is its own page
        lever = "https://jobs.lever.co/acme/0f7b3c1e-1d2a-4b5c-8d9e-0a1b2c3d4e5f/apply"
        assert platform_liveness.strip_workday_apply(lever) == lever


# ─── SmartRecruiters ─────────────────────────────────────────────────────────

class TestSmartRecruiters:
    @pytest.mark.asyncio
    async def test_inactive_posting_is_dead(self):
        """careers.smartrecruiters.com 302s to the company careers home for
        live and closed postings alike; the API's active flag is the truth."""
        result, requested = await _check({
            "api.smartrecruiters.com": (200, {"id": "744000135554529", "active": False}),
        }, "https://careers.smartrecruiters.com/BoschGroup/744000135554529")
        assert result == LivenessResult("dead", "sr_inactive", True)
        assert requested == ["https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/744000135554529"]

    @pytest.mark.asyncio
    async def test_active_posting_is_authoritative_alive(self):
        result, _ = await _check({
            "api.smartrecruiters.com": (200, {"id": "1", "active": True}),
        }, "https://jobs.smartrecruiters.com/ServiceNow/744000092424475-otc-analyst")
        assert result == LivenessResult("alive", "sr_api_200", True)

    @pytest.mark.asyncio
    async def test_404_is_dead_and_uuid_ids_route(self):
        result, requested = await _check({
            "api.smartrecruiters.com": (404, {"code": "RESOURCE_NOT_FOUND"}),
        }, "https://jobs.smartrecruiters.com/LinkedIn3/a3b09881-7c3e-444c-9e65-ac0e2c6a8970?utm_source=vansh")
        assert result == LivenessResult("dead", "sr_api_404", True)
        assert requested[0].endswith("/companies/LinkedIn3/postings/a3b09881-7c3e-444c-9e65-ac0e2c6a8970")

    @pytest.mark.asyncio
    async def test_rate_limit_is_unknown(self):
        result, _ = await _check({"api.smartrecruiters.com": (429, "slow down")},
                                 "https://careers.smartrecruiters.com/BoschGroup/744000135554529")
        assert result.verdict == "unknown"


# ─── Greenhouse ──────────────────────────────────────────────────────────────

class TestGreenhouse:
    @pytest.mark.asyncio
    async def test_board_url_uses_boards_api(self):
        result, requested = await _check({
            "boards-api.greenhouse.io": (200, {"id": 8180461, "title": "Intern"}),
        }, "https://job-boards.greenhouse.io/gusto/jobs/8180461")
        assert result == LivenessResult("alive", "gh_api_200", True)
        assert requested == ["https://boards-api.greenhouse.io/v1/boards/gusto/jobs/8180461"]

    @pytest.mark.asyncio
    async def test_board_api_404_is_dead(self):
        result, _ = await _check({"boards-api.greenhouse.io": (404, {"status": 404})},
                                 "https://boards.greenhouse.io/acme/jobs/2")
        assert result == LivenessResult("dead", "gh_api_404", True)

    @pytest.mark.asyncio
    async def test_gh_jid_on_custom_domain_uses_embed(self):
        """Custom career domains are often Cloudflare-walled; the embed form
        answers honestly for any gh_jid, and the custom page is never hit."""
        result, requested = await _check({
            "embed/job_app": (404, "<html>Not found</html>"),
            "carvana.com": (403, "Just a moment..."),
        }, "https://www.carvana.com/careers/apply?gh_jid=8208440")
        assert result == LivenessResult("dead", "gh_embed_404", True)
        assert requested == ["https://boards.greenhouse.io/embed/job_app?token=8208440"]

    @pytest.mark.asyncio
    async def test_gh_jid_embed_live(self):
        result, _ = await _check({
            "embed/job_app": (200, "<title>Job Application for Software Developer at D2L</title>"),
        }, "https://www.d2l.com/careers/jobs/?job_id=7455458&gh_jid=7455458")
        assert result == LivenessResult("alive", "gh_embed_200", True)

    @pytest.mark.asyncio
    async def test_gh_jid_embed_200_without_the_form_is_unknown(self):
        result, _ = await _check({"embed/job_app": (200, "<html>Something else</html>")},
                                 "https://sofi.com/careers/job/7760620003?gh_jid=7760620003")
        assert result.verdict == "unknown"

    # Jane Street's board switched its embed off: the embed answers 404 for
    # every open posting while the boards-api answers 200.
    JANE = "https://www.janestreet.com/join-jane-street/apply/8631912002?gh_jid=8631912002"
    JANE_ROUTES = {
        "boards-api.greenhouse.io/v1/boards/janestreet/jobs/8631912002": (200, {"id": 8631912002}),
        "embed/job_app": (404, "<html>Not found</html>"),
    }

    @pytest.mark.asyncio
    async def test_gh_jid_with_a_known_board_uses_the_boards_api(self):
        result, requested = await _check(self.JANE_ROUTES, self.JANE,
                                         board_key="greenhouse:janestreet")
        assert result == LivenessResult("alive", "gh_api_200", True)
        assert requested == ["https://boards-api.greenhouse.io/v1/boards/janestreet/jobs/8631912002"]

        closed, _ = await _check({"boards-api.greenhouse.io": (404, {"status": 404})}, self.JANE,
                                 board_key="greenhouse:janestreet")
        assert closed == LivenessResult("dead", "gh_api_404", True)

    @pytest.mark.asyncio
    async def test_gh_jid_board_key_of_another_platform_keeps_the_embed(self):
        _result, requested = await _check(self.JANE_ROUTES, self.JANE, board_key="unknown")
        assert requested == ["https://boards.greenhouse.io/embed/job_app?token=8631912002"]

    @pytest.mark.asyncio
    async def test_board_path_with_gh_jid_never_uses_the_embed(self):
        url = "https://boards.greenhouse.io/janestreet/jobs/8631912002?gh_jid=8631912002"
        result, requested = await _check(self.JANE_ROUTES, url)
        assert result == LivenessResult("alive", "gh_api_200", True)
        assert requested == ["https://boards-api.greenhouse.io/v1/boards/janestreet/jobs/8631912002"]

    @pytest.mark.asyncio
    async def test_embed_url_naming_its_board_uses_the_boards_api(self):
        url = "https://job-boards.greenhouse.io/embed/job_app?for=janestreet&token=8631912002"
        result, requested = await _check(self.JANE_ROUTES, url)
        assert result == LivenessResult("alive", "gh_api_200", True)
        assert requested == ["https://boards-api.greenhouse.io/v1/boards/janestreet/jobs/8631912002"]

    @pytest.mark.asyncio
    async def test_check_listings_plumbs_board_keys(self):
        client, transport = _client(self.JANE_ROUTES)
        async with client:
            results = await check_listings(client, [self.JANE],
                                           board_keys={self.JANE: "greenhouse:janestreet"})
        assert results[self.JANE] == LivenessResult("alive", "gh_api_200", True)
        assert transport.requested == [
            "https://boards-api.greenhouse.io/v1/boards/janestreet/jobs/8631912002"]


# ─── Lever / Ashby / Oracle ──────────────────────────────────────────────────

LEVER_ID = "84335d8e-f91c-4741-b4c6-7649f3ac948d"


class TestLever:
    @pytest.mark.asyncio
    async def test_404_dead_200_alive(self):
        dead, requested = await _check({"api.lever.co": (404, {"ok": False})},
                                       f"https://jobs.lever.co/palantir/{LEVER_ID}/apply")
        assert dead == LivenessResult("dead", "lever_api_404", True)
        assert requested == [f"https://api.lever.co/v0/postings/palantir/{LEVER_ID}"]
        alive, _ = await _check({"api.lever.co": (200, {"id": LEVER_ID})},
                                f"https://jobs.lever.co/palantir/{LEVER_ID}")
        assert alive == LivenessResult("alive", "lever_api_200", True)

    @pytest.mark.asyncio
    async def test_eu_host_uses_eu_api(self):
        _result, requested = await _check({"api.eu.lever.co": (200, {"id": LEVER_ID})},
                                          f"https://jobs.eu.lever.co/acme/{LEVER_ID}")
        assert requested == [f"https://api.eu.lever.co/v0/postings/acme/{LEVER_ID}"]


ASHBY_LIVE = "b5242472-5679-4084-af77-238b6335b792"
ASHBY_GONE = "249837b3-106f-4751-a4f2-03a2c5df5faf"


ASHBY_GRAPHQL = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting"
ASHBY_UNLISTED = "bed47ac1-9c5c-44ae-8965-3a4312706328"


def _ashby_posting(postings: dict, asked: list | None = None):
    """A GraphQL ApiJobPosting handler: ``postings`` maps a job id to its
    ``isListed`` flag; any other id answers ``jobPosting: null``."""
    def handler(request):
        body = json.loads(request.content)
        if asked is not None:
            asked.append((request.method, body))
        job_id = body["variables"]["jobPostingId"]
        if job_id in postings:
            return (200, {"data": {"jobPosting": {"id": job_id, "isListed": postings[job_id]}}})
        return (200, {"data": {"jobPosting": None}})
    return handler


class TestAshby:
    @pytest.mark.asyncio
    async def test_board_membership_and_one_fetch_per_org(self):
        asked: list = []
        client, transport = _client({
            "api.ashbyhq.com/posting-api/job-board/zip": (200, {"jobs": [{"id": ASHBY_LIVE}]}),
            "non-user-graphql": _ashby_posting({}, asked),
        })
        async with client:
            results = await check_listings(client, [
                f"https://jobs.ashbyhq.com/zip/{ASHBY_LIVE}",
                f"https://jobs.ashbyhq.com/zip/{ASHBY_GONE}/application",
                f"https://jobs.ashbyhq.com/zip/{ASHBY_UNLISTED}",
            ])
        assert results[f"https://jobs.ashbyhq.com/zip/{ASHBY_LIVE}"] == LivenessResult(
            "alive", "ashby_listed", True)
        # not on the board, and the posting lookup says it doesn't exist
        assert results[f"https://jobs.ashbyhq.com/zip/{ASHBY_GONE}/application"] == LivenessResult(
            "dead", "ashby_posting_null", True)
        assert transport.requested.count("https://api.ashbyhq.com/posting-api/job-board/zip") == 1
        # the listed posting never needed the lookup
        assert sorted(body["variables"]["jobPostingId"] for _m, body in asked) == sorted(
            [ASHBY_GONE, ASHBY_UNLISTED])

    @pytest.mark.asyncio
    async def test_open_but_unlisted_posting_is_alive(self):
        """The board lists only isListed postings; one shared by direct link
        is open (its page and application form work) and must not read as
        closed. ElevenLabs bed47ac1 answered exactly this live."""
        asked: list = []
        client, _transport = _client({
            "api.ashbyhq.com/posting-api/job-board/elevenlabs": (200, {"jobs": [{"id": ASHBY_LIVE}]}),
            "non-user-graphql": _ashby_posting({ASHBY_UNLISTED: False}, asked),
        })
        url = f"https://jobs.ashbyhq.com/elevenlabs/{ASHBY_UNLISTED}"
        async with client:
            results = await check_listings(client, [url])
        assert results[url] == LivenessResult("alive", "ashby_unlisted_open", True)
        method, body = asked[0]
        assert method == "POST"
        assert body["operationName"] == "ApiJobPosting"
        assert body["variables"] == {"organizationHostedJobsPageName": "elevenlabs",
                                     "jobPostingId": ASHBY_UNLISTED}
        assert "jobPosting(organizationHostedJobsPageName:" in body["query"]

    @pytest.mark.asyncio
    async def test_one_off_check_asks_about_the_posting_only(self):
        """check-live checks one row: no multi-megabyte board download."""
        result, requested = await _check({
            "api.ashbyhq.com": (200, {"jobs": [{"id": ASHBY_LIVE}]}),
            "non-user-graphql": _ashby_posting({ASHBY_LIVE: True}),
        }, f"https://jobs.ashbyhq.com/zip/{ASHBY_LIVE}")
        assert result == LivenessResult("alive", "ashby_posting_open", True)
        assert requested == [ASHBY_GRAPHQL]

    @pytest.mark.asyncio
    async def test_lookup_failures_are_unknown_never_dead(self):
        url = f"https://jobs.ashbyhq.com/zip/{ASHBY_GONE}"
        for spec in ((500, "oops"), (200, {"errors": [{"message": "bad"}]}),
                     (200, "<html>not json</html>"), (429, "slow down"),
                     (200, {"data": {"jobPosting": {"id": "someone-else"}}})):
            result, _ = await _check({"non-user-graphql": spec}, url)
            assert result.verdict == "unknown", spec

    @pytest.mark.asyncio
    async def test_empty_board_is_not_mass_death(self):
        """An empty board is more often an API hiccup than every job closing:
        each posting is asked about on its own, never judged by the board."""
        urls = [f"https://jobs.ashbyhq.com/deel/{ASHBY_GONE}/application",
                f"https://jobs.ashbyhq.com/deel/{ASHBY_UNLISTED}"]
        client, _transport = _client({
            "api.ashbyhq.com": (200, {"jobs": []}),
            "non-user-graphql": _ashby_posting({ASHBY_UNLISTED: True}),
        })
        async with client:
            results = await check_listings(client, urls)
        assert results[urls[0]] == LivenessResult("dead", "ashby_posting_null", True)
        assert results[urls[1]] == LivenessResult("alive", "ashby_posting_open", True)

    @pytest.mark.asyncio
    async def test_board_over_the_cap_is_never_parsed(self, monkeypatch):
        """OpenAI's board is ~14 MB: a board cut off by the byte cap would
        drop ids, and a dropped id must not read as closed."""
        monkeypatch.setattr(platform_liveness, "_MAX_ASHBY_BOARD_BYTES", 64)
        board = {"jobs": [{"id": ASHBY_LIVE, "descriptionHtml": "x" * 500}]}
        client, _transport = _client({
            "api.ashbyhq.com": (200, board),
            "non-user-graphql": _ashby_posting({ASHBY_LIVE: True}),
        })
        url = f"https://jobs.ashbyhq.com/openai/{ASHBY_LIVE}"
        async with client:
            results = await check_listings(client, [url])
        assert results[url] == LivenessResult("alive", "ashby_posting_open", True)

    @pytest.mark.asyncio
    async def test_default_board_cap_fits_the_biggest_board(self):
        assert platform_liveness._MAX_ASHBY_BOARD_BYTES > 14_000_000

    @pytest.mark.asyncio
    async def test_gone_board_is_dead(self):
        client, _transport = _client({"api.ashbyhq.com": (404, {"success": False})})
        url = f"https://jobs.ashbyhq.com/gone/{ASHBY_GONE}"
        async with client:
            results = await check_listings(client, [url])
        assert results[url] == LivenessResult("dead", "ashby_board_404", True)


ORACLE_URL = ("https://fa-evcg-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/"
              "en/sites/CX_1/job/231788")


class TestOracle:
    @pytest.mark.asyncio
    async def test_empty_items_is_dead(self):
        result, requested = await _check({"hcmRestApi": (200, {"items": [], "count": 0})}, ORACLE_URL)
        assert result == LivenessResult("dead", "oracle_items_0", True)
        assert "recruitingCEJobRequisitionDetails" in requested[0]
        assert "finder=ById;Id=%22231788%22,siteNumber=CX_1" in requested[0]

    @pytest.mark.asyncio
    async def test_item_is_alive(self):
        result, _ = await _check({"hcmRestApi": (200, {"items": [{"Id": "231788"}], "count": 1})},
                                 ORACLE_URL)
        assert result == LivenessResult("alive", "oracle_api_item", True)


NOKIA_POD = "fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com"
NOKIA_PAGE = ("<html><head><script src='https://static.oracle.com/cx.js'></script>"
              f"<script>var CX_CONFIG = {{apiBaseUrl: 'https://{NOKIA_POD}/'}};</script>"
              "</head><body><div id='root'></div></body></html>")


class TestOracleVanity:
    """Oracle HCM on the employer's own domain: the page is the same shell
    for live and closed ids and the domain's REST path bounces to an error
    page, but the page names the pod whose API answers honestly."""

    @staticmethod
    def _routes(items_by_id: dict):
        def api(request):
            job_id = str(request.url).split("Id=%22")[1].split("%22")[0]
            return (200, {"items": items_by_id.get(job_id, []), "count": 0})
        return {f"{NOKIA_POD}/hcmRestApi": api, "jobs.nokia.com": (200, NOKIA_PAGE)}

    @pytest.mark.asyncio
    async def test_pod_found_once_per_host_then_asked_per_posting(self):
        client, transport = _client(self._routes({"38158": [{"Id": "38158"}]}))
        live = "https://jobs.nokia.com/en/sites/CX_1/job/38158"
        gone = "https://jobs.nokia.com/en/sites/CX_1/job/37694"
        async with client:
            results = await check_listings(client, [live, gone], concurrency=1)
        assert results[live] == LivenessResult("alive", "oracle_api_item", True)
        assert results[gone] == LivenessResult("dead", "oracle_items_0", True)
        pages = [u for u in transport.requested if u.startswith("https://jobs.nokia.com/")]
        assert pages == [live]  # one page read for the host
        api_calls = [u for u in transport.requested if NOKIA_POD in u]
        assert any("Id=%2238158%22,siteNumber=CX_1" in u for u in api_calls)
        assert any("Id=%2237694%22,siteNumber=CX_1" in u for u in api_calls)

    @pytest.mark.asyncio
    async def test_no_pod_on_the_page_falls_back_to_the_page_check(self):
        result, _ = await _check({"careers.acme.com": (200, "<h1>Engineer</h1>")},
                                 "https://careers.acme.com/sites/CX/job/123")
        assert result == LivenessResult("unknown", "http_200", False)


class TestBambooHR:
    URL = "https://solace.bamboohr.com/careers/773"

    @pytest.mark.asyncio
    async def test_not_found_is_dead_opening_is_alive(self):
        dead, requested = await _check({"/careers/773/detail": (404, {
            "type": "not_found", "title": "Resource not found."})}, self.URL)
        assert dead == LivenessResult("dead", "bamboohr_not_found", True)
        assert requested == ["https://solace.bamboohr.com/careers/773/detail"]
        alive, _ = await _check({"/careers/729/detail": (200, {
            "meta": {}, "result": {"jobOpening": {"jobOpeningName": "Developer"}}})},
            "https://solace.bamboohr.com/careers/729?utm_source=vansh")
        assert alive == LivenessResult("alive", "bamboohr_api_200", True)

    @pytest.mark.asyncio
    async def test_a_bare_404_page_or_wall_is_not_the_api_speaking(self):
        for spec in ((404, "<html>Not found</html>"), (403, "denied"), (200, {"other": 1})):
            result, _ = await _check({"/careers/773/detail": spec}, self.URL)
            assert result.verdict == "unknown", spec


class TestRecruitee:
    HOST = "https://huaweicanada.recruitee.com"

    @pytest.mark.asyncio
    async def test_published_offer_is_alive(self):
        result, requested = await _check({"/api/offers/intern-researcher-ai-3": (200, {
            "offer": {"id": 2648425, "slug": "intern-researcher-ai-3", "status": "published"}})},
            f"{self.HOST}/o/intern-researcher-ai-3")
        assert result == LivenessResult("alive", "recruitee_api_200", True)
        assert requested == [f"{self.HOST}/api/offers/intern-researcher-ai-3"]

    @pytest.mark.asyncio
    async def test_404_is_dead_only_when_the_offer_page_is_gone_too(self):
        result, _ = await _check({"/api/offers/": (404, {"error": "Not Found"}),
                                  "/o/hr-assistant-5": (404, "<html>Not found</html>")},
                                 f"{self.HOST}/o/hr-assistant-5")
        assert result == LivenessResult("dead", "recruitee_offer_404", True)

    @pytest.mark.asyncio
    async def test_old_slug_redirecting_to_another_offer_is_undecided(self):
        """An edited title gets a new slug and the old one redirects to it:
        that may be the same open offer, so it's never read as closed."""
        def page(request):
            if request.url.path == "/o/department-assistant-5":
                return (301, "", {"location": f"{self.HOST}/o/department-clerk"})
            return (200, "<h1>Department Clerk</h1>")

        result, _ = await _check({"/api/offers/": (404, {"error": "Not Found"}), "/o/": page},
                                 f"{self.HOST}/o/department-assistant-5")
        assert result == LivenessResult("unknown", "recruitee_redirected", False)


# ─── LinkedIn / Indeed ───────────────────────────────────────────────────────

LI_URL = "https://www.linkedin.com/jobs/view/4466880635"


class TestLinkedIn:
    @pytest.mark.asyncio
    async def test_closed_banner_is_dead(self):
        body = ('<figcaption class="closed-job__flavor--closed">'
                "No longer accepting applications</figcaption>")
        result, _ = await _check({"linkedin.com": (200, body)}, LI_URL)
        assert result.verdict == "dead"

    @pytest.mark.asyncio
    async def test_expired_redirect_is_dead(self):
        def redirect(request):
            if "/jobs/view/" in str(request.url):
                return (302, "", {"location": "https://www.linkedin.com/jobs/search?trk=expired_jd_redirect"})
            return (200, "<html>Jobs search</html>")

        result, _ = await _check({"linkedin.com": redirect}, LI_URL)
        assert result == LivenessResult("dead", "linkedin_closed", True)

    @pytest.mark.asyncio
    async def test_404_is_dead_rate_limits_are_unknown(self):
        dead, _ = await _check({"linkedin.com": (404, "")}, LI_URL)
        assert dead.verdict == "dead"
        for status in (429, 999):
            walled, _ = await _check({"linkedin.com": (status, "")}, LI_URL)
            assert walled == LivenessResult("unknown", f"bot_wall_{status}", False)

    @pytest.mark.asyncio
    async def test_live_page_is_alive_but_never_authoritative(self):
        body = ('<h1 class="top-card-layout__title topcard__title">Intern</h1>'
                '<button class="apply-button">Apply</button>')
        result, _ = await _check({"linkedin.com": (200, body)}, LI_URL)
        assert result == LivenessResult("alive", "linkedin_apply_cta", False)


@pytest.mark.asyncio
async def test_indeed_is_never_requested():
    result, requested = await _check({}, "https://ca.indeed.com/viewjob?jk=abc123")
    assert result == LivenessResult("unknown", "indeed_unprobeable", False)
    assert requested == []


# ─── Generic pages ───────────────────────────────────────────────────────────

class TestGenericPages:
    @pytest.mark.asyncio
    async def test_status_codes(self):
        for status, verdict in ((404, "dead"), (410, "dead"), (401, "unknown"),
                                (403, "unknown"), (429, "unknown"), (999, "unknown"),
                                (500, "unknown"), (405, "unknown")):
            result, _ = await _check({"careers.acme.com": (status, "x")},
                                     "https://careers.acme.com/jobs/12345")
            assert result.verdict == verdict, status
            assert result.authoritative is False

    @pytest.mark.asyncio
    async def test_generic_200_is_not_evidence(self):
        result, _ = await _check({"careers.acme.com": (200, "<h1>Software Intern</h1>")},
                                 "https://careers.acme.com/jobs/12345")
        assert result == LivenessResult("unknown", "http_200", False)

    @pytest.mark.asyncio
    async def test_error_redirects_are_dead(self):
        targets = (
            "https://jobs.bombardier.com/errorpage/?errortype=404",
            "https://jobs.jobvite.com/careers/nutanix/jobs?error=404",
            "https://job-boards.greenhouse.io/unity3d?error=true",
            "https://careers.acme.com/404",
        )
        for target in targets:
            def redirect(request, target=target):
                if str(request.url) == "https://careers.acme.com/job/11101":
                    return (302, "", {"location": target})
                return (200, "<html>Careers</html>")

            result, _ = await _check({"": redirect}, "https://careers.acme.com/job/11101")
            assert result == LivenessResult("dead", "error_redirect", False), target

    @pytest.mark.asyncio
    async def test_visible_dead_phrases(self):
        for body in (
            "<h2>This job has expired</h2>",
            "<div class='status'>Position Closed</div>",
            "<p>Sorry, this position has been filled.</p>",
            "<p>This job is no longer available.</p>",
            "<p>The job you are looking for is no longer available.</p>",
        ):
            result, _ = await _check({"careers.acme.com": (200, body)},
                                     "https://careers.acme.com/jobs/12345")
            assert result == LivenessResult("dead", "body_closed", False), body

    @pytest.mark.asyncio
    async def test_taleo_section_unavailable_is_not_a_posting_death(self):
        """Taleo answers this page for a live job id, the section's own
        search page and a made-up section alike ('The system may be under
        maintenance'): it is about the section, never the posting."""
        page = ("<html><head><title>Career Section Unavailable</title></head><body>"
                "<h1>Career Section Unavailable</h1><p>The Career section you are trying to "
                "access is not available for the moment. The system may be under "
                "maintenance.</p></body></html>")
        result, _ = await _check({"textron.taleo.net": (200, page)},
                                 "https://textron.taleo.net/careersection/10020/jobdetail.ftl?job=1526509")
        assert result == LivenessResult("unknown", "taleo_section_unavailable", False)
        assert not says_dead(page)

    @pytest.mark.asyncio
    async def test_phrases_inside_scripts_do_not_count(self):
        """Roblox/Lucid-style live pages ship a Next.js 404 template and i18n
        strings inside <script>; only visible text is read."""
        body = (
            "<html><head><script>self.__next_f.push([1,\"404: This page could not be found."
            " This job is no longer available. Position closed.\"])</script>"
            "<style>.closed:after{content:'This job has expired'}</style></head>"
            "<body><h1>Software Engineer Intern</h1><template>Position closed</template>"
            "<noscript>This posting has expired</noscript></body></html>"
        )
        result, _ = await _check({"careers.roblox.com": (200, body)},
                                 "https://careers.roblox.com/jobs/8107091")
        assert result.verdict == "unknown"

    @pytest.mark.asyncio
    async def test_live_boilerplate_is_not_death(self):
        for body in (
            "<p>Page not found? Try our search.</p><h1>Data Intern</h1>",
            "<p>Applications are accepted until the position is filled.</p>",
            "<p>We review applications until the position has been filled.</p>",
            "<p>This position is not available for relocation.</p>",
            "<p>Can't find the job you're looking for? Join our talent network.</p>",
        ):
            result, _ = await _check({"careers.acme.com": (200, body)},
                                     "https://careers.acme.com/jobs/12345")
            assert result.verdict == "unknown", body

    @pytest.mark.asyncio
    async def test_malformed_url_is_dead_without_a_request(self):
        result, requested = await _check({}, "https:/.workable.com/thorlabs/j/E79FA34ED4")
        assert result == LivenessResult("dead", "malformed_url", False)
        assert requested == []


class TestOffsiteHomeRedirect:
    @staticmethod
    def _redirecting(origin: str, target: str):
        def handler(request):
            if str(request.url) == origin:
                return (302, "", {"location": target})
            return (200, "<html><h1>Careers at Bosch</h1></html>")
        return {"": handler}

    @pytest.mark.asyncio
    async def test_career_host_bouncing_to_another_company_home_is_dead(self):
        origin = "https://careers.acmejobs.com/job/744000135554529"
        for target in ("https://jobs.bosch.com/en", "https://www.bosch.com/",
                       "https://www.bosch.com/careers"):
            result, _ = await _check(self._redirecting(origin, target), origin)
            assert result == LivenessResult("dead", "offsite_home_redirect", False), target

    @pytest.mark.asyncio
    async def test_conservative_cases_stay_unknown(self):
        cases = (
            # same registrable domain: left to the age-out rules
            ("https://careers.molsoncoors.com/job/MQXMOLUS37755EXTERNALENUS",
             "https://careers.molsoncoors.com/us/en"),
            # the id survived the redirect (slug canonicalisation)
            ("https://careers.acme.com/job/12345", "https://apply.acmehr.com/en/12345-intern"),
            # landed on a deep page, not a careers home
            ("https://careers.acme.com/job/12345", "https://www.ycombinator.com/companies/party"),
            # original host isn't a career-site pattern
            ("https://www.acme.com/about/12345", "https://www.other.com/"),
        )
        for origin, target in cases:
            result, _ = await _check(self._redirecting(origin, target), origin)
            assert result.verdict == "unknown", (origin, target)


def test_registrable_domain():
    assert registrable_domain("jobs.bosch.com") == "bosch.com"
    assert registrable_domain("careers.acme.co.uk") == "acme.co.uk"
    assert registrable_domain("bosch.com") == "bosch.com"


def test_says_dead_reads_visible_text_only():
    assert says_dead("<p>No longer accepting applications</p>")
    assert not says_dead("<script>'No longer accepting applications'</script><p>Apply</p>")
    # a script cut off by the byte cap has no closing tag
    assert not says_dead("<p>Apply</p><script>var s = 'This job has expired'")


# ─── check_listings: politeness, robustness, time box ────────────────────────

class TestCheckListings:
    @pytest.mark.asyncio
    async def test_never_raises_on_network_errors(self):
        client, _ = _client({"": httpx.ConnectError("boom")})
        async with client:
            results = await check_listings(client, [
                "https://careers.a.com/jobs/1", "https://boards.greenhouse.io/x/jobs/2",
            ])
        assert {r.verdict for r in results.values()} == {"unknown"}
        assert {r.reason for r in results.values()} == {"network_error"}

    @pytest.mark.asyncio
    async def test_at_most_two_requests_per_host(self):
        in_flight: dict[str, int] = {}
        peak: dict[str, int] = {}

        class Slow(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                host = request.url.host
                in_flight[host] = in_flight.get(host, 0) + 1
                peak[host] = max(peak.get(host, 0), in_flight[host])
                await asyncio.sleep(0.01)
                in_flight[host] -= 1
                return httpx.Response(404, request=request)

        urls = [f"https://careers.a.com/jobs/{i}" for i in range(10)]
        urls += [f"https://careers.b.com/jobs/{i}" for i in range(10)]
        async with make_client(transport=Slow()) as client:
            results = await check_listings(client, urls, concurrency=8)
        assert len(results) == 20
        assert all(r.verdict == "dead" for r in results.values())
        assert peak["careers.a.com"] <= 2 and peak["careers.b.com"] <= 2

    @pytest.mark.asyncio
    async def test_past_deadline_starts_nothing(self):
        import time
        client, transport = _client({"": (404, "")})
        async with client:
            results = await check_listings(client, ["https://careers.a.com/jobs/1"],
                                           deadline=time.monotonic() - 1)
        assert results == {}
        assert transport.requested == []

    @pytest.mark.asyncio
    async def test_failing_host_is_skipped_after_the_limit(self):
        client, transport = _client({"careers.hang.com": httpx.ReadTimeout("slow")})
        urls = [f"https://careers.hang.com/jobs/{i}" for i in range(6)]
        async with client:
            results = await check_listings(client, urls, concurrency=1)
        limit = platform_liveness._HOST_FAILURE_LIMIT
        assert len(transport.requested) == limit
        assert all(r.verdict == "unknown" for r in results.values())
        # the rows that never got a request say so: they are not probes
        reasons = [results[url].reason for url in urls]
        assert reasons == ["network_error"] * limit + ["host_skipped"] * (6 - limit)
        assert [platform_liveness.is_deferred(results[url]) for url in urls] == \
            [False] * limit + [True] * (6 - limit)

    @pytest.mark.asyncio
    async def test_rate_limited_host_is_skipped_and_every_miss_is_deferred(self, monkeypatch):
        monkeypatch.setattr(platform_liveness, "_LINKEDIN_MIN_INTERVAL", 0)
        client, transport = _client({"linkedin.com": (429, "slow down")})
        urls = [f"https://www.linkedin.com/jobs/view/{i}" for i in range(5)]
        async with client:
            results = await check_listings(client, urls, cache=platform_liveness.run_cache())
        assert len(transport.requested) == platform_liveness._HOST_FAILURE_LIMIT
        assert all(platform_liveness.is_deferred(r) for r in results.values())
        assert {r.reason for r in results.values()} == {"bot_wall_429", "host_skipped"}

    @pytest.mark.asyncio
    async def test_time_queued_at_a_gate_is_never_a_timeout(self, monkeypatch):
        """The per-request clock starts once the request holds its host's
        gate: eight URLs on one host (two at a time, the last pair done after
        ~1s) that each answer well within the 0.8s request limit all get a
        real answer, however long they queued."""
        monkeypatch.setattr(platform_liveness, "_PER_REQUEST_SECONDS", 0.8)

        class Slow(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                await asyncio.sleep(0.25)
                return httpx.Response(404, request=request)

        urls = [f"https://careers.a.com/jobs/{i}" for i in range(8)]
        async with make_client(transport=Slow()) as client:
            results = await check_listings(client, urls, concurrency=8)
        assert {r.reason for r in results.values()} == {"http_404"}

    @pytest.mark.asyncio
    async def test_waiting_too_long_for_a_turn_is_deferred_not_a_probe(self, monkeypatch):
        monkeypatch.setattr(platform_liveness, "_GATE_QUEUE_SECONDS", 0.15)
        sent: list[str] = []

        class Slow(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                sent.append(str(request.url))
                await asyncio.sleep(0.4)
                return httpx.Response(404, request=request)

        urls = [f"https://careers.a.com/jobs/{i}" for i in range(5)]
        async with make_client(transport=Slow()) as client:
            results = await check_listings(client, urls, concurrency=8)
        reasons = sorted(r.reason for r in results.values())
        assert reasons == ["gate_queue_timeout"] * 3 + ["http_404"] * 2
        assert len(sent) == 2
        assert all(platform_liveness.is_deferred(r) for r in results.values()
                   if r.reason == "gate_queue_timeout")

    @pytest.mark.asyncio
    async def test_request_that_runs_too_long_is_a_real_timeout(self, monkeypatch):
        monkeypatch.setattr(platform_liveness, "_PER_REQUEST_SECONDS", 0.1)

        class Hang(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                await asyncio.sleep(1)
                return httpx.Response(200, request=request)

        async with make_client(transport=Hang()) as client:
            results = await check_listings(client, ["https://careers.a.com/jobs/1"])
        result = results["https://careers.a.com/jobs/1"]
        assert result == LivenessResult("unknown", "timeout", False)
        assert not platform_liveness.is_deferred(result)  # a request did go out
        assert platform_liveness.is_miss(result)


class TestLinkedInPacing:
    """LinkedIn walls bursts (429 after ~10 quick requests per host) and
    counts www/ca as one client: one gate for every *.linkedin.com host, one
    request at a time with a gap after each, and a per-run budget."""

    @staticmethod
    def _recording_transport(log: list):
        state = {"in_flight": 0, "peak": 0}

        class T(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                state["in_flight"] += 1
                state["peak"] = max(state["peak"], state["in_flight"])
                log.append(("start", request.url.host, asyncio.get_running_loop().time()))
                await asyncio.sleep(0.01)
                state["in_flight"] -= 1
                log.append(("end", request.url.host, asyncio.get_running_loop().time()))
                return httpx.Response(200, text='<a class="apply-button">Apply</a>',
                                      request=request)

        return T(), state

    @pytest.mark.asyncio
    async def test_one_gate_one_at_a_time_and_paced(self, monkeypatch):
        monkeypatch.setattr(platform_liveness, "_LINKEDIN_MIN_INTERVAL", 0.05)
        log: list = []
        transport, state = self._recording_transport(log)
        urls = [f"https://{host}.linkedin.com/jobs/view/{i}"
                for i in range(3) for host in ("www", "ca")]
        async with make_client(transport=transport) as client:
            results = await check_listings(client, urls, concurrency=8,
                                           cache=platform_liveness.run_cache())
        assert len(results) == 6
        assert {r.reason for r in results.values()} == {"linkedin_apply_cta"}
        assert state["peak"] == 1  # www and ca share the one gate
        starts = [t for kind, _host, t in log if kind == "start"]
        ends = [t for kind, _host, t in log if kind == "end"]
        gaps = [start - end for end, start in zip(ends, starts[1:])]
        assert min(gaps) >= 0.045

    @pytest.mark.asyncio
    async def test_per_run_budget_defers_the_rest(self, monkeypatch):
        monkeypatch.setattr(platform_liveness, "_LINKEDIN_MIN_INTERVAL", 0)
        log: list = []
        transport, _state = self._recording_transport(log)
        urls = [f"https://www.linkedin.com/jobs/view/{i}" for i in range(5)]
        urls += ["https://careers.acme.com/jobs/1"]
        async with make_client(transport=transport) as client:
            results = await check_listings(client, urls,
                                           cache=platform_liveness.run_cache(linkedin_cap=2))
        linkedin = [results[url] for url in urls[:5]]
        assert sum(r.reason == "linkedin_apply_cta" for r in linkedin) == 2
        assert sum(r.reason == "host_budget_spent" for r in linkedin) == 3
        assert all(platform_liveness.is_deferred(r) for r in linkedin
                   if r.reason == "host_budget_spent")
        # other hosts are not held to LinkedIn's budget
        assert results[urls[5]].reason == "http_200"

    def test_default_cap_and_uncapped_cache(self):
        assert platform_liveness.LINKEDIN_RUN_CAP == 40
        state = platform_liveness._run_state(platform_liveness.run_cache(linkedin_cap=None))
        assert state.caps == {}


class TestAddressGuard:
    """make_client refuses every hop, redirects included, to a non-public
    address: a posting URL must not bounce the probe into the function's own
    network (loopback, private ranges, link-local metadata, CGNAT)."""

    @staticmethod
    def _dns(monkeypatch, table: dict):
        async def fake_resolve(host, port):
            if host not in table:
                raise OSError("no such host")
            return table[host]

        monkeypatch.setattr(platform_liveness, "_resolve", fake_resolve)

    @staticmethod
    def _guarded(routes: dict):
        transport = Routes(routes)
        return make_client(transport=transport, ssrf_guard=True), transport

    @pytest.mark.asyncio
    async def test_redirect_into_internal_addresses_is_refused(self, monkeypatch):
        self._dns(monkeypatch, {"careers.acme.com": ["93.184.216.34"],
                                "internal.acme.com": ["10.0.0.5"]})
        for target in ("http://127.0.0.1:8799/meta/latest/", "http://169.254.169.254/latest/",
                       "http://100.64.1.1/admin", "http://[::1]:8080/", "http://0.0.0.0/",
                       "http://[::ffff:127.0.0.1]/", "https://internal.acme.com/admin"):
            def redirect(request, target=target):
                if request.url.host == "careers.acme.com":
                    return (302, "", {"location": target})
                return (200, "<html>internal secrets</html>")

            client, transport = self._guarded({"": redirect})
            async with client:
                result = await check_listing(client, "https://careers.acme.com/jobs/12345")
            assert result == LivenessResult("unknown", "blocked_address", False), target
            # the internal hop never reached the transport
            assert transport.requested == ["https://careers.acme.com/jobs/12345"], target

    @pytest.mark.asyncio
    async def test_first_hop_is_guarded_too(self, monkeypatch):
        self._dns(monkeypatch, {"metadata.internal": ["169.254.169.254"]})
        client, transport = self._guarded({"": (200, "x")})
        async with client:
            for url in ("http://169.254.169.254/latest/meta-data/job/12345",
                        "http://metadata.internal/job/12345"):
                result = await check_listing(client, url)
                assert result.reason == "blocked_address", url
        assert transport.requested == []

    @pytest.mark.asyncio
    async def test_public_hosts_pass(self, monkeypatch):
        self._dns(monkeypatch, {"careers.acme.com": ["93.184.216.34", "2606:2800:220:1::1"]})
        client, transport = self._guarded({"": (404, "gone")})
        async with client:
            result = await check_listing(client, "https://careers.acme.com/jobs/12345")
        assert result == LivenessResult("dead", "http_404", False)
        assert transport.requested == ["https://careers.acme.com/jobs/12345"]

    @pytest.mark.asyncio
    async def test_guard_is_on_by_default_and_off_for_test_transports(self):
        async with make_client() as client:
            assert platform_liveness._refuse_internal_hosts in client.event_hooks["request"]
        async with make_client(transport=Routes({})) as client:
            assert client.event_hooks["request"] == []

    @pytest.mark.asyncio
    async def test_empty_and_duplicate_urls(self):
        client, transport = _client({"": (404, "")})
        async with client:
            results = await check_listings(client, ["", "https://careers.a.com/jobs/1",
                                                    "https://careers.a.com/jobs/1"])
        assert list(results) == ["https://careers.a.com/jobs/1"]
        assert len(transport.requested) == 1


@pytest.mark.asyncio
async def test_make_client_defaults():
    async with make_client() as client:
        assert client.follow_redirects is True
        assert "Mozilla" in client.headers["user-agent"]
        assert client.timeout.read and client.timeout.read <= 15
