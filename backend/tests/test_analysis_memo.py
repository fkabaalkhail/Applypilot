"""The résumé↔job analysis memo.

Prod 2026-08-11 showed one "tailor my résumé" journey buying the SAME analysis
three times in 34 seconds: opening the job, the "See Your Difference" panel, and
the rewrite's own before-state. These pin that the repeat asks are free — and,
more importantly, that a hit can never be the wrong answer.
"""

import pytest

from backend.schemas.ai import JobAnalysisOut
from backend.services import match_engine
from backend.services.match_engine import MatchEngine

RESUME = "Python engineer, 2 years, FastAPI and Postgres."
JD = "Backend engineer. Python, Kubernetes, AWS."
GOOD = ('{"overall_score": 72, "ats_score": 68, "matched_keywords": ["Python"],'
        ' "missing_keywords": ["Kubernetes", "AWS"], "strengths": ["Python depth"],'
        ' "weaknesses": ["No k8s"], "suggestions": ["Mention container work"]}')


@pytest.fixture(autouse=True)
def _cold_memo():
    match_engine.reset_analysis_memo()
    yield
    match_engine.reset_analysis_memo()


def _engine(monkeypatch, payload=GOOD):
    calls = {"n": 0}

    async def fake(self, prompt, system=None, model=None, json_mode=False, op="unknown"):
        calls["n"] += 1
        return payload

    monkeypatch.setattr("backend.services.openai_service.OpenAIService._generate", fake)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    return MatchEngine(db=None), calls


@pytest.mark.asyncio
async def test_the_same_analysis_is_bought_once(monkeypatch):
    engine, calls = _engine(monkeypatch)
    first = await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    second = await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    assert calls["n"] == 1, "second identical analysis hit the API"
    assert first == second


@pytest.mark.asyncio
async def test_an_edited_resume_is_a_different_question(monkeypatch):
    """The whole point of the rewrite flow: the AFTER analysis must not be
    served the BEFORE answer."""
    engine, calls = _engine(monkeypatch)
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    await engine.analyze_job(RESUME + " Also Kubernetes.", "Backend Engineer", "Acme", JD)
    assert calls["n"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("title,company,jd", [
    ("Different Role", "Acme", JD),
    ("Backend Engineer", "Other Co", JD),
    ("Backend Engineer", "Acme", JD + " Also Terraform."),
])
async def test_any_changed_input_is_a_miss(monkeypatch, title, company, jd):
    engine, calls = _engine(monkeypatch)
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    await engine.analyze_job(RESUME, title, company, jd)
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_a_switched_model_is_a_miss(monkeypatch):
    engine, calls = _engine(monkeypatch)
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    monkeypatch.setenv("OPENAI_MATCH_MODEL", "gpt-4.1-nano")
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_an_unparseable_response_is_not_banked(monkeypatch):
    """A zero from a parse hiccup must not be frozen in for the whole TTL."""
    engine, calls = _engine(monkeypatch, payload="not json at all")
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_an_expired_entry_is_refetched(monkeypatch):
    engine, calls = _engine(monkeypatch)
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    monkeypatch.setattr(match_engine, "ANALYSIS_MEMO_TTL", -1)
    await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_a_caller_mutating_the_result_cannot_poison_later_hits(monkeypatch):
    engine, _ = _engine(monkeypatch)
    first = await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    first.missing_keywords.clear()          # tailor_document reads this list
    second = await engine.analyze_job(RESUME, "Backend Engineer", "Acme", JD)
    assert second.missing_keywords == ["Kubernetes", "AWS"]


@pytest.mark.asyncio
async def test_the_memo_is_bounded(monkeypatch):
    engine, _ = _engine(monkeypatch)
    monkeypatch.setattr(match_engine, "ANALYSIS_MEMO_MAX", 4)
    for i in range(12):
        await engine.analyze_job(f"{RESUME} v{i}", "Backend Engineer", "Acme", JD)
    assert len(match_engine._analysis_memo) <= 4
