"""
Connections and email finder endpoints.

GET  /connections/{company}     → list[InsiderConnectionOut]
POST /connections/email-find    → EmailResult
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.schemas.connections import InsiderConnectionOut, EmailResult
from backend.services.connection_finder import ConnectionFinder
from backend.services.email_finder import EmailFinder, validate_linkedin_url

logger = logging.getLogger(__name__)
router = APIRouter()


class EmailFindRequest(BaseModel):
    """Request body for email finder."""

    linkedin_url: str


@router.get("/{company}", response_model=list[InsiderConnectionOut])
def get_connections(company: str, db: Session = Depends(get_db)):
    """Get insider connections at a company."""
    finder = ConnectionFinder(db)
    connections = finder.find_connections(company)
    return connections


@router.post("/email-find", response_model=EmailResult)
async def find_email(request: EmailFindRequest, db: Session = Depends(get_db)):
    """Find work email from a LinkedIn profile URL."""
    if not validate_linkedin_url(request.linkedin_url):
        raise HTTPException(
            status_code=422,
            detail="Invalid LinkedIn profile URL. Expected format: https://www.linkedin.com/in/{slug}",
        )

    finder = EmailFinder()
    email = await finder.resolve_email(request.linkedin_url)

    if email:
        return EmailResult(
            linkedin_url=request.linkedin_url,
            email=email,
            found=True,
            message="Email found successfully.",
        )
    else:
        return EmailResult(
            linkedin_url=request.linkedin_url,
            email=None,
            found=False,
            message="Could not resolve email for this profile.",
        )
