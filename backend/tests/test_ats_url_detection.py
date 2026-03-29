"""
Tests for ATS URL detection functions: is_greenhouse(), is_lever(), is_workday().
Requirements: 12.2, 13.2, 14.2
"""

import pytest

from backend.bot.ats_greenhouse import is_greenhouse
from backend.bot.ats_lever import is_lever
from backend.bot.ats_workday import is_workday


# ── is_greenhouse ────────────────────────────────────────────


class TestIsGreenhouse:
    """Req 12.2: Detect Greenhouse forms by URL patterns."""

    @pytest.mark.parametrize("url", [
        "https://boards.greenhouse.io/acme/jobs/12345",
        "https://acme.greenhouse.io/jobs/67890",
        "https://boards.greenhouse.io/company/jobs/99999",
        "https://grnh.se/abc123",
        "https://BOARDS.GREENHOUSE.IO/ACME/JOBS/1",
        "https://example.com/jobs/apply?ref=greenhouse.io",
    ])
    def test_positive(self, url):
        assert is_greenhouse(url) is True

    @pytest.mark.parametrize("url", [
        "https://jobs.lever.co/acme/12345",
        "https://myworkdayjobs.com/acme",
        "https://www.linkedin.com/jobs/view/12345",
        "https://example.com/careers",
        "",
    ])
    def test_negative(self, url):
        assert is_greenhouse(url) is False


# ── is_lever ─────────────────────────────────────────────────


class TestIsLever:
    """Req 13.2: Detect Lever forms by URL patterns."""

    @pytest.mark.parametrize("url", [
        "https://jobs.lever.co/acme/12345-abcd",
        "https://lever.co/acme/apply",
        "https://JOBS.LEVER.CO/COMPANY/ID",
    ])
    def test_positive(self, url):
        assert is_lever(url) is True

    @pytest.mark.parametrize("url", [
        "https://boards.greenhouse.io/acme/jobs/12345",
        "https://myworkdayjobs.com/acme",
        "https://www.linkedin.com/jobs/view/12345",
        "https://example.com/careers",
        "",
    ])
    def test_negative(self, url):
        assert is_lever(url) is False


# ── is_workday ───────────────────────────────────────────────


class TestIsWorkday:
    """Req 14.2: Detect Workday forms by URL patterns."""

    @pytest.mark.parametrize("url", [
        "https://acme.myworkdayjobs.com/en-US/External/job/12345",
        "https://company.workday.com/apply",
        "https://MYWORKDAYJOBS.COM/acme",
        "https://wd5.myworkdayjobs.com/acme/job/12345",
    ])
    def test_positive(self, url):
        assert is_workday(url) is True

    @pytest.mark.parametrize("url", [
        "https://boards.greenhouse.io/acme/jobs/12345",
        "https://jobs.lever.co/acme/12345",
        "https://www.linkedin.com/jobs/view/12345",
        "https://example.com/careers",
        "",
    ])
    def test_negative(self, url):
        assert is_workday(url) is False


# ── Cross-check: no overlap between detectors ────────────────


class TestNoOverlap:
    """Each ATS URL should only match one detector."""

    def test_greenhouse_url_not_lever_or_workday(self):
        url = "https://boards.greenhouse.io/acme/jobs/12345"
        assert is_greenhouse(url) is True
        assert is_lever(url) is False
        assert is_workday(url) is False

    def test_lever_url_not_greenhouse_or_workday(self):
        url = "https://jobs.lever.co/acme/12345"
        assert is_lever(url) is True
        assert is_greenhouse(url) is False
        assert is_workday(url) is False

    def test_workday_url_not_greenhouse_or_lever(self):
        url = "https://acme.myworkdayjobs.com/en-US/External/job/12345"
        assert is_workday(url) is True
        assert is_greenhouse(url) is False
        assert is_lever(url) is False

# ── _detect_ats_from_apply_url & _classify_url_as_ats ────────
# Requirements: 21.5, 21.6

from backend.bot.linkedin_bot import _detect_ats_from_apply_url, _classify_url_as_ats


class TestClassifyUrlAsAts:
    """Req 21.5: Classify a raw URL into the correct ATS type."""

    @pytest.mark.parametrize("url,expected", [
        ("https://boards.greenhouse.io/acme/jobs/1", "greenhouse"),
        ("https://acme.greenhouse.io/jobs/2", "greenhouse"),
        ("https://grnh.se/abc123", "greenhouse"),
        ("https://jobs.lever.co/acme/12345", "lever"),
        ("https://lever.co/acme/apply", "lever"),
        ("https://acme.myworkdayjobs.com/job/1", "workday"),
        ("https://company.workday.com/apply", "workday"),
        ("https://jobs-acme.icims.com/jobs/1234", "icims"),
        ("https://careers.icims.com/apply", "icims"),
        ("https://careers.smartrecruiters.com/Acme/job1", "smartrecruiters"),
        ("https://jobs.ashbyhq.com/acme/12345", "ashby"),
        ("https://acme.bamboohr.com/careers/123", "bamboohr"),
        ("https://app.jobvite.com/j?id=abc", "jobvite"),
        ("https://acme.taleo.net/careersection/apply", "taleo"),
        ("https://careers.successfactors.com/apply", "successfactors"),
        ("https://example.com/careers", "external"),
        ("https://www.linkedin.com/jobs/view/12345", "external"),
    ])
    def test_classify(self, url, expected):
        assert _classify_url_as_ats(url) == expected

    def test_case_insensitive(self):
        assert _classify_url_as_ats("https://BOARDS.GREENHOUSE.IO/ACME") == "greenhouse"
        assert _classify_url_as_ats("https://JOBS.LEVER.CO/ACME") == "lever"


class TestDetectAtsFromApplyUrl:
    """Req 21.5, 21.6: Detect ATS type from LinkedIn job page HTML."""

    def test_easy_apply_onsite(self):
        html = '<div class="apply-link-onsite">Easy Apply</div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "easy_apply"

    def test_easy_apply_text_hint(self):
        html = '<span>Easy Apply</span>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "easy_apply"

    def test_easy_apply_json_hint(self):
        html = '<script>{"easyApply": true}</script>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "easy_apply"

    def test_greenhouse_via_json(self):
        html = '<div class="offsite-apply">"applyUrl": "https://boards.greenhouse.io/acme/jobs/1"</div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "greenhouse"

    def test_lever_via_json(self):
        html = '<div class="offsite-apply">"companyApplyUrl": "https://jobs.lever.co/acme/abc"</div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "lever"

    def test_workday_via_href(self):
        html = '<div class="offsite-apply"><a href="https://acme.myworkdayjobs.com/job/1">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "workday"

    def test_icims_via_href(self):
        html = '<div class="offsite-apply"><a href="https://jobs-acme.icims.com/jobs/1234/apply">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "icims"

    def test_smartrecruiters_via_href(self):
        html = '<div class="offsite-apply"><a href="https://careers.smartrecruiters.com/Acme/job1">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "smartrecruiters"

    def test_ashby_via_href(self):
        html = '<div class="offsite-apply"><a href="https://jobs.ashbyhq.com/acme/12345">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "ashby"

    def test_bamboohr_via_href(self):
        html = '<div class="offsite-apply"><a href="https://acme.bamboohr.com/careers/123">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "bamboohr"

    def test_jobvite_via_href(self):
        html = '<div class="offsite-apply"><a href="https://app.jobvite.com/j?id=abc">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "jobvite"

    def test_taleo_via_href(self):
        html = '<div class="offsite-apply"><a href="https://acme.taleo.net/careersection/apply">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "taleo"

    def test_successfactors_via_href(self):
        html = '<div class="offsite-apply"><a href="https://careers.successfactors.com/apply">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "successfactors"

    def test_unknown_external(self):
        html = '<div class="offsite-apply"><a href="https://example.com/apply">Apply</a></div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "external"

    def test_no_apply_link_no_easy_apply(self):
        html = '<div>Some random job page content</div>'
        assert _detect_ats_from_apply_url("https://linkedin.com/jobs/1", html) == "external"
