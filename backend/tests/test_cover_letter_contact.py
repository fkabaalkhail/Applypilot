"""Unit tests for cover-letter contact filling + placeholder stripping."""
from unittest.mock import patch, AsyncMock

import pytest

from backend.services.cover_letter import (
    CoverLetterGenerator,
    _build_contact_block,
    _strip_placeholders,
)


class TestStripPlaceholders:
    def test_fills_known_placeholders_from_values(self):
        text = "[Your Name]\n[Email] • [Phone]\n[Date]\n\nDear Hiring Team,"
        out = _strip_placeholders(
            text,
            {
                "name": "Jane Doe",
                "email": "jane@example.com",
                "phone": "555-1234",
                "date": "June 30, 2026",
            },
        )
        assert "Jane Doe" in out
        assert "jane@example.com" in out
        assert "555-1234" in out
        assert "June 30, 2026" in out
        assert "[" not in out and "]" not in out

    def test_removes_unknown_or_unfilled_brackets(self):
        text = "[Your Name]\n[Address]\n[Some Unknown Token]\n\nBody."
        out = _strip_placeholders(text, {"name": None})
        # No values provided -> every bracket removed, nothing left bracketed.
        assert "[" not in out and "]" not in out
        assert "Body." in out

    def test_leaves_clean_text_untouched(self):
        text = "Jane Doe\njane@example.com\n\nDear Hiring Team at Acme,\n\nSincerely,\nJane"
        out = _strip_placeholders(text, {"name": "Jane Doe"})
        assert out == text


class TestContactBlock:
    def test_only_includes_known_fields(self):
        block = _build_contact_block("Jane Doe", None, "555-1234", "NYC", None)
        assert "Name: Jane Doe" in block
        assert "Phone: 555-1234" in block
        assert "Location: NYC" in block
        assert "Email" not in block
        assert "LinkedIn" not in block

    def test_empty_when_nothing_known(self):
        assert _build_contact_block(None, None, None, None, None) == "(none provided)"


@pytest.mark.asyncio
async def test_generate_injects_contact_into_prompt(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    gen = AsyncMock(return_value="Dear Hiring Team, [Your Name] applying. Sincerely, [Your Name]")
    with patch("backend.services.openai_service.OpenAIService._generate", gen):
        out = await CoverLetterGenerator().generate(
            "resume text", "job desc", "Acme",
            name="Jane Doe", email="jane@example.com",
        )
    prompt = gen.call_args.args[0]
    assert "Name: Jane Doe" in prompt
    assert "Email: jane@example.com" in prompt
    # The safety net replaced the leftover placeholders the model emitted.
    assert "Jane Doe" in out
    assert "[Your Name]" not in out
