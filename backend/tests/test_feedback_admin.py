"""The admin feedback console: listing everyone's feedback, and deleting one item.

The admin gate is the only thing between a signed-in stranger and every user's
feedback, so these tests drive real JWTs through the real ``get_admin_user``
dependency instead of overriding it. conftest's ``client`` overrides the
ordinary user dependencies but deliberately leaves the admin one alone.
"""
import pytest

from backend.auth.tokens import create_access_token
from backend.db.models import Feedback, User


def _user(db, user_id: int, email: str, *, is_admin: bool) -> User:
    user = User(
        id=user_id,
        email=email,
        auth_provider="local",
        email_verified=True,
        is_admin=is_admin,
    )
    db.add(user)
    db.commit()
    return user


def _auth(user_id: int) -> dict:
    """Authorization header carrying a genuine access token for ``user_id``."""
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


def _feedback(db, **overrides) -> Feedback:
    row = Feedback(
        **{
            "user_id": "",
            "category": "bug_report",
            "message": "it broke",
            "wants_followup": 0,
            **overrides,
        }
    )
    db.add(row)
    db.commit()
    return row


# --- listing -----------------------------------------------------------------


def test_list_carries_the_submitter_email(client, db_session):
    """Someone who ticked "I'd like follow-up support via email" is unanswerable
    if the console only shows their numeric id, so the row carries the address.
    """
    _user(db_session, 7, "admin@tailrd.ca", is_admin=True)
    _user(db_session, 12, "student@school.edu", is_admin=False)
    _feedback(db_session, user_id="12", wants_followup=1)

    resp = client.get("/feedback", headers=_auth(7))

    assert resp.status_code == 200
    assert resp.json()["items"][0]["email"] == "student@school.edu"


def test_list_reports_email_none_for_a_deleted_or_anonymous_submitter(client, db_session):
    """Feedback outlives accounts, and logged-out visitors submit with no id at
    all. Neither may blow up the console or invent an address.
    """
    _user(db_session, 7, "admin@tailrd.ca", is_admin=True)
    _feedback(db_session, user_id="")          # never signed in
    _feedback(db_session, user_id="9999")      # account since deleted

    resp = client.get("/feedback", headers=_auth(7))

    assert resp.status_code == 200
    assert [row["email"] for row in resp.json()["items"]] == [None, None]


def test_list_reports_the_total_so_a_capped_page_is_visible(client, db_session):
    """The handler caps how much it returns. Without a total, a truncated page
    looks exactly like "that's all the feedback there is".
    """
    _user(db_session, 7, "admin@tailrd.ca", is_admin=True)
    for _ in range(3):
        _feedback(db_session)

    resp = client.get("/feedback?limit=2", headers=_auth(7))

    body = resp.json()
    assert len(body["items"]) == 2
    assert body["total"] == 3


def test_list_offset_walks_past_the_first_page(client, db_session):
    """"Load more" is offset-based, so page two must not repeat page one."""
    _user(db_session, 7, "admin@tailrd.ca", is_admin=True)
    first = _feedback(db_session, message="oldest")
    second = _feedback(db_session, message="newest")

    resp = client.get("/feedback?limit=1&offset=1", headers=_auth(7))

    ids = [row["id"] for row in resp.json()["items"]]
    assert ids == [first.id]  # newest-first ordering puts `second` on page one
    assert second.id not in ids


def test_non_admin_cannot_list_feedback(client, db_session):
    """A signed-in ordinary user who guesses /admin gets nothing.

    Pins behaviour the admin dependency already provides; it guards against a
    future edit to this router dropping the gate.
    """
    _user(db_session, 12, "student@school.edu", is_admin=False)
    _feedback(db_session, message="private note")

    resp = client.get("/feedback", headers=_auth(12))

    assert resp.status_code == 403


# --- deleting ----------------------------------------------------------------


def test_admin_deletes_one_item_and_leaves_the_rest(client, db_session):
    _user(db_session, 7, "admin@tailrd.ca", is_admin=True)
    doomed = _feedback(db_session, message="delete me")
    survivor = _feedback(db_session, message="keep me")

    resp = client.delete(f"/feedback/{doomed.id}", headers=_auth(7))

    assert resp.status_code == 200
    remaining = [row.id for row in db_session.query(Feedback).all()]
    assert remaining == [survivor.id]


def test_non_admin_cannot_delete_feedback(client, db_session):
    """The destructive half of the console needs the gate more than the read half."""
    _user(db_session, 12, "student@school.edu", is_admin=False)
    row = _feedback(db_session)

    resp = client.delete(f"/feedback/{row.id}", headers=_auth(12))

    assert resp.status_code == 403
    assert db_session.query(Feedback).filter(Feedback.id == row.id).first() is not None


def test_deleting_feedback_that_is_already_gone_says_so(client, db_session):
    """Two admins with the console open both click Delete on the same card. The
    second gets a specific 404, not the framework's generic no-such-route one.
    """
    _user(db_session, 7, "admin@tailrd.ca", is_admin=True)

    resp = client.delete("/feedback/4242", headers=_auth(7))

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Feedback not found"


def test_anonymous_request_cannot_delete_feedback(client, db_session):
    """No token at all: rejected before any row is touched."""
    row = _feedback(db_session)

    resp = client.delete(f"/feedback/{row.id}")

    assert resp.status_code in (401, 403)
    assert db_session.query(Feedback).filter(Feedback.id == row.id).first() is not None
