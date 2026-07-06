import pytest

from backend.schemas.ai import JobAnalysisOut
from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.openai_service import TailorStructuredResult
import backend.services.resume_tailor as rt


@pytest.mark.asyncio
async def test_tailor_document_threads_changes_gaps_figures(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")  # tailor.llm constructs the service

    original = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Handled billing"])]),
    ])
    rewritten = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Cut billing errors 30%"])]),
    ])

    async def fake_analyze(self, text, title, company, jd):
        return JobAnalysisOut(overall_score=70, ats_score=60, match_label="GOOD MATCH",
                              keyword_coverage=50, matched_keywords=["python"], missing_keywords=["aws"])

    async def fake_structured(self, doc, jd, sections=None, keywords=None):
        return TailorStructuredResult(document=rewritten, gaps=["Role wants AWS; not shown"])

    monkeypatch.setattr("backend.services.match_engine.MatchEngine.analyze_job", fake_analyze)
    monkeypatch.setattr("backend.services.openai_service.OpenAIService.tailor_resume_structured", fake_structured)

    result = await rt.tailor_document(db=None, original_document=original, job_title="Eng",
                                      company="X", job_description="AWS role")
    assert result.gaps == ["Role wants AWS; not shown"]
    assert result.figures_to_verify == ["30%"]           # 30% not in source → flagged
    assert any("entr" in c.lower() or "bullet" in c.lower() for c in result.changes)
