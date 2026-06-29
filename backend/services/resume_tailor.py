"""
ResumeTailor — generates tailored resume versions for specific job postings.

Uses Claude to rewrite/reorder resume content to emphasize skills and experience
relevant to the target job. Stores tailored versions linked to specific jobs.
"""

import difflib
import logging
from dataclasses import dataclass
from sqlalchemy.orm import Session

from backend.db.models import TailoredResume, ScrapedJob, ResumeProfileDB
from backend.schemas.ai import JobAnalysisOut, TailoredResumeOut
from backend.schemas.resume_document import ResumeDocument
from backend.services.llm import get_llm_service
from backend.services.resume_document import document_to_text

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

        Uses Claude to rewrite the resume emphasizing relevant skills/experience.
        Stores the result in the TailoredResume table.

        Returns the TailoredResume database record.
        """
        # Generate tailored version via Claude
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


@dataclass
class TailorResult:
    """Output of one tailoring pass: the rewritten doc + before/after scores."""
    document: ResumeDocument
    original_text: str
    tailored_text: str
    before: JobAnalysisOut
    after: JobAnalysisOut
    diff_summary: str


async def tailor_document(
    db: Session,
    original_document: ResumeDocument,
    job_title: str,
    company: str,
    job_description: str,
    sections: list[str] | None = None,
    add_keywords: list[str] | None = None,
) -> TailorResult:
    """Tailor a structured résumé to a job and score it before/after.

    Shared by the web ``/ai/custom-resume`` flow and the extension
    ``/api/tailor-resume`` endpoint so the two cannot drift.

    Keyword semantics: when ``add_keywords`` is None, all of the job's missing
    keywords are woven in (best one-click result); when a list is given (even
    empty), exactly that set is used.
    """
    from backend.services.match_engine import MatchEngine  # local: avoid import cycle

    engine = MatchEngine(db)
    tailor = ResumeTailor(db)
    original_text = document_to_text(original_document)
    before = await engine.analyze_job(original_text, job_title, company, job_description)
    keywords = add_keywords if add_keywords is not None else list(before.missing_keywords)
    document = await tailor.llm.tailor_resume_structured(
        original_document, job_description, sections, keywords
    )
    tailored_text = document_to_text(document)
    after = await engine.analyze_job(tailored_text, job_title, company, job_description)
    diff_summary = tailor.compute_diff(original_text, tailored_text)
    return TailorResult(
        document=document, original_text=original_text, tailored_text=tailored_text,
        before=before, after=after, diff_summary=diff_summary,
    )
