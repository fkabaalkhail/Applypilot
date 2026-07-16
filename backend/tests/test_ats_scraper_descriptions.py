"""ATS scrapers must surface descriptions from the board APIs they already call."""

import httpx
import pytest

from backend.services.ats_scraper import ATSScraper


class MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: dict):
        self.responses = responses
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request):
        self.requests.append(request)
        for fragment, payload in self.responses.items():
            if fragment in str(request.url):
                return httpx.Response(200, json=payload)
        return httpx.Response(404, json={})


@pytest.mark.asyncio
async def test_greenhouse_requests_content_and_captures_description():
    transport = MockTransport({
        "boards-api.greenhouse.io": {"jobs": [{
            "title": "Software Engineer Intern",
            "location": {"name": "Ottawa, Ontario, Canada"},
            "absolute_url": "https://boards.greenhouse.io/acme/jobs/123",
            "updated_at": "2026-07-01T00:00:00Z",
            "departments": [{"name": "Engineering"}],
            "content": "&lt;p&gt;Build &lt;b&gt;great&lt;/b&gt; things all day, every day, with modern tools.&lt;/p&gt;",
        }]},
    })
    scraper = ATSScraper(filter_entry_level=False, filter_north_america=False)
    async with httpx.AsyncClient(transport=transport) as client:
        jobs = await scraper._scrape_greenhouse(client, "acme", "Acme")
    assert jobs[0].description.startswith("Build")
    assert "great" in jobs[0].description
    assert "<" not in jobs[0].description
    assert any("content=true" in str(r.url) for r in transport.requests)


@pytest.mark.asyncio
async def test_lever_captures_description_plain_and_lists():
    transport = MockTransport({
        "api.lever.co": [{
            "text": "New Grad Engineer",
            "categories": {"location": "Toronto, Ontario, Canada"},
            "hostedUrl": "https://jobs.lever.co/acme/abc-123",
            "createdAt": 1750000000000,
            "descriptionPlain": "Do interesting work with a great team every single day.",
            "lists": [{"text": "Requirements", "content": "<li>Python</li><li>SQL</li>"}],
        }],
    })
    scraper = ATSScraper(filter_entry_level=False, filter_north_america=False)
    async with httpx.AsyncClient(transport=transport) as client:
        jobs = await scraper._scrape_lever(client, "acme", "Acme")
    assert "Do interesting work" in jobs[0].description
    assert "Requirements" in jobs[0].description
    assert "Python" in jobs[0].description


@pytest.mark.asyncio
async def test_ashby_captures_description_html():
    transport = MockTransport({
        "api.ashbyhq.com": {"jobs": [{
            "title": "Engineering Intern",
            "location": "Vancouver, British Columbia, Canada",
            "jobUrl": "https://jobs.ashbyhq.com/acme/xyz",
            "publishedAt": "2026-07-01T00:00:00Z",
            "departmentName": "Eng",
            "descriptionHtml": "<p>Ship product with senior mentorship and real ownership.</p>",
        }]},
    })
    scraper = ATSScraper(filter_entry_level=False, filter_north_america=False)
    async with httpx.AsyncClient(transport=transport) as client:
        jobs = await scraper._scrape_ashby(client, "acme", "Acme")
    assert "Ship product" in jobs[0].description
    assert "<p>" not in jobs[0].description
