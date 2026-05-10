"""
Pydantic schemas for insider connections and email finder.
"""

from typing import Optional
from pydantic import BaseModel


class InsiderConnectionOut(BaseModel):
    """An insider connection at a target company."""
    id: int
    company: str
    name: str
    title: str
    relationship_type: str
    linkedin_url: str

    model_config = {"from_attributes": True}


class EmailResult(BaseModel):
    """Result of an email lookup from a LinkedIn profile URL."""
    linkedin_url: str
    email: Optional[str] = None
    found: bool
    message: str
