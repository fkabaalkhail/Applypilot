"""
ConnectionFinder — identifies insider connections at target companies.

Categorizes connections by relationship type: beyond_network, previous_company, school.
"""

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from backend.db.models import InsiderConnection

logger = logging.getLogger(__name__)


@dataclass
class Connection:
    """A user's connection (from LinkedIn or other source)."""

    name: str
    title: str
    company: str
    linkedin_url: str = ""
    relationship_type: str = "beyond_network"  # beyond_network, previous_company, school


class ConnectionFinder:
    """Identifies insider connections at target companies."""

    def __init__(self, db: Session):
        self.db = db

    def find_connections(
        self, company: str, user_id: str | None = None, user_connections: list[Connection] | None = None
    ) -> list[InsiderConnection]:
        """Find connections at a company, categorized by relationship type.

        First checks the database for stored connections. If user_connections
        are provided, also searches those and stores any matches.

        Args:
            company: The target company name
            user_id: The clerk_user_id to scope results to
            user_connections: Optional list of user's connections to search

        Returns:
            List of InsiderConnection records at the target company
        """
        # Check database for existing connections at this company
        q = self.db.query(InsiderConnection).filter(
            InsiderConnection.company.ilike(f"%{company}%")
        )
        if user_id:
            q = q.filter(InsiderConnection.user_id == user_id)
        existing = q.all()

        if existing:
            return existing

        # If user connections provided, find matches and store them
        if user_connections:
            matches = self._match_connections(company, user_connections)
            if matches:
                self._store_connections(matches)
            return matches

        return []

    def _match_connections(
        self, company: str, user_connections: list[Connection]
    ) -> list[InsiderConnection]:
        """Match user connections against a target company.

        Performs case-insensitive substring matching on company name.
        Categorizes each match by relationship type.
        """
        matches = []
        for conn in user_connections:
            if company.lower() in conn.company.lower():
                insider = InsiderConnection(
                    company=conn.company,
                    name=conn.name,
                    title=conn.title,
                    linkedin_url=conn.linkedin_url,
                    relationship_type=conn.relationship_type,
                    source="linkedin",
                )
                matches.append(insider)
        return matches

    def _store_connections(self, connections: list[InsiderConnection]) -> None:
        """Persist matched connections to the database."""
        for conn in connections:
            self.db.add(conn)
        self.db.commit()
        for conn in connections:
            self.db.refresh(conn)
