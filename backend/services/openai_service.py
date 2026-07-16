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

from backend.schemas.resume import AnalysisReport, ResumeProfile
from backend.schemas.resume_document import ResumeDocument
from backend.schemas.application import JobPosting
from backend.services.resume_extraction import build_analysis_report, build_profile

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).resolve().parent.parent.parent / "prompts"

STANDARDS_TOKEN = "{{RESUME_STANDARDS}}"
STANDARDS_FILE = "_standards.md"


def _load_standards() -> str:
    """The shared resume-standards partial, minus its developer header comment.

    Everything before the partial's first ``##`` heading is a note to us, not to the
    model, so it is stripped before the block reaches a prompt.
    """
    text = (PROMPTS_DIR / STANDARDS_FILE).read_text(encoding="utf-8")
    _, sep, body = text.partition("\n## ")
    return f"## {body}".strip() if sep else text.strip()


def _load_prompt(name: str) -> str:
    """Read a prompt template, inlining the shared standards block if it asks for one.

    One canonical copy of the standards means the prompt that grades a resume and the
    prompts that rewrite it cannot drift apart.
    """
    path = PROMPTS_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    template = path.read_text(encoding="utf-8")
    if STANDARDS_TOKEN in template:
        template = template.replace(STANDARDS_TOKEN, _load_standards())
    return template


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


@dataclass
class ImproveStructuredResult:
    """Output of a job-agnostic improvement pass: merged document + the metrics
    the candidate still has to supply (the model is forbidden from guessing)."""

    document: ResumeDocument
    unresolved: list[str]


def _render_emphasis(sections: list[str] | None, keywords: list[str] | None) -> str:
    """The per-request focus block shared by both tailoring prompts.

    ``sections`` is what the user asked us to work on; ``keywords`` are the job's missing
    terms. Both are advisory — the honesty rule in the standards block still overrules them,
    which is why an unsupported term is dropped rather than inserted.
    """
    lines: list[str] = []
    if sections:
        lines.append(f"- Put extra effort into these sections: {', '.join(sections)}.")
    if keywords:
        lines.append(
            "- Where the candidate's REAL experience already supports them, use the job's own "
            f"words for these terms: {', '.join(keywords)}. If a term is not genuinely "
            "supported, leave it out."
        )
    return ("## THIS REQUEST\n\n" + "\n".join(lines)) if lines else ""


def _render_findings(report: AnalysisReport | None) -> str:
    """Flatten an analysis report into the instruction block for improve_resume."""
    if report is None or not report.categories:
        return (
            "(no analysis available — apply general best practice: achievement-led "
            "bullets, strong verbs, no filler, consistent tense)"
        )

    lines: list[str] = []
    for category in report.categories:
        if not category.issues:
            continue
        lines.append(f"## {category.name}")
        for issue in category.issues:
            where = f" in {issue.section}" if issue.section else ""
            lines.append(
                f"- [{issue.severity.upper()}] {issue.title}{where} "
                f"({issue.count} occurrence(s)): {issue.description}"
            )
            for snippet in issue.evidence:
                lines.append(f'    evidence: "{snippet}"')
            if issue.suggestion:
                lines.append(f"    fix: {issue.suggestion}")
    return "\n".join(lines) or "(no issues found)"


class OpenAIService:
    """Async client for the OpenAI Chat Completions API."""

    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip().strip("﻿")
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o").strip().strip("﻿")
        self.timeout = float(os.getenv("OPENAI_TIMEOUT", "60"))
        self.max_tokens = int(os.getenv("OPENAI_MAX_TOKENS", "4096"))
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY not set in environment")

    async def _generate(
        self,
        prompt: str,
        system: str = None,
        model: str = None,
        json_mode: bool = False,
    ) -> str:
        """Run one chat completion.

        ``model`` overrides the account-wide default for calls that don't need
        the flagship (e.g. high-volume match scoring). ``json_mode`` turns on
        OpenAI's JSON response format for callers that parse the output as
        JSON — the prompt must still mention JSON, per the API contract.
        """
        import asyncio

        url = "https://api.openai.com/v1/chat/completions"

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        body: dict = {
            "model": model or self.model,
            "max_tokens": self.max_tokens,
            "messages": messages,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

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
        return build_profile(data)

    async def analyze_resume_quality(
        self, raw_text: str, metrics_digest: str = ""
    ) -> AnalysisReport:
        template = _load_prompt("analyze_resume_quality.txt")
        prompt = (
            template
            .replace("{{METRICS}}", metrics_digest or "(not available)")
            .replace("{{RESUME_TEXT}}", raw_text)
        )
        response = await self._generate(prompt)
        data = json.loads(_extract_json(response))
        return build_analysis_report(data)

    async def improve_resume_structured(
        self, document: ResumeDocument, report: AnalysisReport | None
    ) -> "ImproveStructuredResult":
        """Apply an analysis report's findings to a document, facts locked.

        The model rewrites only wording; ``merge_rewrite`` re-imposes every
        factual field from the original, so a bad rewrite can degrade the prose
        but can never invent an employer, a date, or a degree.
        """
        from backend.services.resume_document import merge_rewrite

        prompt = (
            _load_prompt("improve_resume.txt")
            .replace("{{FINDINGS}}", _render_findings(report))
            .replace("{{RESUME_JSON}}", document.model_dump_json())
        )

        try:
            response = await self._generate(prompt)
            data = json.loads(_extract_json(response))
        except Exception as e:  # noqa: BLE001
            logger.warning("Resume improve failed to parse (%s); returning original", e)
            return ImproveStructuredResult(document=document, unresolved=[])

        if not isinstance(data, dict):
            return ImproveStructuredResult(document=document, unresolved=[])

        resume_data = data.get("resume")
        section_order = data.get("section_order")
        new_summary = data.get("new_summary")
        unresolved_raw = data.get("unresolved", [])

        unresolved = (
            [str(u).strip() for u in unresolved_raw if str(u).strip()]
            if isinstance(unresolved_raw, list)
            else []
        )
        if not isinstance(section_order, list):
            section_order = None
        if not isinstance(new_summary, dict):
            new_summary = None

        try:
            edited = ResumeDocument(**resume_data)
        except Exception as e:  # noqa: BLE001
            logger.warning("Resume improve bad shape (%s); returning original", e)
            return ImproveStructuredResult(document=document, unresolved=unresolved)

        merged = merge_rewrite(
            document, edited, section_order=section_order, new_summary=new_summary
        )
        return ImproveStructuredResult(document=merged, unresolved=unresolved)

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

    async def compose_answer(self, question: str, context: str) -> str:
        """Compose a grounded answer to an open-ended essay question (why-us,
        behavioral, self-intro, company-knowledge). Unlike answer_question, this
        is allowed to write prose that is not stated verbatim in the context —
        but it still may not invent hard facts (see prompts/compose_answer.txt)."""
        template = _load_prompt("compose_answer.txt")
        prompt = template.replace("{{QUESTION}}", question).replace("{{CONTEXT}}", context)
        system = (
            "You are a job applicant writing a short, genuine answer to an "
            "open-ended application question in first person. Ground it in the "
            "applicant's real experience and the job posting. Output only the answer."
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
        prompt = (
            _load_prompt("tailor_resume_guided.txt")
            .replace("{{FOCUS}}", _render_emphasis(sections, keywords))
            .replace("{{RESUME_TEXT}}", resume_text[:6000])
            .replace("{{JOB_DESCRIPTION}}", job_description[:3000])
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

        prompt = (
            _load_prompt("tailor_resume_structured.txt")
            .replace("{{EMPHASIS}}", _render_emphasis(sections, keywords))
            .replace("{{JOB_DESCRIPTION}}", job_description[:3500])
            .replace("{{RESUME_JSON}}", document.model_dump_json())
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
