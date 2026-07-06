"""
OpenAIService — OpenAI Chat Completions client for AI-powered features.

Drop-in replacement for the former AnthropicService: same public interface
(analyze_resume, generate_cover_letter, answer_question, suggest_job_titles,
tailor_resume*, edit_snippet, extract_experience_years,
generate_connection_message, match_job, analyze_resume_quality) so every caller
that goes through get_llm_service() works unchanged. Only the transport
(_generate) and configuration (__init__) are OpenAI-specific; all prompt
building and parsing is provider-agnostic.
"""

import os
import json
import logging
import re
from dataclasses import dataclass
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


@dataclass
class TailorStructuredResult:
    """Output of a structure-aware rewrite: merged document + honest gaps."""

    document: ResumeDocument
    gaps: list[str]


class OpenAIService:
    """Async client for the OpenAI Chat Completions API."""

    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip().strip("﻿")
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o").strip().strip("﻿")
        self.timeout = float(os.getenv("OPENAI_TIMEOUT", "60"))
        self.max_tokens = int(os.getenv("OPENAI_MAX_TOKENS", "4096"))
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY not set in environment")

    async def _generate(self, prompt: str, system: str = None) -> str:
        import asyncio

        url = "https://api.openai.com/v1/chat/completions"

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        body: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": messages,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        max_retries = 4
        for attempt in range(max_retries):
            async with httpx.AsyncClient() as client:
                r = await client.post(url, json=body, headers=headers, timeout=self.timeout)
                if r.status_code == 429:
                    wait_time = (2 ** attempt) * 3
                    logger.warning(
                        f"OpenAI rate limited (429), retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait_time)
                    continue
                if r.status_code in (500, 502, 503):
                    wait_time = (2 ** attempt) * 5
                    logger.warning(
                        f"OpenAI server error ({r.status_code}), retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait_time)
                    continue
                r.raise_for_status()
                data = r.json()
                break
        else:
            raise ConnectionError(
                "OpenAI API rate limited after retries. Please try again in a minute."
            )

        try:
            # OpenAI response: { "choices": [{ "message": { "content": "..." } }] }
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError):
            logger.error("Unexpected OpenAI response: %s", json.dumps(data)[:500])
            raise ValueError("OpenAI returned an unexpected response format")

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
    ) -> "TailorStructuredResult":
        """Structure-aware rewrite. Returns the merged document + honest gaps.

        The model does a genuine rewrite (structure review, achievement-based
        bullets, holistic alignment) and returns a wrapped object
        ``{resume, section_order, new_summary, gaps}``. ``merge_rewrite`` then
        applies the reorder/summary while keeping every factual field locked. A
        bare résumé document is still accepted for back-compat.
        """
        from backend.services.resume_document import merge_rewrite

        emphasis = ""
        if sections:
            emphasis += f"\n- Put extra effort into these sections: {', '.join(sections)}."
        if keywords:
            emphasis += (
                "\n- Secondary: where the candidate's REAL experience already supports "
                f"them, you may surface these job terms: {', '.join(keywords)}. If a term "
                "is not genuinely supported, DO NOT insert it — list it under \"gaps\"."
            )

        doc_json = document.model_dump_json()
        prompt = (
            "You are an expert resume writer and career coach. Rewrite the candidate's "
            "resume (given as JSON) to genuinely fit the target job — a real rewrite, not "
            "a keyword patch. Then return ONE JSON object with this exact shape:\n"
            "{\n"
            '  "resume":        <the same resume JSON, with rewritten content>,\n'
            '  "section_order": [<section ids in the best order for this job>],\n'
            '  "new_summary":   {"title": "PROFESSIONAL SUMMARY", "text": "..."} or null,\n'
            '  "gaps":          [<job priorities the candidate genuinely cannot support>]\n'
            "}\n\n"
            "STEP 1 — STRUCTURE: choose the section order that presents this candidate best "
            "for this job (e.g. lead with Projects when experience is thin). Only include ids "
            "that already exist; reorder only when it clearly helps. If the resume has no "
            "summary/profile section and one would help, write a concise `new_summary` from "
            "the candidate's real experience; otherwise set it to null.\n"
            "STEP 2 — CONTENT: rewrite bullets to lead with strong action verbs and outcomes, "
            "not duties ('Responsible for…'). Keep real quantified results; NEVER introduce a "
            "number, percentage, or metric that is not already in the source. Cut filler; fix "
            "tense and consistency.\n"
            "STEP 3 — ALIGNMENT: match the job's real priorities, seniority, and domain "
            "language — not just its keyword list.\n"
            "STEP 4 — HONESTY: never invent employers, titles, dates, degrees, or skills. "
            "Anything the job needs that the candidate cannot truthfully show goes in `gaps`, "
            "never into the resume.\n\n"
            "JSON RULES for `resume`: same keys, ids, types, and array lengths as the input. "
            "Keep every section `id`/`type`/`title` and every item `id`/`title`/`subtitle`/"
            "`location`/`start_date`/`end_date`/`detail`/`link` UNCHANGED. You may only reword "
            "each section's `text`, the `skills` array, `groups` values, and each item's "
            "`bullets`."
            f"{emphasis}\n\n"
            f"Target job description:\n{job_description[:3500]}\n\n"
            f"Resume JSON:\n{doc_json}\n\n"
            "Return ONLY the JSON object."
        )

        try:
            response = await self._generate(prompt)
            data = json.loads(_extract_json(response))
        except Exception as e:  # noqa: BLE001
            logger.warning("Structured tailor failed to parse (%s); returning original", e)
            return TailorStructuredResult(document=document, gaps=[])

        if isinstance(data, dict) and "resume" in data:
            resume_data = data.get("resume")
            section_order = data.get("section_order")
            new_summary = data.get("new_summary")
            gaps_raw = data.get("gaps", [])
        else:
            # Back-compat: a bare résumé document (no wrapper).
            resume_data, section_order, new_summary, gaps_raw = data, None, None, []

        gaps = (
            [str(g).strip() for g in gaps_raw if str(g).strip()]
            if isinstance(gaps_raw, list)
            else []
        )
        if not isinstance(section_order, list):
            section_order = None
        if not isinstance(new_summary, dict):
            new_summary = None

        try:
            edited = ResumeDocument(**resume_data)
        except Exception as e:  # noqa: BLE001
            logger.warning("Structured tailor bad resume shape (%s); returning original", e)
            return TailorStructuredResult(document=document, gaps=gaps)

        merged = merge_rewrite(document, edited, section_order=section_order, new_summary=new_summary)
        return TailorStructuredResult(document=merged, gaps=gaps)

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
