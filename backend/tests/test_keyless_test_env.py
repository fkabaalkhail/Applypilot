"""
The suite runs with no OpenAI key, on a dev machine exactly as in CI.

backend/db/database.py calls load_dotenv() at import, which walks up to the
first .env it finds. A developer's real key used to reach every local test
run, so tests that forgot the dummy-key fixture passed locally and failed only
in CI (backend CI stayed red from 2026-07-01 without anyone seeing it locally).
conftest.py now pins the key empty before any backend import; these tests pin
that contract.
"""

import os

import pytest
from dotenv import load_dotenv

from backend.services.openai_service import OpenAIService


# Assertions compare to booleans first: on failure pytest prints the operands,
# and the operand here could be a developer's real key.


def test_the_suite_starts_without_an_openai_key():
    keyless = os.environ.get("OPENAI_API_KEY") == ""
    assert keyless, "conftest must pin OPENAI_API_KEY to empty (value withheld)"
    with pytest.raises(ValueError):
        OpenAIService()


def test_a_developer_env_file_cannot_hand_tests_a_key(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text("OPENAI_API_KEY=sk-from-a-developer-env\n", encoding="utf-8")
    prior = os.environ.get("OPENAI_API_KEY")
    try:
        # What backend/db/database.py does at import.
        load_dotenv(dotenv)
        keyless = os.environ.get("OPENAI_API_KEY") == ""
    finally:
        # Never let this test leak a key into the rest of the session.
        if prior is None:
            os.environ.pop("OPENAI_API_KEY", None)
        else:
            os.environ["OPENAI_API_KEY"] = prior
    assert keyless, "load_dotenv() handed the test process a key (value withheld)"


def test_a_test_opts_in_with_a_dummy_key(monkeypatch):
    """The repo's convention for tests that build OpenAIService and mock its calls."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    assert OpenAIService().api_key == "test-key"
