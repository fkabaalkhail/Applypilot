"""API tests for date_posted and experience filters."""

import datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.db.database import Base, get_db
from backend.db.models import ScrapedJob
from backend.main import app


def _client_with_jobs(jobs):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    for job in jobs:
        session.add(job)
    session.commit()

    def override_get_db():
        try:
            yield session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    return client, session, engine


def test_date_posted_24h_filter():
    now = datetime.datetime.utcnow()
    client, session, engine = _client_with_jobs(
        [
            ScrapedJob(
                title="Fresh",
                company="Acme",
                location="Remote",
                url="https://example.com/fresh",
                posted_date=now - datetime.timedelta(hours=2),
                scraped_at=now,
                experience_level="new_grad",
                country="US",
            ),
            ScrapedJob(
                title="Old",
                company="Acme",
                location="Remote",
                url="https://example.com/old",
                posted_date=now - datetime.timedelta(days=30),
                scraped_at=now - datetime.timedelta(days=30),
                experience_level="new_grad",
                country="US",
            ),
        ]
    )
    try:
        response = client.get("/jobs", params={"date_posted": "24h"})
        assert response.status_code == 200
        titles = [j["title"] for j in response.json()]
        assert titles == ["Fresh"]
    finally:
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()


def _catalogue():
    """The only three spellings that reach the DB: the two real levels, plus a
    stray 'senior' row to prove dead levels stay excluded."""
    return [
        ScrapedJob(
            title="Intern",
            company="Acme",
            location="Remote",
            url="https://example.com/intern",
            experience_level="internship",
            country="US",
        ),
        ScrapedJob(
            title="Grad",
            company="Acme",
            location="Remote",
            url="https://example.com/grad",
            experience_level="new_grad",
            country="US",
        ),
        ScrapedJob(
            title="Senior",
            company="Acme",
            location="Remote",
            url="https://example.com/senior",
            experience_level="senior",
            country="US",
        ),
    ]


def _titles_for(experience_level: str) -> list[str]:
    client, session, engine = _client_with_jobs(_catalogue())
    try:
        response = client.get("/jobs", params={"experience_level": experience_level})
        assert response.status_code == 200
        return sorted(j["title"] for j in response.json())
    finally:
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()


def test_experience_filter_canonical_values():
    """The UI now sends the DB's own spellings."""
    assert _titles_for("internship") == ["Intern"]
    assert _titles_for("new_grad") == ["Grad"]
    assert _titles_for("internship,new_grad") == ["Grad", "Intern"]


def test_experience_filter_legacy_values_still_resolve():
    """Stale clients, open tabs, and bookmarked URLs keep working."""
    assert _titles_for("intern_new_grad") == ["Grad", "Intern"]
    assert _titles_for("entry") == ["Grad", "Intern"]


def test_experience_filter_dead_legacy_values_never_widen():
    """Dropping mid/senior/lead/director from the map must not make them silently
    widen into the real catalogue. They keep matching only their own (nonexistent)
    rows, which is exactly what they did before."""
    for dead in ("mid", "senior", "lead", "director"):
        titles = _titles_for(dead)
        assert "Intern" not in titles
        assert "Grad" not in titles
