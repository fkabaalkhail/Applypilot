"""
The suite runs with no live-service credentials, on a dev machine exactly as
in CI.

backend/db/database.py calls load_dotenv() at import, which walks up to the
first .env it finds. A developer's real keys used to reach every local test
run, so tests that forgot the dummy-key fixture passed locally and failed only
in CI (backend CI stayed red from 2026-07-01 without anyone seeing it
locally), and the register tests sent real verification emails. conftest.py
now pins these credentials empty before any backend import; these tests pin
that contract.
"""

import os

import pytest
from dotenv import load_dotenv

from backend.services import blob_storage
from backend.services.email_service import EmailService
from backend.services.openai_service import OpenAIService

LIVE_CREDENTIALS = ("OPENAI_API_KEY", "RESEND_API_KEY", "BLOB_READ_WRITE_TOKEN")

# Assertions compare to booleans first: on failure pytest prints the operands,
# and the operand here could be a developer's real key.


@pytest.mark.parametrize("name", LIVE_CREDENTIALS)
def test_the_suite_starts_without_the_credential(name):
    empty = os.environ.get(name) == ""
    assert empty, f"conftest must pin {name} to empty (value withheld)"


def test_no_live_service_is_configured():
    with pytest.raises(ValueError):
        OpenAIService()
    assert not EmailService().is_configured
    assert not blob_storage.is_configured()


@pytest.mark.parametrize("name", LIVE_CREDENTIALS)
def test_a_developer_env_file_cannot_hand_tests_the_credential(name, tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(f"{name}=from-a-developer-env\n", encoding="utf-8")
    prior = os.environ.get(name)
    try:
        # What backend/db/database.py does at import.
        load_dotenv(dotenv)
        empty = os.environ.get(name) == ""
    finally:
        # Never let this test leak a value into the rest of the session.
        if prior is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = prior
    assert empty, f"load_dotenv() handed the test process {name} (value withheld)"


def test_a_test_opts_in_with_a_dummy_key(monkeypatch):
    """The repo's convention for tests that build OpenAIService and mock its calls."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    assert OpenAIService().api_key == "test-key"
