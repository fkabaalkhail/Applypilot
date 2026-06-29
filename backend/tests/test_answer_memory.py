"""Pure-logic tests for the Question Memory: canonicalization, categorization,
cosine similarity, and best-match selection. No I/O, no DB."""
from types import SimpleNamespace

import pytest

from backend.services.answer_memory import (
    canonicalize_question,
    categorize_question,
    cosine,
    best_match,
)


class TestCanonicalize:
    def test_strips_company_and_title_and_normalizes(self):
        out = canonicalize_question(
            "Why do you want to work at Acme as a Senior Engineer?",
            company="Acme",
            job_title="Senior Engineer",
        )
        assert out == "why do you want to work at {company} as a {role}?"

    def test_company_match_is_case_insensitive(self):
        out = canonicalize_question("Why ACME?", company="Acme")
        assert out == "why {company}?"

    def test_empty_company_does_not_corrupt_text(self):
        # re.sub on an empty pattern would otherwise inject between every char.
        out = canonicalize_question("Why this role?", company="", job_title="")
        assert out == "why this role?"

    def test_collapses_whitespace_and_lowercases(self):
        out = canonicalize_question("  Expected   SALARY?  ")
        assert out == "expected salary?"


class TestCategorize:
    def test_company_specific(self):
        assert categorize_question("Why do you want to work here?") == "company_specific"
        assert categorize_question("What interests you about our company?") == "company_specific"

    def test_behavioral(self):
        assert categorize_question("Tell us about a time you failed.") == "behavioral"
        assert categorize_question("Describe a situation where you led a team.") == "behavioral"

    def test_salary(self):
        assert categorize_question("What is your expected salary?") == "salary"
        assert categorize_question("Desired compensation?") == "salary"

    def test_work_authorization(self):
        assert categorize_question("Are you legally authorized to work in the US?") == "work_authorization"
        assert categorize_question("Do you require visa sponsorship?") == "work_authorization"

    def test_availability(self):
        assert categorize_question("When can you start?") == "availability"
        assert categorize_question("What is your notice period?") == "availability"

    def test_general_fallback(self):
        assert categorize_question("What is your favorite programming language?") == "general"


class TestCosine:
    def test_identical_vectors_is_one(self):
        assert cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == pytest.approx(1.0)

    def test_orthogonal_is_zero(self):
        assert cosine([1.0, 0.0], [0.0, 1.0]) == 0.0

    def test_empty_vector_is_zero(self):
        assert cosine([], [1.0]) == 0.0


class TestBestMatch:
    def test_returns_highest_scoring_row(self):
        rows = [
            SimpleNamespace(id=1, embedding=[1.0, 0.0]),
            SimpleNamespace(id=2, embedding=[0.9, 0.1]),
        ]
        match, score = best_match([1.0, 0.0], rows)
        assert match.id == 1
        assert score == 1.0

    def test_ignores_rows_without_embedding(self):
        rows = [
            SimpleNamespace(id=1, embedding=[]),
            SimpleNamespace(id=2, embedding=[1.0, 0.0]),
        ]
        match, score = best_match([1.0, 0.0], rows)
        assert match.id == 2

    def test_no_rows_returns_none(self):
        match, score = best_match([1.0, 0.0], [])
        assert match is None
        assert score == 0.0
