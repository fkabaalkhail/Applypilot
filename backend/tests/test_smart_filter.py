"""
Tests for SmartFilter — property-based and unit tests.

Property 2: A job matching any blacklist rule is always skipped.
Validates: Requirements 7.1–7.11
"""

import pytest
from hypothesis import given, settings as h_settings, assume
from hypothesis import strategies as st

from backend.db.models import (
    ScrapedJob, ApplicationRecord, ApplicationStatus, JobStatus,
)
from backend.bot.smart_filter import SmartFilter, _parse_max_salary


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_job(db_session, **kw):
    defaults = dict(
        title="Engineer", company="Acme Corp", url="https://linkedin.com/jobs/view/999",
        description="We need a Python developer with 3+ years experience.",
        status=JobStatus.NEW, skip_reason="",
    )
    defaults.update(kw)
    job = ScrapedJob(**defaults)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _empty_settings(**overrides):
    base = {
        "company_blacklist": [],
        "keyword_blacklist": [],
        "min_salary": None,
        "max_salary": None,
        "min_experience_years": None,
        "max_experience_years": None,
    }
    base.update(overrides)
    return base


# ===========================================================================
# Property-based tests (Task 8.4)
# ===========================================================================

non_empty_text = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N")),
    min_size=1, max_size=30,
).filter(lambda s: s.strip())


@given(
    company=non_empty_text,
    blacklist_extras=st.lists(non_empty_text, min_size=0, max_size=5),
)
@h_settings(max_examples=200, deadline=None)
def test_property_company_blacklist_always_skips(company, blacklist_extras):
    """Property: A job whose company is in the blacklist is ALWAYS skipped,
    regardless of other filter settings or blacklist size.

    Validates Req 7.6.
    """
    from backend.tests.conftest import TestingSessionLocal
    session = TestingSessionLocal()
    try:
        blacklist = [company] + blacklist_extras
        sf = SmartFilter(_empty_settings(company_blacklist=blacklist))
        job = _make_job(session, company=company)

        passes, reason = sf.evaluate(job, session)

        assert not passes, f"Job at '{company}' should be skipped when company is blacklisted"
        assert "company_blacklisted" in reason
    finally:
        # Clean up the job we created
        session.query(ScrapedJob).filter(ScrapedJob.id == job.id).delete()
        session.commit()
        session.close()


@given(
    keyword=non_empty_text,
    desc_prefix=st.text(min_size=0, max_size=50),
    desc_suffix=st.text(min_size=0, max_size=50),
)
@h_settings(max_examples=200, deadline=None)
def test_property_keyword_blacklist_always_skips(keyword, desc_prefix, desc_suffix):
    """Property: A job whose description contains a blacklisted keyword is
    ALWAYS skipped.

    Validates Req 7.5.
    """
    from backend.tests.conftest import TestingSessionLocal
    session = TestingSessionLocal()
    try:
        description = f"{desc_prefix} {keyword} {desc_suffix}"
        sf = SmartFilter(_empty_settings(keyword_blacklist=[keyword]))
        job = _make_job(session, description=description)

        passes, reason = sf.evaluate(job, session)

        assert not passes, f"Job with keyword '{keyword}' in description should be skipped"
        assert "keyword_blacklisted" in reason
    finally:
        session.query(ScrapedJob).filter(ScrapedJob.id == job.id).delete()
        session.commit()
        session.close()


# ===========================================================================
# Unit tests (Task 8.5)
# ===========================================================================

class TestCompanyBlacklist:
    def test_exact_match_skips(self, db_session):
        sf = SmartFilter(_empty_settings(company_blacklist=["Evil Corp"]))
        job = _make_job(db_session, company="Evil Corp")
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert "company_blacklisted" in reason

    def test_case_insensitive(self, db_session):
        sf = SmartFilter(_empty_settings(company_blacklist=["evil corp"]))
        job = _make_job(db_session, company="Evil Corp")
        passes, reason = sf.evaluate(job, db_session)
        assert not passes

    def test_non_matching_passes(self, db_session):
        sf = SmartFilter(_empty_settings(company_blacklist=["Evil Corp"]))
        job = _make_job(db_session, company="Good Corp")
        passes, _ = sf.evaluate(job, db_session)
        assert passes

    def test_empty_blacklist_passes(self, db_session):
        sf = SmartFilter(_empty_settings(company_blacklist=[]))
        job = _make_job(db_session, company="Any Corp")
        passes, _ = sf.evaluate(job, db_session)
        assert passes


class TestKeywordBlacklist:
    def test_keyword_in_description_skips(self, db_session):
        sf = SmartFilter(_empty_settings(keyword_blacklist=["unpaid"]))
        job = _make_job(db_session, description="This is an unpaid internship.")
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert "keyword_blacklisted" in reason

    def test_case_insensitive(self, db_session):
        sf = SmartFilter(_empty_settings(keyword_blacklist=["UNPAID"]))
        job = _make_job(db_session, description="This is an unpaid internship.")
        passes, reason = sf.evaluate(job, db_session)
        assert not passes

    def test_no_match_passes(self, db_session):
        sf = SmartFilter(_empty_settings(keyword_blacklist=["unpaid"]))
        job = _make_job(db_session, description="Competitive salary offered.")
        passes, _ = sf.evaluate(job, db_session)
        assert passes

    def test_empty_description_passes(self, db_session):
        sf = SmartFilter(_empty_settings(keyword_blacklist=["unpaid"]))
        job = _make_job(db_session, description="")
        passes, _ = sf.evaluate(job, db_session)
        assert passes


class TestSalaryRange:
    def test_salary_below_minimum_skips(self, db_session):
        sf = SmartFilter(_empty_settings(min_salary=100000))
        job = _make_job(db_session)
        job.salary_range = "$60k - $80k"
        db_session.commit()
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert "salary_below_minimum" in reason

    def test_salary_above_minimum_passes(self, db_session):
        sf = SmartFilter(_empty_settings(min_salary=100000))
        job = _make_job(db_session)
        job.salary_range = "$100k - $150k"
        db_session.commit()
        passes, _ = sf.evaluate(job, db_session)
        assert passes

    def test_no_salary_info_passes(self, db_session):
        sf = SmartFilter(_empty_settings(min_salary=100000))
        job = _make_job(db_session)
        job.salary_range = ""
        db_session.commit()
        passes, _ = sf.evaluate(job, db_session)
        assert passes

    def test_no_min_salary_set_passes(self, db_session):
        sf = SmartFilter(_empty_settings(min_salary=None))
        job = _make_job(db_session)
        job.salary_range = "$30k"
        db_session.commit()
        passes, _ = sf.evaluate(job, db_session)
        assert passes


class TestExperienceRange:
    def test_overqualified_skips(self, db_session):
        sf = SmartFilter(_empty_settings(max_experience_years=5))
        job = _make_job(db_session)
        job.experience_years_required = 10
        db_session.commit()
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert "overqualified" in reason

    def test_underqualified_skips(self, db_session):
        sf = SmartFilter(_empty_settings(min_experience_years=5))
        job = _make_job(db_session)
        job.experience_years_required = 2
        db_session.commit()
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert "underqualified" in reason

    def test_within_range_passes(self, db_session):
        sf = SmartFilter(_empty_settings(
            min_experience_years=2, max_experience_years=8,
        ))
        job = _make_job(db_session)
        job.experience_years_required = 5
        db_session.commit()
        passes, _ = sf.evaluate(job, db_session)
        assert passes

    def test_no_experience_info_passes(self, db_session):
        sf = SmartFilter(_empty_settings(max_experience_years=5))
        job = _make_job(db_session)
        job.experience_years_required = None
        db_session.commit()
        passes, _ = sf.evaluate(job, db_session)
        assert passes


class TestAlreadyApplied:
    def test_duplicate_url_skips(self, db_session):
        job = _make_job(db_session, url="https://linkedin.com/jobs/view/123")
        db_session.add(ApplicationRecord(
            platform="linkedin", company="Acme", role="Engineer",
            url="https://linkedin.com/jobs/view/123",
            status=ApplicationStatus.APPLIED,
        ))
        db_session.commit()

        sf = SmartFilter(_empty_settings())
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert reason == "duplicate_url"

    def test_duplicate_job_id_skips(self, db_session):
        job = _make_job(db_session, url="https://linkedin.com/jobs/view/456")
        db_session.add(ApplicationRecord(
            platform="linkedin", company="Acme", role="Engineer",
            url="https://different-url.com",
            status=ApplicationStatus.APPLIED, job_id=job.id,
        ))
        db_session.commit()

        sf = SmartFilter(_empty_settings())
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        assert reason == "duplicate_job_id"

    def test_no_duplicate_passes(self, db_session):
        job = _make_job(db_session, url="https://linkedin.com/jobs/view/789")
        sf = SmartFilter(_empty_settings())
        passes, _ = sf.evaluate(job, db_session)
        assert passes


class TestFullEvaluation:
    def test_all_filters_pass(self, db_session):
        sf = SmartFilter(_empty_settings(
            company_blacklist=["Evil Corp"],
            keyword_blacklist=["unpaid"],
            min_salary=50000,
            min_experience_years=1,
            max_experience_years=10,
        ))
        job = _make_job(db_session, company="Good Corp",
                        description="Great paid role for developers.")
        job.salary_range = "$80k - $120k"
        job.experience_years_required = 3
        db_session.commit()

        passes, reason = sf.evaluate(job, db_session)
        assert passes
        assert reason == ""

    def test_first_failing_check_wins(self, db_session):
        """When multiple filters would fail, the first one checked wins."""
        job = _make_job(db_session, url="https://linkedin.com/jobs/view/dup")
        db_session.add(ApplicationRecord(
            platform="linkedin", company="Acme", role="Engineer",
            url="https://linkedin.com/jobs/view/dup",
            status=ApplicationStatus.APPLIED,
        ))
        db_session.commit()

        sf = SmartFilter(_empty_settings(
            company_blacklist=["Acme Corp"],
            keyword_blacklist=["python"],
        ))
        passes, reason = sf.evaluate(job, db_session)
        assert not passes
        # Already-applied is checked first
        assert reason == "duplicate_url"


class TestParseMaxSalary:
    def test_range_with_k(self):
        assert _parse_max_salary("$100k - $150k") == 150000

    def test_single_value(self):
        assert _parse_max_salary("$80,000") == 80000

    def test_empty_string(self):
        assert _parse_max_salary("") is None

    def test_no_numbers(self):
        assert _parse_max_salary("competitive") is None
