"""Cost-control tests for the recurring match-alert sweep.

The sweep runs on the scrape cron whether or not anyone opens the app, and every
scored job is a paid LLM call. These tests pin the two guards that keep that
bill bounded: an explicit kill switch, and memoization so a given
(user, job, resume) triple is never scored more than once.
"""

import datetime
import types

import pytest
from sqlalchemy import event

from backend.db.models import (
    JobMatchNotification,
    JobMatchScore,
    ResumeProfileDB,
    ScrapedJob,
    User,
)
from backend.services import match_notifier


@pytest.fixture
def swept_user(db_session):
    """A verified user with a resume — i.e. one the cron sweep will score."""
    user = User(
        email="sweep@example.com",
        first_name="Sweep",
        email_verified=True,
        auth_provider="local",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    db_session.add(ResumeProfileDB(user_id=user.id, raw_text="resume body text"))
    db_session.commit()
    return user


def _make_job(db_session, title="Engineer", company="Globex"):
    job = ScrapedJob(
        title=title,
        company=company,
        url=f"https://jobs.example.com/{title}-{company}".replace(" ", "-"),
        description="x" * 200,
        posted_date=datetime.datetime.utcnow(),
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


@pytest.fixture
def llm_calls(monkeypatch):
    """Count every paid compute_breakdown call the sweep makes.

    The fake scores 42 — deliberately below MATCH_NOTIFY_THRESHOLD. A job that
    never clears the bar is never emailed, so it never lands in
    job_match_notifications and never puts the user in cooldown. That is exactly
    the case that used to be re-scored, at full price, on every cron run.
    """
    calls = []

    async def fake_breakdown(self, resume_text, job_description):
        calls.append((resume_text, job_description))
        return types.SimpleNamespace(overall_score=42)

    monkeypatch.setattr(
        "backend.services.match_engine.MatchEngine.compute_breakdown", fake_breakdown
    )
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None: True,
    )
    return calls


@pytest.mark.asyncio
async def test_kill_switch_spends_nothing(db_session, swept_user, llm_calls, monkeypatch):
    _make_job(db_session)
    monkeypatch.setenv("MATCH_ALERTS_ENABLED", "false")

    result = await match_notifier.sweep_match_alerts(db_session)

    assert llm_calls == []
    assert result["status"] == "disabled"


@pytest.mark.asyncio
async def test_below_threshold_job_is_scored_once_not_every_run(
    db_session, swept_user, llm_calls
):
    job = _make_job(db_session)

    await match_notifier.sweep_match_alerts(db_session)
    assert len(llm_calls) == 1

    # Second run: neither the job nor the resume changed, so the cached score
    # must be reused rather than bought again.
    await match_notifier.sweep_match_alerts(db_session)
    assert len(llm_calls) == 1

    cached = (
        db_session.query(JobMatchScore)
        .filter_by(user_id=swept_user.id, job_id=job.id)
        .one()
    )
    assert cached.score == 42
    # It stayed below the alert threshold, so nothing was emailed.
    assert db_session.query(JobMatchNotification).count() == 0


@pytest.mark.asyncio
async def test_banking_a_score_does_not_refetch_the_job_rows(
    db_session, swept_user, llm_calls
):
    """Committing a score must not drag every job row back over the wire.

    A commit expires the session's ORM objects. If the scoring loop then reads
    job.description again, SQLAlchemy silently re-SELECTs the whole row —
    description column and all — once per job, per user, per cron run. That is
    the same whole-row-fetch bill this table exists to avoid.
    """
    for i in range(3):
        _make_job(db_session, title=f"Role {i}")

    selects: list[str] = []

    def _record(conn, cursor, statement, params, context, executemany):
        if "FROM scraped_jobs" in statement:
            selects.append(statement)

    bind = db_session.get_bind()
    event.listen(bind, "before_cursor_execute", _record)
    try:
        await match_notifier.sweep_match_alerts(db_session)
    finally:
        event.remove(bind, "before_cursor_execute", _record)

    assert len(llm_calls) == 3
    # Exactly one query picks the candidates; nothing re-reads them afterwards.
    assert len(selects) == 1, (
        f"expected 1 scraped_jobs SELECT, got {len(selects)}:\n" + "\n".join(selects)
    )


@pytest.mark.asyncio
async def test_new_resume_invalidates_the_cached_score(
    db_session, swept_user, llm_calls
):
    _make_job(db_session)

    await match_notifier.sweep_match_alerts(db_session)
    assert len(llm_calls) == 1

    profile = (
        db_session.query(ResumeProfileDB).filter_by(user_id=swept_user.id).one()
    )
    profile.raw_text = "a materially different resume"
    db_session.commit()

    await match_notifier.sweep_match_alerts(db_session)
    assert len(llm_calls) == 2

    # Rescored in place: one row per (user, job), not one per resume revision.
    rows = db_session.query(JobMatchScore).filter_by(user_id=swept_user.id).all()
    assert len(rows) == 1
    assert rows[0].score == 42
