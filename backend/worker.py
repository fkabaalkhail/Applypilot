"""
Celery worker — registers all background tasks.

Start with:
    celery -A backend.worker worker --loglevel=info --pool=solo
"""

import os
from celery import Celery

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery("backend.worker", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_track_started=True,
    worker_hijack_root_logger=False,
)


@celery_app.task(name="backend.worker.scrape_jobs", bind=True)
def scrape_jobs(self):
    """Scrape LinkedIn for job listings."""
    from backend.bot.linkedin_bot import scrape_jobs as _scrape
    _scrape(self.request.id)


@celery_app.task(name="backend.worker.apply_to_job", bind=True)
def apply_to_job(self, job_id: int):
    """Apply to a specific job."""
    from backend.bot.linkedin_bot import apply_to_job as _apply
    _apply(self.request.id, job_id)


@celery_app.task(name="backend.worker.analyze_jobs", bind=True)
def analyze_jobs(self):
    """Fetch descriptions, detect ATS, and score matches."""
    from backend.bot.linkedin_bot import analyze_existing_jobs as _analyze
    _analyze(self.request.id)


@celery_app.task(name="backend.worker.run_autopilot", bind=True)
def run_autopilot(self):
    """Run the autopilot continuous apply loop."""
    from backend.bot.autopilot import AutopilotEngine
    from backend.bot.smart_filter import SmartFilter
    from backend.db.database import SessionLocal
    from backend.db.models import UserSettings

    db = SessionLocal()
    try:
        settings_row = db.query(UserSettings).filter(UserSettings.id == 1).first()
        settings = {c.name: getattr(settings_row, c.name) for c in settings_row.__table__.columns} if settings_row else {}
    finally:
        db.close()

    sf = SmartFilter(settings)
    engine = AutopilotEngine(settings, sf)
    engine.run(self.request.id)


@celery_app.task(name="backend.worker.connect_hiring_managers", bind=True)
def connect_hiring_managers(self, job_id: int):
    """Send connection requests to hiring managers for a job."""
    from backend.bot.linkedin_bot import _connect_with_hiring_managers
    from backend.services.browser_pool import BrowserSession
    from backend.db.database import SessionLocal
    from backend.db.models import ScrapedJob, UserSettings

    db = SessionLocal()
    try:
        job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
        settings_row = db.query(UserSettings).filter(UserSettings.id == 1).first()
        settings = {c.name: getattr(settings_row, c.name) for c in settings_row.__table__.columns} if settings_row else {}

        if not job:
            return

        session = BrowserSession.get()
        session.ensure_logged_in(settings)
        _connect_with_hiring_managers(session.driver, job, settings, db, self.request.id)
    finally:
        db.close()
