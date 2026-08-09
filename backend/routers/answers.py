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
    attractor_neighbours,
    canonicalize_question,
    categorize_question,
    best_match,
    key_health,
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
    # Recall statistics, separate from times_reused (which a re-save also
    # bumps). These are what make a bad key visible: a key matching far more
    # questions than a person is ever asked is matching the wrong ones.
    times_matched: int = 0
    last_matched_at: datetime.datetime | None = None
    created_at: datetime.datetime
    updated_at: datetime.datetime | None = None
    # True when this row's key does not read like a question — a widget's own
    # boilerplate ("Yes Required") or an opaque id. Such a key can never match
    # the question it came from, and WILL match unrelated ones verbatim.
    suspect: bool = False
    suspect_reason: str = ""

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
    # Refuse a key that names no question, whatever asked us to save it.
    #
    # The extension declines these too (planAnswerSaves → isNamedQuestion), but
    # this is the only write path into the bank and older builds keep running in
    # the wild for as long as users leave them installed. One bad key is not a
    # bad row: it is a row that answers every future question whose label
    # harvests to the same boilerplate.
    reason = key_health(body.question)
    if reason:
        raise HTTPException(
            status_code=422,
            detail=f"Not a question that can be remembered ({reason}).",
        )

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
    """The user's answer bank, each row tagged with whether its KEY is sound.

    Eviction needs somewhere to aim. A bad key is invisible from the answer
    alone — "Yes Required" → "Yes" reads as a perfectly sensible row until you
    notice it will answer every yes/no question on a Workday form. Flagging it
    in the listing is what lets the user delete it from the panel instead of
    from the database.
    """
    rows = (
        db.query(SavedAnswer)
        .filter(SavedAnswer.user_id == user_id)
        .order_by(SavedAnswer.updated_at.desc(), SavedAnswer.id.desc())
        .limit(200)
        .all()
    )
    neighbours = attractor_neighbours(rows)
    out: list[SavedAnswerOut] = []
    for row in rows:
        item = SavedAnswerOut.model_validate(row)
        reason = key_health(row.question_raw)
        if not reason and row.id in neighbours:
            reason = "attracts_other_questions"
        item.suspect = bool(reason)
        item.suspect_reason = reason
        out.append(item)
    return out


class UpdateAnswerIn(BaseModel):
    answer: str


@router.put("/answers/{answer_id}", response_model=SavedAnswerOut)
def update_answer(
    answer_id: int,
    body: UpdateAnswerIn,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Edit a remembered answer's text in place (from the extension's Autofill
    Information → Remembered answers list). Keyed by id so it never forks a new
    company-scoped row the way a re-POST would."""
    row = (
        db.query(SavedAnswer)
        .filter(SavedAnswer.id == answer_id, SavedAnswer.user_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Answer not found.")
    row.answer = body.answer
    row.source = "user_edited"
    row.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


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
