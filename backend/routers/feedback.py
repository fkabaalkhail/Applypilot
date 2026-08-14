"""Feedback endpoints: user submissions, plus the admin console that reads them."""
import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend.db.database import get_db
from backend.db.models import Feedback, User
from backend.auth.dependencies import get_optional_user_id, get_admin_user_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackCreate(BaseModel):
    category: str
    message: str
    wants_followup: bool = False


@router.post("")
def submit_feedback(
    body: FeedbackCreate,
    user_id: int | None = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    """Submit user feedback."""
    feedback = Feedback(
        user_id=str(user_id) if user_id else "",
        category=body.category,
        message=body.message,
        wants_followup=1 if body.wants_followup else 0,
    )
    db.add(feedback)
    db.commit()
    return {"status": "submitted", "id": feedback.id}


def _emails_for(db: Session, rows: list[Feedback]) -> dict[str, str]:
    """Map the user_id of each row to its account email, in one query.

    Feedback stores the id as a string and outlives the account, so ids that
    aren't numeric (logged-out submissions) or no longer resolve (deleted
    accounts) are simply absent from the map.
    """
    ids = {int(f.user_id) for f in rows if (f.user_id or "").isdigit()}
    if not ids:
        return {}
    found = db.query(User.id, User.email).filter(User.id.in_(ids)).all()
    return {str(uid): email for uid, email in found}


@router.get("")
def list_feedback(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """List all feedback, newest first (admin only).

    Returns ``total`` alongside the page so a capped page is distinguishable
    from "that's all of it". Ties on created_at break by id, which keeps
    paging stable when several submissions land in the same second.
    """
    total = db.query(func.count(Feedback.id)).scalar() or 0
    rows = (
        db.query(Feedback)
        .order_by(Feedback.created_at.desc(), Feedback.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    emails = _emails_for(db, rows)
    return {
        "total": total,
        "items": [
            {
                "id": f.id,
                "user_id": f.user_id,
                "email": emails.get(f.user_id),
                "category": f.category,
                "message": f.message,
                "wants_followup": bool(f.wants_followup),
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in rows
        ],
    }


@router.delete("/{feedback_id}")
def delete_feedback(
    feedback_id: int,
    admin_id: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Delete one feedback item (admin only)."""
    row = db.query(Feedback).filter(Feedback.id == feedback_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Feedback not found")
    db.delete(row)
    db.commit()
    logger.info(f"Feedback {feedback_id} deleted by admin {admin_id}")
    return {"status": "deleted", "id": feedback_id}
