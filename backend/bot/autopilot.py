"""
AutopilotEngine — continuous auto-apply loop.

Scrapes jobs, evaluates them against SmartFilter, applies to qualifying
Easy Apply jobs, and respects daily/weekly limits with randomized delays.

Requirements: 6.1–6.9
"""

import time
import random
import logging
import datetime

from backend.db.database import SessionLocal
from backend.db.models import (
    ScrapedJob, ApplicationRecord, AutopilotRun,
    JobStatus, PendingQuestion, UserSettings,
)
from backend.bot.smart_filter import SmartFilter
from backend.services.task_runner import publish_log

logger = logging.getLogger(__name__)


class AutopilotEngine:
    """Continuous auto-apply engine with configurable limits and delays.

    Usage::

        engine = AutopilotEngine(settings_dict, smart_filter)
        engine.run(task_id)
    """

    def __init__(self, settings: dict, smart_filter: SmartFilter):
        self.settings = settings
        self.smart_filter = smart_filter
        self.daily_limit: int = settings.get("daily_apply_limit", 50)
        self.weekly_limit: int = settings.get("weekly_apply_limit", 200)
        self.delay_min: float = settings.get("apply_delay_min", 30.0)
        self.delay_max: float = settings.get("apply_delay_max", 120.0)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def run(self, task_id: str) -> None:
        """Main autopilot loop: scrape → filter → apply → delay → repeat."""
        from backend.bot.linkedin_bot import scrape_jobs, apply_to_job

        self._publish(task_id, "Autopilot started")

        while True:
            # Check if user disabled autopilot
            if not self._is_enabled():
                self._publish(task_id, "Autopilot disabled by user — stopping")
                break

            db = SessionLocal()
            try:
                # Check daily/weekly limits
                limit_reason = self._check_limits(db)
                if limit_reason:
                    self._publish(task_id, f"Limit reached: {limit_reason} — stopping")
                    self._update_run_status(db, task_id, "limit_reached")
                    break

                # Scrape new jobs
                self._publish(task_id, "Scraping new jobs…")
                try:
                    scrape_jobs(task_id)
                except Exception as exc:
                    self._publish(task_id, f"Scrape error: {exc}")

                # Get unprocessed jobs (new + easy_apply)
                jobs = (
                    db.query(ScrapedJob)
                    .filter(
                        ScrapedJob.status == JobStatus.NEW,
                        ScrapedJob.easy_apply == 1,
                    )
                    .order_by(ScrapedJob.match_score.desc())
                    .all()
                )

                if not jobs:
                    self._publish(task_id, "No new jobs found — waiting before next cycle")
                    self._random_delay()
                    continue

                self._publish(task_id, f"Found {len(jobs)} new jobs to evaluate")

                for job in jobs:
                    # Re-check limits before each application
                    if self._check_limits(db):
                        self._publish(task_id, "Limit reached mid-cycle — stopping")
                        self._update_run_status(db, task_id, "limit_reached")
                        return

                    # Re-check toggle
                    if not self._is_enabled():
                        self._publish(task_id, "Autopilot disabled — stopping")
                        return

                    # Smart filter
                    passes, reason = self.smart_filter.evaluate(job, db)
                    if not passes:
                        job.status = JobStatus.SKIPPED
                        job.skip_reason = reason
                        db.commit()
                        self._publish(task_id, f"Skipped {job.company} — {job.title}: {reason}")
                        self._increment_run_stat(db, task_id, "total_skipped")
                        continue

                    # Check for unresolved PendingQuestions
                    pending = (
                        db.query(PendingQuestion)
                        .filter(
                            PendingQuestion.job_id == job.id,
                            PendingQuestion.answer.is_(None),
                        )
                        .count()
                    )
                    if pending > 0:
                        self._publish(
                            task_id,
                            f"Skipping {job.company} — {job.title}: {pending} unanswered questions",
                        )
                        self._increment_run_stat(db, task_id, "total_waiting")
                        continue

                    # Apply
                    self._publish(task_id, f"Applying to {job.company} — {job.title}")
                    try:
                        # Keep browser session alive during long autopilot runs
                        from backend.bot.linkedin_bot import maybe_keep_alive
                        from backend.services.browser_pool import BrowserSession
                        maybe_keep_alive(BrowserSession.get())

                        result = apply_to_job(task_id, job.id)
                        if result == "applied":
                            self._increment_run_stat(db, task_id, "total_applied")
                        elif result == "waiting_answer":
                            self._increment_run_stat(db, task_id, "total_waiting")
                        else:
                            self._increment_run_stat(db, task_id, "total_failed")
                    except Exception as exc:
                        self._publish(task_id, f"Apply error for job {job.id}: {exc}")
                        self._increment_run_stat(db, task_id, "total_failed")

                    # Random delay between applications
                    self._random_delay()

            finally:
                db.close()

            # Delay before next scrape cycle
            self._random_delay()

        self._publish(task_id, "Autopilot stopped")
        publish_log(task_id, "__DONE__")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _check_limits(self, db) -> str | None:
        """Return a reason string if daily or weekly limit is reached, else None."""
        now = datetime.datetime.utcnow()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_start = today_start - datetime.timedelta(days=now.weekday())

        daily_count = (
            db.query(ApplicationRecord)
            .filter(ApplicationRecord.applied_at >= today_start)
            .count()
        )
        if daily_count >= self.daily_limit:
            return f"daily_limit ({daily_count}/{self.daily_limit})"

        weekly_count = (
            db.query(ApplicationRecord)
            .filter(ApplicationRecord.applied_at >= week_start)
            .count()
        )
        if weekly_count >= self.weekly_limit:
            return f"weekly_limit ({weekly_count}/{self.weekly_limit})"

        return None

    def _random_delay(self) -> None:
        """Sleep for a random duration between configured min and max."""
        delay = random.uniform(self.delay_min, self.delay_max)
        logger.debug("Autopilot delay: %.1fs", delay)
        time.sleep(delay)

    def _is_enabled(self) -> bool:
        """Check if autopilot is still enabled in user settings."""
        db = SessionLocal()
        try:
            s = db.query(UserSettings).filter(UserSettings.id == 1).first()
            return bool(s and s.autopilot_enabled)
        finally:
            db.close()

    def _update_run_status(self, db, task_id: str, status: str) -> None:
        """Update the AutopilotRun record status."""
        run = db.query(AutopilotRun).filter(AutopilotRun.task_id == task_id).first()
        if run:
            run.status = status
            run.stopped_at = datetime.datetime.utcnow()
            db.commit()

    def _increment_run_stat(self, db, task_id: str, field: str) -> None:
        """Increment a counter on the AutopilotRun record."""
        run = db.query(AutopilotRun).filter(AutopilotRun.task_id == task_id).first()
        if run:
            current = getattr(run, field, 0) or 0
            setattr(run, field, current + 1)
            db.commit()

    def _publish(self, task_id: str, msg: str) -> None:
        """Log and publish to SSE stream."""
        logger.info("[autopilot:%s] %s", task_id, msg)
        publish_log(task_id, msg)
