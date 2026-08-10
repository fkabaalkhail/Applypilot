"""Connector parsing pinned against saved board payloads (one per platform).

These are the fixtures that catch a source changing its response shape, the
classic silent-failure mode where a parser starts returning zero jobs and
nobody notices until the catalogue goes stale.
"""

import json
from pathlib import Path

import httpx
import pytest

from backend.data import company_registry
from backend.services.ats_scraper import (
    ATSScraper,
    fetch_workday_detail,
    workday_public_base,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FixtureTransport(httpx.AsyncBaseTransport):
    """Route by URL fragment; a list value pages by call order (Workday)."""

    def __init__(self, responses: dict):
        self.responses = responses
        self.requests: list[httpx.Request] = []
        self._page_counts: dict[str, int] = {}

    async def handle_async_request(self, request):
        self.requests.append(request)
        for fragment, payload in self.responses.items():
            if fragment in str(request.url):
                if isinstance(payload, list) and payload and isinstance(payload[0], dict) \
                        and "jobPostings" in payload[0]:
                    index = self._page_counts.get(fragment, 0)
                    self._page_counts[fragment] = index + 1
                    page = payload[min(index, len(payload) - 1)]
                    return httpx.Response(200, json=page)
                return httpx.Response(200, json=payload)
        return httpx.Response(404, json={})


def _unfiltered() -> ATSScraper:
    return ATSScraper(filter_entry_level=False, filter_north_america=False)


def _filtered() -> ATSScraper:
    return ATSScraper(filter_entry_level=True, filter_north_america=True)


# ─── Greenhouse ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_greenhouse_fixture_parses_ids_salary_and_content():
    transport = FixtureTransport({"boards-api.greenhouse.io": _load("greenhouse_board.json")})
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _unfiltered().scrape_board(client, "greenhouse", "acme", "Acme")

    assert snapshot.board_key == "greenhouse:acme"
    assert snapshot.complete
    assert len(snapshot.jobs) == 3
    intern = next(j for j in snapshot.jobs if "Intern" in j.title)
    assert intern.external_id == "4285367"
    assert intern.url == "https://boards.greenhouse.io/acme/jobs/4285367"
    assert "Python" in intern.description
    assert "45000-55000 CAD" == intern.salary_text
    assert intern.posted_date is not None


@pytest.mark.asyncio
async def test_greenhouse_snapshot_all_urls_includes_filtered_out_jobs():
    """The senior role fails the entry-level filter but its URL must stay in
    all_urls, reconciliation would otherwise mark live jobs as removed."""
    transport = FixtureTransport({"boards-api.greenhouse.io": _load("greenhouse_board.json")})
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _filtered().scrape_board(client, "greenhouse", "acme", "Acme")

    filtered_titles = {j.title for j in snapshot.jobs}
    assert "Senior Staff Architect" not in filtered_titles
    assert "https://boards.greenhouse.io/acme/jobs/4285368" in snapshot.all_urls
    assert len(snapshot.all_urls) == 3


# ─── Lever ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_lever_fixture_parses_commitment_and_salary():
    transport = FixtureTransport({"api.lever.co": _load("lever_board.json")})
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _unfiltered().scrape_board(client, "lever", "acme", "Acme")

    assert len(snapshot.jobs) == 3
    new_grad = next(j for j in snapshot.jobs if "New Grad" in j.title)
    assert new_grad.external_id == "a1b2c3d4-0001"
    assert new_grad.employment_type == "Full-time"
    assert "90000-110000 CAD" in new_grad.salary_text
    assert "TypeScript" in new_grad.description

    intern = next(j for j in snapshot.jobs if "Intern" in j.title)
    assert intern.employment_type == "Intern"


# ─── Ashby ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ashby_fixture_parses_employment_and_compensation():
    transport = FixtureTransport({"api.ashbyhq.com": _load("ashby_board.json")})
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _unfiltered().scrape_board(client, "ashby", "acme", "Acme")

    assert len(snapshot.jobs) == 2
    intern = next(j for j in snapshot.jobs if "Intern" in j.title)
    assert intern.external_id == "f47ac10b-0001"
    assert intern.employment_type == "Intern"
    assert "per hour" in intern.salary_text
    assert "<p>" not in intern.description


# ─── SmartRecruiters ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_smartrecruiters_fixture_parses_and_reports_complete():
    transport = FixtureTransport({"api.smartrecruiters.com": _load("smartrecruiters_board.json")})
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _unfiltered().scrape_board(client, "smartrecruiters", "Acme", "Acme")

    assert snapshot.complete
    assert snapshot.total_listed == 2
    intern = next(j for j in snapshot.jobs if "Intern" in j.title)
    assert intern.external_id == "744000012345"
    assert intern.employment_type == "Intern"
    assert "Montreal" in intern.location


# ─── Workday ─────────────────────────────────────────────────────────────────

@pytest.fixture
def workday_registry(monkeypatch):
    monkeypatch.setattr(
        company_registry, "load_workday_bases",
        lambda: {"acmebank": "https://acmebank.wd3.myworkdayjobs.com/wday/cxs/acmebank/external"},
    )


@pytest.mark.asyncio
async def test_workday_fixture_pages_and_parses(workday_registry):
    transport = FixtureTransport({
        "/wday/cxs/acmebank/external/jobs": [
            _load("workday_board_page1.json"),
            _load("workday_board_page2.json"),
            {"total": 23, "jobPostings": []},
        ],
    })
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _unfiltered().scrape_board(client, "workday", "acmebank", "Acme Bank")

    assert len(snapshot.jobs) == 3
    assert snapshot.total_listed == 23
    assert not snapshot.complete  # 3 fetched < 23 listed → partial

    coop = next(j for j in snapshot.jobs if "Co-op" in j.title)
    assert coop.external_id == "R-48123"
    assert coop.url == (
        "https://acmebank.wd3.myworkdayjobs.com/external"
        "/job/Toronto-ON-CAN/Software-Developer-Co-op--Fall-2026-_R-48123"
    )
    assert coop.detail_ref.startswith("/job/")
    assert coop.posted_date is not None

    # Pagination sent increasing offsets.
    offsets = [json.loads(r.content)["offset"] for r in transport.requests]
    assert offsets == [0, 20, 40]


@pytest.mark.asyncio
async def test_workday_entry_filter_applies(workday_registry):
    transport = FixtureTransport({
        "/wday/cxs/acmebank/external/jobs": [
            _load("workday_board_page1.json"),
            _load("workday_board_page2.json"),
            {"total": 23, "jobPostings": []},
        ],
    })
    async with httpx.AsyncClient(transport=transport) as client:
        snapshot = await _filtered().scrape_board(client, "workday", "acmebank", "Acme Bank")

    titles = {j.title for j in snapshot.jobs}
    assert "Vice President, Risk Management" not in titles
    assert any("Co-op" in t for t in titles)
    # The VP posting is still on the board as far as reconciliation knows.
    assert any("Vice-President" in u for u in snapshot.all_urls)


@pytest.mark.asyncio
async def test_workday_detail_fetch(workday_registry):
    transport = FixtureTransport({
        "/wday/cxs/acmebank/external/job/": _load("workday_detail.json"),
    })
    async with httpx.AsyncClient(transport=transport) as client:
        detail = await fetch_workday_detail(
            client, "acmebank",
            "/job/Toronto-ON-CAN/Software-Developer-Co-op--Fall-2026-_R-48123",
        )

    assert "Java" in detail["description"]
    assert "<p>" not in detail["description"]
    assert detail["employment_type"] == "Full time"


@pytest.mark.asyncio
async def test_workday_without_template_returns_empty_incomplete(monkeypatch):
    monkeypatch.setattr(company_registry, "load_workday_bases", lambda: {})
    async with httpx.AsyncClient() as client:
        snapshot = await _unfiltered().scrape_board(client, "workday", "nobase", "No Base")
    assert snapshot.jobs == []
    assert not snapshot.complete


def test_workday_public_base_derivation():
    assert workday_public_base(
        "https://bmo.wd3.myworkdayjobs.com/wday/cxs/bmo/external"
    ) == "https://bmo.wd3.myworkdayjobs.com/external"
    assert workday_public_base(
        "https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/"
    ) == "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site"


# ─── Registry gating ─────────────────────────────────────────────────────────

def test_registry_supports_workday_only_with_template():
    companies = company_registry.load_companies()
    workday_slugs = {slug for platform, slug, _ in companies if platform == "workday"}
    bases = company_registry.load_workday_bases()
    # Every supported workday board has a CxS base; none ship without one.
    assert workday_slugs, "expected at least one workday board with a template"
    assert workday_slugs <= set(bases.keys())
