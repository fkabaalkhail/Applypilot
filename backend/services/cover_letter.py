"""
CoverLetterGenerator — generates tailored cover letters for job applications.

Uses Claude to create personalized cover letters based on the user's resume
and the target job description. Contact details from the user's profile are
woven directly into the header/signature so the letter never ships with
bracketed placeholders like ``[Your Name]`` or ``[Address]``.
"""

import datetime
import logging
import re

from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)


COVER_LETTER_PROMPT = """
Write a professional cover letter for this job application.
The cover letter should:
- Open with a header containing the candidate's contact details (provided below),
  followed by today's date
- Be addressed to the hiring team at {company}
- Highlight relevant skills and experience from the resume
- Show enthusiasm for the role and company
- Be concise (3-4 paragraphs)
- Use a professional but personable tone
- Close with a sign-off and the candidate's name
{tone_line}

CRITICAL: Use the real contact details below verbatim. Do NOT output bracketed
placeholders such as [Your Name], [Address], [Date], [Email], or [Phone]. If a
detail is not provided, simply omit that line — never invent it and never leave
a placeholder.

Candidate contact details:
{contact_block}
Today's date: {today}

Resume:
{resume_text}

Job Description:
{job_description}

Write the cover letter now:
"""

REWRITE_PROMPT = """
Rewrite the following cover letter for the role at {company}. {tone_line}
Keep it truthful to the candidate's experience and addressed to the hiring team.

CRITICAL: Use the real contact details below verbatim in the header and
signature. Remove any bracketed placeholders such as [Your Name], [Address],
[Date], [Email], or [Phone] — replace them with the real values, or omit the
line if no value is provided. Never leave a bracketed placeholder in the output.

Candidate contact details:
{contact_block}
Today's date: {today}

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


def _build_contact_block(
    name: str | None,
    email: str | None,
    phone: str | None,
    location: str | None,
    linkedin: str | None,
) -> str:
    """Render the known contact fields as labelled lines for the prompt.

    Only fields that have a value are included, so the model is never tempted to
    bracket a missing one.
    """
    lines: list[str] = []
    if name:
        lines.append(f"Name: {name}")
    if location:
        lines.append(f"Location: {location}")
    if email:
        lines.append(f"Email: {email}")
    if phone:
        lines.append(f"Phone: {phone}")
    if linkedin:
        lines.append(f"LinkedIn: {linkedin}")
    return "\n".join(lines) if lines else "(none provided)"


# Maps a normalized placeholder label → the profile attribute that fills it.
# Matching is case-insensitive and tolerates an optional leading "Your ".
_PLACEHOLDER_FIELDS: dict[str, tuple[str, ...]] = {
    "name": ("full name", "name"),
    "email": ("email address", "email", "e-mail"),
    "phone": ("phone number", "phone", "telephone", "mobile"),
    "location": ("address", "location", "city, state", "city", "city and state"),
    "linkedin": ("linkedin url", "linkedin profile", "linkedin"),
    "date": ("today's date", "current date", "date"),
    "company": ("company name", "company"),
}


def _strip_placeholders(text: str, values: dict[str, str | None]) -> str:
    """Replace any remaining bracketed placeholders with real values, then drop
    leftover ``[...]`` tokens entirely.

    A defensive net for when the model ignores the prompt and emits e.g.
    ``[Your Name]`` anyway. Known labels are mapped to profile values; unknown
    brackets are removed (with surrounding whitespace) so nothing ships bracketed.
    """

    def resolve(label: str) -> str | None:
        norm = re.sub(r"^your\s+", "", label.strip().lower())
        norm = norm.rstrip(":").strip()
        for field, aliases in _PLACEHOLDER_FIELDS.items():
            if norm in aliases:
                return values.get(field) or None
        return None

    def replace(match: re.Match[str]) -> str:
        value = resolve(match.group(1))
        return value if value is not None else ""

    out = re.sub(r"\[([^\[\]]+)\]", replace, text)
    # Tidy up artifacts left by removed placeholders: stray "  •  " separators,
    # doubled spaces, and blank lines.
    out = re.sub(r"[ \t]*•[ \t]*\n", "\n", out)
    out = re.sub(r"\n[ \t]*•[ \t]*", "\n", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


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
        *,
        name: str | None = None,
        email: str | None = None,
        phone: str | None = None,
        location: str | None = None,
        linkedin: str | None = None,
    ) -> str:
        """Generate (or regenerate) a tailored cover letter.

        Args:
            resume_text: The user's resume text
            job_description: The target job description
            company: The company name
            tone: Optional tone preset (professional/formal/enthusiastic/concise/technical)
            base_text: When provided, rewrite this existing letter in the new tone
                instead of generating from scratch.
            name/email/phone/location/linkedin: Candidate contact details from the
                profile, woven into the header/signature instead of placeholders.

        Returns:
            The generated cover letter text
        """
        tone_line = TONE_GUIDANCE.get((tone or "").strip().lower(), "")
        contact_block = _build_contact_block(name, email, phone, location, linkedin)
        today = datetime.date.today().strftime("%B %d, %Y")

        if base_text:
            prompt = REWRITE_PROMPT.format(
                company=company,
                tone_line=tone_line or "Improve its clarity and impact.",
                contact_block=contact_block,
                today=today,
                base_text=base_text[:4000],
                job_description=job_description[:2000],
            )
        else:
            prompt = COVER_LETTER_PROMPT.format(
                company=company,
                contact_block=contact_block,
                today=today,
                resume_text=resume_text[:3000],
                job_description=job_description[:3000],
                tone_line=f"- {tone_line}" if tone_line else "",
            )

        text = await self.llm._generate(prompt)
        return _strip_placeholders(
            text,
            {
                "name": name,
                "email": email,
                "phone": phone,
                "location": location,
                "linkedin": linkedin,
                "date": today,
                "company": company,
            },
        )
