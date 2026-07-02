"""
Tests for GET /api/user/application-profile — the endpoint the Chrome extension
autofills from. The key regression it guards: a signed-in user whose data came
from an uploaded resume (ResumeProfileDB) must get a populated profile, even
when UserSettings is empty.
"""

import pytest

from backend.db.models import ResumeProfileDB, User, UserSettings
from backend.auth.dependencies import get_verified_user
from backend.main import app

TEST_USER_ID = 1


@pytest.fixture
def user(db_session):
    """A verified user, and override get_verified_user to return it."""
    u = User(
        id=TEST_USER_ID,
        email="wissam@example.com",
        first_name="",
        last_name="",
        email_verified=True,
        auth_provider="local",
    )
    db_session.add(u)
    db_session.commit()

    async def _override():
        return u

    app.dependency_overrides[get_verified_user] = _override
    yield u
    app.dependency_overrides.pop(get_verified_user, None)


def _make_resume(**overrides):
    base = dict(
        user_id=TEST_USER_ID,
        name="Resume",
        is_primary=1,
        profile_name="Wissam Elmasry",
        email="wissam.resume@example.com",
        phone="+1 555 123 4567",
        location="Ottawa, ON, Canada",
        linkedin_url="https://linkedin.com/in/wissam",
        github_url="https://github.com/wissam",
        other_link="https://wissam.dev",
        skills=["Python", "TypeScript"],
        experience=[
            {
                "company": "Acme Corp",
                "title": "Senior Engineer",
                "start_date": "2022-01",
                "end_date": "Present",
                "bullets": ["Led the platform team", "Shipped the billing rewrite"],
            },
            {
                "company": "Old Co",
                "title": "Engineer",
                "start_date": "2019-06",
                "end_date": "2021-12",
                "bullets": ["Built internal tools"],
            },
        ],
        education=[
            {
                "school": "University of Ottawa",
                "degree": "BSc Computer Science",
                "start_date": "2015-09",
                "end_date": "2019-05",
            }
        ],
        technologies={"Frontend": ["React", "TypeScript"], "Backend": ["FastAPI"]},
    )
    base.update(overrides)
    return ResumeProfileDB(**base)


def test_resume_data_populates_profile(client, db_session, user):
    """The core fix: resume data flows into the extension profile shape."""
    db_session.add(_make_resume())
    db_session.commit()

    res = client.get("/api/user/application-profile")
    assert res.status_code == 200
    body = res.json()

    # Name is split from the resume's parsed full name.
    assert body["firstName"] == "Wissam"
    assert body["lastName"] == "Elmasry"
    assert body["email"] == "wissam.resume@example.com"
    assert body["phone"] == "+1 555 123 4567"
    assert body["location"] == "Ottawa, ON, Canada"
    assert body["linkedin"] == "https://linkedin.com/in/wissam"
    assert body["github"] == "https://github.com/wissam"
    assert body["portfolio"] == "https://wissam.dev"

    # Current company/title come from the most-recent experience entry.
    assert body["currentCompany"] == "Acme Corp"
    assert body["currentTitle"] == "Senior Engineer"

    # Experience is mapped to camelCase with bullets joined into description.
    assert len(body["experience"]) == 2
    first = body["experience"][0]
    assert first["company"] == "Acme Corp"
    assert first["startDate"] == "2022-01"
    assert first["endDate"] == "Present"
    assert "Led the platform team" in first["description"]

    # Education maps end_date -> graduationYear.
    assert body["education"][0]["school"] == "University of Ottawa"
    assert body["education"][0]["graduationYear"] == "2019-05"

    # Skills merge the flat list with the categorized technologies, deduped.
    assert "Python" in body["skills"]
    assert "React" in body["skills"]
    assert "FastAPI" in body["skills"]
    assert body["skills"].count("TypeScript") == 1


def test_settings_fill_gaps_and_screening_answers(client, db_session, user):
    """Settings supply screening answers and fill fields the resume lacks."""
    db_session.add(
        _make_resume(github_url="", other_link="", phone="")
    )
    db_session.add(
        UserSettings(
            user_id=TEST_USER_ID,
            phone="+1 555 999 0000",
            website="https://portfolio.example.com",
            job_title="Staff Engineer",
            prefilled_answers={
                "Are you legally authorized to work?": "Yes",
                "Do you require sponsorship?": "No",
            },
        )
    )
    db_session.commit()

    body = client.get("/api/user/application-profile").json()

    # Resume had no phone/portfolio — settings fill them.
    assert body["phone"] == "+1 555 999 0000"
    assert body["portfolio"] == "https://portfolio.example.com"
    # Screening answers mined from prefilled_answers.
    assert body["workAuthorization"] == "Yes"
    assert body["requiresSponsorship"] == "No"


def test_404_when_no_resume_or_settings(client, db_session, user):
    """No resume and no settings → 404 (nothing to fill from)."""
    res = client.get("/api/user/application-profile")
    assert res.status_code == 404


def test_falls_back_to_account_name(client, db_session, user):
    """With only settings (no resume), account name is the final fallback."""
    user.first_name = "Wissam"
    user.last_name = "Elmasry"
    db_session.add(UserSettings(user_id=TEST_USER_ID, email="settings@example.com"))
    db_session.commit()

    body = client.get("/api/user/application-profile").json()
    assert body["firstName"] == "Wissam"
    assert body["lastName"] == "Elmasry"
    assert body["email"] == "settings@example.com"
    assert body["experience"] == []


# ── Address + EEO self-identification (autofill v2.1, Task C1) ────────────────

_ADDRESS_EEO_PAYLOAD = {
    "addressStreet": "123 Main St",
    "addressCity": "Ottawa",
    "addressState": "ON",
    "postalCode": "K1A 0B1",
    "country": "Canada",
    "eeo": {
        "gender": "Male",
        "race": "Prefer not to say",
        "hispanicLatino": "No",
        "veteranStatus": "Not a protected veteran",
        "disabilityStatus": "No, I do not have a disability",
    },
}


def test_patch_address_and_eeo_then_get_returns_them(client, db_session, user):
    """PUT the new address + EEO fields → GET reflects them (round-trip)."""
    res = client.put("/api/user/application-profile", json=_ADDRESS_EEO_PAYLOAD)
    assert res.status_code == 200

    body = client.get("/api/user/application-profile").json()
    assert body["addressStreet"] == "123 Main St"
    assert body["addressCity"] == "Ottawa"
    assert body["addressState"] == "ON"
    assert body["postalCode"] == "K1A 0B1"
    assert body["country"] == "Canada"
    # addressCity shares the ``city`` column, so ``location`` reflects it too.
    assert body["location"] == "Ottawa"
    # EEO is a nested object with the exact camelCase keys the extension reads.
    assert body["eeo"]["gender"] == "Male"
    assert body["eeo"]["race"] == "Prefer not to say"
    assert body["eeo"]["hispanicLatino"] == "No"
    assert body["eeo"]["veteranStatus"] == "Not a protected veteran"
    assert body["eeo"]["disabilityStatus"] == "No, I do not have a disability"


def test_address_and_eeo_default_empty(client, db_session, user):
    """With only a resume, the new fields default to empty (never null/missing).

    addressCity comes from the ``city`` settings column only — the resume's
    free-form location does NOT populate the structured city field.
    """
    db_session.add(_make_resume())
    db_session.commit()

    body = client.get("/api/user/application-profile").json()
    assert body["addressStreet"] == ""
    assert body["addressCity"] == ""
    assert body["addressState"] == ""
    assert body["postalCode"] == ""
    assert body["country"] == ""
    assert body["eeo"] == {
        "gender": "",
        "race": "",
        "hispanicLatino": "",
        "veteranStatus": "",
        "disabilityStatus": "",
    }


def test_sync_snapshot_carries_address_and_eeo(client, db_session, user):
    """The extension sync snapshot reuses the same merge, so it exposes the new
    fields end-to-end under ``profile`` with matching camelCase keys."""
    assert client.put("/api/user/application-profile", json=_ADDRESS_EEO_PAYLOAD).status_code == 200

    snap = client.get("/api/extension/sync")
    assert snap.status_code == 200
    profile = snap.json()["profile"]
    assert profile["addressStreet"] == "123 Main St"
    assert profile["addressState"] == "ON"
    assert profile["postalCode"] == "K1A 0B1"
    assert profile["country"] == "Canada"
    assert profile["eeo"]["veteranStatus"] == "Not a protected veteran"
    assert profile["eeo"]["disabilityStatus"] == "No, I do not have a disability"
