"""
OllamaService — single async class for all LLM interactions.

Methods:
    - analyze_resume: parse resume text into ResumeProfile
    - generate_cover_letter: create a cover letter from profile + job posting
    - answer_question: answer a form question given context
    - suggest_job_titles: suggest relevant titles from a profile

All methods retry once on timeout and log every call with model + token estimate.
"""

import os
import json
import logging
from pathlib import Path

import httpx

from backend.schemas.resume import ResumeProfile, ExperienceItem, EducationItem
from backend.schemas.application import JobPosting

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).resolve().parent.parent.parent / "prompts"


def _load_prompt(name: str) -> str:
    """Load a prompt template from the /prompts directory."""
    path = PROMPTS_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token."""
    return len(text) // 4


class OllamaService:
    """
    Async client for Ollama LLM API.

    On init, validates that Ollama is reachable. All methods use prompt
    templates from /prompts/*.txt and return structured data.
    """

    def __init__(self):
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self.model = os.getenv("OLLAMA_MODEL", "llama3")
        self.timeout = float(os.getenv("OLLAMA_TIMEOUT", "120"))

    async def _ping(self) -> None:
        """Check that Ollama is running. Raises if unreachable."""
        async with httpx.AsyncClient() as client:
            try:
                r = await client.get(f"{self.base_url}/api/tags", timeout=5)
                r.raise_for_status()
            except Exception as e:
                raise ConnectionError(
                    f"Ollama is not reachable at {self.base_url}. "
                    "Make sure Ollama is running (ollama serve)."
                ) from e

    async def _generate(self, prompt: str, retries: int = 1) -> str:
        """
        Send a prompt to Ollama and return the response text.

        Retries once on timeout. Logs model and estimated token count.
        """
        logger.info(
            "Ollama call | model=%s | prompt_tokens≈%d",
            self.model,
            _estimate_tokens(prompt),
        )

        async with httpx.AsyncClient() as client:
            for attempt in range(1 + retries):
                try:
                    r = await client.post(
                        f"{self.base_url}/api/generate",
                        json={"model": self.model, "prompt": prompt, "stream": False},
                        timeout=self.timeout,
                    )
                    r.raise_for_status()
                    data = r.json()
                    response_text = data.get("response", "")
                    logger.info(
                        "Ollama response | tokens≈%d",
                        _estimate_tokens(response_text),
                    )
                    return response_text
                except httpx.TimeoutException:
                    if attempt < retries:
                        logger.warning("Ollama timeout, retrying (attempt %d)...", attempt + 1)
                    else:
                        raise

    async def analyze_resume(self, raw_text: str) -> ResumeProfile:
        """
        Analyze raw resume text and return a structured ResumeProfile.

        Uses the analyze_resume.txt prompt template.
        """
        await self._ping()
        template = _load_prompt("analyze_resume.txt")
        prompt = template.replace("{{RESUME_TEXT}}", raw_text)
        response = await self._generate(prompt)

        # Parse JSON from response (handle markdown code fences)
        json_str = response.strip()
        if json_str.startswith("```"):
            lines = json_str.split("\n")
            json_str = "\n".join(lines[1:-1])

        data = json.loads(json_str)
        return ResumeProfile(
            name=data.get("name", ""),
            email=data.get("email", ""),
            phone=data.get("phone", ""),
            location=data.get("location", ""),
            linkedin_url=data.get("linkedin_url", ""),
            skills=data.get("skills", []),
            experience=[ExperienceItem(**e) for e in data.get("experience", [])],
            education=[EducationItem(**e) for e in data.get("education", [])],
        )

    async def generate_cover_letter(
        self, profile: ResumeProfile, job: JobPosting
    ) -> str:
        """
        Generate a tailored cover letter from a resume profile and job posting.

        Uses the cover_letter.txt prompt template.
        """
        await self._ping()
        template = _load_prompt("cover_letter.txt")
        prompt = (
            template
            .replace("{{RESUME_JSON}}", profile.model_dump_json(indent=2))
            .replace("{{JOB_TITLE}}", job.title)
            .replace("{{JOB_COMPANY}}", job.company)
            .replace("{{JOB_DESCRIPTION}}", job.description)
        )
        return await self._generate(prompt)

    async def answer_question(self, question: str, context: str) -> str:
        """
        Answer a job application form question using resume context.

        Uses the answer_question.txt prompt template.
        """
        await self._ping()
        template = _load_prompt("answer_question.txt")
        prompt = (
            template
            .replace("{{QUESTION}}", question)
            .replace("{{CONTEXT}}", context)
        )
        return await self._generate(prompt)

    async def suggest_job_titles(self, profile: ResumeProfile) -> list[str]:
        """
        Suggest relevant job titles based on a resume profile.

        Uses the suggest_titles.txt prompt template. Returns a list of strings.
        """
        await self._ping()
        template = _load_prompt("suggest_titles.txt")
        prompt = template.replace("{{RESUME_JSON}}", profile.model_dump_json(indent=2))
        response = await self._generate(prompt)

        # Parse JSON array from response
        json_str = response.strip()
        if json_str.startswith("```"):
            lines = json_str.split("\n")
            json_str = "\n".join(lines[1:-1])

        return json.loads(json_str)

    async def tailor_resume(self, resume_text: str, job_description: str) -> str:
        """Generate a tailored resume summary highlighting matching skills/experience.

        Returns the tailored resume text as a string. The caller is responsible
        for saving it to a file.
        Requirements: 10.1–10.4
        """
        await self._ping()
        template = _load_prompt("tailor_resume.txt")
        prompt = (
            template
            .replace("{{RESUME_TEXT}}", resume_text[:4000])
            .replace("{{JOB_DESCRIPTION}}", job_description[:3000])
        )
        return await self._generate(prompt)

    async def extract_experience_years(self, description: str) -> int | None:
        """Extract the minimum years-of-experience requirement from a job description.

        Returns an integer (e.g. 3) or None if not mentioned.
        Requirement 7.7.
        """
        await self._ping()
        template = _load_prompt("extract_experience.txt")
        prompt = template.replace("{{JOB_DESCRIPTION}}", description[:3000])
        response = await self._generate(prompt)
        text = response.strip().lower()
        if text == "none" or not text:
            return None
        # Extract first integer from the response
        import re
        match = re.search(r"\d+", text)
        if match:
            return int(match.group())
        return None

    async def generate_connection_message(
        self, profile_name: str, profile_title: str, job_title: str, company: str
    ) -> str:
        """Generate a personalized LinkedIn connection request message.

        Returns a short message (under 300 chars) referencing the applied role.
        Requirement 16.4.
        """
        await self._ping()
        template = _load_prompt("connection_message.txt")
        prompt = (
            template
            .replace("{{PROFILE_NAME}}", profile_name)
            .replace("{{PROFILE_TITLE}}", profile_title)
            .replace("{{JOB_TITLE}}", job_title)
            .replace("{{COMPANY}}", company)
        )
        message = await self._generate(prompt)
        # Trim to LinkedIn's 300-char limit
        return message.strip()[:300]

    async def match_job(
        self, resume_text: str, job_title: str, company: str, description: str
    ) -> dict:
        """
        Analyze how well a resume matches a job posting.

        Returns dict with match_score, requirements, summary, salary_range,
        company_size, company_description.
        """
        await self._ping()
        template = _load_prompt("match_job.txt")
        prompt = (
            template
            .replace("{{RESUME_TEXT}}", resume_text[:3000])
            .replace("{{JOB_TITLE}}", job_title)
            .replace("{{JOB_COMPANY}}", company)
            .replace("{{JOB_DESCRIPTION}}", description[:3000])
        )
        response = await self._generate(prompt)

        # Extract JSON from response — handle preamble text and code fences
        json_str = response.strip()

        # Try to find JSON object in the response
        # Method 1: Look for code fence
        if "```" in json_str:
            parts = json_str.split("```")
            for part in parts:
                part = part.strip()
                if part.startswith("json"):
                    part = part[4:].strip()
                if part.startswith("{"):
                    json_str = part
                    break

        # Method 2: Find first { and last }
        if not json_str.startswith("{"):
            start = json_str.find("{")
            end = json_str.rfind("}")
            if start >= 0 and end > start:
                json_str = json_str[start:end + 1]

        try:
            return json.loads(json_str)
        except json.JSONDecodeError:
            logger.warning("Failed to parse match response: %s", response[:300])
            return {
                "match_score": 0,
                "requirements": [],
                "summary": "",
                "salary_range": "",
                "company_size": "",
                "company_description": "",
            }
