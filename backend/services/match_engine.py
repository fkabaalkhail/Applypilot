"""
MatchEngine, computes detailed match score breakdowns via the LLM service.

Extends the existing OpenAIService.match_job with breakdown scores
for experience, skills, and industry.
"""

import hashlib
import json
import logging
import os
import time
from collections import OrderedDict
from typing import Optional

from sqlalchemy.orm import Session

from backend.db.models import ScrapedJob, ResumeProfileDB
from backend.schemas.match import MatchBreakdown, FitAnalysis
from backend.schemas.ai import JobAnalysisOut
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)


DEFAULT_MATCH_MODEL = "gpt-4o-mini"


def _match_model() -> str:
    """Model used for match scoring, the highest-volume LLM call in the app.

    The cron sweep buys a score for every (user, new job) pair whether or not
    anyone opens the app, so this call runs orders of magnitude more often than
    any user-triggered generation. Scoring fit 0-100 does not need the flagship
    model: default to the cheap sibling and leave the quality-sensitive rewrite
    flows on OPENAI_MODEL.
    """
    return os.getenv("OPENAI_MATCH_MODEL", DEFAULT_MATCH_MODEL).strip().strip("﻿") or DEFAULT_MATCH_MODEL


# ── Analysis memo ────────────────────────────────────────────────────────────
#
# One "tailor my résumé" journey asked for the SAME résumé↔job analysis up to
# three times in 34 seconds (prod, 2026-08-11): once when the user opened the
# job, once for the "See Your Difference" panel, and once more as the rewrite's
# own before-state. Identical prompt, identical answer, three round-trips the
# user waits through.
#
# Keyed on the rendered prompt, so the key IS the complete input — no chance of
# a stale hit from a résumé edit or a different job. Process-local and
# short-lived: on Fluid Compute an instance serves consecutive requests from the
# same user, which is exactly the window this needs to cover. A miss simply
# costs what it costs today, so this can never return a wrong answer, only fail
# to save one.
ANALYSIS_MEMO_TTL = float(os.getenv("MATCH_ANALYSIS_MEMO_TTL", "600"))
ANALYSIS_MEMO_MAX = 128

_analysis_memo: "OrderedDict[str, tuple[float, JobAnalysisOut]]" = OrderedDict()


def _memo_key(prompt: str, model: str) -> str:
    return hashlib.sha256(f"{model}\x00{prompt}".encode("utf-8")).hexdigest()


def _memo_get(key: str) -> Optional[JobAnalysisOut]:
    hit = _analysis_memo.get(key)
    if hit is None:
        return None
    stored_at, value = hit
    if time.time() - stored_at > ANALYSIS_MEMO_TTL:
        _analysis_memo.pop(key, None)
        return None
    _analysis_memo.move_to_end(key)
    # A copy, so a caller mutating the result cannot poison later hits.
    return value.model_copy(deep=True)


def _memo_put(key: str, value: JobAnalysisOut) -> None:
    _analysis_memo[key] = (time.time(), value.model_copy(deep=True))
    _analysis_memo.move_to_end(key)
    while len(_analysis_memo) > ANALYSIS_MEMO_MAX:
        _analysis_memo.popitem(last=False)


def reset_analysis_memo() -> None:
    """Drop every memoised analysis (tests, and anything that needs a cold read)."""
    _analysis_memo.clear()


def score_to_label(score: int) -> str:
    """Map a match score (0-100) to a human-readable label.

    >=80 → "STRONG MATCH"
    >=60 → "GOOD MATCH"
    <60  → "FAIR MATCH"
    """
    if score >= 80:
        return "STRONG MATCH"
    elif score >= 60:
        return "GOOD MATCH"
    else:
        return "FAIR MATCH"


MATCH_BREAKDOWN_PROMPT = """
Analyze how well this resume matches the job posting.
Return a JSON object with these exact fields:

{{
  "overall_score": <0-100>,
  "experience_score": <0-100 based on years and relevance of experience>,
  "skill_score": <0-100 based on technical skill overlap>,
  "industry_score": <0-100 based on industry/domain experience>,
  "strengths": ["strength 1", "strength 2", ...],
  "weaknesses": ["weakness 1", "weakness 2", ...]
}}

Resume:
{resume_text}

Job Posting:
{job_description}
"""

JOB_ANALYSIS_PROMPT = """
Analyze how well this resume matches the job posting, like an applicant tracking
system (ATS) would. Return ONLY a JSON object with these exact fields:

{{
  "overall_score": <0-100 overall fit>,
  "ats_score": <0-100 how well the resume would pass an automated ATS keyword scan>,
  "matched_keywords": ["important skills/keywords from the job that ARE in the resume"],
  "missing_keywords": ["important skills/keywords from the job that are NOT in the resume"],
  "strengths": ["short strength phrases"],
  "weaknesses": ["short gap phrases"],
  "suggestions": ["1-2 sentence actionable suggestions to improve the match for this role"]
}}

Job title: {job_title}
Company: {company}

Resume:
{resume_text}

Job Posting:
{job_description}
"""

FIT_ANALYSIS_PROMPT = """
Provide a detailed analysis of how well this candidate fits the job.
Return a JSON object with these exact fields:

{{
  "overall_score": <0-100>,
  "experience_score": <0-100>,
  "skill_score": <0-100>,
  "industry_score": <0-100>,
  "strengths": ["strength 1", ...],
  "weaknesses": ["weakness 1", ...],
  "narrative": "<2-3 paragraph detailed analysis>",
  "recommendations": ["recommendation 1", ...]
}}

Resume:
{resume_text}

Job Posting:
{job_description}
"""


class MatchEngine:
    """Computes detailed match score breakdowns via Claude."""

    def __init__(self, db: Session):
        self.db = db
        self._llm = None

    @property
    def llm(self):
        """Lazily construct the LLM service.

        Deferred so that pure helpers (e.g. JSON parsing) and unit tests can
        use MatchEngine without an OPENAI_API_KEY in the environment.
        """
        if self._llm is None:
            self._llm = get_llm_service()
        return self._llm

    async def compute_breakdown(
        self, resume_text: str, job_description: str
    ) -> MatchBreakdown:
        """Compute match breakdown with individual category scores.

        Returns:
            MatchBreakdown with overall_score, experience_score,
            skill_score, industry_score, strengths, weaknesses
        """
        prompt = MATCH_BREAKDOWN_PROMPT.format(
            resume_text=resume_text[:3000],
            job_description=job_description[:3000],
        )

        response = await self.llm._generate(prompt, model=_match_model(), json_mode=True, op="match.score")
        data = self._parse_json_response(response)
        if not isinstance(data, dict) or "overall_score" not in data:
            # Raising (instead of returning zeros) matters to callers that
            # persist the result: a zero born from a parse hiccup would be
            # banked as this pair's score forever, silencing a real match.
            raise ValueError("match response missing overall_score")

        overall = data.get("overall_score", 0)
        return MatchBreakdown(
            overall_score=overall,
            experience_score=data.get("experience_score", 0),
            skill_score=data.get("skill_score", 0),
            industry_score=data.get("industry_score", 0),
            match_label=score_to_label(overall),
            strengths=data.get("strengths", []),
            weaknesses=data.get("weaknesses", []),
        )

    async def analyze_job(
        self,
        resume_text: str,
        job_title: str,
        company: str,
        job_description: str,
    ) -> JobAnalysisOut:
        """Resume↔job analysis for the rewrite flow.

        Adds an ATS score plus matched/missing keyword lists (and a derived
        keyword-coverage percentage) on top of the overall fit score.

        Memoised for ``ANALYSIS_MEMO_TTL``: the "See Your Difference" panel and
        the rewrite's own before-state ask the identical question seconds apart,
        so the second and third asks are served from memory.
        """
        prompt = JOB_ANALYSIS_PROMPT.format(
            job_title=job_title or "",
            company=company or "",
            resume_text=resume_text[:3000],
            job_description=job_description[:3000],
        )

        model = _match_model()
        key = _memo_key(prompt, model)
        cached = _memo_get(key)
        if cached is not None:
            logger.info("llm_memo op=match.analyze hit=1")
            return cached

        response = await self.llm._generate(prompt, model=model, op="match.analyze")
        data = self._parse_json_response(response)

        def _strs(key: str) -> list[str]:
            # The model sometimes returns a single string where the schema asks
            # for a list (e.g. one suggestion). Iterating a str yields its
            # characters, so coerce a lone string into a one-element list first.
            val = data.get(key, [])
            if isinstance(val, str):
                val = [val]
            elif not isinstance(val, list):
                val = []
            return [str(v).strip() for v in val if str(v).strip()]

        def _score(key: str) -> int:
            try:
                return max(0, min(100, int(data.get(key, 0) or 0)))
            except (TypeError, ValueError):
                return 0

        matched = _strs("matched_keywords")
        missing = _strs("missing_keywords")
        total = len(matched) + len(missing)
        coverage = round(100 * len(matched) / total) if total else 0
        overall = _score("overall_score")

        result = JobAnalysisOut(
            overall_score=overall,
            ats_score=_score("ats_score"),
            match_label=score_to_label(overall),
            keyword_coverage=coverage,
            matched_keywords=matched,
            missing_keywords=missing,
            strengths=_strs("strengths"),
            weaknesses=_strs("weaknesses"),
            suggestions=_strs("suggestions"),
        )
        # Only a parsed, non-empty analysis is worth remembering: banking a zero
        # born from a parse hiccup would freeze it in for the whole TTL.
        if overall or matched or missing:
            _memo_put(key, result)
        return result

    async def analyze_fit(
        self, resume_text: str, job_description: str
    ) -> FitAnalysis:
        """Detailed fit analysis with strengths/weaknesses narrative."""
        prompt = FIT_ANALYSIS_PROMPT.format(
            resume_text=resume_text[:3000],
            job_description=job_description[:3000],
        )

        response = await self.llm._generate(prompt, model=_match_model(), op="match.fit")
        data = self._parse_json_response(response)

        overall = data.get("overall_score", 0)
        breakdown = MatchBreakdown(
            overall_score=overall,
            experience_score=data.get("experience_score", 0),
            skill_score=data.get("skill_score", 0),
            industry_score=data.get("industry_score", 0),
            match_label=score_to_label(overall),
            strengths=data.get("strengths", []),
            weaknesses=data.get("weaknesses", []),
        )

        return FitAnalysis(
            overall_score=overall,
            breakdown=breakdown,
            narrative=data.get("narrative", ""),
            recommendations=data.get("recommendations", []),
        )

    async def queue_analysis(self, job_id: int) -> None:
        """Queue a job for background match analysis.

        Fetches the job, computes the breakdown, and stores scores on the job record.
        """
        job = self.db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
        if not job:
            logger.warning(f"Job {job_id} not found for analysis")
            return

        # Get user's resume text (from the most recent resume profile)
        profile = self.db.query(ResumeProfileDB).order_by(
            ResumeProfileDB.created_at.desc()
        ).first()

        if not profile or not profile.raw_text:
            logger.warning("No resume profile found for match analysis")
            return

        try:
            breakdown = await self.compute_breakdown(
                profile.raw_text, job.description
            )

            # Store scores on the job record
            job.match_score = breakdown.overall_score
            job.experience_score = breakdown.experience_score
            job.skill_score = breakdown.skill_score
            job.industry_score = breakdown.industry_score
            job.match_label = breakdown.match_label
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to analyze job {job_id}: {e}")

    def _parse_json_response(self, response: str) -> dict:
        """Parse JSON from LLM response, handling code fences."""
        json_str = response.strip()

        # Handle markdown code fences
        if "```" in json_str:
            parts = json_str.split("```")
            for part in parts:
                part = part.strip()
                if part.startswith("json"):
                    part = part[4:].strip()
                if part.startswith("{"):
                    json_str = part
                    break

        # Find first { and last }
        if not json_str.startswith("{"):
            start = json_str.find("{")
            end = json_str.rfind("}")
            if start >= 0 and end > start:
                json_str = json_str[start : end + 1]

        try:
            return json.loads(json_str)
        except json.JSONDecodeError:
            logger.warning("Failed to parse match response: %s", response[:300])
            return {}
