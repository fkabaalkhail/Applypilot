"""Unit tests for job description extraction."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.services.description_extractor import (
    compose_jobright_description,
    extract_description_from_html,
    workday_cxs_url,
)


def test_workday_cxs_url():
    public = (
        "https://company.wd1.myworkdayjobs.com/en-US/careers/job/"
        "Remote/Software-Engineer_12345"
    )
    cxs = workday_cxs_url(public)
    assert cxs == (
        "https://company.wd1.myworkdayjobs.com/wday/cxs/company/careers/job/"
        "Remote/Software-Engineer_12345"
    )


def test_compose_jobright_description():
    result = compose_jobright_description(
        {
            "jobSummary": "Build backend services.",
            "coreResponsibilities": ["Design APIs", "Write tests"],
            "qualifications": ["Python", "SQL"],
        }
    )
    assert "Build backend services." in result
    assert "Design APIs" in result
    assert "Python" in result


@pytest.mark.asyncio
async def test_extract_greenhouse_after_redirect():
    client = AsyncMock()
    api_response = MagicMock()
    api_response.status_code = 200
    api_response.json.return_value = {
        "content": "<p>We are hiring a software engineer.</p>" * 5,
    }
    client.get = AsyncMock(return_value=api_response)

    html = "<html><body>Redirecting...</body></html>"
    original = "https://simplify.jobs/c/example"
    final = "https://boards.greenhouse.io/acme/jobs/123456"

    text = await extract_description_from_html(client, original, html, final)
    assert "software engineer" in text.lower()
    client.get.assert_called_once()


@pytest.mark.asyncio
async def test_extract_greenhouse_gh_jid_on_company_site():
    client = AsyncMock()
    api_response = MagicMock()
    api_response.status_code = 200
    api_response.json.return_value = {
        "content": "<p>Build payments infrastructure at global scale.</p>" * 4,
    }

    async def mock_get(url, **kwargs):
        if "boards-api.greenhouse.io" in url:
            return api_response
        raise AssertionError(f"unexpected fetch: {url}")

    client.get = AsyncMock(side_effect=mock_get)

    url = "https://stripe.com/jobs/search?gh_jid=7954688"
    text = await extract_description_from_html(
        client, url, "<html></html>", url
    )
    assert "payments infrastructure" in text.lower()


@pytest.mark.asyncio
async def test_extract_json_ld_array_type():
    client = AsyncMock()
    html = """
    <html><head>
    <script type="application/ld+json">
    {"@type": ["JobPosting", "Occupation"],
     "description": "<p>Join our team to ship features and improve reliability across the platform every week.</p>"}
    </script>
    </head></html>
    """
    text = await extract_description_from_html(
        client,
        "https://example.com/jobs/1",
        html,
        "https://example.com/jobs/1",
    )
    assert "ship features" in text.lower()
    client.get.assert_not_called()


@pytest.mark.asyncio
async def test_extract_json_ld_from_html():
    client = AsyncMock()
    html = """
    <html><head>
    <script type="application/ld+json">
    {"@type": "JobPosting", "description": "<p>Join our team to ship features and improve reliability across the platform every week.</p>"}
    </script>
    </head></html>
    """
    text = await extract_description_from_html(
        client,
        "https://example.com/jobs/1",
        html,
        "https://example.com/jobs/1",
    )
    assert "ship features" in text.lower()
    client.get.assert_not_called()


@pytest.mark.asyncio
async def test_extract_lever_api():
    client = AsyncMock()
    api_response = MagicMock()
    api_response.status_code = 200
    api_response.json.return_value = {
        "descriptionPlain": "Own the frontend platform and partner with design on every customer-facing release.",
        "lists": [{"text": "Requirements", "content": "<li>React</li>"}],
    }
    client.get = AsyncMock(return_value=api_response)

    url = "https://jobs.lever.co/acme/abc12345-6789-abcd-ef01-234567890abc"
    text = await extract_description_from_html(client, url, "<html></html>", url)
    assert "frontend platform" in text.lower()
    assert "React" in text
