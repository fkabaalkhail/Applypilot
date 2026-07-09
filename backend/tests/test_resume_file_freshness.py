"""GET /resumes/{id}/file must serve what the user last saw in the web app.

Untouched résumé → the original uploaded bytes stream as before. Edited via
PUT /resumes/{id} (the workspace editor) → the CURRENT document is rendered to
PDF, so the extension's ATS attach carries the edits, not the stale upload.
"""

from unittest.mock import AsyncMock, patch

from backend.db.models import ResumeProfileDB
from backend.services.resume_parser import _extract_pdf

TEST_USER_ID = 1

_EDIT_PROFILE = {
    "name": "Jane Edited",
    "email": "jane@example.com",
    "skills": ["Python", "Kubernetes"],
    "experience": [
        {
            "title": "Engineer",
            "company": "Acme",
            "start_date": "2020",
            "end_date": "2023",
            "bullets": ["Built tools"],
        }
    ],
    "education": [],
    "projects": [],
    "technologies": {},
}


def _seed(db) -> ResumeProfileDB:
    rec = ResumeProfileDB(
        user_id=TEST_USER_ID,
        profile_name="Jane Doe",
        is_primary=1,
        skills=["Python"],
        experience=[
            {
                "title": "Engineer",
                "company": "Acme",
                "start_date": "2020",
                "end_date": "2023",
                "bullets": ["Built tools"],
            }
        ],
        raw_text="Python engineer.",
        file_blob_url="https://blob.example/orig",
        file_name="orig.docx",
        file_content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return rec


def _download(client, resume_id):
    with patch(
        "backend.routers.resumes.blob_storage.download",
        new=AsyncMock(return_value=b"ORIGBYTES"),
    ) as dl:
        resp = client.get(f"/resumes/{resume_id}/file")
    return resp, dl


def test_untouched_resume_streams_the_original_upload(client, db_session):
    rec = _seed(db_session)
    resp, _ = _download(client, rec.id)
    assert resp.status_code == 200
    assert resp.content == b"ORIGBYTES"
    assert "orig.docx" in resp.headers["content-disposition"]


def test_edit_renders_the_current_document_not_the_upload(client, db_session):
    rec = _seed(db_session)
    assert client.put(f"/resumes/{rec.id}", json={"profile": _EDIT_PROFILE}).status_code == 200

    resp, dl = _download(client, rec.id)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/pdf")
    assert resp.content.startswith(b"%PDF")
    dl.assert_not_called()  # the stale original was never touched
    # The rendered PDF carries the EDITED content.
    text = _extract_pdf(resp.content)
    assert "Kubernetes" in text
    # Filename keeps the base but reflects the rendered format.
    assert 'filename="orig.pdf"' in resp.headers["content-disposition"]


def test_name_only_update_keeps_serving_the_original(client, db_session):
    rec = _seed(db_session)
    assert client.put(f"/resumes/{rec.id}", json={"name": "My best resume"}).status_code == 200
    resp, _ = _download(client, rec.id)
    assert resp.status_code == 200
    assert resp.content == b"ORIGBYTES"


def test_render_failure_falls_back_to_the_original(client, db_session):
    rec = _seed(db_session)
    assert client.put(f"/resumes/{rec.id}", json={"profile": _EDIT_PROFILE}).status_code == 200
    with patch(
        "backend.routers.resumes.render_resume_pdf", side_effect=RuntimeError("boom")
    ), patch(
        "backend.routers.resumes.blob_storage.download",
        new=AsyncMock(return_value=b"ORIGBYTES"),
    ):
        resp = client.get(f"/resumes/{rec.id}/file")
    assert resp.status_code == 200
    assert resp.content == b"ORIGBYTES"


def test_edited_resume_without_stored_file_still_downloads(client, db_session):
    # Uploaded before blob storage existed (no original file): an edited résumé
    # must still attach — the render path doesn't need the blob at all.
    rec = _seed(db_session)
    rec.file_blob_url = None
    db_session.commit()
    assert client.put(f"/resumes/{rec.id}", json={"profile": _EDIT_PROFILE}).status_code == 200
    resp = client.get(f"/resumes/{rec.id}/file")
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")
