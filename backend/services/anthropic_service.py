"""
AnthropicService — Anthropic Claude API client for AI-powered features.

Same interface as the former GeminiService: analyze_resume, generate_cover_letter,
answer_question, suggest_job_titles, tailor_resume, extract_experience_years,
generate_connection_message, match_job, analyze_resume_quality.
"""

import os
import json
import logging
import re
from pathlib import Path

import httpx

from backend.schemas.resume import ResumeProfile, ExperienceItem, EducationItem, AnalysisReport
from backend.schemas.resume_document import ResumeDocument
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


class AnthropicService:
    """Async client for the Anthropic Messages API (Claude)."""

    def __init__(self):
        self.api_key = os.getenv("ANTHROPIC_API_KEY", "").strip().strip("\ufeff")
        self.model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514").strip().strip("\ufeff")
        self.timeout = float(os.getenv("ANTHROPIC_TIMEOUT", "60"))
        self.max_tokens = int(os.getenv("ANTHROPIC_MAX_TOKENS", "4096"))
        if not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY not set in environment")

    async def _generate(self, prompt: str, system: str = None) -> str:
        import asyncio

        url = "https://api.anthropic.com/v1/messages"

        messages = [{"role": "user", "content": prompt}]
        body: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": messages,
        }
        if system:
            body["system"] = system

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }

        max_retries = 4
        for attempt in range(max_retries):
            async with httpx.AsyncClient() as client:
                r = await client.post(url, json=body, headers=headers, timeout=self.timeout)
                if r.status_code == 429:
                    wait_time = (2 ** attempt) * 3
                    logger.warning(
                        f"Anthropic rate limited (429), retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait_time)
                    continue
                if r.status_code == 529:
                    wait_time = (2 ** attempt) * 5
                    logger.warning(
                        f"Anthropic overloaded (529), retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait_time)
                    continue
                r.raise_for_status()
                data = r.json()
                break
        else:
            raise ConnectionError(
                "Anthropic API rate limited after retries. Please try again in a minute."
            )

        try:
            # Anthropic response: { "content": [{ "type": "text", "text": "..." }] }
            return data["content"][0]["text"]
        except (KeyError, IndexError):
            logger.error("Unexpected Anthropic response: %s", json.dumps(data)[:500])
            raise ValueError("Anthropic returned an unexpected response format")

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

    async def tailor_resume_guided(
        self,
        resume_text: str,
        job_description: str,
        sections: list[str] | None = None,
        keywords: list[str] | None = None,
    ) -> str:
        """Rewrite the candidate's COMPLETE resume, tailored to the target job."""
        focus = ""
        if sections:
            focus += (
                "\n- Put extra effort into improving these sections: "
                f"{', '.join(sections)}."
            )
        if keywords:
            focus += (
                "\n- Where it is truthful and supported by the candidate's real "
                f"experience, naturally weave in these keywords: {', '.join(keywords)}. "
                "Never fabricate experience, skills, or tools the candidate does not have."
            )

        prompt = (
            "You are a professional resume writer. Rewrite the candidate's COMPLETE "
            "resume, tailored to the target job below. Output the FULL resume as clean "
            "plain text, preserving every section the candidate actually has (contact "
            "information, professional summary, skills, work experience, projects, "
            "education, and any others present).\n\n"
            "Rules:\n"
            "- Keep all real, factual content — never invent employers, job titles, "
            "dates, degrees, metrics, or skills the candidate does not have.\n"
            "- Reorder and rephrase to emphasize what matches the job; lead with the "
            "most relevant qualifications.\n"
            "- Use strong action verbs and keep any real quantifiable achievements.\n"
            "- Start with the candidate's real name on the first line, then their "
            "contact details.\n"
            "- Use UPPERCASE section headers (e.g. PROFESSIONAL SUMMARY, SKILLS, WORK "
            "EXPERIENCE, PROJECTS, EDUCATION).\n"
            "- Use '- ' for bullet points. Plain text only — no markdown symbols such "
            "as ** or #.\n"
            f"{focus}\n\n"
            f"Candidate resume:\n{resume_text[:6000]}\n\n"
            f"Target job description:\n{job_description[:3000]}\n\n"
            "Return ONLY the rewritten resume text — no preamble, notes, or commentary."
        )
        return await self._generate(prompt)

    async def tailor_resume_structured(
        self,
        document: ResumeDocument,
        job_description: str,
        sections: list[str] | None = None,
        keywords: list[str] | None = None,
    ) -> ResumeDocument:
        """Rewrite a structured resume document, tailored to the target job."""
        from backend.services.resume_document import merge_rewrite

        focus = ""
        if sections:
            focus += (
                "\n- Put extra effort into improving these sections: "
                f"{', '.join(sections)}."
            )
        if keywords:
            focus += (
                "\n- Where it is truthful and supported by the candidate's real "
                f"experience, naturally weave in these keywords: {', '.join(keywords)}. "
                "Never fabricate experience, skills, or tools the candidate does not have."
            )

        doc_json = document.model_dump_json()
        prompt = (
            "You are a professional resume writer. You will be given a candidate's "
            "resume as a JSON object and a target job description. Rewrite the "
            "resume to be tailored to the job, then return the SAME JSON object.\n\n"
            "STRICT RULES:\n"
            "- Return ONLY valid JSON with the exact same shape, keys, and array "
            "lengths. Keep every section's `id` and `type` and every item's `id` "
            "unchanged, in the same order.\n"
            "- You may ONLY change the wording of: each section's `text`, the "
            "`skills` array, the `groups` values, and each item's `bullets`.\n"
            "- NEVER change `header`, `theme`, section `title`s, or item `title`, "
            "`subtitle`, `location`, `start_date`, `end_date`, `detail`, or `link`.\n"
            "- NEVER invent employers, job titles, dates, degrees, metrics, or "
            "skills the candidate does not already have. Only rephrase what is "
            "there, using strong action verbs and keeping real quantified results.\n"
            "- Rephrase bullets to emphasize what matches the job; lead with the "
            "most relevant qualifications."
            f"{focus}\n\n"
            f"Target job description:\n{job_description[:3000]}\n\n"
            f"Resume JSON:\n{doc_json}\n\n"
            "Return ONLY the rewritten JSON object."
        )

        try:
            response = await self._generate(prompt)
            data = json.loads(_extract_json(response))
            edited = ResumeDocument(**data)
        except Exception as e:
            logger.warning("Structured tailor failed (%s); returning original", e)
            return document

        return merge_rewrite(document, edited)

    async def edit_snippet(self, text: str, action: str, job_description: str = "") -> str:
        """Apply a single AI editing action to a selected snippet of resume text."""
        instructions = {
            "rewrite": "Rewrite the text to be clearer and stronger while keeping the meaning.",
            "shorten": "Make the text more concise without losing key information.",
            "expand": "Expand the text with relevant, truthful detail.",
            "professional": "Rewrite in a more professional, polished tone.",
            "ats": "Rewrite to be ATS-friendly: clear, keyword-rich phrasing aligned to the job, plain text only.",
            "impact": "Rewrite to emphasize measurable impact with strong action verbs.",
            "grammar": "Fix spelling and grammar only; keep the wording and meaning intact.",
        }
        instruction = instructions.get(action, instructions["rewrite"])
        ctx = ""
        if job_description and action in ("ats", "impact", "rewrite"):
            ctx = f"\n\nTarget job (for context only):\n{job_description[:1500]}"
        prompt = (
            "You are editing a snippet of a resume. "
            f"{instruction} "
            "Return ONLY the edited text — no preamble, quotes, labels, or explanation. "
            "Do not invent employers, job titles, dates, or metrics that are not already implied."
            f"{ctx}\n\nText:\n{text}"
        )
        result = await self._generate(prompt)
        return result.strip().strip('"').strip()

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
