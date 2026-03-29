"""
Additional tests for _detect_already_applied and _discard_modal.

Supplements test_easy_apply_helpers.py with edge cases:
  - Multiple badge text variants ("Applied ", "You applied")
  - Driver exception fallthrough to DB check
  - Driver exception with no DB record
  - Discard confirmation dialog handling
  - Custom failure reasons
  - Graceful handling when everything fails

Requirements covered: 3.1–3.4, 4.1–4.4.
"""

import sys
from unittest.mock import MagicMock

import pytest

from selenium.webdriver.common.keys import Keys

from backend.db.models import (
    ScrapedJob, ApplicationRecord, ApplicationStatus, JobStatus,
)
from backend.bot.linkedin_bot import _detect_already_applied, _discard_modal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_job(db_session, url="https://linkedin.com/jobs/view/123", **kw):
    defaults = dict(
        title="Engineer", company="Acme", url=url,
        status=JobStatus.NEW, skip_reason="",
    )
    defaults.update(kw)
    job = ScrapedJob(**defaults)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _mock_driver(body_text=""):
    driver = MagicMock()
    body = MagicMock()
    body.text = body_text
    driver.find_element.return_value = body
    return driver


# ===========================================================================
# _detect_already_applied — edge cases
# ===========================================================================

class TestDetectAlreadyAppliedEdgeCases:

    def test_applied_space_variant(self, db_session):
        """'Applied ' (with trailing space) is one of the marker strings."""
        job = _make_job(db_session)
        driver = _mock_driver("Software Engineer at Acme  Applied  2 days ago")

        assert _detect_already_applied(driver, job, db_session) is True
        assert job.skip_reason == "already_applied_badge"

    def test_you_applied_variant(self, db_session):
        """'You applied' variant also triggers skip."""
        job = _make_job(db_session)
        driver = _mock_driver("You applied on March 10, 2025")

        assert _detect_already_applied(driver, job, db_session) is True
        assert job.skip_reason == "already_applied_badge"

    def test_driver_exception_falls_through_to_db(self, db_session):
        """If driver.find_element raises, DB duplicate check still runs."""
        job = _make_job(db_session)
        db_session.add(ApplicationRecord(
            platform="linkedin", company="Acme", role="Engineer",
            url=job.url, status=ApplicationStatus.APPLIED,
        ))
        db_session.commit()

        driver = MagicMock()
        driver.find_element.side_effect = Exception("stale element")

        assert _detect_already_applied(driver, job, db_session) is True
        assert job.skip_reason == "duplicate_url"

    def test_driver_exception_no_record_returns_false(self, db_session):
        """If driver raises and no DB record exists → not a duplicate."""
        job = _make_job(db_session)
        driver = MagicMock()
        driver.find_element.side_effect = Exception("stale element")

        assert _detect_already_applied(driver, job, db_session) is False
        assert job.status == JobStatus.NEW


# ===========================================================================
# _discard_modal — edge cases
# ===========================================================================

class TestDiscardModalEdgeCases:

    def test_discard_confirmation_dialog_handled(self):
        """4.2 — 'Discard application?' confirmation dialog is clicked."""
        driver = MagicMock()
        dismiss_btn = MagicMock()
        dismiss_btn.is_displayed.return_value = True
        discard_btn = MagicMock()
        discard_btn.is_displayed.return_value = True

        def _find(by, sel):
            if sel == "button[aria-label='Dismiss']":
                return dismiss_btn
            if "discard" in str(sel).lower():
                return discard_btn
            raise Exception("not found")

        driver.find_element.side_effect = _find

        _discard_modal(driver)

        dismiss_btn.click.assert_called_once()
        discard_btn.click.assert_called_once()

    def test_custom_reason_stored(self, db_session):
        """Custom failure reason is persisted in skip_reason."""
        job = _make_job(db_session)
        driver = MagicMock()
        driver.find_element.side_effect = Exception("nope")

        _discard_modal(driver, job=job, db=db_session, reason="form_validation_error")

        db_session.refresh(job)
        assert job.status == JobStatus.FAILED
        assert job.skip_reason == "form_validation_error"

    def test_no_crash_when_everything_fails(self):
        """Graceful handling when all selectors, ESC, and switch_to fail."""
        driver = MagicMock()
        driver.find_element.side_effect = Exception("boom")
        driver.switch_to.default_content.side_effect = Exception("no frame")

        # Should not raise
        _discard_modal(driver)

    def test_default_reason_is_failed(self, db_session):
        """Default reason parameter is 'failed'."""
        job = _make_job(db_session)
        driver = MagicMock()
        driver.find_element.side_effect = Exception("nope")

        _discard_modal(driver, job=job, db=db_session)

        db_session.refresh(job)
        assert job.skip_reason == "failed"
