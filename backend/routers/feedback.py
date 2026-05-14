"""Feedback endpoint for user submissions."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend.db.database import get_db
from backend.db.models import Feedback
from backend.auth.clerk import get_optional_user_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackCreate(BaseModel):
    category: str
    message: str
    wants_followup: bool = False


@router.post("")
def submit_feedback(
    body: FeedbackCreate,
    user_id: str = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    """Submit user feedback."""
    feedback = Feedback(
        user_id=user_id or "",
        category=body.category,
        message=body.message,
        wants_followup=1 if body.wants_followup else 0,
    )
    db.add(feedback)
    db.commit()
    return {"status": "submitted", "id": feedback.id}


@router.get("")
def list_feedback(db: Session = Depends(get_db)):
    """List all feedback (admin use)."""
    items = db.query(Feedback).order_by(Feedback.created_at.desc()).limit(100).all()
    return [
        {
            "id": f.id,
            "user_id": f.user_id,
            "category": f.category,
            "message": f.message,
            "wants_followup": bool(f.wants_followup),
            "created_at": f.created_at.isoformat() if f.created_at else None,
        }
        for f in items
    ]
