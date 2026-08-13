"""
Diagnostic capture: the opt-in that lets an account store its own answers and
the employer's form markup, so a failed field can be rebuilt as a fixture later.

The security property under test is the important one: **the client does not get
to decide**. A caller can post captures all day; they are stored only if the
SERVER's copy of that account's flag is on. Otherwise anyone could opt an
account into having its application answers retained just by sending them.

Isolated in-memory SQLite app (never the Neon lifespan), same pattern as
test_autofill_api.py, so it is safe to run standalone.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import AutofillFieldCapture, AutofillReport, UserSettings
from backend.routers.autofill import router as autofill_router
from backend.auth.dependencies import get_verified_user_id

TEST_DATABASE_URL = "sqlite:///./test_autofill_diagnostic.db"
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
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[get_verified_user_id] = lambda: TEST_USER_ID
    yield TestClient(app)
    app.dependency_overrides.clear()


def enable_diagnostics(db_session, on: bool = True):
    db_session.add(UserSettings(user_id=TEST_USER_ID, diagnostic_capture=on))
    db_session.commit()


# One field, exactly as the extension sends it: the real Lyft School control.
CAPTURE = {
    "field_id": "x1-14",
    "label": "School",
    "category": "school",
    "confidence": 0.95,
    "control_type": "combobox",
    "input_type": "",
    "help_text": "",
    "required": False,
    "group_index": 0,
    "options": ["University of Ottawa", "University of Toronto"],
    "proposed_value": "University of Ottawa",
    "observed_value": "",
    "redacted": False,
    "tier": "profile",
    "pass": "",
    "outcome": "failed",
    "reason": 'No option matches "University of Ottawa"',
    "dom": '<div class="input-wrapper"><label for="school--0">School</label>'
           '<input id="school--0" role="combobox"/></div>',
    "selector": "#school--0",
}


def post(client, **over):
    body = {
        "host": "job-boards.greenhouse.io",
        "ats_type": "greenhouse",
        "url": "https://job-boards.greenhouse.io/embed/job_app?for=lyft",
        "total_fields": 1,
        "filled": 0,
        "failed": 1,
        "field_captures": [CAPTURE],
        "extension_version": "0.4.0",
        "durations": {"scan_ms": 120, "local_ms": 900, "backend_ms": 45000, "reask_ms": 0, "total_ms": 46020},
    }
    body.update(over)
    return client.post("/autofill/telemetry", json=body)


# ───────────────────────────── the security property ─────────────────────────

def test_captures_are_discarded_when_the_account_did_not_opt_in(client, db_session):
    """No flag, no storage — even though the client sent the captures."""
    r = post(client)
    assert r.status_code == 200
    assert r.json()["captured"] == 0
    assert db_session.query(AutofillFieldCapture).count() == 0
    # The ordinary report is still recorded: capture is additive, not a gate.
    assert db_session.query(AutofillReport).count() == 1


def test_a_client_cannot_opt_itself_in(client, db_session):
    """The flag is read from the server's own row, never from the payload."""
    r = post(client, diagnostic_capture=True, diagnostic=True)
    assert r.json()["captured"] == 0
    assert db_session.query(AutofillFieldCapture).count() == 0


def test_captures_are_stored_once_the_account_opts_in(client, db_session):
    enable_diagnostics(db_session)
    r = post(client)
    assert r.json()["captured"] == 1

    row = db_session.query(AutofillFieldCapture).one()
    # Everything an agent needs to write the regression test:
    assert row.label == "School"
    assert row.control_type == "combobox"          # absent before; cost a live fetch
    assert row.options == ["University of Ottawa", "University of Toronto"]
    assert row.proposed_value == "University of Ottawa"
    assert row.outcome == "failed"
    assert "role=\"combobox\"" in row.dom          # the fixture material
    assert row.selector == "#school--0"
    assert row.group_index == 0


def test_a_capture_is_linked_to_its_report(client, db_session):
    """So "show me this whole application" is one join, not a timestamp guess."""
    enable_diagnostics(db_session)
    post(client)
    report = db_session.query(AutofillReport).one()
    capture = db_session.query(AutofillFieldCapture).one()
    assert capture.report_id == report.id
    assert capture.host == report.host


# ───────────────────────────── report-level context ──────────────────────────

def test_the_report_records_the_build_and_the_timings(client, db_session):
    """Both were missing when they were needed: a stale build has been mistaken
    for a code bug, and "autofill takes exceptionally long" had no data."""
    post(client)
    report = db_session.query(AutofillReport).one()
    assert report.extension_version == "0.4.0"
    assert report.durations["backend_ms"] == 45000
    assert report.durations["total_ms"] == 46020


# ───────────────────────────── limits ────────────────────────────────────────

def test_oversized_markup_is_truncated_not_rejected(client, db_session):
    """A runaway page must not cost the whole report."""
    enable_diagnostics(db_session)
    big = dict(CAPTURE, dom="<div>" + ("x" * 50_000) + "</div>")
    r = post(client, field_captures=[big])
    assert r.json()["captured"] == 1
    assert len(db_session.query(AutofillFieldCapture).one().dom) <= 8000


def test_a_runaway_field_count_is_capped(client, db_session):
    enable_diagnostics(db_session)
    r = post(client, field_captures=[dict(CAPTURE, field_id=f"f{i}") for i in range(400)])
    assert r.json()["captured"] == 150
    assert db_session.query(AutofillFieldCapture).count() == 150


# ───────────────────────────── the flag endpoint ─────────────────────────────

def test_diagnostic_endpoint_reports_the_accounts_own_setting(client, db_session):
    assert client.get("/autofill/diagnostic").json() == {"enabled": False}
    enable_diagnostics(db_session)
    assert client.get("/autofill/diagnostic").json() == {"enabled": True}


def test_an_older_extension_that_sends_no_captures_still_reports(client, db_session):
    """Forward/backward compatibility: the fields are all optional."""
    r = client.post("/autofill/telemetry", json={"host": "boards.greenhouse.io", "total_fields": 3, "filled": 3})
    assert r.status_code == 200
    assert db_session.query(AutofillReport).count() == 1
