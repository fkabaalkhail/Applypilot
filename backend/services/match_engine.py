"""
MatchEngine — computes detailed match score breakdowns via Gemini.

Extends the existing GeminiService.match_job with breakdown scores
for experience, skills, and industry.
"""

import json
import logging
from sqlalchemy.orm import Session

from backend.db.models import ScrapedJob, ResumeProfileDB
from backend.schemas.match import MatchBreakdown, FitAnalysis
from backend.schemas.ai import JobAnalysisOut
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)


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
    """Computes detailed match score breakdowns via Gemini."""

    def __init__(self, db: Session):
        self.db = db
        self.llm = get_llm_service()

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

        response = await self.llm._generate(prompt)
        data = self._parse_json_response(response)

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
        """
        prompt = JOB_ANALYSIS_PROMPT.format(
            job_title=job_title or "",
            company=company or "",
            resume_text=resume_text[:3000],
            job_description=job_description[:3000],
        )

        response = await self.llm._generate(prompt)
        data = self._parse_json_response(response)

        def _strs(key: str) -> list[str]:
            return [str(v).strip() for v in data.get(key, []) if str(v).strip()]

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

        return JobAnalysisOut(
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

    async def analyze_fit(
        self, resume_text: str, job_description: str
    ) -> FitAnalysis:
        """Detailed fit analysis with strengths/weaknesses narrative."""
        prompt = FIT_ANALYSIS_PROMPT.format(
            resume_text=resume_text[:3000],
            job_description=job_description[:3000],
        )

        response = await self.llm._generate(prompt)
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
