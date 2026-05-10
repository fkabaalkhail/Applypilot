"""
Pydantic schemas for GitHub repository job sources.
"""

import datetime
from typing import Optional
from pydantic import BaseModel


class GitHubSourceCreate(BaseModel):
    """Input schema for creating a new GitHub source."""
    repo_url: str  # validated as GitHub URL
    file_path: str = "README.md"
    poll_interval_minutes: int = 60


class GitHubSourceOut(BaseModel):
    """A GitHub source returned to the frontend."""
    id: int
    repo_url: str
    repo_owner: str
    repo_name: str
    file_path: str
    poll_interval_minutes: int
    last_polled_at: Optional[datetime.datetime] = None
    status: str
    error_message: str
    role_category: str = ""
    experience_level: str = ""

    model_config = {"from_attributes": True}
