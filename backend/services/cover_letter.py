"""
CoverLetterGenerator — generates tailored cover letters for job applications.

Uses Ollama to create personalized cover letters based on the user's resume
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

Resume:
{resume_text}

Job Description:
{job_description}

Write the cover letter now:
"""


class CoverLetterGenerator:
    """Generates tailored cover letters for job applications."""

    def __init__(self):
        self.ollama = get_llm_service()

    async def generate(
        self, resume_text: str, job_description: str, company: str
    ) -> str:
        """Generate a tailored cover letter.

        Args:
            resume_text: The user's resume text
            job_description: The target job description
            company: The company name

        Returns:
            The generated cover letter text
        """
        prompt = COVER_LETTER_PROMPT.format(
            company=company,
            resume_text=resume_text[:3000],
            job_description=job_description[:3000],
        )

        return await self.ollama._generate(prompt)
