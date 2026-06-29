# Extension Cover-Letter Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the extension overlay's "Generate Cover Letter — Coming soon" stub with a working flow that generates a tone-tunable, editable cover letter for the on-page job and smart-inserts it, reusing the existing `CoverLetterGenerator` (no engine changes).

**Architecture:** Mirror the résumé-retailor feature for cover letters. Two new `job_id`-free FastAPI endpoints mounted at `/api` (`/api/cover-letter` ephemeral generate; `/api/render-cover-letter` text→PDF) reuse `CoverLetterGenerator` + a new `reportlab` text renderer. The extension gets a new API client, two service-worker message routes, a pure card builder, four content-script callbacks (smart insert: textarea → file-field PDF → copy/download fallback), and the overlay card UI.

**Tech Stack:** Backend — Python, FastAPI, pydantic, reportlab (already a dep), pytest. Extension — TypeScript, esbuild, vitest, jsdom, MV3.

## Global Constraints

- **Branch:** `feat/extension-cover-letter` (already created; commit every task here).
- **Reuse, don't change, the engine:** `backend/services/cover_letter.py` `CoverLetterGenerator.generate(resume_text, job_description, company, tone=None, base_text=None) -> str` is used as-is. `base_text=None` → fresh letter (`COVER_LETTER_PROMPT`); `base_text` set → rewrite (`REWRITE_PROMPT`).
- **Ephemeral:** the generate endpoint must **never** read or write the `cover_letters` table and must **not** call `bump_profile_version`.
- **Endpoints mounted at `/api`** (like `routers/tailor.py`). Names exactly: `/api/cover-letter`, `/api/render-cover-letter`.
- **Backend errors:** no résumé → **400** (raised by `_resolve_resume`); LLM failure → **503** with `LLM_503_DETAIL`, catching `(ConnectionError, httpx.ConnectError)`; render failure → **422**.
- **Backend tests:** mock the LLM with `patch("backend.services.openai_service.OpenAIService._generate", AsyncMock(...))` (`get_llm_service()` returns `OpenAIService`), and `monkeypatch.setenv("OPENAI_API_KEY", "test-key")`. Use the `client` / `db_session` fixtures. NOTE (project memory): pytest enters the app lifespan and **migrates the real Neon dev DB** — keep new tests hermetic and don't depend on row ordering.
- **Extension test command** (project memory: `npm test` exits 1 with no output in this shell): run vitest directly — from `chrome-extension/`: `node node_modules/vitest/vitest.mjs run test/<file>`. Typecheck: `npx tsc --noEmit`. Build: `npm run build`.
- **UI lives in `content/overlay.ts`** (project memory: the popup is legacy/unbuilt — do not touch `src/popup`).
- **Message names:** `GENERATE_COVER_LETTER`, `RENDER_COVER_LETTER`. **PDF filename:** `cover-letter-{company-slug}.pdf`.
- **Smart-insert order (never submits the form):** cover-letter textarea (`writeControl`) → cover-letter file field (render PDF + `injectResumeFile`) → `{ok:false}` (UI nudges Copy/Download).
- **Commit style:** `feat(backend|extension): …`, `test(…)`, matching existing history.

---

### Task 1: Cover-letter PDF renderer (backend, pure)

**Files:**
- Create: `backend/services/cover_letter_pdf.py`
- Test: `backend/tests/test_cover_letter_pdf.py`

**Interfaces:**
- Consumes: `reportlab` (already installed).
- Produces: `render_cover_letter_pdf(text: str) -> bytes` — a one-column PDF; blank-line-separated paragraphs; single newlines become line breaks; empty/whitespace yields a valid near-empty PDF (never raises for empty); HTML-special chars escaped.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_cover_letter_pdf.py`:

```python
"""Unit tests for the cover-letter PDF renderer (pure function)."""
from backend.services.cover_letter_pdf import render_cover_letter_pdf


def test_renders_pdf_for_multiparagraph_letter():
    pdf = render_cover_letter_pdf(
        "Dear Hiring Team at Acme,\n\nI am excited to apply.\n\nSincerely,\nJane Doe"
    )
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 800


def test_empty_text_still_valid_pdf():
    pdf = render_cover_letter_pdf("   ")
    assert pdf[:5] == b"%PDF-"


def test_long_letter_paginates():
    pdf = render_cover_letter_pdf("\n\n".join(f"Paragraph {i} body text. " * 60 for i in range(40)))
    assert pdf[:5] == b"%PDF-"


def test_html_special_chars_do_not_break_render():
    pdf = render_cover_letter_pdf("I <build> & <ship> things at <Acme>.")
    assert pdf[:5] == b"%PDF-"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest backend/tests/test_cover_letter_pdf.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.services.cover_letter_pdf'`.

- [ ] **Step 3: Write the implementation**

Create `backend/services/cover_letter_pdf.py`:

```python
"""
Render a plain-text cover letter to PDF bytes with reportlab.

Mirrors services/resume_pdf.py's reportlab/Platypus approach: clean, single
column, real selectable text (ATS-friendly). Pure function — no DB, no network,
no file I/O. Used by POST /api/render-cover-letter so the extension can attach a
cover-letter PDF to a file field or download it.
"""
from __future__ import annotations

import io

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

_TEXT = HexColor("#1f2937")


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_cover_letter_pdf(text: str) -> bytes:
    """Render `text` to a one-column business-letter PDF.

    Paragraphs are split on blank lines; single newlines within a paragraph
    are kept as line breaks. Empty/whitespace input yields a valid, near-empty
    single-page PDF rather than raising.
    """
    body = ParagraphStyle(
        "cl_body", fontName="Helvetica", fontSize=11, leading=11 * 1.4,
        textColor=_TEXT, spaceAfter=10,
    )

    story: list = []
    for block in (text or "").split("\n\n"):
        block = block.strip()
        if not block:
            continue
        html = _esc(block).replace("\n", "<br/>")
        story.append(Paragraph(html, body))

    if not story:
        story.append(Spacer(1, 1))

    buf = io.BytesIO()
    pdf = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.8 * inch, rightMargin=0.8 * inch,
        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
        title="Cover Letter",
    )
    pdf.build(story)
    return buf.getvalue()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest backend/tests/test_cover_letter_pdf.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/services/cover_letter_pdf.py backend/tests/test_cover_letter_pdf.py
git commit -m "feat(backend): cover-letter PDF renderer (reportlab)"
```

---

### Task 2: `/api/cover-letter` + `/api/render-cover-letter` endpoints

**Files:**
- Create: `backend/schemas/cover_letter.py`
- Create: `backend/routers/cover_letter.py`
- Modify: `backend/main.py` (import line ~23; router mount after the `tailor` mount ~line 81)
- Test: `backend/tests/test_cover_letter_api.py`

**Interfaces:**
- Consumes: `render_cover_letter_pdf` (Task 1); `_resolve_resume`, `LLM_503_DETAIL` (`backend/routers/ai.py`); `CoverLetterGenerator` (`backend/services/cover_letter.py`).
- Produces:
  - `POST /api/cover-letter` body `CoverLetterGenerateIn{resume_id?, job_description, job_title, company, tone?, base_text?}` → `CoverLetterGenerateOut{text}`.
  - `POST /api/render-cover-letter` body `RenderCoverLetterIn{text, filename?}` → `RenderCoverLetterOut{data_base64, name, content_type}`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_cover_letter_api.py`:

```python
"""Endpoint tests for the extension's /api/cover-letter + /api/render-cover-letter."""
import base64
from unittest.mock import patch, AsyncMock

from backend.db.models import CoverLetter, ResumeProfileDB

TEST_USER_ID = 1


def _seed_resume(db):
    db.add(ResumeProfileDB(
        user_id=TEST_USER_ID, profile_name="Jane Doe", is_primary=1,
        skills=["Python"], raw_text="Python engineer with 5 years experience.",
    ))
    db.commit()


class TestGenerateCoverLetter:
    def test_fresh_generate_uses_cover_letter_prompt(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(return_value="Dear Hiring Team at Acme, ...")
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "We need Python.",
            })
        assert resp.status_code == 200
        assert resp.json()["text"].startswith("Dear Hiring Team")
        prompt = gen.call_args.args[0]
        assert "Write a professional cover letter" in prompt
        assert "Rewrite the following cover letter" not in prompt

    def test_rewrite_uses_base_text_prompt(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(return_value="Revised letter ...")
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
                "tone": "enthusiastic", "base_text": "My first draft letter.",
            })
        assert resp.status_code == 200
        prompt = gen.call_args.args[0]
        assert "Rewrite the following cover letter" in prompt
        assert "My first draft letter." in prompt

    def test_503_on_llm_connection_error(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        import httpx
        gen = AsyncMock(side_effect=httpx.ConnectError("boom"))
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
            })
        assert resp.status_code == 503

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        resp = client.post("/api/cover-letter", json={"job_description": "JD"})
        assert resp.status_code == 400

    def test_ephemeral_writes_no_cover_letter_row(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        before = db_session.query(CoverLetter).filter(CoverLetter.user_id == TEST_USER_ID).count()
        gen = AsyncMock(return_value="A letter.")
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
            })
        assert resp.status_code == 200
        after = db_session.query(CoverLetter).filter(CoverLetter.user_id == TEST_USER_ID).count()
        assert after == before


class TestRenderCoverLetter:
    def test_returns_base64_pdf(self, client):
        resp = client.post("/api/render-cover-letter", json={
            "text": "Dear Hiring Team,\n\nI am excited to apply.\n\nSincerely,\nJane",
            "filename": "cover-letter-acme",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["content_type"] == "application/pdf"
        assert data["name"] == "cover-letter-acme.pdf"
        assert base64.b64decode(data["data_base64"])[:5] == b"%PDF-"

    def test_slugs_pdf_suffixed_filename(self, client):
        resp = client.post("/api/render-cover-letter", json={"text": "Hi", "filename": "My Letter.pdf"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "my-letter.pdf"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest backend/tests/test_cover_letter_api.py -v`
Expected: FAIL — 404s (routes not mounted) / assertion errors.

- [ ] **Step 3a: Create the schemas**

Create `backend/schemas/cover_letter.py`:

```python
"""Schemas for the extension cover-letter endpoints (mounted at /api)."""
from pydantic import BaseModel


class CoverLetterGenerateIn(BaseModel):
    """Generate/regenerate a cover letter for a scraped job (no job_id)."""
    resume_id: int | None = None
    job_description: str = ""
    job_title: str = ""
    company: str = ""
    tone: str | None = None
    # None -> fresh letter; set -> rewrite this text in `tone`.
    base_text: str | None = None


class CoverLetterGenerateOut(BaseModel):
    text: str


class RenderCoverLetterIn(BaseModel):
    text: str
    filename: str | None = None


class RenderCoverLetterOut(BaseModel):
    data_base64: str
    name: str
    content_type: str = "application/pdf"
```

- [ ] **Step 3b: Create the router**

Create `backend/routers/cover_letter.py`:

```python
"""
Extension cover-letter endpoints (mounted at /api).

POST /api/cover-letter        — generate/regenerate a cover letter for a
                                *scraped* job (no job_id), reusing the same
                                CoverLetterGenerator as the web flow. Ephemeral:
                                nothing is persisted to the cover_letters table.
POST /api/render-cover-letter — render cover-letter text to a PDF (base64 JSON).

Used by the Chrome extension on live application pages, where there is no
ScrapedJob row to key off (unlike the web /ai/cover-letter/{job_id} flow).
"""
import base64
import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.auth.dependencies import get_verified_user_id
from backend.db.database import get_db
from backend.routers.ai import LLM_503_DETAIL, _resolve_resume
from backend.schemas.cover_letter import (
    CoverLetterGenerateIn, CoverLetterGenerateOut,
    RenderCoverLetterIn, RenderCoverLetterOut,
)
from backend.services.cover_letter import CoverLetterGenerator
from backend.services.cover_letter_pdf import render_cover_letter_pdf

logger = logging.getLogger(__name__)
router = APIRouter()


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or "cover-letter"


@router.post("/cover-letter", response_model=CoverLetterGenerateOut)
async def cover_letter_endpoint(
    body: CoverLetterGenerateIn,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Generate (or rewrite in a tone) a cover letter from a scraped job. Ephemeral."""
    resume = _resolve_resume(db, user_id, body.resume_id)  # 400 if none on file
    try:
        text = await CoverLetterGenerator().generate(
            resume.raw_text, body.job_description, body.company,
            tone=body.tone, base_text=body.base_text,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)
    return CoverLetterGenerateOut(text=text)


@router.post("/render-cover-letter", response_model=RenderCoverLetterOut)
def render_cover_letter_endpoint(
    body: RenderCoverLetterIn,
    user_id: int = Depends(get_verified_user_id),
):
    """Render cover-letter text to a PDF, returned as base64."""
    try:
        pdf = render_cover_letter_pdf(body.text)
    except Exception as e:
        logger.warning("Cover-letter PDF render failed: %s", e)
        raise HTTPException(status_code=422, detail="Could not render this cover letter.")
    base = body.filename or "cover-letter"
    if base.lower().endswith(".pdf"):
        base = base[:-4]
    name = f"{_slug(base)}.pdf"
    return RenderCoverLetterOut(
        data_base64=base64.b64encode(pdf).decode("ascii"),
        name=name,
    )
```

- [ ] **Step 3c: Mount the router in `backend/main.py`**

Find (line ~23):

```python
from backend.routers import auth, auth_extension, extension, tailor
```

Replace with:

```python
from backend.routers import auth, auth_extension, extension, tailor, cover_letter
```

Find (the `tailor` mount, line ~81):

```python
app.include_router(tailor.router, prefix="/api", tags=["tailor"])
```

Add immediately after it:

```python
app.include_router(cover_letter.router, prefix="/api", tags=["cover-letter"])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest backend/tests/test_cover_letter_api.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/schemas/cover_letter.py backend/routers/cover_letter.py backend/main.py backend/tests/test_cover_letter_api.py
git commit -m "feat(backend): /api/cover-letter + /api/render-cover-letter (ephemeral)"
```

---

### Task 3: Extension API client `coverLetter.ts`

**Files:**
- Create: `chrome-extension/src/api/coverLetter.ts`
- Test: `chrome-extension/test/coverLetter.test.ts`

**Interfaces:**
- Consumes: `authedRequest` (`src/api/client.ts`); `JobContext` (`src/shared/types.ts`).
- Produces:
  - `buildCoverLetterRequestBody(resumeId, jobContext, tone?, baseText?)` → snake_case body.
  - `generateCoverLetter(resumeId, jobContext, tone?, baseText?) -> Promise<{ text: string }>`.
  - `renderCoverLetter(text, filename?) -> Promise<{ dataBase64, name, contentType }>`.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/coverLetter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCoverLetterRequestBody } from "../src/api/coverLetter";
import type { JobContext } from "../src/shared/types";

const ctx: JobContext = { jobDescription: "Need AWS", jobTitle: "Engineer", company: "Acme" };

describe("buildCoverLetterRequestBody", () => {
  it("maps args + context to the snake_case payload", () => {
    expect(buildCoverLetterRequestBody(7, ctx, "professional", "draft")).toEqual({
      resume_id: 7, job_description: "Need AWS", job_title: "Engineer",
      company: "Acme", tone: "professional", base_text: "draft",
    });
  });

  it("sends null tone/base_text when omitted (fresh letter)", () => {
    expect(buildCoverLetterRequestBody(null, ctx)).toEqual({
      resume_id: null, job_description: "Need AWS", job_title: "Engineer",
      company: "Acme", tone: null, base_text: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/coverLetter.test.ts`
Expected: FAIL — cannot resolve `../src/api/coverLetter`.

- [ ] **Step 3: Write the implementation**

Create `chrome-extension/src/api/coverLetter.ts`:

```typescript
/**
 * Calls the backend cover-letter endpoints (POST /api/cover-letter,
 * POST /api/render-cover-letter) from the service worker. Mirrors
 * api/tailorResume.ts: authedRequest handles auth + silent token refresh.
 * The server returns snake_case; these helpers normalize to camelCase.
 */
import type { JobContext } from "../shared/types";
import { authedRequest } from "./client";

export function buildCoverLetterRequestBody(
  resumeId: number | null,
  jobContext: JobContext,
  tone?: string | null,
  baseText?: string | null
): {
  resume_id: number | null;
  job_description: string;
  job_title: string;
  company: string;
  tone: string | null;
  base_text: string | null;
} {
  return {
    resume_id: resumeId,
    job_description: jobContext.jobDescription,
    job_title: jobContext.jobTitle,
    company: jobContext.company,
    tone: tone ?? null,
    base_text: baseText ?? null,
  };
}

export async function generateCoverLetter(
  resumeId: number | null,
  jobContext: JobContext,
  tone?: string | null,
  baseText?: string | null
): Promise<{ text: string }> {
  const raw = await authedRequest<{ text: string }>("/api/cover-letter", {
    method: "POST",
    body: JSON.stringify(buildCoverLetterRequestBody(resumeId, jobContext, tone, baseText)),
  });
  return { text: raw.text ?? "" };
}

export async function renderCoverLetter(
  text: string,
  filename?: string
): Promise<{ dataBase64: string; name: string; contentType: string }> {
  const res = await authedRequest<{ data_base64: string; name: string; content_type: string }>(
    "/api/render-cover-letter",
    { method: "POST", body: JSON.stringify({ text, filename: filename ?? null }) }
  );
  return { dataBase64: res.data_base64, name: res.name, contentType: res.content_type };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/coverLetter.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/api/coverLetter.ts chrome-extension/test/coverLetter.test.ts
git commit -m "feat(extension): coverLetter API client + request-body test"
```

---

### Task 4: Shared types + service-worker routing

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (add to `BackgroundRequest` union ~line 366-375; add response/opts interfaces near the tailor types ~line 257-300)
- Modify: `chrome-extension/src/background/serviceWorker.ts` (imports ~17-32; `handle()` return union ~139-152; new cases after `RENDER_RESUME` ~line 333)

**Interfaces:**
- Consumes: `generateCoverLetter`, `renderCoverLetter` (Task 3).
- Produces: message types `GENERATE_COVER_LETTER` / `RENDER_COVER_LETTER`; `CoverLetterGenOpts`, `GenerateCoverLetterResponse`, `RenderCoverLetterResponse`; two `handle()` cases.

- [ ] **Step 1: Add the types to `src/shared/types.ts`**

Find the end of the résumé-retailoring block (after `RenderResumeResponse`, ~line 300):

```typescript
export interface RenderResumeResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  dataBase64?: string;
  name: string;
  contentType: string;
}
```

Add immediately after it:

```typescript
// ---------------------------------------------------------------------------
// Cover-letter generation (backend POST /api/cover-letter, /api/render-cover-letter)
// ---------------------------------------------------------------------------

/** Options for a cover-letter generate request, chosen in the overlay. */
export interface CoverLetterGenOpts {
  resumeId: number | null;
  tone?: string | null;
  /** null/undefined -> fresh letter; a string -> rewrite this text in `tone`. */
  baseText?: string | null;
}

/** Background reply for GENERATE_COVER_LETTER. */
export interface GenerateCoverLetterResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  text?: string;
}

/** Background reply for RENDER_COVER_LETTER (mirrors RenderResumeResponse). */
export interface RenderCoverLetterResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  dataBase64?: string;
  name: string;
  contentType: string;
}
```

Find the end of the `BackgroundRequest` union (~line 375):

```typescript
  | { type: "RENDER_RESUME"; document: ResumeDoc; filename?: string };
```

Replace with (note the new members before the closing `;`):

```typescript
  | { type: "RENDER_RESUME"; document: ResumeDoc; filename?: string }
  | {
      type: "GENERATE_COVER_LETTER";
      resumeId: number | null;
      jobContext: JobContext;
      tone?: string | null;
      baseText?: string | null;
    }
  | { type: "RENDER_COVER_LETTER"; text: string; filename?: string };
```

- [ ] **Step 2: Wire the service worker `src/background/serviceWorker.ts`**

Find (~line 17):

```typescript
import { renderResume, tailorResume } from "../api/tailorResume";
```

Add immediately after it:

```typescript
import { generateCoverLetter, renderCoverLetter } from "../api/coverLetter";
```

Find the types import block (~19-32) and add these two names to it:

```typescript
  GenerateCoverLetterResponse,
  RenderCoverLetterResponse,
```

Find the `handle()` return union (~139-152) ending with:

```typescript
  | TailorResumeResponse
  | RenderResumeResponse
> {
```

Replace with:

```typescript
  | TailorResumeResponse
  | RenderResumeResponse
  | GenerateCoverLetterResponse
  | RenderCoverLetterResponse
> {
```

Find the end of the `RENDER_RESUME` case (~line 333) — the closing `}` right before `case "OPEN_DASHBOARD"`. Insert these two cases just before `case "OPEN_DASHBOARD": {`:

```typescript
    case "GENERATE_COVER_LETTER": {
      try {
        const { text } = await generateCoverLetter(
          message.resumeId, message.jobContext, message.tone, message.baseText
        );
        return { ok: true, text };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return { ok: false, error: err instanceof Error ? err.message : "Cover-letter generation failed" };
      }
    }

    case "RENDER_COVER_LETTER": {
      try {
        const { dataBase64, name, contentType } = await renderCoverLetter(message.text, message.filename);
        return { ok: true, dataBase64, name, contentType };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, name: "", contentType: "", error: err.message };
        }
        return { ok: false, name: "", contentType: "", error: err instanceof Error ? err.message : "Render failed" };
      }
    }

```

- [ ] **Step 3: Verify typecheck passes (no new unit test — wiring task)**

Run (from `chrome-extension/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the existing test suite to confirm nothing broke**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run`
Expected: all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/background/serviceWorker.ts
git commit -m "feat(extension): cover-letter message types + service-worker routes"
```

---

### Task 5: Cover-letter card builder `coverLetterCard.ts`

**Files:**
- Create: `chrome-extension/src/content/coverLetterCard.ts`
- Test: `chrome-extension/test/coverLetterCard.test.ts`

**Interfaces:**
- Consumes: nothing (pure, DOM-free).
- Produces: `buildCoverLetterCardHtml(text: string, insertLabel: string) -> string` — an editable preview `<textarea id="ap-cover-text">` seeded with `text`, plus buttons `#ap-cover-regen`, `#ap-cover-insert` (labelled `insertLabel`), `#ap-cover-copy`, `#ap-cover-download`, and `<div id="ap-cover-status">`. Escapes `text` and `insertLabel`.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/coverLetterCard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCoverLetterCardHtml } from "../src/content/coverLetterCard";

describe("buildCoverLetterCardHtml", () => {
  it("seeds the textarea and renders the action buttons", () => {
    const html = buildCoverLetterCardHtml("Dear Acme,", "Insert to form");
    expect(html).toContain('id="ap-cover-text"');
    expect(html).toContain("Dear Acme,");
    expect(html).toContain('id="ap-cover-regen"');
    expect(html).toContain('id="ap-cover-insert"');
    expect(html).toContain('id="ap-cover-copy"');
    expect(html).toContain('id="ap-cover-download"');
    expect(html).toContain('id="ap-cover-status"');
    expect(html).toContain("Insert to form");
  });

  it("uses the provided insert label (e.g. Attach PDF)", () => {
    expect(buildCoverLetterCardHtml("x", "Attach PDF")).toContain("Attach PDF");
  });

  it("escapes HTML in the letter text", () => {
    const html = buildCoverLetterCardHtml("<script>alert(1)</script>", "Insert to form");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/coverLetterCard.test.ts`
Expected: FAIL — cannot resolve `../src/content/coverLetterCard`.

- [ ] **Step 3: Write the implementation**

Create `chrome-extension/src/content/coverLetterCard.ts`:

```typescript
/**
 * Pure builder for the overlay's "Generate Cover Letter" result card.
 * Kept DOM-free so the markup is unit-testable; overlay.ts injects the returned
 * HTML, reads/edits the textarea, and wires the buttons. Mirrors tailorCard.ts.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Inner HTML for the cover-letter card: an editable preview textarea seeded with
 * `text`, then Regenerate / Insert / Copy / Download actions + a status line.
 * `insertLabel` is "Insert to form" (textarea on page) or "Attach PDF" (file field).
 */
export function buildCoverLetterCardHtml(text: string, insertLabel: string): string {
  return (
    `<textarea class="ap-cover-text" id="ap-cover-text" spellcheck="true">${esc(text)}</textarea>` +
    `<div class="ap-tailor-actions">` +
    `<button class="ap-btn-soft" id="ap-cover-regen" type="button">Regenerate</button>` +
    `<button class="ap-btn-upload" id="ap-cover-insert" type="button">${esc(insertLabel)}</button>` +
    `<button class="ap-btn-soft" id="ap-cover-copy" type="button">Copy</button>` +
    `<button class="ap-btn-soft" id="ap-cover-download" type="button">Download PDF</button>` +
    `</div>` +
    `<div class="ap-upload-status" id="ap-cover-status"></div>`
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/coverLetterCard.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/coverLetterCard.ts chrome-extension/test/coverLetterCard.test.ts
git commit -m "feat(extension): cover-letter result-card builder + test"
```

---

### Task 6: Content-script callbacks + smart insert

**Files:**
- Modify: `chrome-extension/src/content/fieldMatcher.ts` (export `LONG_TEXT`, line ~411)
- Modify: `chrome-extension/src/content/overlay.ts` (add 4 signatures to the `OverlayCallbacks` interface ~line 58; add `CoverLetterGenOpts` to the shared/types import)
- Modify: `chrome-extension/src/content/contentScript.ts` (types import ~20-38; add `import { LONG_TEXT } from "./fieldMatcher";`; 4 new callbacks in the `overlayCallbacks` object, after `onDownloadTailored` ~line 310)

**Interfaces:**
- Consumes: `CoverLetterGenOpts`, `GenerateCoverLetterResponse`, `RenderCoverLetterResponse` (Task 4); `writeControl`, `verifyControl` (`writeEngine.ts`); `base64ToFile`, `downloadBase64File`, `injectResumeFile` (`fileUpload.ts`); `extractJobContext`; module-scope `lastFields` / `registry`.
- Produces (added to `OverlayCallbacks`): `onGenerateCoverLetter`, `onInsertCoverLetter`, `onDownloadCoverLetter`, `onCopyCoverLetter`.

- [ ] **Step 1: Export `LONG_TEXT` from `fieldMatcher.ts`**

Find (line ~411):

```typescript
const LONG_TEXT: ControlType[] = ["textarea", "contenteditable"];
```

Replace with:

```typescript
export const LONG_TEXT: ControlType[] = ["textarea", "contenteditable"];
```

- [ ] **Step 2: Add callback signatures to the `OverlayCallbacks` interface in `overlay.ts`**

Find the `CoverLetterGenOpts`-relevant import — the shared/types import in `overlay.ts` (it already imports `TailorResumeOpts`, `TailorResult`, `ResumeDoc`, etc.). Add `CoverLetterGenOpts` to that import list.

Find the end of the `OverlayCallbacks` interface — the `onDownloadTailored` line (~line 58):

```typescript
  /** Render the tailored document to PDF and download it. */
  onDownloadTailored: (document: ResumeDoc) => Promise<{ ok: boolean; reason?: string }>;
```

Add immediately after it:

```typescript
  /** Generate (or rewrite) a cover letter for this page's job. */
  onGenerateCoverLetter: (
    opts: CoverLetterGenOpts
  ) => Promise<{ ok: boolean; needsLogin?: boolean; reason?: string; text?: string }>;
  /** Insert the cover letter into the page (textarea, else attach a PDF). */
  onInsertCoverLetter: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Render the cover letter to PDF and download it. */
  onDownloadCoverLetter: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Copy the cover letter to the clipboard. */
  onCopyCoverLetter: (text: string) => Promise<{ ok: boolean; reason?: string }>;
```

- [ ] **Step 3: Implement the callbacks in `contentScript.ts`**

In the types import block (~20-38), add: `CoverLetterGenOpts`, `GenerateCoverLetterResponse`, `RenderCoverLetterResponse`.

After the `formScanner` import (~line 41), add:

```typescript
import { LONG_TEXT } from "./fieldMatcher";
```

Find the end of the `onDownloadTailored` callback (the `},` before the object's closing `};` ~line 310). Insert these four callbacks right after `onDownloadTailored`'s closing `},`:

```typescript
    onGenerateCoverLetter: async (opts: CoverLetterGenOpts) => {
      const resp = await sendToBackground<GenerateCoverLetterResponse>({
        type: "GENERATE_COVER_LETTER",
        resumeId: opts.resumeId,
        jobContext: extractJobContext(),
        tone: opts.tone,
        baseText: opts.baseText,
      });
      if (!resp?.ok || typeof resp.text !== "string") {
        return {
          ok: false,
          needsLogin: resp?.needsLogin,
          reason: resp?.error ?? "Could not generate a cover letter.",
        };
      }
      return { ok: true, text: resp.text };
    },
    onInsertCoverLetter: async (text: string) => {
      // Prefer a cover-letter textarea; fall back to a cover-letter file field.
      const textField = lastFields.find(
        (f) => f.category === "coverLetter" && LONG_TEXT.includes(f.controlType)
      );
      if (textField) {
        const control = registry.get(textField.id);
        if (!control) return { ok: false, reason: "Cover-letter field is no longer on the page — rescan." };
        const res = writeControl(control, text);
        if (!res.written) return { ok: false, reason: res.reason };
        return verifyControl(control, text)
          ? { ok: true }
          : { ok: false, reason: "Text did not stick — please check the field." };
      }
      const fileField = lastFields.find(
        (f) => f.category === "coverLetter" && f.controlType === "file"
      );
      const fileControl = fileField ? registry.get(fileField.id) : undefined;
      if (fileControl?.el) {
        const company = extractJobContext().company;
        const file = await sendToBackground<RenderCoverLetterResponse>({
          type: "RENDER_COVER_LETTER",
          text,
          filename: company ? `cover-letter-${company}` : "cover-letter",
        });
        if (!file?.ok || !file.dataBase64) {
          return { ok: false, reason: file?.error ?? "Could not render your cover letter." };
        }
        return injectResumeFile(fileControl.el, base64ToFile(file.dataBase64, file.name, file.contentType));
      }
      return { ok: false, reason: "No cover-letter field found on this page." };
    },
    onDownloadCoverLetter: async (text: string) => {
      const company = extractJobContext().company;
      const file = await sendToBackground<RenderCoverLetterResponse>({
        type: "RENDER_COVER_LETTER",
        text,
        filename: company ? `cover-letter-${company}` : "cover-letter",
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not render your cover letter." };
      }
      downloadBase64File(file.dataBase64, file.name, file.contentType);
      return { ok: true };
    },
    onCopyCoverLetter: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      } catch {
        return { ok: false, reason: "Clipboard blocked — select the text and copy manually." };
      }
    },
```

- [ ] **Step 4: Verify typecheck passes**

Run (from `chrome-extension/`): `npx tsc --noEmit`
Expected: no errors. (If TS reports `registry`/`lastFields` unused before this, ignore — they are used by the existing tailor callbacks.)

- [ ] **Step 5: Run the existing test suite**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/fieldMatcher.ts chrome-extension/src/content/overlay.ts chrome-extension/src/content/contentScript.ts
git commit -m "feat(extension): cover-letter content-script callbacks + smart insert"
```

---

### Task 7: Overlay card UI

**Files:**
- Modify: `chrome-extension/src/content/overlay.ts` — import the card builder; `PanelState` + `overlayState` + `Refs` + `collectRefs`; replace the coming-soon markup; wire the Generate button; `refreshMainView`; `resetState`; new cover functions; CSS.

**Interfaces:**
- Consumes: `buildCoverLetterCardHtml` (Task 5); `OverlayCallbacks.onGenerateCoverLetter/onInsertCoverLetter/onDownloadCoverLetter/onCopyCoverLetter` (Task 6); existing `selectedResumeId()`.
- Produces: a working "Generate Cover Letter" card in the overlay (no exported interface change).

- [ ] **Step 1: Import the card builder**

Find (~line 15):

```typescript
import { buildTailorCardHtml } from "./tailorCard";
```

Add immediately after it:

```typescript
import { buildCoverLetterCardHtml } from "./coverLetterCard";
```

- [ ] **Step 2: Extend `PanelState` and `overlayState`**

Find the end of `PanelState` (~line 564-567):

```typescript
  tailorResult: TailorResult | null;
  tailorKeywords: Set<string>;
  tailorBusy: boolean;
}
```

Replace with:

```typescript
  tailorResult: TailorResult | null;
  tailorKeywords: Set<string>;
  tailorBusy: boolean;
  coverLetterText: string | null;
  coverLetterBusy: boolean;
}
```

Find the end of the `overlayState` initializer (~line 590-593):

```typescript
  tailorResult: null,
  tailorKeywords: new Set(),
  tailorBusy: false,
};
```

Replace with:

```typescript
  tailorResult: null,
  tailorKeywords: new Set(),
  tailorBusy: false,
  coverLetterText: null,
  coverLetterBusy: false,
};
```

- [ ] **Step 3: Extend `Refs` and `collectRefs`**

Find in the `Refs` interface (~line 608-609):

```typescript
  btnTailor: HTMLButtonElement;
  tailorResult: HTMLDivElement;
```

Replace with:

```typescript
  btnTailor: HTMLButtonElement;
  tailorResult: HTMLDivElement;
  btnCover: HTMLButtonElement;
  coverTone: HTMLSelectElement;
  coverResult: HTMLDivElement;
```

Find in `collectRefs` (~line 838-839):

```typescript
    btnTailor: q("#ap-btn-tailor"),
    tailorResult: q("#ap-tailor-result"),
```

Replace with:

```typescript
    btnTailor: q("#ap-btn-tailor"),
    tailorResult: q("#ap-tailor-result"),
    btnCover: q("#ap-btn-cover"),
    coverTone: q("#ap-cover-tone"),
    coverResult: q("#ap-cover-result"),
```

- [ ] **Step 4: Replace the coming-soon markup**

Find inside the cover-letter section sub (~line 762-767):

```html
            <div class="ap-file-name" id="ap-cover-name">No cover letter uploaded</div>
            <div class="ap-section-action">
              ${icon('<polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/>', 14)}
              Generate Cover Letter
              <span class="ap-coming-soon">Coming soon</span>
            </div>
```

Replace with:

```html
            <div class="ap-cover-controls">
              <select id="ap-cover-tone" class="ap-cover-tone" aria-label="Cover letter tone">
                <option value="">Default tone</option>
                <option value="professional">Professional</option>
                <option value="formal">Formal</option>
                <option value="enthusiastic">Enthusiastic</option>
                <option value="concise">Concise</option>
                <option value="technical">Technical</option>
              </select>
              <button class="ap-btn-tailor" id="ap-btn-cover" type="button" disabled>
                ${icon('<polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/>', 14)}
                Generate Cover Letter
              </button>
            </div>
            <div id="ap-cover-result"></div>
```

- [ ] **Step 5: Wire the Generate button**

Find the tailor button wiring in `wireEvents` (~line 894-895):

```typescript
  // Tailor button
  root.querySelector("#ap-btn-tailor")!.addEventListener("click", () => void doTailor());
```

Add immediately after it:

```typescript
  // Generate Cover Letter button
  root.querySelector("#ap-btn-cover")!.addEventListener("click", () => void doGenerateCoverLetter());
```

- [ ] **Step 6: Enable the button in `refreshMainView`**

Find (~line 1094):

```typescript
  updateUploadButtonState();
  updateTailorButtonState();
```

Replace with:

```typescript
  updateUploadButtonState();
  updateTailorButtonState();
  updateCoverButtonState();
```

- [ ] **Step 7: Reset cover state in `resetState`**

Find (~line 1448-1450):

```typescript
  overlayState.tailorResult = null;
  overlayState.tailorKeywords = new Set();
  overlayState.tailorBusy = false;
```

Replace with:

```typescript
  overlayState.tailorResult = null;
  overlayState.tailorKeywords = new Set();
  overlayState.tailorBusy = false;
  overlayState.coverLetterText = null;
  overlayState.coverLetterBusy = false;
```

- [ ] **Step 8: Add the cover-letter functions**

Find the end of the tailor section — the `setTailorStatus` function (~line 1559-1568). Add the following block immediately after it (before the next top-level function/section):

```typescript
// ---------------------------------------------------------------------------
// Generate Cover Letter (on the spot + insert)
// ---------------------------------------------------------------------------

function updateCoverButtonState(): void {
  if (!refs) return;
  refs.btnCover.disabled = !overlayState.profile || overlayState.coverLetterBusy;
}

/** "Insert to form" when a cover-letter textarea exists; "Attach PDF" for a file field. */
function coverInsertLabel(): { label: string; enabled: boolean } {
  const hasText = overlayState.fields.some(
    (f) =>
      f.category === "coverLetter" &&
      (f.controlType === "textarea" || f.controlType === "contenteditable")
  );
  if (hasText) return { label: "Insert to form", enabled: true };
  const hasFile = overlayState.fields.some(
    (f) => f.category === "coverLetter" && f.controlType === "file"
  );
  if (hasFile) return { label: "Attach PDF", enabled: true };
  return { label: "Insert to form", enabled: false };
}

/** The (possibly edited) text in the preview textarea, falling back to state. */
function currentCoverText(): string {
  const ta = refs?.coverResult.querySelector<HTMLTextAreaElement>("#ap-cover-text");
  return ta ? ta.value : overlayState.coverLetterText ?? "";
}

async function doGenerateCoverLetter(baseText?: string): Promise<void> {
  if (!refs || !callbacks || overlayState.coverLetterBusy) return;
  if (!overlayState.profile) {
    setCoverStatus("Connect your Tailrd account to generate a cover letter.", "warn");
    return;
  }
  overlayState.coverLetterBusy = true;
  refs.btnCover.disabled = true;
  refs.btnCover.textContent = baseText ? "Rewriting…" : "Generating…";
  try {
    const res = await callbacks.onGenerateCoverLetter({
      resumeId: selectedResumeId(),
      tone: refs.coverTone.value || null,
      baseText: baseText ?? null,
    });
    if (!res.ok || typeof res.text !== "string") {
      setCoverStatus(res.reason ?? "Couldn't generate a cover letter.", "error");
      return;
    }
    overlayState.coverLetterText = res.text;
    renderCoverLetterResult();
  } catch (err) {
    setCoverStatus(err instanceof Error ? err.message : "Generation failed.", "error");
  } finally {
    overlayState.coverLetterBusy = false;
    if (refs) {
      updateCoverButtonState();
      refs.btnCover.textContent = overlayState.coverLetterText
        ? "Regenerate cover letter"
        : "Generate Cover Letter";
    }
  }
}

function renderCoverLetterResult(): void {
  if (!refs || overlayState.coverLetterText === null) return;
  const { label, enabled } = coverInsertLabel();
  refs.coverResult.innerHTML = buildCoverLetterCardHtml(overlayState.coverLetterText, label);

  refs.coverResult
    .querySelector("#ap-cover-regen")
    ?.addEventListener("click", () => void doGenerateCoverLetter(currentCoverText()));
  refs.coverResult
    .querySelector("#ap-cover-insert")
    ?.addEventListener("click", () => void insertCoverLetter());
  refs.coverResult
    .querySelector("#ap-cover-copy")
    ?.addEventListener("click", () => void copyCoverLetter());
  refs.coverResult
    .querySelector("#ap-cover-download")
    ?.addEventListener("click", () => void downloadCoverLetter());

  const insertBtn = refs.coverResult.querySelector<HTMLButtonElement>("#ap-cover-insert");
  if (insertBtn && !enabled) {
    insertBtn.disabled = true;
    insertBtn.title = "No cover-letter field on this page — use Copy or Download instead.";
  }
}

async function insertCoverLetter(): Promise<void> {
  if (!refs || !callbacks) return;
  setCoverStatus("Inserting…", "");
  const res = await callbacks.onInsertCoverLetter(currentCoverText());
  setCoverStatus(
    res.ok ? "Inserted. Review before submitting." : res.reason ?? "Could not insert.",
    res.ok ? "ok" : "error"
  );
}

async function copyCoverLetter(): Promise<void> {
  if (!refs || !callbacks) return;
  const res = await callbacks.onCopyCoverLetter(currentCoverText());
  setCoverStatus(res.ok ? "Copied to clipboard." : res.reason ?? "Could not copy.", res.ok ? "ok" : "error");
}

async function downloadCoverLetter(): Promise<void> {
  if (!refs || !callbacks) return;
  setCoverStatus("Preparing download…", "");
  const res = await callbacks.onDownloadCoverLetter(currentCoverText());
  setCoverStatus(res.ok ? "Downloaded." : res.reason ?? "Could not download.", res.ok ? "ok" : "error");
}

function setCoverStatus(text: string, kind: "ok" | "warn" | "error" | ""): void {
  const el = refs?.coverResult.querySelector<HTMLDivElement>("#ap-cover-status");
  if (el) {
    el.textContent = text;
    el.className = "ap-upload-status" + (kind ? ` ${kind}` : "");
  }
}
```

- [ ] **Step 9: Add the CSS**

Find the tailor actions rule in the `STYLES` string (~line 537-538):

```css
.ap-tailor-actions { display: flex; gap: 8px; margin-top: 12px; }
.ap-tailor-actions .ap-btn-upload { width: auto; flex: 1; }
```

Add immediately after it:

```css
.ap-cover-controls { display: flex; gap: 8px; align-items: center; }
.ap-cover-tone { flex: 0 0 auto; padding: 8px; border: 1px solid #e7e4ff; border-radius: 8px;
  font-size: 12px; background: #fff; color: #1a1a2e; }
.ap-cover-controls .ap-btn-tailor { flex: 1; }
.ap-cover-text { width: 100%; box-sizing: border-box; margin-top: 10px; min-height: 160px;
  padding: 10px; border: 1px solid #e7e4ff; border-radius: 8px; font-size: 12.5px;
  line-height: 1.5; resize: vertical; color: #1a1a2e; font-family: inherit; }
```

- [ ] **Step 10: Typecheck + build + full test suite**

Run (from `chrome-extension/`):
```bash
npx tsc --noEmit
npm run build
node node_modules/vitest/vitest.mjs run
```
Expected: typecheck clean; build writes `dist/` with no errors; all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add chrome-extension/src/content/overlay.ts
git commit -m "feat(extension): Generate Cover Letter card in the overlay"
```

---

### Task 8: Full-suite verification + manual E2E

**Files:** none (verification only).

- [ ] **Step 1: Backend — run the cover-letter tests + a broad sweep**

Run:
```bash
python -m pytest backend/tests/test_cover_letter_pdf.py backend/tests/test_cover_letter_api.py -v
python -m pytest backend/tests/test_tailor_api.py -v
```
Expected: all PASS (confirms the shared `/api` surface + reused `_resolve_resume`/`LLM_503_DETAIL` still behave).

- [ ] **Step 2: Extension — full suite + build**

Run (from `chrome-extension/`):
```bash
npx tsc --noEmit
node node_modules/vitest/vitest.mjs run
npm run build
```
Expected: clean typecheck, all tests PASS, `dist/` rebuilt.

- [ ] **Step 3: Manual E2E (load the unpacked build)**

Load `chrome-extension/dist` as an unpacked extension. On a Greenhouse/Workday application page with a cover-letter textarea, signed in with a résumé on file:
1. Open the panel → expand "Upload Cover Letter".
2. Pick a tone → **Generate Cover Letter** → a letter appears in the editable preview.
3. Change tone → **Regenerate** → the letter updates (rewrite). Edit the textarea, regenerate → edits carry into the rewrite.
4. **Insert to form** → the page's cover-letter textarea is filled; the form is **not** submitted.
5. **Copy** → clipboard holds the letter. **Download PDF** → a `cover-letter-*.pdf` downloads.
6. On a page whose cover letter is a **file** upload (no textarea): the button reads **Attach PDF**, and clicking it attaches the rendered PDF without submitting.
7. On a page with **no** cover-letter field: the insert button is disabled with the Copy/Download hint.
8. Signed out / expired session: generating routes through the existing reconnect (`needsLogin`) path; the panel never crashes.

- [ ] **Step 4: Confirm ephemeral**

After generating from the extension, verify (web app or DB) that **no** new `cover_letters` row was created and the active autofill cover letter is unchanged.

- [ ] **Step 5: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "test(extension): cover-letter E2E verification notes"   # only if changes were made
```

---

## Notes for the implementer

- **Line numbers are approximate** — they will drift as you edit. Locate edits by the quoted anchor strings, which are unique.
- **`OverlayCallbacks` is edited in Task 6 (interface) and Task 7 (UI)** — different regions of `overlay.ts`; both compile independently.
- **Wiring tasks (4 & 6) have no new unit test** — their gate is `npx tsc --noEmit` + the existing suite. Smart-insert behavior is exercised in Task 8's manual E2E (the repo has no content-script harness).
- **Optional, out of scope:** `routers/ai.py:46` `LLM_503_DETAIL` still says "Anthropic API key" post-migration. Leave it unless the user asks (mentioned in the spec).
