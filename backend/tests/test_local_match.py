"""The free local match scorer and the zero-cost defaults built on it.

Pins: scores rank sensibly, stored terms are computed once per job, an
LLM-confirmed score is never overwritten by a local one, the sweep calls the
LLM at most MATCH_AI_DAILY_PER_USER times per user per day (0 = never), and
opening a job / its description costs nothing by default.
"""

import datetime
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.dependencies import get_current_user_id, get_optional_user_id, get_verified_user_id
from backend.db.database import get_db
from backend.db.models import JobMatchScore, ResumeProfileDB, ScrapedJob, User
from backend.services import local_match as lm
from backend.services import match_notifier

TECH_RESUME = (
    "Jane Doe. Software Engineer Intern at Shopify. Built REST APIs in Python and FastAPI, "
    "React and TypeScript front ends, PostgreSQL, Docker, AWS. BASc Software Engineering."
)
SWE_DESC = (
    "We are hiring a Software Engineer, New Grad. You will build backend services in Python "
    "and React apps in TypeScript, use PostgreSQL and Docker, deploy to AWS, and write tests. "
    "Software engineering fundamentals, APIs, services, backend, frontend."
)
NURSE_DESC = (
    "Registered Nurse, new graduate. Provide patient care in the emergency department, "
    "administer medication, chart patient records, collaborate with physicians. "
    "Nursing license required. Patient safety, clinical care, hospital shifts."
)


def _profile(**kw):
    base = dict(
        raw_text=TECH_RESUME, skills=["Kubernetes"], target_job_title=None, summary_title=None,
        experience=[{"title": "Software Engineer Intern", "start_date": "May 2025", "end_date": "Aug 2025"}],
        education=[{"degree": "BASc Software Engineering"}],
    )
    base.update(kw)
    return types.SimpleNamespace(**base)


# ─── Pure scorer ────────────────────────────────────────────────────────────


def test_fingerprints_differ_and_fit_the_column():
    ai, local = lm.current_fingerprints("text")
    assert ai != local and local.startswith(lm.LOCAL_MODEL_VERSION + ":")
    assert len(ai) <= 64 and len(local) <= 64


def test_relevant_job_scores_far_above_unrelated_job():
    resume = lm.resume_signals(_profile())
    swe = lm.score(resume, lm.job_signals("Software Engineer, New Grad", SWE_DESC, None, "Software Engineering"))
    nurse = lm.score(resume, lm.job_signals("Registered Nurse", NURSE_DESC, None, "Healthcare"))
    assert swe.overall >= 60
    assert nurse.overall <= 30
    assert swe.overall - nurse.overall >= 30
    assert "python" in swe.matched_skills


def test_implied_skills_count_as_shown():
    resume = lm.resume_signals(_profile(raw_text="Built apps with PostgreSQL and Next.js."))
    assert {"sql", "react", "javascript"} <= resume.tags


def test_calibration_is_monotonic_and_bounded():
    outs = [lm._calibrate(x) for x in range(-10, 120)]
    assert outs == sorted(outs)
    assert 0 <= min(outs) and max(outs) <= 100


def test_experience_score_uses_stated_requirement():
    resume = lm.resume_signals(_profile())
    ok = lm.score(resume, lm.job_signals("Software Engineer", SWE_DESC, None, "", None))
    gap = lm.score(resume, lm.job_signals("Software Engineer", SWE_DESC, None, "", 5))
    assert ok.experience_score == 90
    assert gap.experience_score < 50


def test_display_skill():
    assert lm.display_skill("postgresql") == "PostgreSQL"
    assert lm.display_skill("machine learning") == "Machine Learning"


# ─── DB helpers ─────────────────────────────────────────────────────────────


@pytest.fixture
def user_and_resume(db_session):
    user = User(email="local@example.com", first_name="Lo", email_verified=True, auth_provider="local")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    profile = ResumeProfileDB(
        user_id=user.id, raw_text=TECH_RESUME, skills=["Kubernetes"],
        experience=[{"title": "Software Engineer Intern", "start_date": "2025", "end_date": "2025"}],
        education=[{"degree": "BASc Software Engineering"}],
    )
    db_session.add(profile)
    db_session.commit()
    db_session.refresh(profile)
    return user, profile


_n = 0


def _job(db_session, title="Software Engineer, New Grad", description=SWE_DESC, **kw):
    global _n
    _n += 1
    job = ScrapedJob(
        title=title, company=kw.pop("company", "Acme"), url=f"https://jobs.example.com/lm-{_n}",
        description=description, role_category=kw.pop("role_category", "Software Engineering"),
        posted_date=datetime.datetime.utcnow(), **kw,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def test_terms_are_computed_once(db_session):
    j = _job(db_session)
    assert lm.ensure_terms(db_session, [j.id]) == 1
    assert lm.ensure_terms(db_session, [j.id]) == 0
    db_session.refresh(j)
    assert j.match_terms["v"] == lm.TERMS_VERSION and "python" in j.match_terms["tags"]


def test_bank_never_overwrites_an_llm_score(db_session, user_and_resume):
    user, profile = user_and_resume
    confirmed, fresh, stale = _job(db_session), _job(db_session), _job(db_session)
    db_session.add_all([
        JobMatchScore(user_id=user.id, job_id=confirmed.id, score=91,
                      resume_fingerprint=lm.ai_fingerprint(profile.raw_text)),
        JobMatchScore(user_id=user.id, job_id=stale.id, score=12, resume_fingerprint="old-resume"),
    ])
    db_session.commit()
    banked = lm.bank_local_scores(db_session, user.id, profile, [confirmed.id, fresh.id, stale.id])
    assert set(banked) == {fresh.id, stale.id}
    rows = {r.job_id: r for r in db_session.query(JobMatchScore).filter_by(user_id=user.id)}
    assert rows[confirmed.id].score == 91
    assert rows[stale.id].resume_fingerprint == lm.local_fingerprint(profile.raw_text)


# ─── Sweep: free by default, LLM capped ─────────────────────────────────────


@pytest.fixture
def sweep_env(monkeypatch):
    monkeypatch.setenv("MATCH_SCORING", "local")
    calls, sent = [], []

    async def fake_breakdown(self, resume_text, job_description):
        calls.append(job_description)
        return types.SimpleNamespace(overall_score=93)

    monkeypatch.setattr("backend.services.match_engine.MatchEngine.compute_breakdown", fake_breakdown)
    monkeypatch.setattr(
        match_notifier.email_service, "send_job_match_alert",
        lambda to, jobs, name=None, **_kw: sent.append(len(jobs)) or True,
    )
    return calls, sent


@pytest.mark.asyncio
async def test_local_sweep_scores_everything_and_confirms_at_most_n(
    db_session, user_and_resume, sweep_env, monkeypatch
):
    user, _ = user_and_resume
    calls, sent = sweep_env
    monkeypatch.setenv("MATCH_AI_DAILY_PER_USER", "2")
    monkeypatch.setenv("MATCH_AI_CONFIRM_MIN", "0")
    jobs = [_job(db_session) for _ in range(6)] + [_job(db_session, "Registered Nurse", NURSE_DESC)]

    result = await match_notifier.sweep_match_alerts(db_session)
    assert result["scoring_mode"] == "local"
    assert result["jobs_scored"] == len(jobs)
    assert len(calls) == 2 and result["ai_confirmed"] == 2
    # Only the two LLM-confirmed 93s are emailed while confirmation is on.
    assert sent == [2]

    # Same day, allowance spent: no more LLM calls, nothing re-scored.
    result = await match_notifier.sweep_match_alerts(db_session)
    assert len(calls) == 2 and result["jobs_scored"] == 0


@pytest.mark.asyncio
async def test_zero_allowance_never_calls_the_llm(db_session, user_and_resume, sweep_env, monkeypatch):
    calls, _ = sweep_env
    monkeypatch.setenv("MATCH_AI_DAILY_PER_USER", "0")
    for _ in range(3):
        _job(db_session)
    result = await match_notifier.sweep_match_alerts(db_session)
    assert calls == [] and result["jobs_scored"] == 3 and result["ai_confirmed"] == 0


@pytest.mark.asyncio
async def test_unfunded_account_falls_back_to_local_scores(db_session, user_and_resume, sweep_env, monkeypatch):
    from backend.services.openai_service import LLMAccountError

    calls, sent = sweep_env
    monkeypatch.setenv("MATCH_AI_CONFIRM_MIN", "0")
    monkeypatch.setenv("MATCH_NOTIFY_THRESHOLD", "1")  # any local score is "strong"

    async def refused(self, resume_text, job_description):
        calls.append(job_description)
        raise LLMAccountError("insufficient_quota")

    monkeypatch.setattr("backend.services.match_engine.MatchEngine.compute_breakdown", refused)
    _job(db_session)
    result = await match_notifier.sweep_match_alerts(db_session)
    assert len(calls) == 1  # one refused call, then it stops asking
    assert result["status"] == "llm_unavailable"
    assert sent == [1]  # local score emailed, since nothing can confirm it


# ─── Routes: opening a job costs nothing ────────────────────────────────────


@pytest.fixture
def app_client(db_session, user_and_resume, monkeypatch):
    from backend.routers.ai import router as ai_router
    from backend.routers.jobs import router as jobs_router

    user, _ = user_and_resume
    monkeypatch.setenv("MATCH_SCORING", "local")
    monkeypatch.delenv("JOB_STRUCTURE_AI", raising=False)
    app = FastAPI()
    app.include_router(ai_router, prefix="/ai")
    app.include_router(jobs_router, prefix="/jobs")

    def _db():
        yield db_session

    async def _uid():
        return user.id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user_id] = _uid
    app.dependency_overrides[get_verified_user_id] = _uid
    app.dependency_overrides[get_optional_user_id] = _uid

    async def no_llm(*a, **k):
        raise AssertionError("the LLM must not be called")

    monkeypatch.setattr("backend.services.match_engine.MatchEngine.compute_breakdown", no_llm)
    monkeypatch.setattr("backend.services.openai_service.OpenAIService._generate", no_llm, raising=False)
    with TestClient(app) as c:
        yield c


def test_match_breakdown_is_local_and_matches_the_card(app_client, db_session, user_and_resume):
    j = _job(db_session)
    r = app_client.post(f"/ai/match-breakdown/{j.id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall_score"] > 0 and body["strengths"]
    card = {x["id"]: x["match_score"] for x in app_client.get("/jobs").json()}
    assert card[j.id] == body["overall_score"]


def test_structure_description_is_free_by_default(app_client, db_session):
    j = _job(db_session)
    r = app_client.post(f"/jobs/{j.id}/structure-description")
    assert r.status_code == 200
    assert r.json()["sections"] == [] and r.json()["source"] == "client"
