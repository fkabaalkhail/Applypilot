"""
Tests for OllamaService.analyze_resume_quality method.
"""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from backend.services.ollama_service import OllamaService
from backend.schemas.resume import AnalysisReport


MOCK_QUALITY_RESPONSE = json.dumps({
    "overall_grade": "GOOD",
    "urgent_fix_count": 1,
    "critical_fix_count": 3,
    "optional_fix_count": 5,
    "summary": "This is a solid resume with some areas for improvement.",
    "highlights": [
        "Strong action verbs used throughout",
        "Missing quantified achievements in bullet points",
        "Good overall formatting and structure",
    ],
})


def run(coro):
    return asyncio.run(coro)


def test_parses_valid_json_response():
    ollama = OllamaService()
    with patch.object(ollama, "_ping", new_callable=AsyncMock):
        with patch.object(
            ollama, "_generate", new_callable=AsyncMock, return_value=MOCK_QUALITY_RESPONSE
        ):
            report = run(ollama.analyze_resume_quality("Some resume text"))
            assert isinstance(report, AnalysisReport)
            assert report.overall_grade == "GOOD"
            assert report.urgent_fix_count == 1
            assert report.critical_fix_count == 3
            assert report.optional_fix_count == 5
            assert "solid resume" in report.summary
            assert len(report.highlights) == 3


def test_handles_code_fenced_response():
    ollama = OllamaService()
    fenced = "```json\n" + MOCK_QUALITY_RESPONSE + "\n```"
    with patch.object(ollama, "_ping", new_callable=AsyncMock):
        with patch.object(
            ollama, "_generate", new_callable=AsyncMock, return_value=fenced
        ):
            report = run(ollama.analyze_resume_quality("Some resume text"))
            assert report.overall_grade == "GOOD"
            assert report.urgent_fix_count == 1


def test_handles_preamble_text():
    ollama = OllamaService()
    preamble = "Here is the analysis:\n" + MOCK_QUALITY_RESPONSE
    with patch.object(ollama, "_ping", new_callable=AsyncMock):
        with patch.object(
            ollama, "_generate", new_callable=AsyncMock, return_value=preamble
        ):
            report = run(ollama.analyze_resume_quality("Some resume text"))
            assert report.overall_grade == "GOOD"


def test_raises_value_error_on_invalid_json():
    ollama = OllamaService()
    with patch.object(ollama, "_ping", new_callable=AsyncMock):
        with patch.object(
            ollama, "_generate", new_callable=AsyncMock, return_value="not json at all"
        ):
            try:
                run(ollama.analyze_resume_quality("Some resume text"))
                assert False, "Should have raised ValueError"
            except ValueError as e:
                assert "invalid JSON" in str(e)


def test_uses_correct_prompt_template():
    """Verify the method loads analyze_resume_quality.txt and substitutes resume text."""
    ollama = OllamaService()
    with patch.object(ollama, "_ping", new_callable=AsyncMock):
        with patch.object(
            ollama, "_generate", new_callable=AsyncMock, return_value=MOCK_QUALITY_RESPONSE
        ) as mock_gen:
            run(ollama.analyze_resume_quality("MY UNIQUE RESUME TEXT"))
            call_prompt = mock_gen.call_args[0][0]
            assert "MY UNIQUE RESUME TEXT" in call_prompt
            assert "{{RESUME_TEXT}}" not in call_prompt


def test_defaults_missing_fields():
    """Verify defaults are applied when response is missing optional fields."""
    ollama = OllamaService()
    minimal_response = json.dumps({
        "overall_grade": "FAIR",
        "summary": "Needs work.",
    })
    with patch.object(ollama, "_ping", new_callable=AsyncMock):
        with patch.object(
            ollama, "_generate", new_callable=AsyncMock, return_value=minimal_response
        ):
            report = run(ollama.analyze_resume_quality("Some resume text"))
            assert report.overall_grade == "FAIR"
            assert report.urgent_fix_count == 0
            assert report.critical_fix_count == 0
            assert report.optional_fix_count == 0
            assert report.summary == "Needs work."
            assert report.highlights == []
