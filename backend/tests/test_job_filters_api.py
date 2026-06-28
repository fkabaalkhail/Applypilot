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


def test_experience_filter_intern_new_grad():
    client, session, engine = _client_with_jobs(
        [
            ScrapedJob(
                title="Intern",
                company="Acme",
                location="Remote",
                url="https://example.com/intern",
                experience_level="internship",
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
    )
    try:
        response = client.get("/jobs", params={"experience_level": "intern_new_grad"})
        assert response.status_code == 200
        titles = [j["title"] for j in response.json()]
        assert titles == ["Intern"]
    finally:
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()
