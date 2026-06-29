"""
Question Memory CRUD — POST/GET/DELETE /api/answers.

POST is the *only* write path into the answer bank: it canonicalizes,
categorizes, embeds, and upserts (deduping near-identical questions). This is
what enforces "save only on approval" — the fill endpoint never writes here.
"""
import datetime
import logging

from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import SavedAnswer
from backend.auth.dependencies import get_verified_user_id
from backend.services.answer_memory import (
    canonicalize_question,
    categorize_question,
    best_match,
    DEDUP_THRESHOLD,
)
from backend.services.embeddings import EmbeddingsService

logger = logging.getLogger(__name__)
router = APIRouter()


class SaveAnswerIn(BaseModel):
    question: str
    answer: str
    company: str = ""
    jobTitle: str = ""
    fieldType: str = "text"
    source: str = "user_edited"  # "ai" (accepted as-is) or "user_edited"


class SavedAnswerOut(BaseModel):
    id: int
    question_raw: str
    question_canonical: str
    answer: str
    category: str
    source: str
    times_reused: int
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


async def _embed(text: str) -> tuple[list[float], str]:
    """Embed `text`, degrading to (empty, '') when embeddings are unavailable."""
    try:
        svc = EmbeddingsService()
        return await svc.embed(text), svc.model
    except Exception as e:  # missing key, network, bad response
        logger.warning("Embedding unavailable on save: %s", e)
        return [], ""


@router.post("/answers", response_model=SavedAnswerOut)
async def save_answer(
    body: SaveAnswerIn,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    canonical = canonicalize_question(body.question, body.company, body.jobTitle)
    category = categorize_question(body.question)
    embedding, model = await _embed(canonical)

    rows = db.query(SavedAnswer).filter(SavedAnswer.user_id == user_id).all()
    existing = next((r for r in rows if r.question_canonical == canonical), None)
    if existing is None and embedding:
        cand, score = best_match(embedding, rows)
        if cand is not None and score >= DEDUP_THRESHOLD:
            existing = cand

    if existing is not None:
        existing.question_raw = body.question
        existing.answer = body.answer
        existing.category = category
        if embedding:
            existing.embedding = embedding
            existing.embedding_model = model
        existing.source = body.source or existing.source
        existing.times_reused = (existing.times_reused or 0) + 1
        existing.updated_at = datetime.datetime.utcnow()
        row = existing
    else:
        row = SavedAnswer(
            user_id=user_id,
            question_raw=body.question,
            question_canonical=canonical,
            answer=body.answer,
            category=category,
            embedding=embedding,
            embedding_model=model,
            source=body.source,
        )
        db.add(row)

    db.commit()
    db.refresh(row)
    return row


@router.get("/answers", response_model=list[SavedAnswerOut])
def list_answers(
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    return (
        db.query(SavedAnswer)
        .filter(SavedAnswer.user_id == user_id)
        .order_by(SavedAnswer.updated_at.desc(), SavedAnswer.id.desc())
        .limit(200)
        .all()
    )


@router.delete("/answers/{answer_id}", status_code=204)
def delete_answer(
    answer_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    row = (
        db.query(SavedAnswer)
        .filter(SavedAnswer.id == answer_id, SavedAnswer.user_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Answer not found.")
    db.delete(row)
    db.commit()
