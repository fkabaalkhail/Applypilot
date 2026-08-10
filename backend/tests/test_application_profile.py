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
    "location": "Ottawa, ON, Canada",
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
        "genderIdentity": "Cisgender",
        "pronouns": "He/Him",
        "sexualOrientation": "Prefer not to say",
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
    # location and addressCity are separate columns now — see
    # test_location_and_address_city_both_survive_one_put below.
    assert body["location"] == "Ottawa, ON, Canada"
    # EEO is a nested object with the exact camelCase keys the extension reads.
    assert body["eeo"]["gender"] == "Male"
    assert body["eeo"]["race"] == "Prefer not to say"
    assert body["eeo"]["hispanicLatino"] == "No"
    assert body["eeo"]["veteranStatus"] == "Not a protected veteran"
    assert body["eeo"]["disabilityStatus"] == "No, I do not have a disability"
    assert body["eeo"]["genderIdentity"] == "Cisgender"
    assert body["eeo"]["pronouns"] == "He/Him"
    assert body["eeo"]["sexualOrientation"] == "Prefer not to say"


def test_address_and_eeo_default_empty(client, db_session, user):
    """With only a resume, the new fields default to empty (never null/missing).

    addressCity comes from the settings columns only — the resume's free-form
    location does NOT populate the structured city field.
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
        "genderIdentity": "",
        "pronouns": "",
        "sexualOrientation": "",
    }


# ── location vs addressCity: two fields, two columns ──────────────────────────
#
# They shared ``user_settings.city`` until 2026-08-09, so the PUT's field_map had
# two entries pointing at one column and dict iteration order silently decided
# which of the user's two values survived.

def test_location_and_address_city_both_survive_one_put(client, db_session, user):
    """A single PUT carrying different values for both must persist BOTH."""
    res = client.put(
        "/api/user/application-profile",
        json={"location": "Greater Toronto Area", "addressCity": "Mississauga"},
    )
    assert res.status_code == 200

    body = client.get("/api/user/application-profile").json()
    assert body["location"] == "Greater Toronto Area"
    assert body["addressCity"] == "Mississauga"


def test_city_only_user_is_not_relocated_to_the_bot_default(client, db_session, user):
    """The mirror fallback. ``user_settings.location`` is the LinkedIn bot's
    search region and defaults to "United States"; splitting the columns must not
    let it become the answer for a user who only ever filled in their City."""
    assert client.put(
        "/api/user/application-profile", json={"addressCity": "Ottawa"}
    ).status_code == 200

    body = client.get("/api/user/application-profile").json()
    assert body["addressCity"] == "Ottawa"
    assert body["location"] == "Ottawa"


def test_address_city_falls_back_to_the_legacy_city_column(client, db_session, user):
    """Rows written before the split kept the address city in ``city``; they must
    keep working, so a blank ``address_city`` reads through to it."""
    _seed_settings(db_session, city="Ottawa")

    body = client.get("/api/user/application-profile").json()
    assert body["addressCity"] == "Ottawa"
    assert body["location"] == "Ottawa"


# ── github is writable now ────────────────────────────────────────────────────

def test_github_round_trips_through_put(client, db_session, user):
    """github had no write path at all: the web app wrote it to the resume row
    and the extension kept it in chrome.storage.local, so it never synced."""
    assert client.put(
        "/api/user/application-profile",
        json={"github": "https://github.com/wissam-e"},
    ).status_code == 200

    body = client.get("/api/user/application-profile").json()
    assert body["github"] == "https://github.com/wissam-e"


def test_saved_github_overrides_the_resume_parsed_one(client, db_session, user):
    """The resume value is only what the parser found — an explicit edit wins."""
    db_session.add(_make_resume(github_url="https://github.com/parsed-wrong"))
    db_session.commit()

    client.put(
        "/api/user/application-profile",
        json={"github": "https://github.com/corrected"},
    )
    body = client.get("/api/user/application-profile").json()
    assert body["github"] == "https://github.com/corrected"


# ── The eight screening answers ───────────────────────────────────────────────

_SCREENING_PAYLOAD = {
    "willingToRelocate": "Yes",
    "workPreference": "Hybrid",
    "noticePeriod": "2 weeks",
    "earliestStartDate": "2026-09-01",
    "yearsOfExperience": "5",
    "securityClearance": "None",
    "driversLicense": "Yes",
    "languages": "English (Native), French (Professional)",
}


def test_screening_answers_round_trip(client, db_session, user):
    assert client.put(
        "/api/user/application-profile", json=_SCREENING_PAYLOAD
    ).status_code == 200

    body = client.get("/api/user/application-profile").json()
    for field, value in _SCREENING_PAYLOAD.items():
        assert body[field] == value, field


def test_screening_answers_use_the_exact_contract_keys(client, db_session, user):
    """The prefilled_answers keys are binding on the web app and the extension
    too — they are what all three surfaces agree on. Pin them."""
    client.put("/api/user/application-profile", json=_SCREENING_PAYLOAD)

    db_session.expire_all()
    stored = db_session.query(UserSettings).filter(
        UserSettings.user_id == TEST_USER_ID
    ).first().prefilled_answers
    assert stored == {
        "Willing to relocate": "Yes",
        "Work preference": "Hybrid",
        "Notice period": "2 weeks",
        "Earliest start date": "2026-09-01",
        "Years of experience": "5",
        "Security clearance": "None",
        "Driver's licence": "Yes",
        "Languages": "English (Native), French (Professional)",
    }


def test_screening_answers_default_empty(client, db_session, user):
    db_session.add(_make_resume())
    db_session.commit()

    body = client.get("/api/user/application-profile").json()
    for field in _SCREENING_PAYLOAD:
        assert body[field] == "", field


def test_screening_answers_are_never_substring_mined(client, db_session, user):
    """The whole point of exact keys. "Earliest start date" must not be read as
    a date of birth, and "Work preference" must not become the user's
    work-authorization answer — mining either would put a wrong, confident
    answer on a real employer's form."""
    client.put(
        "/api/user/application-profile",
        json={"dateOfBirth": "1998-04-11", "workAuthorization": "Canadian citizen"},
    )
    client.put("/api/user/application-profile", json=_SCREENING_PAYLOAD)

    body = client.get("/api/user/application-profile").json()
    assert body["dateOfBirth"] == "1998-04-11"
    assert body["earliestStartDate"] == "2026-09-01"
    assert body["workAuthorization"] == "Canadian citizen"
    assert body["workPreference"] == "Hybrid"
    # And nothing leaked into the answers they sit next to.
    assert body["requiresSponsorship"] == ""
    assert body["salaryExpectation"] == ""


def test_screening_keys_cannot_shadow_a_mined_legacy_answer(client, db_session, user):
    """A saved screening answer must not join the substring-mining pool, where
    it could out-rank the real harvested question text it sits beside."""
    _seed_settings(
        db_session,
        prefilled_answers={
            "Work preference": "Remote",
            "Are you legally eligible to work in the US?": "Yes",
        },
    )

    body = client.get("/api/user/application-profile").json()
    assert body["workAuthorization"] == "Yes"
    assert body["workPreference"] == "Remote"


def test_sync_snapshot_carries_the_new_fields(client, db_session, user):
    """GET /api/extension/sync reuses build_application_profile, so everything
    above must reach the extension unchanged — including the raw answer map."""
    client.put("/api/user/application-profile", json={
        **_SCREENING_PAYLOAD,
        "github": "https://github.com/wissam-e",
        "location": "Greater Toronto Area",
        "addressCity": "Mississauga",
        "eeo": {"genderIdentity": "Non-binary", "pronouns": "They/Them",
                "sexualOrientation": "Bisexual"},
    })

    snap = client.get("/api/extension/sync")
    assert snap.status_code == 200
    body = snap.json()
    profile = body["profile"]

    for field, value in _SCREENING_PAYLOAD.items():
        assert profile[field] == value, field
    assert profile["github"] == "https://github.com/wissam-e"
    assert profile["location"] == "Greater Toronto Area"
    assert profile["addressCity"] == "Mississauga"
    assert profile["eeo"]["genderIdentity"] == "Non-binary"
    assert profile["eeo"]["pronouns"] == "They/Them"
    assert profile["eeo"]["sexualOrientation"] == "Bisexual"
    # The snapshot also passes the raw map through; the exact keys survive it.
    assert body["settings"]["prefilledAnswers"]["Driver's licence"] == "Yes"


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


# ── Screening answers round-trip (salaryExpectation was write-only) ───────────

def test_salary_expectation_round_trips(client, db_session, user):
    """It is written into prefilled_answers, so it must also be mined back out."""
    put = client.put(
        "/api/user/application-profile",
        json={"salaryExpectation": "90000 CAD"},
    )
    assert put.status_code == 200

    got = client.get("/api/user/application-profile")
    assert got.status_code == 200
    assert got.json()["salaryExpectation"] == "90000 CAD"


def test_screening_answers_round_trip_together(client, db_session, user):
    client.put(
        "/api/user/application-profile",
        json={
            "currentTitle": "Software Engineer Intern",
            "workAuthorization": "Yes, authorized to work for any employer",
            "requiresSponsorship": "No",
            "salaryExpectation": "$85,000",
        },
    )

    body = client.get("/api/user/application-profile").json()
    assert body["currentTitle"] == "Software Engineer Intern"
    assert body["workAuthorization"] == "Yes, authorized to work for any employer"
    assert body["requiresSponsorship"] == "No"
    assert body["salaryExpectation"] == "$85,000"


# ── SetupWizard's internal keys must not shadow real screening answers ────────
#
# Onboarding (frontend/src/setup/SetupWizard.tsx) PUTs its own filter state into
# the same prefilled_answers map: {"job_types": ..., "work_authorization": ...}.
# The literal key "work_authorization" contains the substring "authoriz", is
# non-empty, and is inserted first — so first-match substring mining used to
# serve the internal enum token back as the user's answer AND block the real
# fixed key from ever winning. The user's correction was silently discarded and
# the extension kept autofilling "needs_sponsorship" into employers' forms.

_SETUP_WIZARD_ANSWERS = {
    "job_types": "internship",
    "work_authorization": "needs_sponsorship",
}


def _seed_settings(db_session, **kwargs) -> UserSettings:
    s = UserSettings(user_id=TEST_USER_ID, **kwargs)
    db_session.add(s)
    db_session.commit()
    return s


def test_setup_wizard_token_is_never_served_as_an_answer(client, db_session, user):
    """"needs_sponsorship" is an internal enum, not something an employer sees."""
    _seed_settings(db_session, prefilled_answers=dict(_SETUP_WIZARD_ANSWERS))

    body = client.get("/api/user/application-profile").json()
    assert body["workAuthorization"] == ""
    assert body["requiresSponsorship"] == ""


def test_setup_wizard_key_cannot_shadow_a_saved_work_authorization(
    client, db_session, user
):
    """A user who ticked "needs sponsorship" at onboarding must still be able to
    correct their work-authorization answer. The onboarding key literally
    contains "authoriz", so first-match substring mining used to win and
    silently discard the correction."""
    _seed_settings(db_session, prefilled_answers=dict(_SETUP_WIZARD_ANSWERS))

    put = client.put(
        "/api/user/application-profile",
        json={"workAuthorization": "Yes, I am legally authorized to work in Canada"},
    )
    assert put.status_code == 200

    body = client.get("/api/user/application-profile").json()
    assert body["workAuthorization"] == "Yes, I am legally authorized to work in Canada"


def test_substring_fallback_still_mines_legacy_question_keys(client, db_session, user):
    """The fix must not break the path it exists for: legacy rows and question
    text the extension harvested verbatim from a real form still resolve."""
    _seed_settings(
        db_session,
        prefilled_answers={
            "Are you legally eligible to work in the US?": "Yes",
            "Will you now or in the future require sponsorship?": "No",
            "What are your salary expectations?": "80000",
        },
    )

    body = client.get("/api/user/application-profile").json()
    assert body["workAuthorization"] == "Yes"
    assert body["requiresSponsorship"] == "No"
    assert body["salaryExpectation"] == "80000"


def test_exact_saved_key_beats_a_conflicting_mined_key(client, db_session, user):
    """An answer the user deliberately saved through the PUT is authoritative
    over anything merely matched by substring, whatever the insertion order."""
    _seed_settings(
        db_session,
        prefilled_answers={
            "Are you legally eligible to work in the US?": "Stale harvested answer",
        },
    )

    client.put(
        "/api/user/application-profile",
        json={"workAuthorization": "Yes, authorized for any employer"},
    )

    body = client.get("/api/user/application-profile").json()
    assert body["workAuthorization"] == "Yes, authorized for any employer"


# ── PUT /settings must not destroy user-curated answers ───────────────────────

def test_settings_put_merges_prefilled_answers(client, db_session, user):
    """prefilled_answers is now user-owned, user-curated data (the Profile card
    writes the three screening answers into it). A client sending its own keys —
    SetupWizard is the only one — must not wipe the rest of the map."""
    _seed_settings(db_session, prefilled_answers={"Salary expectation": "120000"})

    res = client.put("/settings", json={"prefilled_answers": {"job_types": "internship"}})
    assert res.status_code == 200

    # The setup wizard's key landed, and the salary answer survived.
    assert res.json()["prefilled_answers"] == {
        "Salary expectation": "120000",
        "job_types": "internship",
    }
    assert client.get("/api/user/application-profile").json()["salaryExpectation"] == "120000"
