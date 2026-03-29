"""
Tests for Easy Apply helper functions:
  - _detect_already_applied
  - _discard_modal
"""

import sys
from unittest.mock import MagicMock, patch, PropertyMock
import pytest

from backend.db.models import (
    ScrapedJob, ApplicationRecord, ApplicationStatus, JobStatus,
)
from backend.bot.linkedin_bot import _detect_already_applied, _discard_modal


# ── Fixtures ──────────────────────────────────────────────────


@pytest.fixture
def mock_driver():
    """Selenium WebDriver mock."""
    driver = MagicMock()
    body = MagicMock()
    body.text = ""
    driver.find_element.return_value = body
    return driver


@pytest.fixture
def sample_job(db_session):
    """Insert a ScrapedJob and return it."""
    job = ScrapedJob(
        title="Software Engineer",
        company="Acme Corp",
        url="https://www.linkedin.com/jobs/view/12345/",
        status=JobStatus.NEW,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


# ── _detect_already_applied ──────────────────────────────────


class TestDetectAlreadyApplied:
    """Req 3.1–3.4: already-applied and duplicate detection."""

    def test_badge_on_page(self, mock_driver, sample_job, db_session):
        """When page shows 'Already applied', should return True and mark skipped."""
        body = MagicMock()
        body.text = "Some text Already applied to this job"
        mock_driver.find_element.return_value = body

        assert _detect_already_applied(mock_driver, sample_job, db_session) is True
        db_session.refresh(sample_job)
        assert sample_job.status == JobStatus.SKIPPED
        assert sample_job.skip_reason == "already_applied_badge"

    def test_no_badge_no_record(self, mock_driver, sample_job, db_session):
        """When no badge and no existing record, should return False."""
        body = MagicMock()
        body.text = "Apply now for this great role"
        mock_driver.find_element.return_value = body

        assert _detect_already_applied(mock_driver, sample_job, db_session) is False
        db_session.refresh(sample_job)
        assert sample_job.status == JobStatus.NEW

    def test_duplicate_url(self, mock_driver, sample_job, db_session):
        """When ApplicationRecord with same URL exists, should return True."""
        db_session.add(ApplicationRecord(
            platform="linkedin", company="Acme Corp", role="SE",
            url=sample_job.url, status=ApplicationStatus.APPLIED,
        ))
        db_session.commit()

        body = MagicMock()
        body.text = "Apply now"
        mock_driver.find_element.return_value = body

        assert _detect_already_applied(mock_driver, sample_job, db_session) is True
        db_session.refresh(sample_job)
        assert sample_job.skip_reason == "duplicate_url"

    def test_duplicate_job_id(self, mock_driver, sample_job, db_session):
        """When ApplicationRecord with same job_id exists, should return True."""
        db_session.add(ApplicationRecord(
            platform="linkedin", company="Acme Corp", role="SE",
            url="https://other-url.com", status=ApplicationStatus.APPLIED,
            job_id=sample_job.id,
        ))
        db_session.commit()

        body = MagicMock()
        body.text = "Apply now"
        mock_driver.find_element.return_value = body

        assert _detect_already_applied(mock_driver, sample_job, db_session) is True
        db_session.refresh(sample_job)
        assert sample_job.skip_reason == "duplicate_job_id"


# ── _discard_modal ───────────────────────────────────────────


class TestDiscardModal:
    """Req 4.1–4.4: modal discard and failure recovery."""

    def test_dismiss_button_clicked(self, mock_driver, sample_job, db_session):
        """Should try dismiss button and switch back to default content."""
        dismiss_btn = MagicMock()
        dismiss_btn.is_displayed.return_value = True

        # First call: switch_to.default_content (setup)
        # find_element calls: dismiss button found on first CSS selector
        mock_driver.find_element.side_effect = [dismiss_btn]

        _discard_modal(mock_driver, sample_job, db_session, reason="timeout")

        dismiss_btn.click.assert_called_once()
        db_session.refresh(sample_job)
        assert sample_job.status == JobStatus.FAILED
        assert sample_job.skip_reason == "timeout"

    def test_esc_fallback(self, mock_driver, sample_job, db_session):
        """When dismiss button not found, should send ESC key."""
        from selenium.webdriver.common.by import By

        # All CSS selectors for dismiss fail, then body for ESC
        mock_driver.find_element.side_effect = [
            Exception("not found"),  # Dismiss
            Exception("not found"),  # Close
            Exception("not found"),  # artdeco
            MagicMock(),             # body for ESC
            Exception("not found"),  # discard confirm CSS
            Exception("not found"),  # discard XPATH 1
            Exception("not found"),  # discard XPATH 2
            Exception("not found"),  # discard XPATH 3
        ]

        _discard_modal(mock_driver, sample_job, db_session, reason="form_error")

        db_session.refresh(sample_job)
        assert sample_job.status == JobStatus.FAILED

    def test_switches_to_default_content(self, mock_driver):
        """Should always switch back to default content."""
        mock_driver.find_element.side_effect = Exception("not found")

        _discard_modal(mock_driver)

        mock_driver.switch_to.default_content.assert_called()

    def test_no_job_no_db_update(self, mock_driver):
        """When job/db not provided, should not crash."""
        mock_driver.find_element.side_effect = Exception("not found")
        # Should not raise
        _discard_modal(mock_driver, job=None, db=None, reason="test")
