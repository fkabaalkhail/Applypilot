"""
GeminiService — drop-in replacement for OllamaService using Google Gemini API.

Same interface: analyze_resume, generate_cover_letter, answer_question,
suggest_job_titles, tailor_resume, extract_experience_years,
generate_connection_message, match_job, analyze_resume_quality.
"""

import os
import json
import logging
import re
from pathlib import Path

import httpx

from backend.schemas.resume import ResumeProfile, ExperienceItem, EducationItem, AnalysisReport
from backend.schemas.application import JobPosting

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).resolve().parent.parent.parent / "prompts"


def _load_prompt(name: str) -> str:
    path = PROMPTS_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def _extract_json(response: str) -> str:
    """Extract JSON from a response that may contain markdown fences or preamble."""
    text = response.strip()
    if "```" in text:
        parts = text.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("{") or part.startswith("["):
                return part
    if not text.startswith("{") and not text.startswith("["):
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return text[start:end + 1]
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            return text[start:end + 1]
    return text


class GeminiService:
    """Async client for Google Gemini API. Same interface as OllamaService."""

    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY", "")
        self.model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
        self.timeout = float(os.getenv("GEMINI_TIMEOUT", "60"))
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not set in environment")

    async def _generate(self, prompt: str, system: str = None) -> str:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}"
            f":generateContent?key={self.api_key}"
        )
        contents = [{"parts": [{"text": prompt}]}]
        body = {"contents": contents}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}

        async with httpx.AsyncClient() as client:
            r = await client.post(url, json=body, timeout=self.timeout)
            r.raise_for_status()
            data = r.json()

        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            logger.error("Unexpected Gemini response: %s", json.dumps(data)[:500])
            raise ValueError("Gemini returned an unexpected response format")

    async def analyze_resume(self, raw_text: str) -> ResumeProfile:
        template = _load_prompt("analyze_resume.txt")
        prompt = template.replace("{{RESUME_TEXT}}", raw_text)
        response = await self._generate(prompt)
        data = json.loads(_extract_json(response))
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

    async def analyze_resume_quality(self, raw_text: str) -> AnalysisReport:
        template = _load_prompt("analyze_resume_quality.txt")
        prompt = template.replace("{{RESUME_TEXT}}", raw_text)
        response = await self._generate(prompt)
        data = json.loads(_extract_json(response))
        return AnalysisReport(
            overall_grade=data.get("overall_grade", "FAIR"),
            urgent_fix_count=data.get("urgent_fix_count", 0),
            critical_fix_count=data.get("critical_fix_count", 0),
            optional_fix_count=data.get("optional_fix_count", 0),
            summary=data.get("summary", ""),
            highlights=data.get("highlights", []),
        )

    async def generate_cover_letter(self, profile: ResumeProfile, job: JobPosting) -> str:
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
        template = _load_prompt("answer_question.txt")
        prompt = template.replace("{{QUESTION}}", question).replace("{{CONTEXT}}", context)
        system = (
            "You are a job applicant filling out an application form. "
            "You write in first person. You give direct answers only. "
            "Never start with conversational phrases. Never explain yourself. "
            "Just answer the question."
        )
        return await self._generate(prompt, system=system)

    async def suggest_job_titles(self, profile: ResumeProfile) -> list[str]:
        template = _load_prompt("suggest_titles.txt")
        prompt = template.replace("{{RESUME_JSON}}", profile.model_dump_json(indent=2))
        response = await self._generate(prompt)
        return json.loads(_extract_json(response))

    async def tailor_resume(self, resume_text: str, job_description: str) -> str:
        template = _load_prompt("tailor_resume.txt")
        prompt = (
            template
            .replace("{{RESUME_TEXT}}", resume_text[:4000])
            .replace("{{JOB_DESCRIPTION}}", job_description[:3000])
        )
        return await self._generate(prompt)

    async def extract_experience_years(self, description: str) -> int | None:
        template = _load_prompt("extract_experience.txt")
        prompt = template.replace("{{JOB_DESCRIPTION}}", description[:3000])
        response = await self._generate(prompt)
        text = response.strip().lower()
        if text == "none" or not text:
            return None
        match = re.search(r"\d+", text)
        return int(match.group()) if match else None

    async def generate_connection_message(
        self, profile_name: str, profile_title: str, job_title: str, company: str
    ) -> str:
        template = _load_prompt("connection_message.txt")
        prompt = (
            template
            .replace("{{PROFILE_NAME}}", profile_name)
            .replace("{{PROFILE_TITLE}}", profile_title)
            .replace("{{JOB_TITLE}}", job_title)
            .replace("{{COMPANY}}", company)
        )
        message = await self._generate(prompt)
        return message.strip()[:300]

    async def match_job(
        self, resume_text: str, job_title: str, company: str, description: str
    ) -> dict:
        template = _load_prompt("match_job.txt")
        prompt = (
            template
            .replace("{{RESUME_TEXT}}", resume_text[:3000])
            .replace("{{JOB_TITLE}}", job_title)
            .replace("{{JOB_COMPANY}}", company)
            .replace("{{JOB_DESCRIPTION}}", description[:3000])
        )
        response = await self._generate(prompt)
        try:
            return json.loads(_extract_json(response))
        except json.JSONDecodeError:
            logger.warning("Failed to parse match response: %s", response[:300])
            return {
                "match_score": 0, "requirements": [], "summary": "",
                "salary_range": "", "company_size": "", "company_description": "",
            }
