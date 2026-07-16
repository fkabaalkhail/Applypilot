# AI-Composed Long-Answer Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill open-ended long-answer application fields (why-us, behavioral, self-intro, company-knowledge) with an AI-composed answer grounded in the applicant's real experience + the job posting, instead of leaving them blank.

**Architecture:** Backend-only. A pure heuristic in `fill.py` flags a long free-text field carrying an open-ended cue and routes it to a new `compose_answer.txt` prompt (via a new `OpenAIService.compose_answer` method); every other field keeps the untouched strict-grounding `answer_question.txt` path. The extension already treats textareas as AI candidates, fills returned answers silently, and sends the job posting + profile, so nothing on the extension changes.

**Tech Stack:** Python 3, FastAPI, pytest (isolated SQLite `TestClient`, no Neon), OpenAI Chat Completions via `OpenAIService`, plain-text prompt templates in `prompts/`.

## Global Constraints

- **Backend-only** — no files under `chrome-extension/` may change.
- **Factual path is byte-for-byte unchanged** — `prompts/answer_question.txt` and the non-essay branch of Pass 3 must not be edited; unsupported factual questions still return `__NO_ANSWER__` and stay blank.
- **Balanced compose contract** — composed answers ground every concrete claim in the applicant's real experience/skills/education + the job posting; they never invent employers, titles, dates, years, degrees, skills, or company specifics (awards/history/products/revenue) not in the posting.
- **Question-cue boundary** — only a `textarea` field (no options) whose label/helpText carries an open-ended cue (or is a `?`-question of ≥ 4 words) is composed; a cue-less "Additional comments" box stays blank.
- **Answer length** — composed answers target ~60–150 words; honor an explicit limit stated in the field's help text.
- **Commits use explicit pathspec** — the working tree is a shared checkout with unrelated uncommitted work from concurrent sessions; every commit stages and commits only the task's named files (`git commit -m … -- <paths>`), never `git add -A`.
- **Test isolation** — new router tests use their own SQLite file and the standalone `FastAPI()` + router harness (as in `test_fill_sentinel.py`); they must not enter the main app lifespan (which migrates the real Neon dev DB). Run only the named test files, never the whole suite.

---

### Task 1: `is_essay_question` heuristic

**Files:**
- Modify: `backend/routers/fill.py` (add a module-level function after `_profile_context`, which ends at line 207)
- Test: `backend/tests/test_essay_heuristic.py` (create)

**Interfaces:**
- Consumes: `FormField` (existing pydantic model in `backend/routers/fill.py`, fields `label: str`, `type: str`, `options: list[str]`, `helpText: str`).
- Produces: `is_essay_question(field: FormField) -> bool` — imported by the Pass-3 router in Task 3.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_essay_heuristic.py`:

```python
"""Unit tests for is_essay_question — the pure heuristic that decides which
long free-text fields get an AI-composed answer. No DB, no network."""
from backend.routers.fill import FormField, is_essay_question


def _f(label: str, type: str = "textarea", options=None, helpText: str = "") -> FormField:
    return FormField(label=label, type=type, options=options or [], helpText=helpText)


def test_motivation_question_is_essay():
    assert is_essay_question(_f("Why do you want to work here?")) is True


def test_behavioral_question_is_essay():
    assert is_essay_question(_f("Describe a time you faced a challenge.")) is True


def test_self_intro_question_is_essay():
    assert is_essay_question(_f("Tell us about yourself")) is True


def test_company_knowledge_question_is_essay():
    assert is_essay_question(_f("What do you know about our company?")) is True


def test_bare_question_mark_textarea_is_essay():
    # A genuine question on a long-text field, no keyword cue.
    assert is_essay_question(_f("What would your ideal workday involve?")) is True


def test_factual_experience_textarea_is_not_essay():
    # "Describe your experience with X" is groundable -> stays on answer_question.
    assert is_essay_question(_f("Describe your experience with COBOL")) is False


def test_cueless_comments_box_is_not_essay():
    assert is_essay_question(_f("Additional comments")) is False


def test_short_question_textarea_is_not_essay():
    # "Start date?" is a question but too short to be an essay prompt.
    assert is_essay_question(_f("Start date?")) is False


def test_numeric_control_is_never_essay():
    # A years-of-experience question rendered as a number input keeps strict grounding.
    assert is_essay_question(_f("How many years of experience do you have?", type="number")) is False


def test_field_with_options_is_never_essay():
    # A "why" question that is actually a dropdown must stay on the option-aware path.
    assert is_essay_question(_f("Why did you apply?", type="select", options=["Growth", "Pay"])) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_essay_heuristic.py -v`
Expected: FAIL — `ImportError: cannot import name 'is_essay_question' from 'backend.routers.fill'`

- [ ] **Step 3: Write minimal implementation**

In `backend/routers/fill.py`, immediately after the `_profile_context` function (after line 207, before the `@router.post("/fill", …)` decorator), add:

```python
# Open-ended long-answer cues. A textarea carrying one of these (or a genuine
# ?-question) is COMPOSED from real experience + the job posting rather than
# extracted; every other field keeps the strict answer_question.txt grounding.
_ESSAY_CUES = (
    "why", "motivat", "interest", "excit", "passion",
    "tell us about yourself", "about yourself", "describe a",
    "a time when", "a time you", "challenge", "proud", "accomplish",
    "strength", "weakness", "goal", "see yourself", "what do you know",
    "in your own words", "what makes you", "why should we", "drawn to",
    "fit for this", "cover letter",
)


def is_essay_question(field: FormField) -> bool:
    """True when a field is an open-ended essay prompt worth AI-composing.

    Only long free-text controls are ever candidates — choice/short controls
    (select, radio, checkbox, number) keep the strict grounding path, so a
    factual screening question can never be routed into generative mode.
    """
    if field.type != "textarea" or field.options:
        return False
    text = f"{field.label} {field.helpText}".lower()
    if any(cue in text for cue in _ESSAY_CUES):
        return True
    label = field.label.strip()
    return label.endswith("?") and len(label.split()) >= 4
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_essay_heuristic.py -v`
Expected: PASS — 10 passed

- [ ] **Step 5: Commit**

```bash
git add -- backend/routers/fill.py backend/tests/test_essay_heuristic.py
git commit -m "feat(fill): is_essay_question heuristic for open-ended long answers" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- backend/routers/fill.py backend/tests/test_essay_heuristic.py
```

---

### Task 2: `compose_answer` prompt + LLM method

**Files:**
- Create: `prompts/compose_answer.txt`
- Modify: `backend/services/openai_service.py` (add `compose_answer` after `answer_question`, which ends at line 321)
- Test: `backend/tests/test_fill_prompt.py` (append compose-prompt pins)

**Interfaces:**
- Consumes: `_load_prompt(name)` and `self._generate(prompt, system=...)` (existing in `openai_service.py`); the `{{QUESTION}}` / `{{CONTEXT}}` placeholder convention.
- Produces: `OpenAIService.compose_answer(self, question: str, context: str) -> str` — invoked by the Pass-3 router in Task 3. Returns the composed answer text, or the literal `__NO_ANSWER__` when nothing can be grounded.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_fill_prompt.py`:

```python
COMPOSE = Path(__file__).resolve().parent.parent.parent / "prompts" / "compose_answer.txt"


def test_compose_prompt_composes_open_ended():
    text = COMPOSE.read_text(encoding="utf-8").lower()
    assert "open-ended" in text          # it is the generative contract, not extraction
    assert "first person" in text


def test_compose_prompt_keeps_hard_fact_guardrails():
    text = COMPOSE.read_text(encoding="utf-8").lower()
    assert "may not invent" in text                              # no fabricated credentials
    assert "do not invent specific claims about the company" in text  # no fabricated company facts
    assert "job posting" in text


def test_compose_prompt_keeps_floor_sentinel():
    text = COMPOSE.read_text(encoding="utf-8")
    assert "__NO_ANSWER__" in text       # blank floor survives when nothing can be grounded
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_fill_prompt.py -v`
Expected: FAIL — the three new tests error with `FileNotFoundError: …/prompts/compose_answer.txt` (existing tests still pass)

- [ ] **Step 3a: Create the prompt template**

Create `prompts/compose_answer.txt`:

```
You are a job applicant filling out an application form. You ARE the applicant — write in FIRST PERSON as if you are the person described below. Your job is to write a genuine, specific answer to ONE open-ended application question.

APPLICANT CONTEXT:
{{CONTEXT}}

QUESTION: {{QUESTION}}

This is an OPEN-ENDED question — motivation, fit, a behavioral story, a self-introduction, or what you know about the company. Unlike a factual field, the exact answer will NOT appear word-for-word in the context; you are expected to COMPOSE one. Do NOT return a blank or a refusal just because the answer is not stated verbatim.

HOW TO WRITE IT:
- Ground every concrete claim in the applicant's REAL experience, skills, projects, and education from the context, and in what the JOB posting says about the role and company. Pick a real, relevant piece of the applicant's background and connect it to what the posting actually asks for.
- You MAY express motivation, enthusiasm, and fit that reasonably follow from those facts — e.g. "my two years building payment APIs is exactly why this backend role appeals to me".
- You may NOT invent hard facts: employers, job titles, dates, years-of-experience numbers, degrees, certifications, or skills the applicant does not have. Do NOT invent specific claims about the company — its awards, revenue, history, size, or products — beyond what the job posting states. If you do not know a company specific, speak to the role and your own fit instead.
- If the job posting is missing, focus on the role title and the applicant's real experience; never fabricate company details to fill the gap.

STYLE:
- Professional, concrete, and specific. No clichés, no empty buzzwords ("hard-working team player passionate about synergy"), no generic filler that could apply to any company.
- First person. NEVER refer to "the applicant" or "the candidate" — you ARE them.
- Length: concise and substantive — about 60 to 150 words (roughly 3 to 7 sentences). If the field's help text states a word or character limit, obey it.

OUTPUT:
- Return ONLY the answer text. No preamble, no heading, no quotation marks. NEVER start with "I'm happy to", "Here's", "Sure", "Of course", "Certainly", "Based on", or "As an applicant".
- If — and ONLY if — there is genuinely no relevant applicant experience to draw on AND no job posting to reference, so any answer would be pure invention, respond with EXACTLY this token and nothing else: __NO_ANSWER__

ANSWER:
```

- [ ] **Step 3b: Add the LLM service method**

In `backend/services/openai_service.py`, immediately after the `answer_question` method (after line 321, before `suggest_job_titles`), add:

```python
    async def compose_answer(self, question: str, context: str) -> str:
        """Compose a grounded answer to an open-ended essay question (why-us,
        behavioral, self-intro, company-knowledge). Unlike answer_question, this
        is allowed to write prose that is not stated verbatim in the context —
        but it still may not invent hard facts (see prompts/compose_answer.txt)."""
        template = _load_prompt("compose_answer.txt")
        prompt = template.replace("{{QUESTION}}", question).replace("{{CONTEXT}}", context)
        system = (
            "You are a job applicant writing a short, genuine answer to an "
            "open-ended application question in first person. Ground it in the "
            "applicant's real experience and the job posting. Output only the answer."
        )
        return await self._generate(prompt, system=system)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_fill_prompt.py -v`
Expected: PASS — all tests pass (original + 3 new)

- [ ] **Step 5: Commit**

```bash
git add -- prompts/compose_answer.txt backend/services/openai_service.py backend/tests/test_fill_prompt.py
git commit -m "feat(fill): compose_answer prompt + LLM method for grounded essays" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- prompts/compose_answer.txt backend/services/openai_service.py backend/tests/test_fill_prompt.py
```

---

### Task 3: Route essay fields in Pass 3

**Files:**
- Modify: `backend/routers/fill.py` (Pass-3 per-field loop, the `raw = await llm.answer_question(...)` call at line 323)
- Test: `backend/tests/test_essay_autofill.py` (create)

**Interfaces:**
- Consumes: `is_essay_question(field)` (Task 1); `OpenAIService.compose_answer` and `OpenAIService.answer_question` (Task 2 / existing).
- Produces: no new public interface — behavior change only. Essay fields are answered by `compose_answer`; all other fields by `answer_question`. Both results flow through the unchanged sentinel/emit logic.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_essay_autofill.py`:

```python
"""Pass-3 routing on /api/fill: open-ended essay fields go to compose_answer,
everything else keeps answer_question. Isolated SQLite app; both LLM methods are
mocked so no network/key is used. Mirrors test_fill_sentinel.py's harness."""
from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.auth.dependencies import get_verified_user_id
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_essay_autofill.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1
_ANSWER = "backend.services.openai_service.OpenAIService.answer_question"
_COMPOSE = "backend.services.openai_service.OpenAIService.compose_answer"

app = FastAPI()
app.include_router(fill.router, prefix="/api", tags=["fill"])


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


@pytest.fixture
def client():
    session = TestingSessionLocal()

    def _get_db():
        try:
            yield session
        finally:
            pass

    async def _user():
        return TEST_USER_ID

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_verified_user_id] = _user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    session.close()


def _payload(label: str, type: str = "textarea"):
    return {
        "fields": [{"id": "f1", "label": label, "type": type}],
        "company": "Acme",
        "jobTitle": "Backend Engineer",
        "jobDescription": "Build payment APIs.",
        "profile": {"firstName": "Ada", "experience": ["Backend Engineer at Globex (2022-Present)"]},
    }


def test_essay_field_routes_to_compose(client):
    compose = AsyncMock(return_value="I'm drawn to this backend role because my work on payment APIs at Globex maps directly to it.")
    answer = AsyncMock(return_value="SHOULD_NOT_BE_CALLED")
    with patch(_COMPOSE, compose), patch(_ANSWER, answer):
        resp = client.post("/api/fill", json=_payload("Why do you want to work here?"))
    assert resp.status_code == 200
    answers = resp.json()["answers"]
    assert len(answers) == 1
    assert answers[0]["answer"].startswith("I'm drawn to this backend role")
    compose.assert_awaited_once()
    answer.assert_not_awaited()


def test_factual_field_routes_to_answer_question(client):
    compose = AsyncMock(return_value="SHOULD_NOT_BE_CALLED")
    # Unsupported factual free-text still grounds out to the sentinel -> blank.
    answer = AsyncMock(return_value="__NO_ANSWER__")
    with patch(_COMPOSE, compose), patch(_ANSWER, answer):
        resp = client.post("/api/fill", json=_payload("Describe your experience with COBOL"))
    assert resp.status_code == 200
    assert resp.json()["answers"] == []  # regression: grounding preserved
    answer.assert_awaited_once()
    compose.assert_not_awaited()


def test_compose_floor_leaves_field_blank(client):
    # compose_answer may still decline when there is nothing to ground on.
    compose = AsyncMock(return_value="__NO_ANSWER__")
    with patch(_COMPOSE, compose), patch(_ANSWER, AsyncMock(return_value="x")):
        resp = client.post("/api/fill", json=_payload("Tell us about yourself"))
    assert resp.status_code == 200
    assert resp.json()["answers"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_essay_autofill.py -v`
Expected: FAIL — `test_essay_field_routes_to_compose` fails because Pass 3 always calls `answer_question`, so `compose.assert_awaited_once()` raises (compose was never awaited) and the returned answer is `"SHOULD_NOT_BE_CALLED"`.

- [ ] **Step 3: Write minimal implementation**

In `backend/routers/fill.py`, replace the single line 323:

```python
                    raw = await llm.answer_question(question=q, context=context)
```

with:

```python
                    if is_essay_question(field):
                        raw = await llm.compose_answer(question=q, context=context)
                    else:
                        raw = await llm.answer_question(question=q, context=context)
```

(Leave the surrounding `q` construction and the `answer = raw.strip()…` line and everything after it unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_essay_autofill.py -v`
Expected: PASS — 3 passed

- [ ] **Step 5: Commit**

```bash
git add -- backend/routers/fill.py backend/tests/test_essay_autofill.py
git commit -m "feat(fill): route open-ended essay fields to compose_answer" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- backend/routers/fill.py backend/tests/test_essay_autofill.py
```

---

### Task 4: Integration verification

**Files:**
- Test: runs existing + new fill tests together; no code change.

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: confidence that the new routing did not regress the grounding sentinel, memory pass, or prompt pins.

- [ ] **Step 1: Run the full fill test set**

Run:
```bash
python -m pytest backend/tests/test_essay_heuristic.py backend/tests/test_essay_autofill.py backend/tests/test_fill_prompt.py backend/tests/test_fill_sentinel.py backend/tests/test_fill_memory.py -v
```
Expected: PASS — all tests in all five files pass. In particular `test_fill_sentinel.py::test_sentinel_answer_emits_no_field_answer` still passes (factual grounding intact) and `test_fill_memory.py` is unaffected.

- [ ] **Step 2: Confirm no extension files changed**

Run: `git diff --name-only cbe9cad..HEAD`
Expected: only `prompts/compose_answer.txt`, `backend/routers/fill.py`, `backend/services/openai_service.py`, `backend/tests/test_essay_heuristic.py`, `backend/tests/test_essay_autofill.py`, `backend/tests/test_fill_prompt.py`, plus the spec/plan docs — and **nothing** under `chrome-extension/`.

- [ ] **Step 3 (post-deploy, manual): Live check**

After the backend is deployed, open a real application form with a "Why do you want to work here?" (or similar) textarea, run the extension's Autofill, and confirm the field is filled with a grounded first-person answer that references your real experience and does not fabricate company facts. If a field misfires, diagnose via the `autofill_reports` Neon prod telemetry (exact URL + per-field reasons) before changing code.

---

## Notes for the executor

- Do **not** touch `prompts/answer_question.txt` or the non-essay branch of Pass 3 — the factual grounding behavior is deliberate and separately tested.
- The `_generate` transport, `get_llm_service()` wiring, `FormField`/`ApplicantProfile` request models, and the extension are all untouched by this plan.
- If `python -m pytest` cannot import `backend.*`, run it from the repository root (`C:\Users\elmas\Desktop\Tailrd`), where the existing fill tests already resolve the package.
