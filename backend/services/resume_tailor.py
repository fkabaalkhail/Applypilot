"""
ResumeTailor — generates tailored resume versions for specific job postings.

Uses Gemini to rewrite/reorder resume content to emphasize skills and experience
relevant to the target job. Stores tailored versions linked to specific jobs.
"""

import difflib
import logging
from sqlalchemy.orm import Session

from backend.db.models import TailoredResume, ScrapedJob, ResumeProfileDB
from backend.schemas.ai import TailoredResumeOut
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)


class ResumeTailor:
    """Generates tailored resume versions for specific job postings."""

    def __init__(self, db: Session):
        self.db = db
        self.llm = get_llm_service()

    async def tailor_resume(
        self, resume_text: str, job_description: str, job_id: int, user_id: str | None = None
    ) -> TailoredResume:
        """Generate a tailored resume for a specific job.

        Uses Gemini to rewrite the resume emphasizing relevant skills/experience.
        Stores the result in the TailoredResume table.

        Returns the TailoredResume database record.
        """
        # Generate tailored version via Gemini
        tailored_text = await self.llm.tailor_resume(resume_text, job_description)

        # Compute diff summary
        diff_summary = self.compute_diff(resume_text, tailored_text)

        # Store in database
        tailored = TailoredResume(
            user_id=user_id,
            job_id=job_id,
            original_text=resume_text,
            tailored_text=tailored_text,
            diff_summary=diff_summary,
            status="draft",
        )
        self.db.add(tailored)
        self.db.commit()
        self.db.refresh(tailored)

        return tailored

    def compute_diff(self, original: str, tailored: str) -> str:
        """Produce a human-readable diff summary between original and tailored resume.

        Uses unified diff format to show what changed.
        """
        original_lines = original.splitlines(keepends=True)
        tailored_lines = tailored.splitlines(keepends=True)

        diff = difflib.unified_diff(
            original_lines,
            tailored_lines,
            fromfile="Original Resume",
            tofile="Tailored Resume",
            lineterm="",
        )

        return "".join(diff)

    async def get_or_create(
        self, job_id: int
    ) -> TailoredResume | None:
        """Get existing tailored resume for a job, or create one.

        Returns None if no resume profile is available.
        """
        # Check for existing tailored resume
        existing = (
            self.db.query(TailoredResume)
            .filter(TailoredResume.job_id == job_id)
            .order_by(TailoredResume.created_at.desc())
            .first()
        )
        if existing:
            return existing

        # Get job and resume profile
        job = self.db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
        if not job:
            return None

        profile = self.db.query(ResumeProfileDB).order_by(
            ResumeProfileDB.created_at.desc()
        ).first()
        if not profile or not profile.raw_text:
            return None

        return await self.tailor_resume(profile.raw_text, job.description, job_id)
