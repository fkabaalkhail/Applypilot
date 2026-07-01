"""
Extension cover-letter endpoints (mounted at /api).

POST /api/cover-letter        — generate/regenerate a cover letter for a
                                *scraped* job (no job_id), reusing the same
                                CoverLetterGenerator as the web flow. Ephemeral:
                                nothing is persisted to the cover_letters table.
POST /api/render-cover-letter — render cover-letter text to a PDF (base64 JSON).

Used by the Chrome extension on live application pages, where there is no
ScrapedJob row to key off (unlike the web /ai/cover-letter/{job_id} flow).
"""
import base64
import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.auth.dependencies import get_verified_user_id
from backend.services.usage_limiter import llm_guard
from backend.db.database import get_db
from backend.routers.ai import LLM_503_DETAIL, _resolve_resume
from backend.schemas.cover_letter import (
    CoverLetterGenerateIn, CoverLetterGenerateOut,
    RenderCoverLetterIn, RenderCoverLetterOut,
)
from backend.services.cover_letter import CoverLetterGenerator
from backend.services.cover_letter_pdf import render_cover_letter_pdf

logger = logging.getLogger(__name__)
router = APIRouter()


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or "cover-letter"


@router.post("/cover-letter", response_model=CoverLetterGenerateOut)
async def cover_letter_endpoint(
    body: CoverLetterGenerateIn,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Generate (or rewrite in a tone) a cover letter from a scraped job. Ephemeral."""
    resume = _resolve_resume(db, user_id, body.resume_id)  # 400 if none on file
    try:
        text = await CoverLetterGenerator().generate(
            resume.raw_text, body.job_description, body.company,
            tone=body.tone, base_text=body.base_text,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)
    return CoverLetterGenerateOut(text=text)


@router.post("/render-cover-letter", response_model=RenderCoverLetterOut)
def render_cover_letter_endpoint(
    body: RenderCoverLetterIn,
    user_id: int = Depends(get_verified_user_id),
):
    """Render cover-letter text to a PDF, returned as base64."""
    try:
        pdf = render_cover_letter_pdf(body.text)
    except Exception as e:
        logger.warning("Cover-letter PDF render failed: %s", e)
        raise HTTPException(status_code=422, detail="Could not render this cover letter.")
    base = body.filename or "cover-letter"
    if base.lower().endswith(".pdf"):
        base = base[:-4]
    name = f"{_slug(base)}.pdf"
    return RenderCoverLetterOut(
        data_base64=base64.b64encode(pdf).decode("ascii"),
        name=name,
    )
