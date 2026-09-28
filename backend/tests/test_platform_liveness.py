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


async def _check(routes: dict, url: str) -> tuple[LivenessResult, list[str]]:
    client, transport = _client(routes)
    async with client:
        result = await check_listing(client, url)
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


class TestAshby:
    @pytest.mark.asyncio
    async def test_board_membership_and_one_fetch_per_org(self):
        client, transport = _client({
            "api.ashbyhq.com/posting-api/job-board/zip": (200, {"jobs": [{"id": ASHBY_LIVE}]}),
        })
        async with client:
            results = await check_listings(client, [
                f"https://jobs.ashbyhq.com/zip/{ASHBY_LIVE}",
                f"https://jobs.ashbyhq.com/zip/{ASHBY_GONE}/application",
            ])
        assert results[f"https://jobs.ashbyhq.com/zip/{ASHBY_LIVE}"] == LivenessResult(
            "alive", "ashby_listed", True)
        assert results[f"https://jobs.ashbyhq.com/zip/{ASHBY_GONE}/application"] == LivenessResult(
            "dead", "ashby_not_listed", True)
        assert transport.requested == ["https://api.ashbyhq.com/posting-api/job-board/zip"]

    @pytest.mark.asyncio
    async def test_empty_board_is_not_mass_death(self):
        result, _ = await _check({"api.ashbyhq.com": (200, {"jobs": []})},
                                 f"https://jobs.ashbyhq.com/deel/{ASHBY_GONE}/application")
        assert result == LivenessResult("unknown", "ashby_board_empty", False)


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
            "<title>Career Section Unavailable</title>",
            "<div class='status'>Position Closed</div>",
            "<p>Sorry, this position has been filled.</p>",
            "<p>This job is no longer available.</p>",
            "<p>The job you are looking for is no longer available.</p>",
        ):
            result, _ = await _check({"careers.acme.com": (200, body)},
                                     "https://careers.acme.com/jobs/12345")
            assert result == LivenessResult("dead", "body_closed", False), body

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
        assert len(transport.requested) == platform_liveness._HOST_FAILURE_LIMIT
        assert all(r.verdict == "unknown" for r in results.values())

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
