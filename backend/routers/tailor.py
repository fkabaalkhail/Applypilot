"""
Extension résumé-tailoring endpoints (mounted at /api).

POST /api/tailor-resume — tailor a résumé to a *scraped* job (no job_id),
                          reusing the same services as the web Custom Resume
                          flow. Returns the structured document + before/after
                          scores + the candidate keyword set (from `before`,
                          so the overlay's chips stay stable across regenerates).
POST /api/render-resume — render a structured document to a PDF (base64 JSON).

Used by the Chrome extension on live application pages, where there is no
ScrapedJob row to key off (unlike the web /ai/custom-resume/{job_id} flow).
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
from backend.schemas.tailor import (
    RenderResumeIn, RenderResumeOut, TailorResumeIn, TailorResumeOut,
)
from backend.services.resume_document import db_record_to_document
from backend.services.resume_pdf import render_resume_pdf
from backend.services.resume_tailor import tailor_document

logger = logging.getLogger(__name__)
router = APIRouter()


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or "resume"


@router.post("/tailor-resume", response_model=TailorResumeOut)
async def tailor_resume_endpoint(
    body: TailorResumeIn,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Tailor the caller's résumé to a scraped job description."""
    resume = _resolve_resume(db, user_id, body.resume_id)  # 400 if none on file
    original_document = db_record_to_document(resume)
    try:
        result = await tailor_document(
            db, original_document, body.job_title, body.company,
            body.job_description, body.sections, body.add_keywords,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    return TailorResumeOut(
        document=result.document,
        original_overall_score=result.before.overall_score,
        new_overall_score=result.after.overall_score,
        new_ats_score=result.after.ats_score,
        new_keyword_coverage=result.after.keyword_coverage,
        matched_keywords=result.before.matched_keywords,
        missing_keywords=result.before.missing_keywords,
        diff_summary=result.diff_summary,
    )


@router.post("/render-resume", response_model=RenderResumeOut)
def render_resume_endpoint(
    body: RenderResumeIn,
    user_id: int = Depends(get_verified_user_id),
):
    """Render a structured résumé document to a PDF, returned as base64."""
    try:
        pdf = render_resume_pdf(body.document)
    except Exception as e:
        logger.warning("Resume PDF render failed: %s", e)
        raise HTTPException(status_code=422, detail="Could not render this résumé document.")
    base = body.filename or "resume"
    if base.lower().endswith(".pdf"):
        base = base[:-4]
    name = f"{_slug(base)}.pdf"
    return RenderResumeOut(
        data_base64=base64.b64encode(pdf).decode("ascii"),
        name=name,
    )
