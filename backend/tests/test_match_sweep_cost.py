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
    """A verified user with a resume, i.e. one the cron sweep will score."""
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

    The fake scores 42, deliberately below MATCH_NOTIFY_THRESHOLD. A job that
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
    job.description again, SQLAlchemy silently re-SELECTs the whole row,
    description column and all, once per job, per user, per cron run. That is
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


@pytest.mark.asyncio
async def test_cached_low_scores_do_not_cross_the_wire_again(
    db_session, swept_user, llm_calls
):
    """A job already scored below threshold must not be re-fetched, row and all.

    Memoization (above) stops the re-buying of LLM scores; this pins the other
    half of the bill: a below-threshold job can be neither scored nor emailed,
    so later sweeps must not keep dragging its full row, description included,
    over the wire just to look up a cached number and drop it.
    """
    for i in range(3):
        _make_job(db_session, title=f"Role {i}")

    await match_notifier.sweep_match_alerts(db_session)
    assert len(llm_calls) == 3

    # Empty the identity map so any row the second sweep materializes counts
    # as a fresh load.
    db_session.expunge_all()
    loaded: list = []

    def _record(session, instance):
        if isinstance(instance, ScrapedJob):
            loaded.append(instance)

    event.listen(db_session, "loaded_as_persistent", _record)
    try:
        await match_notifier.sweep_match_alerts(db_session)
    finally:
        event.remove(db_session, "loaded_as_persistent", _record)

    assert len(llm_calls) == 3
    assert loaded == []


@pytest.mark.asyncio
async def test_cached_strong_match_is_still_emailed_without_a_new_llm_call(
    db_session, swept_user, llm_calls
):
    """A banked >=threshold score must still produce the alert on a later run.

    That happens when the score was bought but the email couldn't go out (send
    budget spent, transient Resend failure). The pair is cached and un-notified:
    the sweep must fetch the row and email it from the cache, zero LLM spend.
    """
    job = _make_job(db_session)
    fingerprint = match_notifier._resume_fingerprint("resume body text")
    db_session.add(
        JobMatchScore(
            user_id=swept_user.id,
            job_id=job.id,
            score=91,
            resume_fingerprint=fingerprint,
        )
    )
    db_session.commit()

    result = await match_notifier.sweep_match_alerts(db_session)

    assert llm_calls == []
    assert result["jobs_notified"] == 1
    assert (
        db_session.query(JobMatchNotification)
        .filter_by(user_id=swept_user.id, job_id=job.id)
        .count()
        == 1
    )


@pytest.mark.asyncio
async def test_unparseable_llm_response_is_not_banked_as_zero(
    db_session, swept_user, monkeypatch
):
    """A parse hiccup must cost one wasted call, not a permanent wrong answer.

    compute_breakdown runs for real here; only the HTTP layer is stubbed to
    return garbage. If the resulting zero were banked, this (user, job, resume)
    triple would be silenced forever, a real match never alerted. The sweep
    must skip banking and pay to retry on the next run.
    """
    _make_job(db_session)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None: True,
    )

    calls = []

    async def garbage(self, prompt, system=None, model=None, json_mode=False, op="unknown"):
        calls.append(prompt)
        return "I am not JSON at all"

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", garbage
    )

    await match_notifier.sweep_match_alerts(db_session)
    assert len(calls) == 1
    assert db_session.query(JobMatchScore).count() == 0

    # Nothing banked, so the next run tries again instead of serving the zero.
    await match_notifier.sweep_match_alerts(db_session)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_scoring_runs_on_the_cheap_model(db_session, swept_user, monkeypatch):
    """Sweep scoring must go to OPENAI_MATCH_MODEL (default gpt-4o-mini), in
    JSON mode, not to the flagship OPENAI_MODEL the rewrite flows use."""
    _make_job(db_session)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None: True,
    )

    seen = {}

    async def fake(self, prompt, system=None, model=None, json_mode=False, op="unknown"):
        seen["model"] = model
        seen["json_mode"] = json_mode
        return (
            '{"overall_score": 55, "experience_score": 50, "skill_score": 60,'
            ' "industry_score": 40, "strengths": [], "weaknesses": []}'
        )

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", fake
    )

    await match_notifier.sweep_match_alerts(db_session)

    assert seen["model"] == "gpt-4o-mini"
    assert seen["json_mode"] is True


@pytest.mark.asyncio
async def test_scoring_model_is_env_overridable(db_session, swept_user, monkeypatch):
    """OPENAI_MATCH_MODEL lets prod try a different cheap model without a deploy."""
    _make_job(db_session)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MATCH_MODEL", "gpt-5-nano")
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None: True,
    )

    seen = {}

    async def fake(self, prompt, system=None, model=None, json_mode=False, op="unknown"):
        seen["model"] = model
        return (
            '{"overall_score": 55, "experience_score": 50, "skill_score": 60,'
            ' "industry_score": 40, "strengths": [], "weaknesses": []}'
        )

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", fake
    )

    await match_notifier.sweep_match_alerts(db_session)

    assert seen["model"] == "gpt-5-nano"


# --- LLM outage visibility (2026-09 audit) ----------------------------------
# From 2026-08-12 to at least 2026-09-28 the OpenAI account answered every call
# with 429 billing_not_active. The sweep swallowed each failure, reported
# status "completed", and nobody could tell "no strong matches" from "scored
# nothing for seven weeks".


def _swept(db_session, email, resume):
    """Another verified user with a resume."""
    user = User(email=email, first_name="U", email_verified=True, auth_provider="local")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    db_session.add(ResumeProfileDB(user_id=user.id, raw_text=resume))
    db_session.commit()
    return user


@pytest.mark.asyncio
async def test_account_outage_stops_scoring_and_says_so(
    db_session, swept_user, monkeypatch
):
    from backend.services.openai_service import LLMAccountError

    _swept(db_session, "sweep2@example.com", "another resume")
    for i in range(5):
        _make_job(db_session, title=f"Role {i}")
    calls = []

    async def refused(self, resume_text, job_description):
        calls.append(1)
        raise LLMAccountError("OpenAI rejected the request (billing_not_active).")

    monkeypatch.setattr(
        "backend.services.match_engine.MatchEngine.compute_breakdown", refused
    )

    result = await match_notifier.sweep_match_alerts(db_session)

    # One refused call, not 5 jobs x 2 users of them.
    assert len(calls) == 1
    assert result["status"] == "llm_unavailable"
    assert "billing_not_active" in result["error"]
    assert result["jobs_scored"] == 0
    assert result["scoring_errors"] == 0
    assert db_session.query(JobMatchScore).count() == 0


@pytest.mark.asyncio
async def test_a_real_billing_refusal_reaches_the_breaker(db_session, swept_user, monkeypatch):
    """The same outage through the real MatchEngine and OpenAIService, with only
    the HTTP call faked: exactly the body OpenAI has returned since 2026-08-12.
    Nothing between the API and the sweep may wrap the refusal into something
    the breaker doesn't recognise."""
    import httpx

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    posts = []

    async def post(self, url, **kwargs):  # noqa: ARG001
        posts.append(url)
        return httpx.Response(
            429,
            json={"error": {
                "code": "billing_not_active",
                "type": "billing_not_active",
                "message": "Your account is not active, please check your billing details.",
            }},
            request=httpx.Request("POST", url),
        )

    async def no_sleep(_seconds):
        raise AssertionError("an account refusal must never be retried")

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    monkeypatch.setattr("asyncio.sleep", no_sleep)
    for i in range(4):
        _make_job(db_session, title=f"Role {i}")

    result = await match_notifier.sweep_match_alerts(db_session)

    assert len(posts) == 1
    assert result["status"] == "llm_unavailable"
    assert "billing_not_active" in result["error"]


@pytest.mark.asyncio
async def test_account_outage_still_emails_cached_strong_matches(
    db_session, swept_user, monkeypatch
):
    """Sending needs no model: a strong match banked before the outage still
    goes out even though nothing new can be scored."""
    from backend.services.openai_service import LLMAccountError

    _make_job(db_session, title="Unscored")
    cached_job = _make_job(db_session, title="Cached")
    db_session.add(
        JobMatchScore(
            user_id=swept_user.id,
            job_id=cached_job.id,
            score=91,
            resume_fingerprint=match_notifier._resume_fingerprint("resume body text"),
        )
    )
    db_session.commit()

    async def refused(self, resume_text, job_description):
        raise LLMAccountError("billing_not_active")

    sent = []
    monkeypatch.setattr(
        "backend.services.match_engine.MatchEngine.compute_breakdown", refused
    )
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None, **_kw: sent.append(jobs) or True,
    )

    result = await match_notifier.sweep_match_alerts(db_session)

    assert result["status"] == "llm_unavailable"
    assert result["jobs_notified"] == 1
    assert [j["title"] for j in sent[0]] == ["Cached"]


@pytest.mark.asyncio
async def test_transient_scoring_failures_are_counted_not_silent(
    db_session, swept_user, monkeypatch
):
    _make_job(db_session, title="A")
    _make_job(db_session, title="B")
    calls = []

    async def flaky(self, resume_text, job_description):
        calls.append(1)
        raise ValueError("match response missing overall_score")

    monkeypatch.setattr(
        "backend.services.match_engine.MatchEngine.compute_breakdown", flaky
    )

    result = await match_notifier.sweep_match_alerts(db_session)

    # A one-off failure never stops the run: every job still gets its call.
    assert len(calls) == 2
    assert result["status"] == "completed"
    assert result["scoring_errors"] == 2
    assert result["jobs_scored"] == 0


@pytest.mark.asyncio
async def test_summary_counts_what_was_scored(db_session, swept_user, llm_calls):
    for i in range(3):
        _make_job(db_session, title=f"Role {i}")

    result = await match_notifier.sweep_match_alerts(db_session)

    assert result["status"] == "completed"
    assert result["jobs_scored"] == 3
    assert result["scoring_errors"] == 0
    assert "error" not in result


@pytest.mark.asyncio
async def test_disabled_summary_keeps_every_counter(db_session, monkeypatch):
    monkeypatch.setenv("MATCH_ALERTS_ENABLED", "false")

    result = await match_notifier.sweep_match_alerts(db_session)

    assert result["status"] == "disabled"
    assert result["jobs_scored"] == 0 and result["scoring_errors"] == 0


# --- wall-clock box ----------------------------------------------------------


@pytest.mark.asyncio
async def test_scoring_budget_stops_llm_calls_but_not_cached_sends(
    db_session, swept_user, monkeypatch
):
    """Once CRON_MATCH_BUDGET_S is spent the sweep stops paying and waiting
    (cron-poll has to finish inside Vercel's 300 s), but cached strong matches
    still go out and nothing unscored is banked."""
    monkeypatch.setenv("CRON_MATCH_BUDGET_S", "100")
    cached_job = _make_job(db_session, title="Cached")
    for i in range(4):
        _make_job(db_session, title=f"Role {i}")
    db_session.add(
        JobMatchScore(
            user_id=swept_user.id,
            job_id=cached_job.id,
            score=91,
            resume_fingerprint=match_notifier._resume_fingerprint("resume body text"),
        )
    )
    db_session.commit()

    clock = {"t": 1000.0}
    monkeypatch.setattr(match_notifier, "_now", lambda: clock["t"])
    calls = []

    async def slow(self, resume_text, job_description):
        calls.append(1)
        clock["t"] += 60  # each call eats a minute of retries
        return types.SimpleNamespace(overall_score=42)

    sent = []
    monkeypatch.setattr(
        "backend.services.match_engine.MatchEngine.compute_breakdown", slow
    )
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None, **_kw: sent.append(jobs) or True,
    )

    result = await match_notifier.sweep_match_alerts(db_session)

    # Calls start at +0 s and +60 s; at +120 s the 100 s box is spent.
    assert len(calls) == 2
    assert result["scoring_budget_spent"] is True
    assert result["status"] == "completed"
    assert result["jobs_scored"] == 2
    assert [j["title"] for j in sent[0]] == ["Cached"]
    assert db_session.query(JobMatchScore).count() == 3  # 1 cached + 2 bought


@pytest.mark.asyncio
async def test_scoring_budget_zero_means_no_box(db_session, swept_user, llm_calls, monkeypatch):
    monkeypatch.setenv("CRON_MATCH_BUDGET_S", "0")
    clock = {"t": 0.0}

    def tick():
        clock["t"] += 10_000
        return clock["t"]

    monkeypatch.setattr(match_notifier, "_now", tick)
    for i in range(3):
        _make_job(db_session, title=f"Role {i}")

    result = await match_notifier.sweep_match_alerts(db_session)

    assert len(llm_calls) == 3
    assert result["scoring_budget_spent"] is False
