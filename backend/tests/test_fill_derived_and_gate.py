"""
End-to-end /api/fill: the 18+ question is answered from the profile, and no
pass can return a value the profile contradicts.

The production failure this pins: a Workday yes/no radio group whose label
harvested as the widget boilerplate "Yes Required" canonicalized identically to
every OTHER yes/no group on the page, so they all shared one Question Memory
row — last write wins — and "Are you 18 or older?" was answered from it. The
grounding contract lives in a prompt, so only pass 3 was ever checked.

Isolated SQLite app; embeddings and the LLM are mocked, so no network/key.
"""
from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import SavedAnswer
from backend.services.usage_limiter import llm_guard
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_fill_derived.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

app = FastAPI()
app.include_router(fill.router, prefix="/api", tags=["fill"])

_EMBED = "backend.services.embeddings.EmbeddingsService.embed_batch"
_ANSWER = "backend.services.openai_service.OpenAIService.answer_question"

# An applicant who is unambiguously an adult, with a datable career.
ADULT = {
    "firstName": "Ada",
    "email": "ada@example.com",
    "dateOfBirth": "2000-04-23",
    "requiresSponsorship": "No",
    "workHistory": [{"startDate": "2021-01", "endDate": "Present"}],
    "educationHistory": [{"degree": "BSc Computer Science", "graduationYear": "2022"}],
}


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def override_deps():
    def _db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[llm_guard] = lambda: TEST_USER_ID
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def post(client, fields, profile=ADULT, company=""):
    return client.post(
        "/api/fill",
        json={"fields": fields, "profile": profile, "company": company},
    ).json()


def age_field(options=None):
    return {
        "id": "f1",
        "label": "Are you 18 years of age or older?",
        "type": "radio",
        "options": options if options is not None else ["Yes", "No"],
    }


def poison(db, question, answer):
    """Bank an answer under `question` with an embedding that matches anything.

    A single stored vector plus a single query vector means cosine 1.0 — the
    exact-key collision the boilerplate label produced in production.
    """
    db.add(SavedAnswer(
        user_id=TEST_USER_ID, question_raw=question,
        question_canonical=question.lower(), answer=answer,
        category="general", embedding=[1.0, 0.0], embedding_model="test",
    ))
    db.commit()


# ── The 18+ question is now deterministic ────────────────────────────────────

def test_18_plus_is_answered_from_the_profile_with_memory_disabled(client):
    """The proof that the path is deterministic: no saved answers at all, and
    the LLM would say the opposite if it were ever consulted."""
    with patch(_EMBED, AsyncMock(side_effect=AssertionError("memory must not be consulted"))), \
         patch(_ANSWER, AsyncMock(return_value="No")):
        body = post(client, [age_field()])
    assert len(body["answers"]) == 1
    ans = body["answers"][0]
    assert ans["answer"] == "Yes"
    assert ans["fillPass"] == "derived"


def test_18_plus_short_circuits_before_question_memory(client):
    """A poisoned key that WOULD match is never reached — pass 1 answered."""
    db = TestingSessionLocal()
    poison(db, "Yes Required", "No")
    db.close()

    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="No")):
        body = post(client, [age_field()])
    assert body["answers"][0]["answer"] == "Yes"
    assert body["answers"][0]["fillPass"] == "derived"

    # The poisoned row was never even matched.
    db = TestingSessionLocal()
    row = db.query(SavedAnswer).first()
    assert (row.times_matched or 0) == 0
    db.close()


def test_a_minor_is_answered_no_not_yes(client):
    minor = {**ADULT, "dateOfBirth": "2012-04-23"}
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="Yes")):
        body = post(client, [age_field()], profile=minor)
    assert body["answers"][0]["answer"] == "No"


def test_an_age_dropdown_with_prose_options_gets_the_right_option(client):
    options = ["I am 18 years of age or older", "I am under 18 years of age"]
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="")):
        body = post(client, [age_field(options)])
    assert body["answers"][0]["answer"] == "I am 18 years of age or older"


def test_without_a_dob_the_question_falls_through(client):
    """No DOB means the resolver abstains; the existing keyword rule still
    answers, and nothing is invented by the derived path."""
    no_dob = {k: v for k, v in ADULT.items() if k != "dateOfBirth"}
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="")):
        body = post(client, [age_field()], profile=no_dob)
    assert body["answers"][0]["fillPass"] == "rule"


# ── The gate applies to every pass ───────────────────────────────────────────

# "Please confirm your e-mail" is the vehicle for the pass-2 and pass-3 cases:
# the hyphen means pass 1's `"email" in question` shortcut does not fire, so the
# question genuinely reaches the later passes — while the gate, which matches
# `e-?mail`, still knows the profile speaks to it.
EMAIL_FIELD = {
    "id": "f1",
    "label": "Please confirm your e-mail",
    "type": "text",
    "options": [],
}


def test_a_remembered_answer_contradicting_the_profile_is_dropped(client):
    """Pass 2, gated."""
    db = TestingSessionLocal()
    poison(db, "Please confirm your e-mail", "old-address@example.com")
    db.close()

    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="__NO_ANSWER__")):
        body = post(client, [EMAIL_FIELD])
    assert body["answers"] == []
    assert body["dropped"][0]["reason"] == "contradicts_profile:email"
    assert body["dropped"][0]["source"] == "memory"
    # And never the value.
    assert "old-address" not in str(body)


def test_an_ai_answer_contradicting_the_profile_is_dropped(client):
    """Pass 3, gated by the same check — not by the prompt."""
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="someone.else@example.com")):
        body = post(client, [EMAIL_FIELD])
    assert body["answers"] == []
    assert body["dropped"][0]["reason"] == "contradicts_profile:email"
    assert body["dropped"][0]["source"] == "ai"


def test_the_matching_answer_survives_on_every_pass(client):
    """The gate refuses contradictions, not answers."""
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="ada@example.com")):
        body = post(client, [EMAIL_FIELD])
    assert body["answers"][0]["answer"] == "ada@example.com"


def test_a_rule_answer_that_the_widget_cannot_take_is_dropped(client):
    """Pass 1, gated. The real production case (autofill_reports #124): the
    `"city" in question` shortcut matched inside "capaCITY", and the applicant's
    home city was proposed as the answer to a yes/no question. It reached the
    page; only the option match failed, and nothing had checked the value."""
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="__NO_ANSWER__")):
        body = post(
            client,
            [{
                "id": "f1",
                "label": "Have you previously been employed by uOttawa in any capacity?",
                "type": "radio",
                "options": ["Yes", "No"],
            }],
            profile={**ADULT, "addressCity": "Ottawa, ON"},
        )
    assert body["answers"] == []
    # The rule's answer is refused first; the AI then declines to invent one,
    # and the field is left blank for the gap modal.
    assert [(d["source"], d["reason"]) for d in body["dropped"]] == [
        ("rule", "not_an_offered_option"),
        ("ai", "no_answer"),
    ]
    # The label legitimately names uOttawa; the refused ANSWER never appears.
    assert "Ottawa, ON" not in str(body)


def test_a_derived_fact_shadows_question_memory_entirely(client):
    """Pass 1's resolvers run before pass 2 is consulted, so a computable
    question can never be answered by a neighbouring row."""
    db = TestingSessionLocal()
    poison(db, "Total years of professional experience", "12")
    db.close()

    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="12")):
        body = post(client, [{
            "id": "f1", "label": "Total years of professional experience",
            "type": "text", "options": [],
        }])
    assert body["answers"][0]["fillPass"] == "derived"
    assert body["answers"][0]["answer"] == "5"


def test_every_drop_records_a_reason_and_never_the_value(client):
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="Gold")):
        body = post(client, [{
            "id": "f1", "label": "Favourite metal?", "type": "select",
            "options": ["Silver", "Bronze"],
        }])
    assert body["dropped"][0]["reason"] == "not_an_offered_option"
    assert "Gold" not in str(body["dropped"])


# ── Pass-2 hit counting ──────────────────────────────────────────────────────

def test_a_pass_2_match_is_counted_even_when_the_answer_is_kept(client):
    db = TestingSessionLocal()
    poison(db, "Are you willing to relocate for this role?", "Yes")
    db.close()

    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="")):
        body = post(client, [{
            "id": "f1", "label": "Are you willing to relocate for this role?",
            "type": "radio", "options": ["Yes", "No"],
        }])
    assert body["answers"][0]["answer"] == "Yes"

    db = TestingSessionLocal()
    row = db.query(SavedAnswer).first()
    assert row.times_matched == 1
    assert row.last_matched_at is not None
    db.close()


def test_a_match_whose_answer_is_dropped_still_counts_as_a_match(client):
    """Otherwise the one row worth finding — a key winning recall for questions
    it has nothing to do with — is the one row with no evidence against it."""
    db = TestingSessionLocal()
    poison(db, "Please confirm your e-mail", "old-address@example.com")
    db.close()

    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])), \
         patch(_ANSWER, AsyncMock(return_value="__NO_ANSWER__")):
        post(client, [EMAIL_FIELD])

    db = TestingSessionLocal()
    row = db.query(SavedAnswer).first()
    assert row.times_matched == 1
    assert (row.times_reused or 0) == 0  # matched, but not actually reused
    db.close()
