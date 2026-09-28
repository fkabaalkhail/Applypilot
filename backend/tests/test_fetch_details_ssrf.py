"""POST /jobs/{id}/fetch-details: the SSRF guard covers every request the
page fetch sends, not only the stored URL. A public job page that redirects
into loopback, a private network, carrier NAT or cloud metadata must never
reach it, and the landing page's text must never become the description.

No network: an ``httpx.MockTransport`` serves every request that gets past
the guard, and DNS is monkeypatched.
"""

import socket

import httpx
import pytest

from backend.db.models import ScrapedJob
from backend.routers import jobs as jobs_router

JOB_URL = "https://jobs.example.com/job/123456"
SECRET_PAGE = "<html><body>AccessKeyId=ASIAEXAMPLE SecretAccessKey=abc123</body></html>"
JOB_PAGE = "<html><body><h1>Software Engineer Intern</h1>Build things.</body></html>"

# Hostnames that resolve inside; everything else resolves to a public address.
_INTERNAL_DNS = {
    "intranet.example": "10.0.0.5",
    "cgnat.example": "100.64.1.1",
    "metadata.example": "169.254.169.254",
}


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    def fake_getaddrinfo(host, *args, **kwargs):
        address = _INTERNAL_DNS.get(host, "93.184.216.34")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


def _serve(monkeypatch, handler):
    """Route fetch-details through its real client (guard included) over a
    MockTransport; returns every URL the transport was asked for."""
    seen: list[str] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return handler(request)

    real_client = jobs_router._details_client
    monkeypatch.setattr(
        jobs_router, "_details_client",
        lambda: real_client(transport=httpx.MockTransport(recording)),
    )
    return seen


def _echo_extractor(monkeypatch):
    """The extractor returns the page it was given, so a leak would land in
    the stored description."""
    async def fake_extract(client, url, html, final_url):
        return html

    monkeypatch.setattr(jobs_router, "extract_description_from_html", fake_extract)


def _job(db_session, url=JOB_URL):
    job = ScrapedJob(url=url, title="Software Engineer Intern", company="Acme",
                     description="", source_platform="ats", listing_status="active")
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _reload(db_session, job_id):
    db_session.expire_all()
    return db_session.get(ScrapedJob, job_id)


@pytest.mark.parametrize("target", [
    "http://127.0.0.1:8799/meta/latest/",
    "http://169.254.169.254/latest/meta-data/iam/",
    "http://[::1]:9001/2018-06-01/runtime/invocation/next",
    "http://10.1.2.3/admin",
    "http://100.64.1.1/",
    "http://intranet.example/hr",
    "http://cgnat.example/",
    "http://metadata.example/latest/",
])
def test_redirect_into_a_non_public_address_is_never_followed(
    client, db_session, monkeypatch, target,
):
    _echo_extractor(monkeypatch)
    seen = _serve(monkeypatch, lambda request: (
        httpx.Response(302, headers={"location": target})
        if request.url.host == "jobs.example.com"
        else httpx.Response(200, text=SECRET_PAGE)
    ))
    job = _job(db_session)

    body = client.post(f"/jobs/{job.id}/fetch-details").json()

    assert seen == [JOB_URL]  # the internal hop never left the process
    assert "SecretAccessKey" not in body["description"]
    assert (body["dead"], body["listing_status"]) == (False, "active")
    row = _reload(db_session, job.id)
    assert row.description == ""
    assert row.listing_status == "active"


def test_a_follow_up_request_on_the_same_client_is_guarded(client, db_session, monkeypatch):
    # The extractor (and the platform check) reuse fetch-details' client.
    async def fetching_extract(fetch_client, url, html, final_url):
        response = await fetch_client.get("http://169.254.169.254/latest/meta-data/")
        return response.text

    monkeypatch.setattr(jobs_router, "extract_description_from_html", fetching_extract)
    seen = _serve(monkeypatch, lambda request: (
        httpx.Response(200, text=JOB_PAGE) if request.url.host == "jobs.example.com"
        else httpx.Response(200, text=SECRET_PAGE)
    ))
    job = _job(db_session)

    body = client.post(f"/jobs/{job.id}/fetch-details").json()

    assert seen == [JOB_URL]
    assert "SecretAccessKey" not in body["description"]
    assert _reload(db_session, job.id).description == ""


def test_public_redirect_is_still_followed(client, db_session, monkeypatch):
    _echo_extractor(monkeypatch)
    moved = "https://www.example.com/careers/job/123456"
    seen = _serve(monkeypatch, lambda request: (
        httpx.Response(301, headers={"location": moved})
        if request.url.host == "jobs.example.com"
        else httpx.Response(200, text=JOB_PAGE)
    ))
    job = _job(db_session)

    body = client.post(f"/jobs/{job.id}/fetch-details").json()

    assert seen == [JOB_URL, moved]
    assert body["apply_url"] == moved
    assert "Software Engineer Intern" in _reload(db_session, job.id).description


@pytest.mark.parametrize("address", ["100.64.1.1", "198.18.0.1", "192.0.0.8", "::ffff:127.0.0.1"])
def test_guard_rejects_non_global_ranges(address):
    assert jobs_router._ip_is_internal(address)
    host = f"[{address}]" if ":" in address else address
    assert not jobs_router._is_url_allowed(f"http://{host}/")


def test_guard_keeps_public_hosts():
    assert not jobs_router._ip_is_internal("93.184.216.34")
    assert jobs_router._is_url_allowed(JOB_URL)
