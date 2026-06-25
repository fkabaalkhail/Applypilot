"""
Integration tests for the extension-sync surface added for the Chrome extension:

  - resume file storage flag + authenticated download proxy (Phase 2)
  - profile sync version + write-back round-trip (Phase 4)
  - cover-letter persistence + CRUD + active (Phase 3)

Auth: the conftest ``client`` fixture overrides ``get_verified_user_id`` (used by
the resumes/ai routers); the ``user`` fixture below overrides ``get_verified_user``
(used by the profile router).
"""

import pytest

from backend.auth.dependencies import get_verified_user
from backend.db.models import ResumeProfileDB, User
from backend.main import app

TEST_USER_ID = 1


@pytest.fixture
def user(db_session):
    u = User(
        id=TEST_USER_ID,
        email="u@example.com",
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


# ── Resume file storage + download (Phase 2) ──────────────────────────────────

def test_resume_list_has_file_flag_false_and_download_404(client, db_session):
    r = ResumeProfileDB(user_id=TEST_USER_ID, name="R", raw_text="x")
    db_session.add(r)
    db_session.commit()

    items = client.get("/resumes").json()
    assert items[0]["has_file"] is False

    # No stored binary → download 404 with a helpful message.
    res = client.get(f"/resumes/{r.id}/file")
    assert res.status_code == 404


def test_resume_file_download_proxies_bytes(client, db_session, monkeypatch):
    r = ResumeProfileDB(
        user_id=TEST_USER_ID,
        name="R",
        raw_text="x",
        file_blob_url="https://blob.example/x",
        file_name="cv.pdf",
        file_content_type="application/pdf",
        file_size=3,
    )
    db_session.add(r)
    db_session.commit()

    async def fake_download(url):
        assert url == "https://blob.example/x"
        return b"PDF"

    monkeypatch.setattr("backend.services.blob_storage.download", fake_download)

    res = client.get(f"/resumes/{r.id}/file")
    assert res.status_code == 200
    assert res.content == b"PDF"
    assert res.headers["content-type"].startswith("application/pdf")
    assert "cv.pdf" in res.headers.get("content-disposition", "")

    # And the list now reports the file is available.
    assert client.get("/resumes").json()[0]["has_file"] is True


def test_resume_download_404_for_other_users_file(client, db_session):
    """Authorization: a file owned by another user must not be downloadable."""
    r = ResumeProfileDB(
        user_id=999, name="R", raw_text="x", file_blob_url="https://blob.example/x"
    )
    db_session.add(r)
    db_session.commit()

    assert client.get(f"/resumes/{r.id}/file").status_code == 404


# ── Profile sync version + write-back (Phase 4) ───────────────────────────────

def test_profile_version_and_put_roundtrip(client, db_session, user):
    put = client.put(
        "/api/user/application-profile",
        json={"phone": "+1 555", "currentTitle": "Staff Eng", "workAuthorization": "Yes"},
    )
    assert put.status_code == 200
    v1 = put.json()["version"]
    assert v1 >= 1

    # Cheap version endpoint agrees.
    assert client.get("/api/user/profile-version").json()["version"] == v1

    # Edits are reflected (settings-first precedence) and screening mined back.
    body = client.get("/api/user/application-profile").json()
    assert body["phone"] == "+1 555"
    assert body["currentTitle"] == "Staff Eng"
    assert body["workAuthorization"] == "Yes"
    assert body["version"] == v1

    # A further edit bumps the version so the extension knows to refetch.
    v2 = client.put("/api/user/application-profile", json={"phone": "+1 666"}).json()["version"]
    assert v2 > v1


# ── Cover letters (Phase 3) ───────────────────────────────────────────────────

def test_cover_letter_crud_and_active(client, db_session):
    saved = client.post(
        "/ai/cover-letters",
        json={"text": "Dear team", "company": "Acme", "set_active": True},
    )
    assert saved.status_code == 200
    cl = saved.json()
    assert cl["is_active"] is True
    assert cl["text"] == "Dear team"

    assert any(c["id"] == cl["id"] for c in client.get("/ai/cover-letters").json())

    # A second active letter deactivates the first; re-activating the first works.
    client.post("/ai/cover-letters", json={"text": "Hello", "set_active": True})
    act = client.put(f"/ai/cover-letters/{cl['id']}/active")
    assert act.status_code == 200
    assert act.json()["is_active"] is True

    assert client.delete(f"/ai/cover-letters/{cl['id']}").status_code == 204
