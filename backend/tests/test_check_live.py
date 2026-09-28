"""Click-time liveness (POST /jobs/{id}/check-live), duplicate deep links
(GET /jobs/{id}) and fetch-details as a liveness read.

No network: platform checks are either stubbed at
``platform_liveness.check_listing`` or served by an ``httpx.MockTransport``,
and DNS for the SSRF guard is monkeypatched to a public address.
"""

import asyncio
import datetime
import socket

import httpx
import pytest

from backend.auth.dependencies import get_verified_user_id
from backend.db.models import CompanyLogo, ScrapedJob
from backend.main import app
from backend.routers import jobs as jobs_router
from backend.services import platform_liveness
from backend.services.platform_liveness import LivenessResult

NOW = datetime.datetime.utcnow


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """Every hostname resolves to a public address, so the SSRF guard passes
    without a real lookup (IP literals are still judged as written)."""

    def fake_getaddrinfo(host, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


@pytest.fixture
def probes(monkeypatch):
    """Stub the platform check: returns the queued result and records URLs
    (and, third, the board_key each check was given)."""
    calls: list[str] = []
    board_keys: list[str] = []
    state = {"result": LivenessResult("unknown", "http_200")}

    async def fake_check_listing(client, url, *, cache=None, board_key=""):
        calls.append(url)
        board_keys.append(board_key)
        result = state["result"]
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(platform_liveness, "check_listing", fake_check_listing)

    def set_result(result):
        state["result"] = result

    return calls, set_result, board_keys


def _job(db_session, url="https://jobs.lever.co/acme/0f7b3c1e-1d2a-4b5c-8d9e-0a1b2c3d4e5f", **fields):
    fields.setdefault("title", "Software Engineer")
    fields.setdefault("company", "Acme")
    job = ScrapedJob(url=url, description="", **fields)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _reload(db_session, job_id):
    db_session.expire_all()
    return db_session.get(ScrapedJob, job_id)


# ─── POST /jobs/{id}/check-live ──────────────────────────────────────────────

class TestCheckLive:
    def test_unknown_job_is_404_with_specific_detail(self, client, probes):
        resp = client.post("/jobs/999999/check-live")
        assert resp.status_code == 404
        # Not FastAPI's bare "Not Found", which the client reads as "no endpoint".
        assert resp.json()["detail"] == "Job not found."
        assert probes[0] == []

    @pytest.mark.parametrize("status", ["removed", "expired"])
    def test_closed_row_answers_dead_without_probing(self, client, db_session, probes, status):
        job = _job(db_session, listing_status=status)

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.status_code == 200
        assert resp.json() == {"id": job.id, "listing_status": status, "verdict": "dead"}
        assert probes[0] == []
        assert _reload(db_session, job.id).last_probed_at is None

    def test_only_a_conclusive_stored_state_answers_without_a_probe(self, client, db_session, probes):
        """A row its board vouched for within a day is alive, no request. A
        recent probe that learned nothing is not an answer: a sweep may have
        been rate-limited on it, so the click asks the platform."""
        fresh = _job(db_session, url="https://example.com/jobs/1",
                     listing_status="active", last_probed_at=NOW() - datetime.timedelta(hours=1),
                     last_seen_at=NOW() - datetime.timedelta(hours=2))
        unseen = _job(db_session, url="https://example.com/jobs/2",
                      listing_status="active", last_probed_at=NOW() - datetime.timedelta(hours=1),
                      last_seen_at=NOW() - datetime.timedelta(days=5))
        stale = _job(db_session, url="https://example.com/jobs/3",
                     listing_status="stale", last_probed_at=NOW() - datetime.timedelta(hours=5),
                     last_seen_at=NOW() - datetime.timedelta(hours=2))
        probes[1](LivenessResult("dead", "lever_api_404", True))

        answers = {
            job.id: client.post(f"/jobs/{job.id}/check-live").json()
            for job in (fresh, unseen, stale)
        }

        assert answers[fresh.id] == {"id": fresh.id, "listing_status": "active", "verdict": "alive"}
        assert answers[unseen.id] == {"id": unseen.id, "listing_status": "removed", "verdict": "dead"}
        assert answers[stale.id] == {"id": stale.id, "listing_status": "removed", "verdict": "dead"}
        assert probes[0] == [unseen.url, stale.url]

    def test_probe_older_than_recheck_window_asks_again(self, client, db_session, probes):
        job = _job(db_session, last_probed_at=NOW() - datetime.timedelta(hours=7))

        client.post(f"/jobs/{job.id}/check-live")

        assert probes[0] == [job.url]

    @pytest.mark.parametrize("reason", [
        "bot_wall_429", "bot_wall_999", "network_error", "timeout", "error",
        "host_skipped", "gate_queue_timeout", "host_budget_spent", "url_not_allowed",
    ])
    def test_a_probe_that_got_no_answer_is_not_recorded(self, client, db_session, probes, reason):
        """A rate limit or a network miss learned nothing: stamping it would
        push the row back in the sweeps' queue as if it had been checked."""
        probes[1](LivenessResult("unknown", reason))
        job = _job(db_session, listing_status="active")

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "active", "verdict": "unknown"}
        assert _reload(db_session, job.id).last_probed_at is None

    def test_board_key_reaches_the_check(self, client, db_session, probes):
        job = _job(db_session, url="https://www.janestreet.com/join-jane-street/apply/1?gh_jid=1",
                   board_key="greenhouse:janestreet")

        client.post(f"/jobs/{job.id}/check-live")

        assert probes[2] == ["greenhouse:janestreet"]

    def test_dead_marks_removed(self, client, db_session, probes):
        probes[1](LivenessResult("dead", "lever_api_404", True))
        job = _job(db_session, listing_status="active")

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "removed", "verdict": "dead"}
        row = _reload(db_session, job.id)
        assert row.listing_status == "removed"
        assert row.listing_status_changed_at is not None
        assert row.last_probed_at is not None

    def test_authoritative_alive_confirms_and_revives(self, client, db_session, probes):
        probes[1](LivenessResult("alive", "lever_api_200", True))
        old_seen = NOW() - datetime.timedelta(days=4)
        job = _job(db_session, listing_status="stale", last_seen_at=old_seen)

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "active", "verdict": "alive"}
        row = _reload(db_session, job.id)
        assert row.listing_status == "active"
        assert row.last_seen_at > old_seen
        assert row.last_probed_at is not None

    def test_weak_alive_only_stamps_probe(self, client, db_session, probes):
        # A LinkedIn page with an apply button is not the platform's word.
        probes[1](LivenessResult("alive", "linkedin_apply_cta"))
        old_seen = NOW() - datetime.timedelta(days=4)
        job = _job(db_session, url="https://www.linkedin.com/jobs/view/4465855955",
                   listing_status="stale", last_seen_at=old_seen)

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "stale", "verdict": "alive"}
        row = _reload(db_session, job.id)
        assert row.listing_status == "stale"
        assert row.last_seen_at == old_seen
        assert row.last_probed_at is not None

    def test_unknown_only_stamps_last_probed_at(self, client, db_session, probes):
        probes[1](LivenessResult("unknown", "bot_wall_403"))
        old_seen = NOW() - datetime.timedelta(days=2)
        job = _job(db_session, listing_status="active", last_seen_at=old_seen)

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "active", "verdict": "unknown"}
        row = _reload(db_session, job.id)
        assert row.listing_status == "active"
        assert row.last_seen_at == old_seen
        assert row.last_probed_at is not None

    def test_repeat_click_after_a_platform_confirmation_is_served_from_the_db(
        self, client, db_session, probes,
    ):
        probes[1](LivenessResult("alive", "lever_api_200", True))
        job = _job(db_session)

        first = client.post(f"/jobs/{job.id}/check-live").json()
        second = client.post(f"/jobs/{job.id}/check-live").json()

        assert first["verdict"] == second["verdict"] == "alive"
        assert probes[0] == [job.url]

    def test_repeat_click_after_an_inconclusive_probe_asks_again(self, client, db_session, probes):
        job = _job(db_session)

        client.post(f"/jobs/{job.id}/check-live")
        client.post(f"/jobs/{job.id}/check-live")

        assert probes[0] == [job.url, job.url]

    def test_timeout_is_unknown_not_an_error(self, client, db_session, monkeypatch):
        async def slow_check(client, url, *, cache=None, board_key=""):
            await asyncio.sleep(5)
            return LivenessResult("dead", "late")

        monkeypatch.setattr(platform_liveness, "check_listing", slow_check)
        monkeypatch.setattr(jobs_router, "CHECK_LIVE_TIMEOUT_S", 0.05)
        job = _job(db_session, listing_status="active")

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.status_code == 200
        assert resp.json() == {"id": job.id, "listing_status": "active", "verdict": "unknown"}
        row = _reload(db_session, job.id)
        assert row.listing_status == "active"
        assert row.last_probed_at is None  # nothing came back: not a probe

    def test_probe_crash_is_unknown_not_500(self, client, db_session, probes):
        probes[1](RuntimeError("boom"))
        job = _job(db_session)

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.status_code == 200
        assert resp.json()["verdict"] == "unknown"

    def test_private_address_is_never_probed(self, client, db_session, probes):
        job = _job(db_session, url="http://169.254.169.254/latest/meta-data/job/12345")

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json()["verdict"] == "unknown"
        assert probes[0] == []

    def test_requires_authentication(self, client, db_session, probes):
        job = _job(db_session)
        app.dependency_overrides.pop(get_verified_user_id, None)

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.status_code == 401
        assert probes[0] == []

    def test_rate_limit_caps_real_probes_per_user(self, client, db_session, probes, monkeypatch):
        monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
        # The daily cap: a minute bucket could roll over mid-test.
        monkeypatch.setattr(jobs_router, "CHECK_LIVE_PER_DAY", 2)
        probes[1](LivenessResult("alive", "lever_api_200", True))
        rows = [_job(db_session, url=f"https://example.com/jobs/{n}") for n in range(3)]

        codes = [client.post(f"/jobs/{row.id}/check-live").status_code for row in rows]

        assert codes == [200, 200, 429]
        assert len(probes[0]) == 2
        # Answers from stored state are free: a platform-confirmed row still answers.
        assert client.post(f"/jobs/{rows[0].id}/check-live").json()["verdict"] == "alive"
        closed = _job(db_session, url="https://example.com/jobs/closed", listing_status="removed")
        assert client.post(f"/jobs/{closed.id}/check-live").json()["verdict"] == "dead"

    def test_workday_unpublished_end_to_end(self, client, db_session, monkeypatch):
        """Through the real platform_liveness: Workday's CXS S22 is dead."""
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(403, json={"errorCode": "S22", "message": "unpublished"})

        real_make_client = platform_liveness.make_client
        monkeypatch.setattr(
            platform_liveness, "make_client",
            lambda **kw: real_make_client(transport=httpx.MockTransport(handler)),
        )
        job = _job(
            db_session,
            url="https://acme.wd5.myworkdayjobs.com/en-US/External/job/Toronto/Engineer_R12345",
        )

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "removed", "verdict": "dead"}
        assert seen and "/wday/cxs/acme/External/job/" in seen[0]

    def test_gh_jid_row_on_a_known_board_is_asked_through_its_api(
        self, client, db_session, monkeypatch,
    ):
        """Jane Street switched its Greenhouse embed off (404 for every open
        posting): a click used to read that as closed and remove the row."""
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.host == "boards-api.greenhouse.io":
                return httpx.Response(200, json={"id": 8631912002, "title": "Trader"})
            return httpx.Response(404, text="Not found")

        real_make_client = platform_liveness.make_client
        monkeypatch.setattr(
            platform_liveness, "make_client",
            lambda **kw: real_make_client(transport=httpx.MockTransport(handler)),
        )
        job = _job(db_session,
                   url="https://www.janestreet.com/join-jane-street/apply/8631912002?gh_jid=8631912002",
                   board_key="greenhouse:janestreet", listing_status="stale",
                   last_seen_at=NOW() - datetime.timedelta(days=3))

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "active", "verdict": "alive"}
        assert seen == ["https://boards-api.greenhouse.io/v1/boards/janestreet/jobs/8631912002"]

    def test_redirect_into_a_private_address_is_refused(self, client, db_session, monkeypatch):
        """The SSRF check used to see only the first URL; a posting that
        redirects into loopback must not be fetched (and its answer must not
        decide the row's fate)."""
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.host == "careers.example.com":
                return httpx.Response(302, headers={"location": "http://127.0.0.1:8799/internal-admin"})
            return httpx.Response(404, text="internal")

        async def public(host, port):
            return ["93.184.216.34"]

        monkeypatch.setattr(platform_liveness, "_resolve", public)
        real_make_client = platform_liveness.make_client
        # The production client, guard included, on a transport that records.
        monkeypatch.setattr(
            platform_liveness, "make_client",
            lambda **kw: real_make_client(transport=httpx.MockTransport(handler), ssrf_guard=True),
        )
        job = _job(db_session, url="https://careers.example.com/job/12345", listing_status="active")

        resp = client.post(f"/jobs/{job.id}/check-live")

        assert resp.json() == {"id": job.id, "listing_status": "active", "verdict": "unknown"}
        assert seen == ["https://careers.example.com/job/12345"]
        assert _reload(db_session, job.id).listing_status == "active"

    def test_route_does_not_shadow_neighbours(self, client, db_session, probes):
        job = _job(db_session)
        # GET on the same path is not a route; the job itself still answers.
        assert client.get(f"/jobs/{job.id}/check-live").status_code == 405
        assert client.get(f"/jobs/{job.id}").json()["id"] == job.id
        assert client.post("/jobs/not-a-number/check-live").status_code == 422


# ─── GET /jobs/{id}: duplicates land on the visible twin ─────────────────────

class TestGetJobCanonical:
    def test_hidden_duplicate_returns_canonical_twin(self, client, db_session):
        canonical = _job(db_session, url="https://jobs.lever.co/acme/1111", listing_status="active")
        twin = _job(db_session, url="https://www.linkedin.com/jobs/view/1", duplicate_of=canonical.id)

        body = client.get(f"/jobs/{twin.id}").json()

        assert body["id"] == canonical.id
        assert body["url"] == canonical.url
        assert body["listing_status"] == "active"

    def test_removed_direct_canonical_still_answers_closed(self, client, db_session):
        # The board removed the employer's own requisition; the LinkedIn
        # mirror of it is closed too, whatever LinkedIn's page still shows.
        canonical = _job(db_session, url="https://jobs.lever.co/acme/2222",
                         source_platform="ats", listing_status="removed")
        twin = _job(db_session, url="https://www.linkedin.com/jobs/view/2", duplicate_of=canonical.id)

        body = client.get(f"/jobs/{twin.id}").json()

        assert body["id"] == canonical.id
        assert body["listing_status"] == "removed"

    @pytest.mark.parametrize("status", ["expired", "removed"])
    def test_closed_aggregator_canonical_leaves_the_duplicate_as_itself(
        self, client, db_session, status,
    ):
        # A live LinkedIn repost hidden behind an older copy that has since
        # aged out or died: the deep link opens the repost, not the closed row.
        canonical = _job(
            db_session, source_platform="linkedin", listing_status=status,
            url="https://www.linkedin.com/jobs/view/software-engineer-ii-at-affirm-4440083739",
            title="Software Engineer II, Data Platform",
        )
        dup = _job(
            db_session, source_platform="linkedin", listing_status="active",
            url="https://www.linkedin.com/jobs/view/software-engineer-ii-at-affirm-4470027097",
            title="Software Engineer II, Identity", duplicate_of=canonical.id,
        )

        body = client.get(f"/jobs/{dup.id}").json()

        assert (body["id"], body["listing_status"], body["title"]) == \
            (dup.id, "active", "Software Engineer II, Identity")

    def test_expired_direct_canonical_leaves_the_duplicate_as_itself(self, client, db_session):
        # Expiry is age or missing evidence, not a death verdict.
        canonical = _job(db_session, url="https://boards.greenhouse.io/acme/jobs/3333",
                         source_platform="ats", listing_status="expired")
        dup = _job(db_session, url="https://www.linkedin.com/jobs/view/3333",
                   source_platform="linkedin", duplicate_of=canonical.id)

        body = client.get(f"/jobs/{dup.id}").json()

        assert (body["id"], body["listing_status"]) == (dup.id, "active")

    def test_missing_twin_falls_back_to_the_row_itself(self, client, db_session):
        orphan = _job(db_session, url="https://www.linkedin.com/jobs/view/3", duplicate_of=987654)

        assert client.get(f"/jobs/{orphan.id}").json()["id"] == orphan.id

    def test_cycle_does_not_loop(self, client, db_session):
        a = _job(db_session, url="https://example.com/a")
        b = _job(db_session, url="https://example.com/b", duplicate_of=a.id)
        a.duplicate_of = b.id
        db_session.commit()

        assert client.get(f"/jobs/{a.id}").status_code == 200

    def test_plain_row_and_removed_row_answer_as_is(self, client, db_session):
        plain = _job(db_session, url="https://example.com/plain")
        closed = _job(db_session, url="https://example.com/closed", listing_status="expired")

        assert client.get(f"/jobs/{plain.id}").json()["id"] == plain.id
        body = client.get(f"/jobs/{closed.id}").json()
        assert (body["id"], body["listing_status"]) == (closed.id, "expired")


# ─── POST /jobs/{id}/fetch-details as a liveness read ────────────────────────

def _serve(monkeypatch, handler):
    """Route fetch-details' page fetch (and any platform check it makes on
    the same client) through ``handler``."""
    seen: list[str] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return handler(request)

    monkeypatch.setattr(
        jobs_router, "_details_client",
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(recording), follow_redirects=True,
        ),
    )
    return seen


def _stub_extractor(monkeypatch, text="A real job description. " * 5):
    async def fake_extract(client, url, html, final_url):
        return text

    monkeypatch.setattr(jobs_router, "extract_description_from_html", fake_extract)


class TestFetchDetailsLiveness:
    def test_error_landing_marks_removed_and_keeps_apply_url(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch)
        url = "https://jobs.bombardier.com/job/11101"

        def handler(request):
            if request.url.path == "/job/11101":
                return httpx.Response(
                    302, headers={"location": "https://jobs.bombardier.com/errorpage/?errortype=404"},
                )
            return httpx.Response(200, text="<html><body>Oops</body></html>")

        seen = _serve(monkeypatch, handler)
        job = _job(db_session, url=url)

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert body["dead"] is True
        assert body["listing_status"] == "removed"
        assert body["apply_url"] == url  # never the error page
        # The landing alone is proof: no second look through the platform check.
        assert seen == [url, "https://jobs.bombardier.com/errorpage/?errortype=404"]
        row = _reload(db_session, job.id)
        assert row.listing_status == "removed"
        assert row.last_probed_at is not None
        assert row.description == ""  # the error page is not a description

    def test_http_404_marks_removed(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch)
        _serve(monkeypatch, lambda request: httpx.Response(404, text="gone"))
        job = _job(db_session, url="https://careers.example.com/job/55555")

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert (body["dead"], body["listing_status"]) == (True, "removed")

    def test_bot_wall_is_not_death(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch, text="")
        _serve(monkeypatch, lambda request: httpx.Response(403, text="Access denied"))
        job = _job(db_session, url="https://careers.example.com/job/66666")

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert body["dead"] is False
        assert _reload(db_session, job.id).listing_status == "active"

    def test_indeed_is_never_judged(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch, text="")
        _serve(monkeypatch, lambda request: httpx.Response(404, text="Authenticating..."))
        job = _job(db_session, url="https://ca.indeed.com/viewjob?jk=abc123def456")

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert body["dead"] is False
        assert _reload(db_session, job.id).listing_status == "active"

    def test_offsite_careers_home_bounce_is_judged_by_platform_check(
        self, client, db_session, monkeypatch,
    ):
        _stub_extractor(monkeypatch)
        url = "https://careers.revionics.com/job/82935"

        def handler(request):
            if request.url.host == "careers.revionics.com":
                return httpx.Response(302, headers={"location": "https://www.aptos.com/careers"})
            return httpx.Response(200, text="<html><body><h1>Join us</h1></body></html>")

        seen = _serve(monkeypatch, handler)
        job = _job(db_session, url=url)

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert body["dead"] is True
        assert body["apply_url"] == url
        assert _reload(db_session, job.id).listing_status == "removed"
        # The page fetch, then platform_liveness' own look at the same URL.
        assert seen.count(url) == 2

    def test_bounce_the_platform_calls_alive_keeps_row_and_original_url(
        self, client, db_session, monkeypatch, probes,
    ):
        # SmartRecruiters careers links bounce to the company site even when
        # the posting is open; its API is what decides.
        probes[1](LivenessResult("alive", "smartrecruiters_api_200", True))
        _stub_extractor(monkeypatch)
        url = "https://careers.smartrecruiters.com/Bosch/744000012345678"
        _serve(monkeypatch, lambda request: (
            httpx.Response(302, headers={"location": "https://www.bosch.com/careers/"})
            if request.url.host == "careers.smartrecruiters.com"
            else httpx.Response(200, text="<html><body>Careers at Bosch</body></html>")
        ))
        job = _job(db_session, url=url)

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert body["dead"] is False
        assert body["listing_status"] == "active"
        assert body["apply_url"] == url  # not the careers homepage
        assert probes[0] == [url]

    def test_redirect_that_keeps_the_posting_id_is_adopted(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch)
        _serve(monkeypatch, lambda request: (
            httpx.Response(301, headers={"location": "https://www.example.com/careers/job/77777"})
            if request.url.host == "example.com"
            else httpx.Response(200, text="<html><body>Engineer</body></html>")
        ))
        job = _job(db_session, url="https://example.com/job/77777")

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert body["dead"] is False
        assert body["apply_url"] == "https://www.example.com/careers/job/77777"

    def test_linkedin_closed_banner_marks_removed(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch)
        page = (
            '<html><body><figure class="closed-job"><figcaption class="closed-job__flavor--closed">'
            "No longer accepting applications</figcaption></figure></body></html>"
        )
        _serve(monkeypatch, lambda request: httpx.Response(200, text=page))
        job = _job(db_session, url="https://www.linkedin.com/jobs/view/4465855955")

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert (body["dead"], body["listing_status"]) == (True, "removed")

    def test_never_writes_og_image_or_apistemic_logos(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch)
        page = (
            '<html><head><meta property="og:image" content="https://cdn.example.com/share-1200x630.jpg">'
            '<meta property="og:title" content="Acme hiring Engineer in Toronto | LinkedIn">'
            "</head><body>Engineer</body></html>"
        )
        _serve(monkeypatch, lambda request: httpx.Response(200, text=page))
        job = _job(db_session, url="https://www.linkedin.com/jobs/view/123456789",
                   company="", company_logo="")

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        row = _reload(db_session, job.id)
        assert row.company == "Acme"
        assert row.company_logo == ""
        assert body["company_logo"] == ""

    def test_missing_logo_comes_from_the_store_or_linkedin(self, client, db_session, monkeypatch):
        _stub_extractor(monkeypatch)
        sha = "ab" * 20
        db_session.add(CompanyLogo(company_key="acme", display_name="Acme", status="ok",
                                   sha=sha, fmt="png"))
        db_session.commit()
        licdn = ("https://media.licdn.com/dms/image/v2/C4E0BAQ/company-logo_100_100/0/1?"
                 "e=2147483647&amp;v=beta&amp;t=abc")
        other = "https://media.licdn.com/dms/image/v2/D4E0OTHER/company-logo_100_100/0/2"
        page = (
            # Another employer's card first (a similar-jobs strip), then ours.
            f'<html><body><img class="artdeco-entity-image" data-delayed-url="{other}" alt="Initech">'
            f'<img class="artdeco-entity-image artdeco-entity-image--square-5" '
            f'data-delayed-url="{licdn}" alt="Globex"></body></html>'
        )
        _serve(monkeypatch, lambda request: httpx.Response(200, text=page))
        stored = _job(db_session, url="https://www.linkedin.com/jobs/view/111111111",
                      company="**Acme**",
                      company_logo="https://www.google.com/s2/favicons?domain=acme.com&sz=128")
        hotlinked = _job(db_session, url="https://www.linkedin.com/jobs/view/222222222",
                         company="Globex", company_logo="")

        assert client.post(f"/jobs/{stored.id}/fetch-details").json()["company_logo"] == \
            f"/jobs/logo/{sha}.png"
        assert client.post(f"/jobs/{hotlinked.id}/fetch-details").json()["company_logo"] == \
            licdn.replace("&amp;", "&")

    def test_existing_description_answers_with_listing_state(self, client, db_session, monkeypatch):
        _serve(monkeypatch, lambda request: pytest.fail("no fetch expected"))
        job = _job(db_session, url="https://example.com/job/88888", listing_status="expired")
        job.description = "A long enough stored description for the posting. " * 3
        db_session.commit()

        body = client.post(f"/jobs/{job.id}/fetch-details").json()

        assert (body["dead"], body["listing_status"]) == (True, "expired")
        assert body["apply_url"] == job.url


def test_linkedin_logo_needs_a_usable_company_name():
    """A blank or placeholder company has nothing to match the alt text
    against, so no image on the page (possibly another employer's card after
    an expired-job redirect) may be taken as its logo."""
    from backend.routers.jobs import _linkedin_company_logo

    licdn = ("https://media.licdn.com/dms/image/v2/C4E0BAQ/company-logo_100_100/0/1?"
             "e=2147483647&amp;v=beta&amp;t=abc")
    page = (f'<html><body><img class="artdeco-entity-image" '
            f'data-delayed-url="{licdn}" alt="Initech"></body></html>')
    assert _linkedin_company_logo(page, "") == ""
    assert _linkedin_company_logo(page, "nan") == ""
    assert _linkedin_company_logo(page, "Initech").startswith("https://media.licdn.com/")
