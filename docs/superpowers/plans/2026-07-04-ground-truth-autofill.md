# Ground-Truth-Only Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the extension from filling form fields with fabricated data — answer only what the applicant's resume/profile supports, leave everything else blank, and give the AI each field's help text and native input type so it understands the real question.

**Architecture:** Three backend changes to `backend/routers/fill.py` and `prompts/answer_question.txt` (rewrite the prompt to a grounding contract with a `__NO_ANSWER__` sentinel, honor the sentinel by emitting no answer, forward new `helpText`/`inputType` context, prune assumption-based rule shortcuts) plus two extension changes (`DetectedField`/`formScanner` carry the two new signals, `AiFillField`/`toAiFillField` forward them). The extension already skips empty answers, so "leave blank" needs no new client fill logic.

**Tech Stack:** Python/FastAPI + pytest (backend), TypeScript + vitest (chrome-extension).

## Global Constraints

- Sentinel token is exactly `__NO_ANSWER__` (compared case-insensitively after stripping quotes/whitespace).
- EEO / sensitive fields never reach the backend — do not change that; nothing in this plan sends demographic data.
- `AiFillField` (TS, `chrome-extension/src/shared/types.ts`) must stay a structural mirror of `FormField` (Python, `backend/routers/fill.py`) — when one gains a field, so does the other.
- Backend tests run with `python -m pytest` from repo root. Extension vitest is run directly via node (see memory: `npm test` exits 1 with no output in this shell) — use `node chrome-extension/node_modules/vitest/vitest.mjs run <path>` from the `chrome-extension` dir, or `npx vitest run <path>`.
- Follow TDD: failing test first, minimal implementation, green, commit.

---

### Task 1: Rewrite the AI prompt to a grounding contract

**Files:**
- Modify: `prompts/answer_question.txt` (full rewrite of the rules body)
- Test: `backend/tests/test_fill_prompt.py`

**Interfaces:**
- Consumes: nothing.
- Produces: a prompt that instructs the model to output `__NO_ANSWER__` when the applicant context does not support an answer. Task 2 relies on this token being present in the prompt.

- [ ] **Step 1: Replace the failing test with the new contract assertions**

Overwrite `backend/tests/test_fill_prompt.py` with:

```python
from pathlib import Path

PROMPT = Path(__file__).resolve().parent.parent.parent / "prompts" / "answer_question.txt"


def test_prompt_forces_closest_listed_option():
    text = PROMPT.read_text(encoding="utf-8").lower()
    # Multiple-choice answers must still be exact option text.
    assert "not in the list" in text


def test_prompt_defines_no_answer_sentinel():
    text = PROMPT.read_text(encoding="utf-8")
    assert "__NO_ANSWER__" in text


def test_prompt_does_not_instruct_fabrication():
    text = PROMPT.read_text(encoding="utf-8").lower()
    # The old fabrication rules must be gone.
    assert "3.5/4.0" not in text
    assert "always agree" not in text
    assert "never say you have zero experience" not in text
    assert "never say \"i don't have experience\"" not in text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest backend/tests/test_fill_prompt.py -v`
Expected: `test_prompt_defines_no_answer_sentinel` and `test_prompt_does_not_instruct_fabrication` FAIL (sentinel absent, fabrication phrases still present).

- [ ] **Step 3: Rewrite the prompt**

Overwrite `prompts/answer_question.txt` with:

```
You are a job applicant filling out an application form. You ARE the applicant — write in FIRST PERSON as if you are the person described below.

APPLICANT CONTEXT:
{{CONTEXT}}

QUESTION: {{QUESTION}}

STRICT RULES — FOLLOW EVERY ONE:

1. GROUNDING (most important):
   - Answer ONLY from the APPLICANT CONTEXT above. Do NOT invent facts, numbers, dates, GPAs, employers, or experience that the context does not state.
   - If the context does not give you enough to answer truthfully, respond with EXACTLY this token and nothing else: __NO_ANSWER__
   - Never guess. A blank field is better than a fabricated answer. When in doubt, return __NO_ANSWER__.

2. ANSWER FORMAT:
   - Return ONLY the answer. No preamble, no explanation, no "Sure!", no "I'd be happy to help".
   - NEVER start with: "I'm happy to", "Here's", "Sure", "Of course", "Certainly", "Based on", "According to", "The answer is", "Let me".
   - Just the raw answer text (or the __NO_ANSWER__ token), nothing else.

3. MULTIPLE CHOICE / DROPDOWN:
   - If options are listed, respond with EXACTLY one of them, word for word — do not paraphrase or modify the option text. Never return a value that is not in the list.
   - Choose an option ONLY when the applicant context clearly supports one. If nothing in the context supports a specific option, return __NO_ANSWER__.
   - Exception: if the question is a decline-to-answer style question and a "Prefer not to say" / "Decline to answer" option exists, you may use that option.

4. YES/NO QUESTIONS:
   - Answer "Yes" or "No" ONLY when the context supports it. If it does not, return __NO_ANSWER__.

5. TEXT / PARAGRAPH QUESTIONS (e.g. "Describe your experience with X"):
   - Write 2-4 sentences in FIRST PERSON drawn from the resume/context. Reference specific projects, tools, or roles that actually appear in the context.
   - If the context has NO relevant experience for the question, return __NO_ANSWER__ rather than inventing experience.
   - NEVER say "The applicant" or "The candidate" — you ARE the applicant.

6. NUMERIC QUESTIONS (years of experience, number of companies, etc.):
   - Return just the number, derived from the context. If the context does not support a number, return __NO_ANSWER__.

7. COUNTRY / NATIONALITY / LOCATION:
   - Use the applicant's actual location from the context. If absent, return __NO_ANSWER__.

The field's type and any surrounding help text may be included with the question — use them to format your answer (e.g. a date field wants a date), and to judge whether the field even applies to you. If it does not apply or you cannot ground an answer, return __NO_ANSWER__.

ANSWER:
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest backend/tests/test_fill_prompt.py -v`
Expected: all three PASS.

- [ ] **Step 5: Commit**

```bash
git add prompts/answer_question.txt backend/tests/test_fill_prompt.py
git commit -m "feat(fill): rewrite AI prompt to grounding contract with __NO_ANSWER__ sentinel"
```

---

### Task 2: Honor the sentinel + forward helpText/inputType (backend)

**Files:**
- Modify: `backend/routers/fill.py` (`FormField` model; Pass 3 loop, ~lines 313-335)
- Test: `backend/tests/test_fill_sentinel.py` (create)

**Interfaces:**
- Consumes: the `__NO_ANSWER__` token from Task 1's prompt.
- Produces: `FormField` now has `helpText: str = ""` and `inputType: str = ""`. The Pass 3 loop injects them into the question and skips emitting a `FieldAnswer` when the AI returns the sentinel. Task 5 (extension) sends these two fields.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_fill_sentinel.py`. This mirrors the isolated-SQLite
harness of `backend/tests/test_fill_memory.py` (own `FastAPI()` app, patched
`OpenAIService.answer_question`, no real DB, no network):

```python
"""The grounding sentinel and page-context forwarding on /api/fill.

Isolated SQLite app; OpenAIService.answer_question is mocked so no network/key
is used. Mirrors test_fill_memory.py's harness.
"""
from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.auth.dependencies import get_verified_user_id
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_fill_sentinel.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1
_ANSWER = "backend.services.openai_service.OpenAIService.answer_question"

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


def _payload(**field):
    base = {"id": "f1", "label": "Describe your experience with COBOL", "type": "textarea"}
    base.update(field)
    return {"fields": [base], "profile": {"firstName": "Ada"}}


def test_sentinel_answer_emits_no_field_answer(client):
    # No saved answers seeded -> memory pass is skipped and this goes to the AI
    # pass, which returns the grounding sentinel.
    with patch(_ANSWER, AsyncMock(return_value="__NO_ANSWER__")):
        resp = client.post("/api/fill", json=_payload())
    assert resp.status_code == 200
    # A field the AI could not ground produces no answer -> stays blank.
    assert resp.json()["answers"] == []


def test_help_text_and_input_type_reach_the_prompt(client):
    mock = AsyncMock(return_value="__NO_ANSWER__")
    with patch(_ANSWER, mock):
        client.post("/api/fill", json=_payload(
            label="Start date", type="text",
            helpText="When can you begin?", inputType="date",
        ))
    question = mock.call_args.kwargs["question"]
    assert "date" in question
    assert "When can you begin?" in question
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest backend/tests/test_fill_sentinel.py -v`
Expected: FAIL — `helpText`/`inputType` are rejected or ignored, and the sentinel answer is emitted as a literal `__NO_ANSWER__` answer instead of being skipped.

- [ ] **Step 3: Add the two fields to `FormField`**

In `backend/routers/fill.py`, in `class FormField` (after `required: bool = False`, ~line 39) add:

```python
    helpText: str = ""   # surrounding help/section text harvested by the extension
    inputType: str = ""  # native input type hint ("date", "number", "email"…)
```

- [ ] **Step 4: Add the sentinel constant and honor it in Pass 3**

Near the top of `backend/routers/fill.py`, after `router = APIRouter()` (~line 30), add:

```python
NO_ANSWER = "__NO_ANSWER__"
```

In the Pass 3 loop, replace the block that currently reads:

```python
                q = field.label
                if field.options:
                    q += f"\nOptions: {', '.join(field.options)}"
                raw = await llm.answer_question(question=q, context=context)
                answer = raw.strip().strip('"')

                # Match to options if applicable. Keep the AI's raw answer
                # when nothing matches — the client fuzzy-matches (writeSelect
                # / fillAriaCombobox); snapping to options[0] used to silently
                # select a "Select…" placeholder.
                if field.options:
                    matched_opt = _match_option(answer, field.options)
                    if matched_opt:
                        answer = matched_opt
```

with:

```python
                q = field.label
                if field.inputType:
                    q += f"\nField type: {field.inputType}"
                if field.helpText:
                    q += f"\nHelp text: {field.helpText}"
                if field.options:
                    q += f"\nOptions: {', '.join(field.options)}"
                raw = await llm.answer_question(question=q, context=context)
                answer = raw.strip().strip('"').strip()

                # Grounding sentinel: the model has no supported answer — leave
                # the field blank (emit nothing). The client skips fields with
                # no answer, so a skipped field simply stays empty.
                if not answer or answer.upper() == NO_ANSWER:
                    continue

                # Match to options if applicable. Keep the AI's raw answer
                # when nothing matches — the client fuzzy-matches (writeSelect
                # / fillAriaCombobox); snapping to options[0] used to silently
                # select a "Select…" placeholder.
                if field.options:
                    matched_opt = _match_option(answer, field.options)
                    if matched_opt:
                        answer = matched_opt
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest backend/tests/test_fill_sentinel.py -v`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/fill.py backend/tests/test_fill_sentinel.py
git commit -m "feat(fill): honor __NO_ANSWER__ sentinel and forward helpText/inputType"
```

---

### Task 3: Prune assumption-based rule shortcuts (backend)

**Files:**
- Modify: `backend/routers/fill.py` (`_raw_rule_based_answer`, ~lines 136-141)
- Test: `backend/tests/test_fill_profile.py` (update two existing assertions, add one)

**Interfaces:**
- Consumes: nothing.
- Produces: `relocat`, `driver`+`licen`, `background check`, and `drug test` no longer auto-answer; they fall through to the (now-conservative) AI pass. Kept: authorization/sponsorship/18+/agreement/worked-here/profile lookups.

- [ ] **Step 1: Update the existing tests that assume the dropped rules**

In `backend/tests/test_fill_profile.py`, replace `test_yesno_keyword_rules_still_answer_yes_no_and_free_text` (lines 50-54) with:

```python
def test_kept_universal_rules_still_answer():
    """Truly universal screening questions still auto-answer."""
    assert _rule_based_answer("Are you legally authorized to work?", ["Yes", "No"], settings=None) == "Yes"
    assert _rule_based_answer("Do you require sponsorship?", ["Yes", "No"], settings=None) == "No"
    assert _rule_based_answer("Are you at least 18 years old?", ["Yes", "No"], settings=None) == "Yes"


def test_assumption_rules_are_dropped():
    """Assumption-based questions no longer auto-fill a hardcoded Yes — they
    defer to the AI pass, which leaves them blank unless the profile supports it."""
    assert _rule_based_answer("Are you willing to relocate?", ["Yes", "No"], settings=None) is None
    assert _rule_based_answer("Do you have a valid driver's license?", ["Yes", "No"], settings=None) is None
    assert _rule_based_answer("Do you consent to a background check?", ["Yes", "No"], settings=None) is None
    assert _rule_based_answer("Are you willing to take a drug test?", ["Yes", "No"], settings=None) is None
```

Also, in `test_yesno_keyword_rules_defer_when_options_are_not_yes_no` (lines 32-45), the first assertion uses a "relocate" office multi-select and expects `None`. That still holds (the rule is gone, so it returns `None` for a different reason) — leave it unchanged.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `python -m pytest backend/tests/test_fill_profile.py -v`
Expected: `test_assumption_rules_are_dropped` FAILS (relocate/driver/background/drug still return "Yes").

- [ ] **Step 3: Remove the four assumption rules**

In `backend/routers/fill.py`, in `_raw_rule_based_answer`, delete these four lines (~136-141):

```python
    if "relocat" in q:
        return "Yes" if yes_no else "yes"
    if "driver" in q and "licen" in q:
        return "Yes" if yes_no else "yes"
    if "background check" in q or "drug test" in q:
        return "Yes" if yes_no else "yes"
```

Leave the sponsorship, "legally authorized", and "18 years" rules above them intact.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest backend/tests/test_fill_profile.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/fill.py backend/tests/test_fill_profile.py
git commit -m "feat(fill): drop assumption-based rule shortcuts (relocate/license/background/drug)"
```

---

### Task 4: Carry helpText/inputType on DetectedField (extension scanner)

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (`DetectedField`, ~lines 207-229)
- Modify: `chrome-extension/src/content/formScanner.ts` (the three `fields.push({…})` sites, ~lines 358, 394, 429)
- Test: `chrome-extension/test/formScanner.test.ts`

**Interfaces:**
- Consumes: `FieldSignals` (`domUtils.ts`), which already carries `nearby: string` and `typeHint: string`.
- Produces: `DetectedField` now has `helpText?: string` and `inputType?: string`, populated from `signals.nearby` / `signals.typeHint`. Task 5 reads these.

- [ ] **Step 1: Write the failing test**

Add to `chrome-extension/test/formScanner.test.ts` (append a test that scans a labeled date input; match the file's existing DOM-setup style — check the top of the file for its `scanPage` import and how it builds `document.body.innerHTML`):

```ts
it("carries the native input type and nearby help text on the detected field", () => {
  document.body.innerHTML = `
    <form>
      <label for="d">Start date
        <span class="help">When can you begin?</span>
      </label>
      <input id="d" name="start_date" type="date" />
    </form>`;
  const { fields } = scanPage();
  const field = fields.find((f) => f.label.includes("Start date"));
  expect(field).toBeDefined();
  expect(field!.inputType).toBe("date");
  expect(field!.helpText).toContain("When can you begin?");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `chrome-extension/`): `npx vitest run test/formScanner.test.ts`
Expected: FAIL — `inputType`/`helpText` are `undefined`.

- [ ] **Step 3: Add the fields to `DetectedField`**

In `chrome-extension/src/shared/types.ts`, inside `interface DetectedField`, after `currentValue?: string;` add:

```ts
  /** Surrounding help/section text (FieldSignals.nearby) — page context for the AI. */
  helpText?: string;
  /** Native input type hint (FieldSignals.typeHint: "date", "number"…) — AI format cue. */
  inputType?: string;
```

- [ ] **Step 4: Populate them at all three push sites**

In `chrome-extension/src/content/formScanner.ts`, add these two properties to each of the three `fields.push({ … })` object literals (the single-control site ~line 358, the radio-group site ~line 394, and the checkbox-group site ~line 429). In each, `signals` is already in scope:

```ts
      helpText: signals.nearby,
      inputType: signals.typeHint,
```

(For radio/checkbox groups `typeHint` is `""`, which is fine.)

- [ ] **Step 5: Run the test to verify it passes**

Run (from `chrome-extension/`): `npx vitest run test/formScanner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/formScanner.ts chrome-extension/test/formScanner.test.ts
git commit -m "feat(extension): carry helpText/inputType on DetectedField"
```

---

### Task 5: Forward helpText/inputType to the backend (extension planner)

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (`AiFillField`, ~lines 236-242)
- Modify: `chrome-extension/src/content/aiFillPlanner.ts` (`toAiFillField`, ~lines 77-85)
- Test: `chrome-extension/test/aiFillPlanner.test.ts`

**Interfaces:**
- Consumes: `DetectedField.helpText` / `DetectedField.inputType` from Task 4.
- Produces: `AiFillField` gains `helpText: string` and `inputType: string`; `toAiFillField` populates them. This is what `buildFillRequestBody` (`api/aiFill.ts`) sends to the backend `FormField` from Task 2.

- [ ] **Step 1: Write the failing test**

Add to `chrome-extension/test/aiFillPlanner.test.ts` (match the file's existing `toAiFillField` test setup — reuse its helper for building a `DetectedField` if one exists, otherwise construct a minimal field inline with the required properties):

```ts
it("forwards helpText and inputType onto the AiFillField", () => {
  const field = {
    id: "f1",
    category: "custom",
    confidence: 1,
    label: "Start date",
    controlType: "text",
    required: false,
    proposedValue: null,
    fillable: true,
    sensitive: false,
    helpText: "When can you begin?",
    inputType: "date",
  } as unknown as DetectedField;
  const out = toAiFillField(field);
  expect(out.helpText).toBe("When can you begin?");
  expect(out.inputType).toBe("date");
});
```

Ensure `DetectedField` and `toAiFillField` are imported at the top of the test file (they are already imported if other `toAiFillField` tests exist; otherwise add `import { toAiFillField } from "../src/content/aiFillPlanner";` and `import type { DetectedField } from "../src/shared/types";`).

- [ ] **Step 2: Run the test to verify it fails**

Run (from `chrome-extension/`): `npx vitest run test/aiFillPlanner.test.ts`
Expected: FAIL — `out.helpText` / `out.inputType` are `undefined` (and likely a TS error that `AiFillField` has no such property).

- [ ] **Step 3: Add the fields to `AiFillField`**

In `chrome-extension/src/shared/types.ts`, inside `interface AiFillField`, after `required: boolean;` add:

```ts
  /** Surrounding help/section text — page context for the AI (mirrors FormField.helpText). */
  helpText: string;
  /** Native input type hint — AI format cue (mirrors FormField.inputType). */
  inputType: string;
```

- [ ] **Step 4: Populate them in `toAiFillField`**

In `chrome-extension/src/content/aiFillPlanner.ts`, in `toAiFillField`, add to the returned object (after `required: field.required,`):

```ts
    helpText: field.helpText ?? "",
    inputType: field.inputType ?? "",
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `chrome-extension/`): `npx vitest run test/aiFillPlanner.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full extension + backend suites to confirm nothing regressed**

Run (from `chrome-extension/`): `npx vitest run`
Run (from repo root): `python -m pytest backend/tests/test_fill_prompt.py backend/tests/test_fill_profile.py backend/tests/test_fill_sentinel.py backend/tests/test_fill_memory.py -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/aiFillPlanner.ts chrome-extension/test/aiFillPlanner.test.ts
git commit -m "feat(extension): forward helpText/inputType to backend fill request"
```

---

## Post-implementation verification (manual)

Not a task, but do this before considering the work done:

1. Rebuild the extension and load it (per the project's build step).
2. Open a real application form with a mix of: a question grounded in your resume, an ungrounded free-text question (e.g. a technology you've never used), and a screening question (authorization). Run Autofill.
3. Confirm: grounded field filled, ungrounded field left **blank** (not fabricated), authorization still auto-answered, relocate/license left blank.
4. If any field misfires, pull its row from the `autofill_reports` table in Neon prod (exact URL + per-field reasons) before changing code — per the telemetry debugging workflow.
