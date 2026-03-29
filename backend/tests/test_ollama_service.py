"""
Tests for OllamaService — uses mocked HTTP responses.
"""

import json
import pytest
import httpx
from unittest.mock import AsyncMock, patch

from backend.services.ollama_service import OllamaService
from backend.schemas.resume import ResumeProfile


MOCK_RESUME_RESPONSE = json.dumps({
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "555-0100",
    "location": "San Francisco, CA",
    "linkedin_url": "https://linkedin.com/in/johndoe",
    "skills": ["Python", "FastAPI", "Docker"],
    "experience": [
        {
            "title": "Senior Engineer",
            "company": "TechCorp",
            "duration": "2020-2024",
            "bullets": ["Led backend team", "Built microservices"],
        }
    ],
    "education": [
        {"degree": "BS Computer Science", "school": "MIT", "year": "2020"}
    ],
})


@pytest.fixture
def ollama():
    return OllamaService()


class TestAnalyzeResume:
    """Tests for analyze_resume method."""

    @pytest.mark.asyncio
    async def test_parses_valid_response(self, ollama):
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value=MOCK_RESUME_RESPONSE
            ):
                profile = await ollama.analyze_resume("Some resume text")
                assert profile.name == "John Doe"
                assert profile.email == "john@example.com"
                assert len(profile.skills) == 3
                assert len(profile.experience) == 1
                assert profile.experience[0].company == "TechCorp"

    @pytest.mark.asyncio
    async def test_handles_code_fenced_response(self, ollama):
        fenced = f"```json\n{MOCK_RESUME_RESPONSE}\n```"
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value=fenced
            ):
                profile = await ollama.analyze_resume("Some resume text")
                assert profile.name == "John Doe"


class TestAnswerQuestion:
    """Tests for answer_question method."""

    @pytest.mark.asyncio
    async def test_returns_answer_string(self, ollama):
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value="Yes, I have 5 years of experience."
            ):
                answer = await ollama.answer_question("Do you have experience?", "context")
                assert "experience" in answer.lower()


class TestExtractExperienceYears:
    """Tests for extract_experience_years method."""

    @pytest.mark.asyncio
    async def test_returns_integer_for_years(self, ollama):
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value="3"
            ):
                result = await ollama.extract_experience_years("Requires 3+ years of experience")
                assert result == 3

    @pytest.mark.asyncio
    async def test_returns_none_when_not_mentioned(self, ollama):
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value="none"
            ):
                result = await ollama.extract_experience_years("Join our team as a developer")
                assert result is None

    @pytest.mark.asyncio
    async def test_handles_verbose_response(self, ollama):
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value="The answer is 5 years"
            ):
                result = await ollama.extract_experience_years("Need 5 years exp")
                assert result == 5

    @pytest.mark.asyncio
    async def test_returns_none_for_empty_response(self, ollama):
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value=""
            ):
                result = await ollama.extract_experience_years("Some description")
                assert result is None

    @pytest.mark.asyncio
    async def test_truncates_long_descriptions(self, ollama):
        """Verify descriptions are truncated to 3000 chars."""
        long_desc = "x" * 5000
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value="none"
            ) as mock_gen:
                await ollama.extract_experience_years(long_desc)
                # The prompt should contain at most 3000 chars of the description
                call_prompt = mock_gen.call_args[0][0]
                assert "x" * 3001 not in call_prompt


class TestTailorResume:
    """Tests for tailor_resume method."""

    @pytest.mark.asyncio
    async def test_returns_tailored_text(self, ollama):
        tailored = "Professional Summary\n- 5 years Python experience\n- Led backend teams"
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value=tailored
            ):
                result = await ollama.tailor_resume("My resume text", "Job description here")
                assert "Python" in result
                assert "backend" in result.lower()

    @pytest.mark.asyncio
    async def test_truncates_long_inputs(self, ollama):
        """Verify resume is truncated to 4000 chars and description to 3000 chars."""
        long_resume = "r" * 6000
        long_desc = "d" * 5000
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value="tailored"
            ) as mock_gen:
                await ollama.tailor_resume(long_resume, long_desc)
                call_prompt = mock_gen.call_args[0][0]
                assert "r" * 4001 not in call_prompt
                assert "d" * 3001 not in call_prompt


class TestSuggestTitles:
    """Tests for suggest_job_titles method."""

    @pytest.mark.asyncio
    async def test_returns_list_of_strings(self, ollama):
        mock_response = json.dumps(["Backend Engineer", "Python Developer", "DevOps Engineer"])
        with patch.object(ollama, "_ping", new_callable=AsyncMock):
            with patch.object(
                ollama, "_generate", new_callable=AsyncMock, return_value=mock_response
            ):
                profile = ResumeProfile(name="Test", skills=["Python"])
                titles = await ollama.suggest_job_titles(profile)
                assert len(titles) == 3
                assert "Backend Engineer" in titles
