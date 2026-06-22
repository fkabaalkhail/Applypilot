"""
CoverLetterGenerator — generates tailored cover letters for job applications.

Uses Gemini to create personalized cover letters based on the user's resume
and the target job description.
"""

import logging
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)


COVER_LETTER_PROMPT = """
Write a professional cover letter for this job application.
The cover letter should:
- Be addressed to the hiring team at {company}
- Highlight relevant skills and experience from the resume
- Show enthusiasm for the role and company
- Be concise (3-4 paragraphs)
- Use a professional but personable tone
{tone_line}

Resume:
{resume_text}

Job Description:
{job_description}

Write the cover letter now:
"""

REWRITE_PROMPT = """
Rewrite the following cover letter for the role at {company}. {tone_line}
Keep it truthful to the candidate's experience and addressed to the hiring team.
Return only the revised cover letter.

Existing cover letter:
{base_text}

Job description (for context):
{job_description}

Write the revised cover letter now:
"""

# tone preset → one-line guidance appended to the prompt.
TONE_GUIDANCE = {
    "professional": "Keep a polished, professional tone.",
    "formal": "Use a formal, traditional business tone.",
    "enthusiastic": "Use an enthusiastic, energetic tone that conveys genuine excitement.",
    "concise": "Be brief and to the point — no more than two short paragraphs.",
    "technical": "Emphasize technical depth, tools, and measurable engineering impact.",
}


class CoverLetterGenerator:
    """Generates tailored cover letters for job applications."""

    def __init__(self):
        self.llm = get_llm_service()

    async def generate(
        self,
        resume_text: str,
        job_description: str,
        company: str,
        tone: str | None = None,
        base_text: str | None = None,
    ) -> str:
        """Generate (or regenerate) a tailored cover letter.

        Args:
            resume_text: The user's resume text
            job_description: The target job description
            company: The company name
            tone: Optional tone preset (professional/formal/enthusiastic/concise/technical)
            base_text: When provided, rewrite this existing letter in the new tone
                instead of generating from scratch.

        Returns:
            The generated cover letter text
        """
        tone_line = TONE_GUIDANCE.get((tone or "").strip().lower(), "")

        if base_text:
            prompt = REWRITE_PROMPT.format(
                company=company,
                tone_line=tone_line or "Improve its clarity and impact.",
                base_text=base_text[:4000],
                job_description=job_description[:2000],
            )
        else:
            prompt = COVER_LETTER_PROMPT.format(
                company=company,
                resume_text=resume_text[:3000],
                job_description=job_description[:3000],
                tone_line=f"- {tone_line}" if tone_line else "",
            )

        return await self.llm._generate(prompt)
