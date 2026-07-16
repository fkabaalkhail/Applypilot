"""Taleo data-island extraction + Workday CXS query-string fix."""

from urllib.parse import quote

import pytest

from backend.services.description_extractor import (
    _extract_taleo_html,
    extract_description_from_html,
    workday_cxs_url,
)


def test_workday_cxs_url_strips_tracking_params():
    url = ("https://aig.wd1.myworkdayjobs.com/aig/job/GA-Atlanta/"
           "Data-Engineering-Analyst_JR2505609-1?utm_source=vansh&ref=x#top")
    cxs = workday_cxs_url(url)
    assert cxs.startswith("https://aig.wd1.myworkdayjobs.com/wday/cxs/aig/aig/job/")
    assert "?" not in cxs
    assert "#" not in cxs


def test_workday_cxs_url_unchanged_for_clean_urls():
    url = ("https://bmo.wd3.myworkdayjobs.com/external/job/Phoenix-AZ-USA/"
           "Financial-Advisor_R260019074")
    assert workday_cxs_url(url) == (
        "https://bmo.wd3.myworkdayjobs.com/wday/cxs/bmo/external/job/"
        "Phoenix-AZ-USA/Financial-Advisor_R260019074"
    )


def _taleo_page(description_html: str) -> str:
    """Synthetic Taleo careersection page: '!|!'-delimited data island with the
    description percent-encoded, mirroring live agnicoeagle.taleo.net pages."""
    encoded = quote(description_html)
    return (
        "<html><body><script>var apiData = 'meta!|!Job Title!|!"
        + encoded
        + "!|!Ontario!|!144240';</script></body></html>"
    )


REAL_ISH_DESC = (
    "<p><span style=\"font-family:Arial\">Reporting to the Manager, IT Ontario "
    "Operations, you will be a part of the Information Technology Team, working "
    "within a global team of professionals. Your role is to provide technical "
    "expertise for network and voice radio solutions that span across all "
    "operations technology networks, satisfy business requirements, and keep "
    "the mine sites connected around the clock in every season.</span></p>"
    "<ul><li>Provide support for network infrastructure</li>"
    "<li>Coordinate with vendors and internal teams on incidents</li>"
    "<li>Document designs and operating procedures for the region</li></ul>"
)


def test_taleo_island_extracts_description():
    text = _extract_taleo_html(_taleo_page(REAL_ISH_DESC))
    assert "Reporting to the Manager" in text
    assert "network infrastructure" in text
    assert "<" not in text


def test_taleo_ignores_pages_without_island():
    assert _extract_taleo_html("<html><body>No island here</body></html>") == ""


@pytest.mark.asyncio
async def test_extractor_routes_taleo_urls():
    html = _taleo_page(REAL_ISH_DESC)
    text = await extract_description_from_html(
        None,  # client unused on the taleo path
        "https://agnicoeagle.taleo.net/careersection/2/jobdetail.ftl?job=140858&lang=en",
        html,
        "https://agnicoeagle.taleo.net/careersection/2/jobdetail.ftl?job=140858&lang=en",
    )
    assert "Reporting to the Manager" in text
