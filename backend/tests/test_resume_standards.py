"""
The shared resume-standards block.

The whole point of `prompts/_standards.md` is that the prompt which *grades* a resume and
the prompts that *rewrite* it are held to one copy of the rules. These tests pin that:
every writing prompt inlines the block, the transcription prompt never does, and the rules
the feature rests on are actually in there.
"""

import re

import pytest

from backend.services.openai_service import (
    PROMPTS_DIR,
    STANDARDS_TOKEN,
    _load_prompt,
    _load_standards,
    _render_emphasis,
)

# The prompts that write or grade a resume. Every one is held to the standard.
WRITING_PROMPTS = [
    "analyze_resume_quality.txt",
    "improve_resume.txt",
    "tailor_resume.txt",
    "tailor_resume_guided.txt",
    "tailor_resume_structured.txt",
]


@pytest.mark.parametrize("filename", WRITING_PROMPTS)
def test_every_writing_prompt_inlines_the_standards(filename):
    template = _load_prompt(filename)
    assert "THE WHO METHOD" in template, f"{filename} lost the standards block"
    assert STANDARDS_TOKEN not in template, f"{filename} shipped an unresolved token"


def test_the_transcription_prompt_is_never_given_the_standards():
    """analyze_resume.txt reads a resume; it must not be tempted to improve one.

    Its "copy every line verbatim" contract is what protects upload fidelity, handing it
    writing rules is how Projects sections start disappearing again.
    """
    assert "THE WHO METHOD" not in _load_prompt("analyze_resume.txt")


def test_the_developer_header_is_stripped_before_the_model_sees_it():
    standards = _load_standards()
    assert standards.startswith("## THE STANDARD")
    assert "Never include this in analyze_resume.txt" not in standards


@pytest.mark.parametrize(
    "rule",
    [
        "What did you do?",                     # the WHO method
        "3–5 bullets per entry",                # Yale's bullet count
        "present continuous",                   # tense rule
        "Contractions",
        "Pronouns",
        "marital status",                       # banned personal data
        "Undergraduate → **1 page**",           # length by level
        "THE HONESTY RULE",
        "**Never add a bullet.**",              # see test_resume_document.py
        "not evidence that it was used anywhere in particular",
    ],
)
def test_the_standards_state_the_rules_the_pipeline_relies_on(rule):
    """Each of these is load-bearing: the metrics measure it and the analyzer grades it.

    Deleting one from the partial would silently stop enforcing it everywhere at once.
    """
    assert rule in _load_standards()


def test_the_analyzer_never_asks_the_rewriter_to_manufacture_evidence():
    """A live run caught this: told to "provide experience demonstrating" an unevidenced
    skill, the rewriter invented "Utilized React for the frontend" about a project that
    never used React. The remedy for an unevidenced skill is to cut it or for the candidate
    to supply the bullet, never for the model to write one."""
    template = _load_prompt("analyze_resume_quality.txt")
    assert "Do NOT write that bullet for them" in template
    assert "cut it from the Skills list" in template


@pytest.mark.parametrize("filename", ["improve_resume.txt", "tailor_resume_structured.txt"])
def test_the_rewrite_prompts_lock_the_bullet_count_and_the_tense(filename):
    template = _load_prompt(filename)
    assert "the same number of bullets it went in with" in template
    assert "end_date" in template and "present simple" in template


def test_no_prompt_ships_an_unresolved_token_for_a_file_that_does_not_exist():
    """Catch a typo'd include, e.g. {{RESUME_STANDARD}}, before it reaches OpenAI."""
    for path in PROMPTS_DIR.glob("*.txt"):
        template = _load_prompt(path.name)
        for token in re.findall(r"\{\{[A-Z_]+\}\}", template):
            assert token != STANDARDS_TOKEN, f"{path.name} failed to inline {token}"


def test_emphasis_block_is_empty_when_nothing_was_requested():
    """An empty focus must not leave a dangling '## THIS REQUEST' heading in the prompt."""
    assert _render_emphasis(None, None) == ""
    assert _render_emphasis([], []) == ""


def test_emphasis_block_tells_the_model_to_drop_unsupported_keywords():
    block = _render_emphasis(["Work Experience"], ["kubernetes"])
    assert "Work Experience" in block
    assert "kubernetes" in block
    # The honesty rule wins over keyword coverage: an unsupported term is dropped, not woven in.
    assert "leave it out" in block
