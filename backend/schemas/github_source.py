"""
Pydantic schemas for GitHub repository job sources.
"""

import datetime
from typing import Optional
from pydantic import BaseModel, Field


class GitHubSourceCreate(BaseModel):
    """Input schema for creating a new GitHub source."""
    repo_url: str  # validated as GitHub URL
    file_path: str = "README.md"
    # Any value but 60/1440 sticks (AggregatorService.poll_source); a negative
    # one was due on every cron-poll run. 5 is the admin form's own minimum.
    poll_interval_minutes: int = Field(default=60, ge=5, le=10080)


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
