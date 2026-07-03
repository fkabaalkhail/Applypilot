"""
Tests for /autofill — telemetry recording, admin summary, and override serving.

Isolated in-memory SQLite app (never the Neon lifespan), same pattern as
test_apply_log.py, so it is safe to run standalone.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import AutofillReport, AutofillOverride
from backend.routers.autofill import router as autofill_router
from backend.auth.dependencies import get_verified_user_id, get_admin_user_id

TEST_DATABASE_URL = "sqlite:///./test_autofill_api.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)
TEST_USER_ID = 1

app = FastAPI()
app.include_router(autofill_router, prefix="/autofill", tags=["autofill"])


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def db_session():
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    async def _override_user_id():
        return TEST_USER_ID

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_verified_user_id] = _override_user_id
    app.dependency_overrides[get_admin_user_id] = _override_user_id
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_telemetry_records_a_pass(client, db_session):
    resp = client.post(
        "/autofill/telemetry",
        json={
            "host": "Boards.Greenhouse.io",
            "ats_type": "greenhouse",
            "url": "https://boards.greenhouse.io/acme/jobs/1",
            "total_fields": 10,
            "filled": 8,
            "failed": 2,
            "failed_fields": [
                {"label": "Work Authorization", "category": "unknown", "reason": "No option matches"}
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ok"

    rows = db_session.query(AutofillReport).all()
    assert len(rows) == 1
    assert rows[0].host == "boards.greenhouse.io"  # normalized to lowercase
    assert rows[0].failed == 2
    assert rows[0].failed_fields[0]["label"] == "Work Authorization"


def test_telemetry_skips_blank_host(client, db_session):
    resp = client.post("/autofill/telemetry", json={"host": "   "})
    assert resp.status_code == 200
    assert resp.json()["status"] == "skipped"
    assert db_session.query(AutofillReport).count() == 0


def test_overrides_empty_when_none(client):
    resp = client.get("/autofill/overrides")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "empty"
    assert body["rules"] == []


def test_overrides_served_and_versioned(client, db_session):
    db_session.add(
        AutofillOverride(
            host="boards.greenhouse.io",
            label_pattern="work authorization",
            category="workAuthorization",
            value_synonyms={"Canada": "Canadian"},
        )
    )
    db_session.add(  # disabled → not served
        AutofillOverride(host="*", label_pattern="secret", category="x", enabled=False)
    )
    db_session.commit()

    resp = client.get("/autofill/overrides")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] != "empty"
    assert len(body["rules"]) == 1
    assert body["rules"][0]["category"] == "workAuthorization"
    assert body["rules"][0]["value_synonyms"] == {"Canada": "Canadian"}


def test_summary_aggregates_by_host_worst_first(client, db_session):
    db_session.add(AutofillReport(user_id=TEST_USER_ID, host="a.com", total_fields=10, filled=5, failed=5))
    db_session.add(AutofillReport(user_id=TEST_USER_ID, host="a.com", total_fields=10, filled=10, failed=0))
    db_session.add(AutofillReport(user_id=TEST_USER_ID, host="b.com", total_fields=10, filled=9, failed=1))
    db_session.commit()

    resp = client.get("/autofill/telemetry/summary")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    by_host = {r["host"]: r for r in rows}
    assert by_host["a.com"]["failed"] == 5
    assert by_host["a.com"]["total_fields"] == 20
    assert by_host["a.com"]["fail_rate"] == 0.25
    assert rows[0]["host"] == "a.com"  # worst fail-rate first
