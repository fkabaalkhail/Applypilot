# Extension Résumé Retailor + Attach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From any job application page, the Chrome extension tailors the user's résumé to the on-page job and attaches the result as a server-rendered PDF — reusing the web app's tailoring engine.

**Architecture:** Two new `/api` endpoints reuse the existing tailoring services (`db_record_to_document` → `MatchEngine.analyze_job` → `tailor_resume_structured`) but take a *scraped* job description instead of a `job_id`; a new pure `reportlab` renderer turns the structured `ResumeDocument` into PDF bytes. The extension scrapes the JD with the existing `extractJobContext()`, shows a one-click + keyword-tweak result card in the overlay, and attaches the rendered PDF with the existing `injectResumeFile()`.

**Tech Stack:** FastAPI + Pydantic + SQLAlchemy (Python 3.12); `reportlab` (new, pure-Python PDF); TypeScript + esbuild + vitest/jsdom (extension).

Spec: `docs/superpowers/specs/2026-06-28-extension-resume-retailor-design.md`.

## Global Constraints

- **New backend dependency:** add `reportlab==4.2.5` to `backend/requirements.txt` (pure-Python wheel; **no system libraries**; if that exact patch is unavailable use the latest `4.2.x`).
- **Endpoint surface:** new endpoints mount under `prefix="/api"` in `backend/main.py` (same surface the extension already calls for `/api/fill`).
- **Auth:** every new endpoint depends on `get_verified_user_id`.
- **Test LLM mock:** patch `backend.services.anthropic_service.AnthropicService._generate` with an `AsyncMock`; `/api/tailor-resume` makes exactly **3** `_generate` calls in order — analyze(before), structured tailor, analyze(after) — so use `side_effect=[BEFORE_JSON, EDITED_DOC_JSON, AFTER_JSON]`.
- **Backend test fixtures:** reuse `backend/tests/conftest.py` `client` + `db_session` (in-memory SQLite, `TEST_USER_ID = 1`); set `ANTHROPIC_API_KEY` via `monkeypatch.setenv`.
- **Extension build:** esbuild entry points are **only** `src/background/serviceWorker.ts` and `src/content/contentScript.ts`; new modules are bundled automatically via imports — **no `build.mjs` change**.
- **Extension tests:** `npm test` runs `vitest run` (jsdom). Type gate: `npm run typecheck`.
- **Extension conventions:** base URL `https://www.tailrd.ca`; `authedRequest<T>` for JSON (handles auth + silent refresh, throws `AuthRequiredError`); extension types are **camelCase** — map the server's snake_case in the api client; **never submit forms**; the résumé upload field is `category === "resumeUpload" && controlType === "file"`; brand string is **"Tailrd"**.
- **Branch:** `feat/extension-resume-retailor` (already created). **Commit after each task.**

---

### Task 1: PDF renderer service (`render_resume_pdf`)

**Files:**
- Modify: `backend/requirements.txt` (add `reportlab==4.2.5`)
- Create: `backend/services/resume_pdf.py`
- Test: `backend/tests/test_resume_pdf.py`

**Interfaces:**
- Produces: `render_resume_pdf(doc: ResumeDocument) -> bytes` — pure (no DB/network/file I/O).

- [ ] **Step 1: Add the dependency and install**

Add this line to `backend/requirements.txt` (after `pdfplumber==0.11.0`):

```
reportlab==4.2.5
```

Run: `pip install reportlab==4.2.5`
Expected: installs cleanly (pure-Python wheel).

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_resume_pdf.py`:

```python
"""Unit tests for the structured-document → PDF renderer (pure function)."""
from backend.schemas.resume_document import (
    ResumeDocument, ResumeHeader, Section, SectionItem, Theme,
)
from backend.services.resume_pdf import render_resume_pdf


def _sample_doc(**theme_kw) -> ResumeDocument:
    return ResumeDocument(
        header=ResumeHeader(
            name="Jane Doe", email="jane@example.com", phone="555-1212",
            location="NYC", linkedin_url="linkedin.com/in/jane",
        ),
        sections=[
            Section(type="summary", title="SUMMARY", text="Engineer.\nSecond line."),
            Section(type="skills", title="SKILLS", skills=["Python", "SQL", "AWS"]),
            Section(type="experience", title="WORK EXPERIENCE", items=[
                SectionItem(
                    title="Software Engineer", subtitle="Acme", location="NYC",
                    start_date="2020", end_date="2023",
                    bullets=["Built internal tools used by 500+ employees", "Cut latency 40%"],
                ),
            ]),
            Section(type="technologies", title="TECHNOLOGIES", groups={"Cloud": ["AWS", "GCP"]}),
        ],
        theme=Theme(**theme_kw),
    )


def test_returns_pdf_bytes():
    pdf = render_resume_pdf(_sample_doc())
    assert isinstance(pdf, (bytes, bytearray))
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 800


def test_empty_document_still_renders():
    pdf = render_resume_pdf(ResumeDocument())
    assert pdf[:5] == b"%PDF-"


def test_a4_page_size_renders():
    pdf = render_resume_pdf(_sample_doc(page_size="a4"))
    assert pdf[:5] == b"%PDF-"


def test_multipage_document_paginates():
    big = _sample_doc()
    big.sections[2].items = [
        SectionItem(title=f"Role {i}", subtitle="Company", start_date="2020",
                    end_date="2021", bullets=["Did meaningful things here"] * 6)
        for i in range(40)
    ]
    pdf = render_resume_pdf(big)
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 3000
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest backend/tests/test_resume_pdf.py -v`
Expected: FAIL — `ModuleNotFoundError: backend.services.resume_pdf`.

- [ ] **Step 4: Implement the renderer**

Create `backend/services/resume_pdf.py`:

```python
"""
Render a structured ResumeDocument to PDF bytes with reportlab.

Mirrors the structure + theme mapping of the web app's DOCX builder
(frontend/src/lib/resumeExport.ts) so the extension's PDF stays consistent
with the web app's outputs: clean, single-column, real selectable text
(ATS-friendly). Pure function — no DB, no network, no file I/O.
"""
from __future__ import annotations

import io

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from backend.schemas.resume_document import ResumeDocument

_GRAY = HexColor("#4b5563")


def _fonts(family: str) -> tuple[str, str]:
    """Map a CSS font-family to a (regular, bold) built-in PDF font pair."""
    first = (family.split(",")[0] or "").strip().strip("'\"").lower()
    if "times" in first or "georgia" in first:
        return "Times-Roman", "Times-Bold"
    if "courier" in first or "mono" in first:
        return "Courier", "Courier-Bold"
    return "Helvetica", "Helvetica-Bold"  # Calibri/Segoe/Arial/sans-serif


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_resume_pdf(doc: ResumeDocument) -> bytes:
    theme = doc.theme
    base, bold = _fonts(theme.font_family)
    accent_hex = theme.accent_color or "#1f2937"
    accent = HexColor(accent_hex)
    text_color = HexColor(theme.text_color or "#1f2937")
    pagesize = A4 if theme.page_size == "a4" else LETTER
    content_width = pagesize[0] - 1.2 * inch

    body = ParagraphStyle("body", fontName=base, fontSize=theme.base_font_pt,
                          leading=theme.base_font_pt * theme.line_height,
                          textColor=text_color)
    name_style = ParagraphStyle("name", parent=body, fontName=bold,
                                fontSize=theme.name_font_pt,
                                leading=theme.name_font_pt * 1.1,
                                alignment=TA_CENTER, textColor=accent)
    center = ParagraphStyle("center", parent=body, alignment=TA_CENTER)
    heading = ParagraphStyle("heading", parent=body, fontName=bold,
                             fontSize=theme.heading_font_pt, textColor=accent,
                             spaceBefore=theme.section_spacing_pt, spaceAfter=2)
    title_style = ParagraphStyle("title", parent=body, fontName=bold)
    date_style = ParagraphStyle("date", parent=body, alignment=TA_RIGHT, textColor=_GRAY)
    sub_style = ParagraphStyle("sub", parent=body, textColor=_GRAY)
    bullet_style = ParagraphStyle("bullet", parent=body, leftIndent=14,
                                  bulletIndent=2, spaceBefore=1)

    story: list = []
    h = doc.header
    story.append(Paragraph(_esc(h.name) or "Your Name", name_style))
    contact = "  •  ".join(v for v in (h.location, h.email, h.phone) if v)
    if contact:
        story.append(Paragraph(_esc(contact), center))
    links = "  •  ".join(v for v in (h.linkedin_url, h.github_url, h.other_link) if v)
    if links:
        story.append(Paragraph(f'<font color="{accent_hex}">{_esc(links)}</font>', center))

    for section in doc.sections:
        story.append(Paragraph((_esc(section.title) or section.type).upper(), heading))
        story.append(HRFlowable(width="100%", thickness=0.6, color=accent,
                                spaceBefore=1, spaceAfter=4))

        if section.type in ("summary", "custom") and section.text:
            for para in section.text.split("\n"):
                if para.strip():
                    story.append(Paragraph(_esc(para.strip()), body))

        skills = [s for s in section.skills if s.strip()]
        if skills:
            story.append(Paragraph(_esc(", ".join(skills)), body))

        for category, items in (section.groups or {}).items():
            vals = [x for x in items if x.strip()]
            if vals:
                story.append(Paragraph(f"<b>{_esc(category)}:</b> {_esc(', '.join(vals))}", body))

        for item in section.items:
            dates = " – ".join(v for v in (item.start_date, item.end_date) if v)
            title_cell = Paragraph(_esc(item.title), title_style)
            if dates:
                row = Table([[title_cell, Paragraph(_esc(dates), date_style)]],
                            colWidths=[content_width * 0.7, content_width * 0.3])
                row.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]))
                story.append(row)
            else:
                story.append(Spacer(1, 3))
                story.append(title_cell)
            second = "  •  ".join(v for v in (item.subtitle, item.location) if v)
            if second:
                story.append(Paragraph(_esc(second), sub_style))
            if item.link:
                story.append(Paragraph(f'<font color="{accent_hex}">{_esc(item.link)}</font>', body))
            if item.detail:
                story.append(Paragraph(_esc(item.detail), sub_style))
            for b in item.bullets:
                if b.strip():
                    story.append(Paragraph(_esc(b.strip()), bullet_style, bulletText="•"))

    if not story:
        story.append(Spacer(1, 1))

    buf = io.BytesIO()
    pdf = SimpleDocTemplate(
        buf, pagesize=pagesize,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.5 * inch, bottomMargin=0.5 * inch,
        title=(h.name or "Resume"),
    )
    pdf.build(story)
    return buf.getvalue()
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest backend/tests/test_resume_pdf.py -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/services/resume_pdf.py backend/tests/test_resume_pdf.py
git commit -m "feat(backend): structured ResumeDocument -> PDF renderer (reportlab)"
```

---

### Task 2: Shared `tailor_document` helper (+ refactor web rewrite)

Extract the tailor-and-score core both the web `/ai/custom-resume` flow and the new `/api/tailor-resume` endpoint share, so they cannot drift.

**Files:**
- Modify: `backend/services/resume_tailor.py` (add `TailorResult` + `tailor_document`)
- Modify: `backend/routers/ai.py` (refactor `rewrite_resume` to call the helper)
- Test: covered by the existing `backend/tests/test_ai_web_flow.py::TestRewrite` (regression gate)

**Interfaces:**
- Produces: `tailor_document(db, original_document, job_title, company, job_description, sections=None, add_keywords=None) -> TailorResult` where `TailorResult` has `.document (ResumeDocument)`, `.original_text (str)`, `.tailored_text (str)`, `.before (JobAnalysisOut)`, `.after (JobAnalysisOut)`, `.diff_summary (str)`.
- Keyword rule: `add_keywords is None` → weave **all** `before.missing_keywords`; a list (even `[]`) → use exactly that.

- [ ] **Step 1: Confirm the regression test passes before refactor**

Run: `pytest backend/tests/test_ai_web_flow.py::TestRewrite -v`
Expected: PASS (this is the safety net for the refactor).

- [ ] **Step 2: Add the helper**

In `backend/services/resume_tailor.py`, add these imports near the top (below the existing imports):

```python
from dataclasses import dataclass

from backend.schemas.ai import JobAnalysisOut
from backend.services.resume_document import document_to_text
```

Then append to the end of the file:

```python
@dataclass
class TailorResult:
    """Output of one tailoring pass: the rewritten doc + before/after scores."""
    document: ResumeDocument
    original_text: str
    tailored_text: str
    before: JobAnalysisOut
    after: JobAnalysisOut
    diff_summary: str


async def tailor_document(
    db: Session,
    original_document: ResumeDocument,
    job_title: str,
    company: str,
    job_description: str,
    sections: list[str] | None = None,
    add_keywords: list[str] | None = None,
) -> TailorResult:
    """Tailor a structured résumé to a job and score it before/after.

    Shared by the web ``/ai/custom-resume`` flow and the extension
    ``/api/tailor-resume`` endpoint so the two cannot drift.

    Keyword semantics: when ``add_keywords`` is None, all of the job's missing
    keywords are woven in (best one-click result); when a list is given (even
    empty), exactly that set is used.
    """
    from backend.services.match_engine import MatchEngine  # local: avoid import cycle

    engine = MatchEngine(db)
    tailor = ResumeTailor(db)
    original_text = document_to_text(original_document)
    before = await engine.analyze_job(original_text, job_title, company, job_description)
    keywords = add_keywords if add_keywords is not None else list(before.missing_keywords)
    document = await tailor.llm.tailor_resume_structured(
        original_document, job_description, sections, keywords
    )
    tailored_text = document_to_text(document)
    after = await engine.analyze_job(tailored_text, job_title, company, job_description)
    diff_summary = tailor.compute_diff(original_text, tailored_text)
    return TailorResult(
        document=document, original_text=original_text, tailored_text=tailored_text,
        before=before, after=after, diff_summary=diff_summary,
    )
```

Note: `ResumeDocument` and `Session` are already imported at the top of `resume_tailor.py`.

- [ ] **Step 3: Refactor the web endpoint to use the helper**

In `backend/routers/ai.py`, inside `rewrite_resume`, replace the `try` block that does the before-analysis, structured tailor, and after-analysis (currently lines ~369-386) with a call to the helper. The new body of that `try` is:

```python
    try:
        from backend.services.resume_tailor import tailor_document
        result = await tailor_document(
            db, original_document, job.title, job.company, job.description,
            opts.sections, opts.add_keywords,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    before = result.before
    after = result.after
    document = result.document
    tailored_text = result.tailored_text
    diff_summary = result.diff_summary
```

Leave everything after it (the `ResumeVersion` save and the `RewriteOut(...)` return) unchanged — it already reads `document`, `tailored_text`, `diff_summary`, `before`, `after`. The existing `original_text` local is still used by `RewriteOut`; keep its assignment (`original_text = document_to_text(original_document)`) above the `try`.

- [ ] **Step 4: Run the regression test**

Run: `pytest backend/tests/test_ai_web_flow.py::TestRewrite -v`
Expected: PASS — identical behavior (same 3 `_generate` calls, same outputs).

- [ ] **Step 5: Commit**

```bash
git add backend/services/resume_tailor.py backend/routers/ai.py
git commit -m "refactor(backend): extract shared tailor_document helper"
```

---

### Task 3: `/api/tailor-resume` + `/api/render-resume` endpoints

**Files:**
- Create: `backend/schemas/tailor.py`
- Create: `backend/routers/tailor.py`
- Modify: `backend/main.py` (mount the router)
- Test: `backend/tests/test_tailor_api.py`

**Interfaces:**
- Consumes: `tailor_document` (Task 2), `render_resume_pdf` (Task 1), `_resolve_resume` + `LLM_503_DETAIL` (`backend/routers/ai.py`), `db_record_to_document` (`backend/services/resume_document.py`).
- Produces: `POST /api/tailor-resume` → `TailorResumeOut`; `POST /api/render-resume` → `RenderResumeOut`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_tailor_api.py`:

```python
"""Endpoint tests for the extension's /api/tailor-resume + /api/render-resume."""
import base64
from unittest.mock import patch, AsyncMock

from backend.db.models import ResumeProfileDB

TEST_USER_ID = 1

BEFORE = ('{"overall_score":60,"ats_score":55,"matched_keywords":["Python"],'
          '"missing_keywords":["AWS","TypeScript"]}')
EDITED = '{"sections":[{"type":"skills","skills":["Python","AWS","TypeScript"]}]}'
AFTER = ('{"overall_score":80,"ats_score":78,"matched_keywords":["Python","AWS","TypeScript"],'
         '"missing_keywords":[]}')


def _seed_resume(db):
    db.add(ResumeProfileDB(
        user_id=TEST_USER_ID, profile_name="Jane Doe", is_primary=1,
        skills=["Python"],
        experience=[{"title": "Engineer", "company": "Acme", "start_date": "2020",
                     "end_date": "2023", "bullets": ["Built tools"]}],
        raw_text="Python engineer.",
    ))
    db.commit()


class TestTailorResume:
    def test_auto_weaves_all_missing_keywords(self, client, db_session, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.anthropic_service.AnthropicService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "We need Python, AWS and TypeScript.",
            })
        assert resp.status_code == 200
        data = resp.json()
        assert data["original_overall_score"] == 60
        assert data["new_overall_score"] == 80
        assert data["new_ats_score"] == 78
        # chip set is the BEFORE candidate set (stable across regenerates)
        assert data["missing_keywords"] == ["AWS", "TypeScript"]
        assert data["document"]["sections"][0]["skills"] == ["Python", "AWS", "TypeScript"]
        # omitted add_keywords -> all missing keywords woven into the tailor prompt
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "weave in these keywords: AWS, TypeScript." in tailor_prompt

    def test_explicit_keywords_used_exactly(self, client, db_session, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.anthropic_service.AnthropicService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "JD", "add_keywords": ["AWS"],
            })
        assert resp.status_code == 200
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "weave in these keywords: AWS." in tailor_prompt

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/tailor-resume", json={"job_description": "JD"})
        assert resp.status_code == 400


class TestRenderResume:
    def test_returns_base64_pdf(self, client):
        doc = {"header": {"name": "Jane Doe"},
               "sections": [{"type": "skills", "title": "SKILLS", "skills": ["Python", "AWS"]}],
               "theme": {}}
        resp = client.post("/api/render-resume", json={"document": doc, "filename": "resume-acme"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["content_type"] == "application/pdf"
        assert data["name"] == "resume-acme.pdf"
        assert base64.b64decode(data["data_base64"])[:5] == b"%PDF-"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest backend/tests/test_tailor_api.py -v`
Expected: FAIL — 404s (router not mounted yet) / import errors.

- [ ] **Step 3: Add the schemas**

Create `backend/schemas/tailor.py`:

```python
"""Schemas for the extension résumé-tailoring endpoints (mounted at /api)."""
from pydantic import BaseModel

from backend.schemas.resume_document import ResumeDocument


class TailorResumeIn(BaseModel):
    """Tailor a résumé to a scraped job (no job_id)."""
    resume_id: int | None = None
    job_description: str = ""
    job_title: str = ""
    company: str = ""
    sections: list[str] | None = None
    # None -> weave all missing keywords; a list (even []) -> use exactly that.
    add_keywords: list[str] | None = None


class TailorResumeOut(BaseModel):
    """Tailored document + before/after scores + the stable candidate keyword set."""
    document: ResumeDocument
    original_overall_score: int
    new_overall_score: int
    new_ats_score: int
    new_keyword_coverage: int
    matched_keywords: list[str] = []
    missing_keywords: list[str] = []
    diff_summary: str = ""


class RenderResumeIn(BaseModel):
    document: ResumeDocument
    filename: str | None = None


class RenderResumeOut(BaseModel):
    data_base64: str
    name: str
    content_type: str = "application/pdf"
```

- [ ] **Step 4: Add the router**

Create `backend/routers/tailor.py`:

```python
"""
Extension résumé-tailoring endpoints (mounted at /api).

POST /api/tailor-resume — tailor a résumé to a *scraped* job (no job_id),
                          reusing the same services as the web Custom Resume
                          flow. Returns the structured document + before/after
                          scores + the candidate keyword set (from `before`,
                          so the overlay's chips stay stable across regenerates).
POST /api/render-resume — render a structured document to a PDF (base64 JSON).

Used by the Chrome extension on live application pages, where there is no
ScrapedJob row to key off (unlike the web /ai/custom-resume/{job_id} flow).
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
from backend.schemas.tailor import (
    RenderResumeIn, RenderResumeOut, TailorResumeIn, TailorResumeOut,
)
from backend.services.resume_document import db_record_to_document
from backend.services.resume_pdf import render_resume_pdf
from backend.services.resume_tailor import tailor_document

logger = logging.getLogger(__name__)
router = APIRouter()


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or "resume"


@router.post("/tailor-resume", response_model=TailorResumeOut)
async def tailor_resume_endpoint(
    body: TailorResumeIn,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Tailor the caller's résumé to a scraped job description."""
    resume = _resolve_resume(db, user_id, body.resume_id)  # 400 if none on file
    original_document = db_record_to_document(resume)
    try:
        result = await tailor_document(
            db, original_document, body.job_title, body.company,
            body.job_description, body.sections, body.add_keywords,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    return TailorResumeOut(
        document=result.document,
        original_overall_score=result.before.overall_score,
        new_overall_score=result.after.overall_score,
        new_ats_score=result.after.ats_score,
        new_keyword_coverage=result.after.keyword_coverage,
        matched_keywords=result.before.matched_keywords,
        missing_keywords=result.before.missing_keywords,
        diff_summary=result.diff_summary,
    )


@router.post("/render-resume", response_model=RenderResumeOut)
def render_resume_endpoint(
    body: RenderResumeIn,
    user_id: int = Depends(get_verified_user_id),
):
    """Render a structured résumé document to a PDF, returned as base64."""
    pdf = render_resume_pdf(body.document)
    name = body.filename or "resume"
    if not name.lower().endswith(".pdf"):
        name = f"{_slug(name)}.pdf"
    return RenderResumeOut(
        data_base64=base64.b64encode(pdf).decode("ascii"),
        name=name,
    )
```

- [ ] **Step 5: Mount the router**

In `backend/main.py`, add the import alongside the other router imports, then mount it right after the `fill.router` line (`main.py:79`):

```python
app.include_router(tailor.router, prefix="/api", tags=["tailor"])
```

Make sure `tailor` is included in the `from backend.routers import (...)` group (or add `from backend.routers import tailor`).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pytest backend/tests/test_tailor_api.py -v`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full backend suite for regressions**

Run: `pytest backend/tests/test_ai_web_flow.py backend/tests/test_resume_pdf.py backend/tests/test_tailor_api.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/schemas/tailor.py backend/routers/tailor.py backend/main.py backend/tests/test_tailor_api.py
git commit -m "feat(backend): /api/tailor-resume + /api/render-resume endpoints"
```

---

### Task 4: Extension types + API client (`tailorResume.ts`)

**Files:**
- Modify: `chrome-extension/src/shared/types.ts`
- Create: `chrome-extension/src/api/tailorResume.ts`
- Test: `chrome-extension/test/tailorResume.test.ts`

**Interfaces:**
- Produces: `buildTailorRequestBody(resumeId, jobContext, sections?, addKeywords?)`, `mapTailorResponse(raw)`, `tailorResume(resumeId, jobContext, sections?, addKeywords?) -> Promise<TailorResult>`, `renderResume(document, filename?) -> Promise<{dataBase64,name,contentType}>`.
- Produces (types): `ResumeDoc`, `TailorResumeOpts`, `TailorResult`, `TailorResumeResponse`, `RenderResumeResponse`; extends `BackgroundRequest`.

- [ ] **Step 1: Add the shared types**

In `chrome-extension/src/shared/types.ts`, add after the `AiDraft` interface (around line 246):

```typescript
// ---------------------------------------------------------------------------
// Résumé retailoring (backend POST /api/tailor-resume, /api/render-resume)
// ---------------------------------------------------------------------------

/** Opaque structured résumé document (backend ResumeDocument); passed through. */
export type ResumeDoc = Record<string, unknown>;

/** Options for a tailor request, chosen in the overlay. */
export interface TailorResumeOpts {
  resumeId: number | null;
  sections?: string[];
  /** null/undefined -> weave all missing keywords; a list -> exactly that set. */
  addKeywords?: string[] | null;
}

/** Normalized tailor result the overlay renders (camelCase). */
export interface TailorResult {
  document: ResumeDoc;
  originalScore: number;
  newScore: number;
  atsScore: number;
  keywordCoverage: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  diffSummary: string;
}

/** Background reply for TAILOR_RESUME. */
export interface TailorResumeResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  result?: TailorResult;
}

/** Background reply for RENDER_RESUME (mirrors ResumeFileResponse). */
export interface RenderResumeResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  dataBase64?: string;
  name: string;
  contentType: string;
}
```

Then extend the `BackgroundRequest` union (add the two members before the closing `;` at line ~312):

```typescript
  | {
      type: "TAILOR_RESUME";
      resumeId: number | null;
      jobContext: JobContext;
      sections?: string[];
      addKeywords?: string[] | null;
    }
  | { type: "RENDER_RESUME"; document: ResumeDoc; filename?: string };
```

- [ ] **Step 2: Write the failing test**

Create `chrome-extension/test/tailorResume.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildTailorRequestBody, mapTailorResponse } from "../src/api/tailorResume";
import type { JobContext } from "../src/shared/types";

const ctx: JobContext = { jobDescription: "Need AWS", jobTitle: "Engineer", company: "Acme" };

describe("buildTailorRequestBody", () => {
  it("maps opts + context to the snake_case backend payload", () => {
    expect(buildTailorRequestBody(7, ctx, ["Skills"], ["AWS"])).toEqual({
      resume_id: 7, job_description: "Need AWS", job_title: "Engineer",
      company: "Acme", sections: ["Skills"], add_keywords: ["AWS"],
    });
  });

  it("sends null sections/keywords when omitted (server auto-weaves)", () => {
    expect(buildTailorRequestBody(null, ctx)).toEqual({
      resume_id: null, job_description: "Need AWS", job_title: "Engineer",
      company: "Acme", sections: null, add_keywords: null,
    });
  });
});

describe("mapTailorResponse", () => {
  it("maps snake_case server fields to the camelCase TailorResult", () => {
    const doc = { header: { name: "Jane" }, sections: [], theme: {} };
    expect(
      mapTailorResponse({
        document: doc, original_overall_score: 60, new_overall_score: 82,
        new_ats_score: 78, new_keyword_coverage: 90,
        matched_keywords: ["Python"], missing_keywords: ["AWS"], diff_summary: "d",
      })
    ).toEqual({
      document: doc, originalScore: 60, newScore: 82, atsScore: 78,
      keywordCoverage: 90, matchedKeywords: ["Python"], missingKeywords: ["AWS"],
      diffSummary: "d",
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `chrome-extension/`): `npm test -- tailorResume`
Expected: FAIL — cannot find `../src/api/tailorResume`.

- [ ] **Step 4: Implement the client**

Create `chrome-extension/src/api/tailorResume.ts`:

```typescript
/**
 * Calls the backend résumé-tailoring endpoints (POST /api/tailor-resume,
 * POST /api/render-resume) from the service worker. Mirrors api/aiFill.ts:
 * authedRequest handles auth + silent token refresh. The server returns
 * snake_case; mapTailorResponse normalizes to the camelCase TailorResult the
 * UI consumes (a pure function, unit-tested).
 */
import type { JobContext, ResumeDoc, TailorResult } from "../shared/types";
import { authedRequest } from "./client";

interface TailorApiResponse {
  document: ResumeDoc;
  original_overall_score: number;
  new_overall_score: number;
  new_ats_score: number;
  new_keyword_coverage: number;
  matched_keywords: string[];
  missing_keywords: string[];
  diff_summary: string;
}

export function buildTailorRequestBody(
  resumeId: number | null,
  jobContext: JobContext,
  sections?: string[],
  addKeywords?: string[] | null
): {
  resume_id: number | null;
  job_description: string;
  job_title: string;
  company: string;
  sections: string[] | null;
  add_keywords: string[] | null;
} {
  return {
    resume_id: resumeId,
    job_description: jobContext.jobDescription,
    job_title: jobContext.jobTitle,
    company: jobContext.company,
    sections: sections ?? null,
    add_keywords: addKeywords ?? null,
  };
}

export function mapTailorResponse(r: TailorApiResponse): TailorResult {
  return {
    document: r.document,
    originalScore: r.original_overall_score,
    newScore: r.new_overall_score,
    atsScore: r.new_ats_score,
    keywordCoverage: r.new_keyword_coverage,
    matchedKeywords: r.matched_keywords ?? [],
    missingKeywords: r.missing_keywords ?? [],
    diffSummary: r.diff_summary ?? "",
  };
}

export async function tailorResume(
  resumeId: number | null,
  jobContext: JobContext,
  sections?: string[],
  addKeywords?: string[] | null
): Promise<TailorResult> {
  const raw = await authedRequest<TailorApiResponse>("/api/tailor-resume", {
    method: "POST",
    body: JSON.stringify(buildTailorRequestBody(resumeId, jobContext, sections, addKeywords)),
  });
  return mapTailorResponse(raw);
}

export async function renderResume(
  document: ResumeDoc,
  filename?: string
): Promise<{ dataBase64: string; name: string; contentType: string }> {
  const res = await authedRequest<{ data_base64: string; name: string; content_type: string }>(
    "/api/render-resume",
    { method: "POST", body: JSON.stringify({ document, filename: filename ?? null }) }
  );
  return { dataBase64: res.data_base64, name: res.name, contentType: res.content_type };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tailorResume`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/api/tailorResume.ts chrome-extension/test/tailorResume.test.ts
git commit -m "feat(extension): tailorResume API client + shared types"
```

---

### Task 5: Wire service worker + content-script callbacks

**Files:**
- Modify: `chrome-extension/src/background/serviceWorker.ts`
- Modify: `chrome-extension/src/content/fileUpload.ts` (add `downloadBase64File`)
- Modify: `chrome-extension/src/content/contentScript.ts`
- Modify: `chrome-extension/src/content/overlay.ts` (extend the `OverlayCallbacks` interface only)

**Interfaces:**
- Consumes: `tailorResume`, `renderResume` (Task 4); `injectResumeFile`, `base64ToFile` (`fileUpload.ts`); `extractJobContext` (`jobContext.ts`).
- Produces (overlay callbacks): `onTailorResume(opts) -> {ok,needsLogin?,reason?,result?}`, `onAttachTailored(document) -> {ok,reason?}`, `onDownloadTailored(document) -> {ok,reason?}`.

- [ ] **Step 1: Add the two service-worker routes**

In `chrome-extension/src/background/serviceWorker.ts`:

Add to the imports:

```typescript
import { renderResume, tailorResume } from "../api/tailorResume";
```

Add `RenderResumeResponse` and `TailorResumeResponse` to the `import type { … }` block from `../shared/types`, and add them to the `handle()` return-type union (the `Promise<… | AiFillResponse>` union).

Then add these two cases inside the `switch (message.type)` (next to `AI_FILL`):

```typescript
    case "TAILOR_RESUME": {
      try {
        const result = await tailorResume(
          message.resumeId, message.jobContext, message.sections, message.addKeywords
        );
        return { ok: true, result };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return { ok: false, error: err instanceof Error ? err.message : "Tailoring failed" };
      }
    }

    case "RENDER_RESUME": {
      try {
        const { dataBase64, name, contentType } = await renderResume(message.document, message.filename);
        return { ok: true, dataBase64, name, contentType };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, name: "", contentType: "", error: err.message };
        }
        return { ok: false, name: "", contentType: "", error: err instanceof Error ? err.message : "Render failed" };
      }
    }
```

- [ ] **Step 2: Add a base64 download helper**

In `chrome-extension/src/content/fileUpload.ts`, append:

```typescript
/** Trigger a browser download of base64 bytes (the "Download PDF" action). */
export function downloadBase64File(b64: string, name: string, type: string): void {
  const file = base64ToFile(b64, name, type);
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 3: Add the content-script callbacks**

In `chrome-extension/src/content/contentScript.ts`:

Extend the import from `./fileUpload`:

```typescript
import { base64ToFile, downloadBase64File, injectResumeFile } from "./fileUpload";
```

Add to the `import type { … } from "../shared/types"` block: `RenderResumeResponse`, `ResumeDoc`, `TailorResumeOpts`, `TailorResumeResponse`.

Then add these three callbacks inside the `overlayCallbacks` object (after `onUploadResume`):

```typescript
    onTailorResume: async (opts: TailorResumeOpts) => {
      const resp = await sendToBackground<TailorResumeResponse>({
        type: "TAILOR_RESUME",
        resumeId: opts.resumeId,
        jobContext: extractJobContext(),
        sections: opts.sections,
        addKeywords: opts.addKeywords,
      });
      if (!resp?.ok || !resp.result) {
        return {
          ok: false,
          needsLogin: resp?.needsLogin,
          reason: resp?.error ?? "Could not tailor your résumé.",
        };
      }
      return { ok: true, result: resp.result };
    },
    onAttachTailored: async (document: ResumeDoc) => {
      const field = lastFields.find(
        (f) => f.category === "resumeUpload" && f.controlType === "file"
      );
      const control = field ? registry.get(field.id) : undefined;
      if (!control?.el) {
        return { ok: false, reason: "No résumé upload field found on this page." };
      }
      const company = extractJobContext().company;
      const file = await sendToBackground<RenderResumeResponse>({
        type: "RENDER_RESUME",
        document,
        filename: company ? `resume-${company}` : "resume",
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not render your résumé." };
      }
      return injectResumeFile(control.el, base64ToFile(file.dataBase64, file.name, file.contentType));
    },
    onDownloadTailored: async (document: ResumeDoc) => {
      const company = extractJobContext().company;
      const file = await sendToBackground<RenderResumeResponse>({
        type: "RENDER_RESUME",
        document,
        filename: company ? `resume-${company}` : "resume",
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not render your résumé." };
      }
      downloadBase64File(file.dataBase64, file.name, file.contentType);
      return { ok: true };
    },
```

- [ ] **Step 4: Extend the `OverlayCallbacks` interface**

In `chrome-extension/src/content/overlay.ts`, add to the `import type { … }` block: `ResumeDoc`, `TailorResult`, `TailorResumeOpts`. Then add these members to the `OverlayCallbacks` interface (after `onUploadResume`):

```typescript
  /** Tailor the active résumé to this page's job; returns scores + keywords. */
  onTailorResume: (
    opts: TailorResumeOpts
  ) => Promise<{ ok: boolean; needsLogin?: boolean; reason?: string; result?: TailorResult }>;
  /** Render the tailored document to PDF and attach it to the upload field. */
  onAttachTailored: (document: ResumeDoc) => Promise<{ ok: boolean; reason?: string }>;
  /** Render the tailored document to PDF and download it. */
  onDownloadTailored: (document: ResumeDoc) => Promise<{ ok: boolean; reason?: string }>;
```

- [ ] **Step 5: Typecheck**

Run (from `chrome-extension/`): `npm run typecheck`
Expected: PASS — no type errors. (The overlay still compiles: it does not yet *call* the new callbacks; Task 6 adds the UI that uses them.)

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/background/serviceWorker.ts chrome-extension/src/content/fileUpload.ts chrome-extension/src/content/contentScript.ts chrome-extension/src/content/overlay.ts
git commit -m "feat(extension): wire TAILOR_RESUME/RENDER_RESUME through SW + content script"
```

---

### Task 6: Overlay result-card UI

Activate the "Generate Custom Resume" block: a one-click tailor button, then a result card with score jump, toggleable keyword chips, Regenerate, Attach to form, and Download PDF.

**Files:**
- Create: `chrome-extension/src/content/tailorCard.ts` (pure, testable HTML builder)
- Test: `chrome-extension/test/tailorCard.test.ts`
- Modify: `chrome-extension/src/content/overlay.ts` (section HTML, styles, refs, state, wiring)

**Interfaces:**
- Consumes: `OverlayCallbacks.onTailorResume/onAttachTailored/onDownloadTailored` (Task 5); `TailorResult` (Task 4).
- Produces: `scoreJumpText(before, after)`, `buildTailorCardHtml(result, selected)`.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/tailorCard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreJumpText, buildTailorCardHtml } from "../src/content/tailorCard";
import type { TailorResult } from "../src/shared/types";

const result: TailorResult = {
  document: {}, originalScore: 72, newScore: 85, atsScore: 88,
  keywordCoverage: 92, matchedKeywords: ["react"], missingKeywords: ["aws", "docker"],
  diffSummary: "",
};

describe("scoreJumpText", () => {
  it("shows a jump when the score improves", () => {
    expect(scoreJumpText(72, 85)).toBe("Match 7.2 → 8.5");
  });
  it("shows 'held' when unchanged", () => {
    expect(scoreJumpText(80, 80)).toBe("Match held at 8.0");
  });
});

describe("buildTailorCardHtml", () => {
  it("renders score, stats, keyword chips and action buttons", () => {
    const html = buildTailorCardHtml(result, new Set(["aws"]));
    expect(html).toContain("Match 7.2 → 8.5");
    expect(html).toContain("ATS 88 · 92% coverage");
    expect(html).toContain('data-kw="aws"');
    expect(html).toContain('data-kw="docker"');
    expect(html).toContain("ap-kw on"); // aws is selected
    expect(html).toContain('id="ap-tailor-attach"');
    expect(html).toContain('id="ap-tailor-regen"');
    expect(html).toContain('id="ap-tailor-download"');
  });
  it("omits the keyword row when there are no missing keywords", () => {
    const html = buildTailorCardHtml({ ...result, missingKeywords: [] }, new Set());
    expect(html).not.toContain("ap-kw-row");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tailorCard`
Expected: FAIL — cannot find `../src/content/tailorCard`.

- [ ] **Step 3: Implement the card builder**

Create `chrome-extension/src/content/tailorCard.ts`:

```typescript
/**
 * Pure builders for the overlay's "Generate Custom Resume" result card.
 * Kept DOM-free so the markup is unit-testable; overlay.ts injects the returned
 * HTML and wires the buttons.
 */
import type { TailorResult } from "../shared/types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "Match 7.2 → 8.5" / "Match held at 8.0" from 0-100 scores. */
export function scoreJumpText(before: number, after: number): string {
  const b = (before / 10).toFixed(1);
  const a = (after / 10).toFixed(1);
  if (after > before) return `Match ${b} → ${a}`;
  if (after === before) return `Match held at ${a}`;
  return `Match ${a}`;
}

/** Inner HTML for the result card. `selected` = keyword chips currently on. */
export function buildTailorCardHtml(result: TailorResult, selected: Set<string>): string {
  const jump = scoreJumpText(result.originalScore, result.newScore);
  const stats = `ATS ${result.atsScore} · ${result.keywordCoverage}% coverage`;
  const chips = result.missingKeywords
    .map(
      (k) =>
        `<button class="ap-kw ${selected.has(k) ? "on" : ""}" data-kw="${esc(k)}" type="button">${esc(k)}</button>`
    )
    .join("");
  const kwBlock = result.missingKeywords.length
    ? `<div class="ap-kw-label">Keywords to weave in</div><div class="ap-kw-row">${chips}</div>`
    : "";
  return (
    `<div class="ap-tailor-scores"><span class="ap-tailor-jump">${esc(jump)}</span>` +
    `<span class="ap-tailor-stats">${esc(stats)}</span></div>` +
    kwBlock +
    `<div class="ap-tailor-actions">` +
    `<button class="ap-btn-soft" id="ap-tailor-regen" type="button">Regenerate</button>` +
    `<button class="ap-btn-upload" id="ap-tailor-attach" type="button">Attach to form</button>` +
    `<button class="ap-btn-soft" id="ap-tailor-download" type="button">Download PDF</button>` +
    `</div>` +
    `<div class="ap-upload-status" id="ap-tailor-status"></div>`
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tailorCard`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the section markup, styles, and refs in overlay.ts**

In `chrome-extension/src/content/overlay.ts`:

(a) Import the builders and the type — add near the top imports:

```typescript
import { buildTailorCardHtml } from "./tailorCard";
```

(b) Append these styles to the `STYLES` template string (before the closing backtick):

```css
.ap-btn-soft { padding: 9px 12px; border: 1px solid #e7e4ff; border-radius: 8px;
  background: #f9f8ff; color: #7c6cff; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.ap-btn-soft:hover:not(:disabled) { background: #f0edff; }
.ap-btn-soft:disabled { opacity: 0.5; cursor: default; }
.ap-btn-tailor { width: 100%; padding: 11px; border: none; border-radius: 9px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%); color: #fff;
  font-size: 13.5px; font-weight: 700; cursor: pointer; display: flex;
  align-items: center; justify-content: center; gap: 7px; }
.ap-btn-tailor:disabled { opacity: 0.5; cursor: default; }
.ap-tailor-scores { display: flex; justify-content: space-between; align-items: baseline;
  margin-top: 10px; }
.ap-tailor-jump { font-weight: 700; font-size: 14px; color: #1a1a2e; }
.ap-tailor-stats { font-size: 11.5px; color: #888; }
.ap-kw-label { font-size: 11.5px; color: #666; margin: 10px 0 5px; }
.ap-kw-row { display: flex; flex-wrap: wrap; gap: 6px; }
.ap-kw { font-size: 11.5px; padding: 4px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid #ddd; background: #fff; color: #555; }
.ap-kw.on { background: #7c6cff; border-color: #7c6cff; color: #fff; }
.ap-tailor-actions { display: flex; gap: 8px; margin-top: 12px; }
.ap-tailor-actions .ap-btn-upload { width: auto; flex: 1; }
```

(c) In `buildHTML()`, add a new section immediately after the "Upload Resume" section (`</div>` that closes `#ap-section-resume`'s `.ap-section`) and before the "Upload Cover Letter" section:

```html
        <!-- Generate Custom Resume -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-tailor">
            <div class="ap-section-left">
              <span class="ap-section-icon">${icon('<polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/>', 18)}</span>
              <span class="ap-section-title">Generate Custom Resume</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_DOWN}</span>
          </div>
          <div class="ap-section-sub" id="ap-tailor-sub" style="display:none">
            <button class="ap-btn-tailor" id="ap-btn-tailor" type="button">
              ${icon('<polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/>', 14)}
              Tailor my résumé for this job
            </button>
            <div id="ap-tailor-result"></div>
          </div>
        </div>
```

(d) Add two refs to the `Refs` interface and to `collectRefs()`:

Interface (after `uploadStatus`):

```typescript
  btnTailor: HTMLButtonElement;
  tailorResult: HTMLDivElement;
```

`collectRefs` return (after `uploadStatus`):

```typescript
    btnTailor: q("#ap-btn-tailor"),
    tailorResult: q("#ap-tailor-result"),
```

- [ ] **Step 6: Add state, wiring, and handlers in overlay.ts**

(a) Add to the `PanelState` interface and `overlayState` initializer:

Interface (after `infoCategory: string;`):

```typescript
  tailorResult: TailorResult | null;
  tailorKeywords: Set<string>;
  tailorBusy: boolean;
```

Initializer (after `infoCategory: "personal",`):

```typescript
  tailorResult: null,
  tailorKeywords: new Set(),
  tailorBusy: false,
```

Also add `TailorResult` to the `import type { … }` block.

(b) In `wireEvents()`, add (next to the resume section toggle):

```typescript
  // Generate Custom Resume section toggle
  root.querySelector("#ap-section-tailor")!.addEventListener("click", () => {
    const sub = root.querySelector<HTMLElement>("#ap-tailor-sub")!;
    sub.style.display = sub.style.display === "none" ? "block" : "none";
  });

  // Tailor button
  root.querySelector("#ap-btn-tailor")!.addEventListener("click", () => void doTailor());
```

(c) Add these functions at the end of the file (before the final closing of the module):

```typescript
// ---------------------------------------------------------------------------
// Generate Custom Resume (tailor on the spot + attach)
// ---------------------------------------------------------------------------

function selectedResumeId(): number | null {
  const { resumes } = overlayState;
  if (resumes.length === 0) return null;
  if (refs && refs.resumeSelect.style.display !== "none" && refs.resumeSelect.value) {
    return Number(refs.resumeSelect.value);
  }
  const primary = resumes.find((r) => r.isPrimary) ?? resumes[0];
  return primary.id;
}

async function doTailor(addKeywords?: string[] | null): Promise<void> {
  if (!refs || !callbacks || overlayState.tailorBusy) return;
  if (!overlayState.profile) {
    setTailorStatus("Connect your Tailrd account to tailor your résumé.", "warn");
    return;
  }
  overlayState.tailorBusy = true;
  refs.btnTailor.disabled = true;
  refs.btnTailor.textContent = "Tailoring…";
  try {
    const res = await callbacks.onTailorResume({
      resumeId: selectedResumeId(),
      // First pass: undefined -> server auto-weaves all missing keywords.
      addKeywords: addKeywords,
    });
    if (!res.ok || !res.result) {
      setTailorStatus(res.reason ?? "Couldn't tailor your résumé.", "error");
      return;
    }
    overlayState.tailorResult = res.result;
    // Pre-check the keywords that were actually woven in.
    overlayState.tailorKeywords = new Set(
      addKeywords ?? res.result.missingKeywords
    );
    renderTailorResult();
  } catch (err) {
    setTailorStatus(err instanceof Error ? err.message : "Tailoring failed.", "error");
  } finally {
    overlayState.tailorBusy = false;
    if (refs) {
      refs.btnTailor.disabled = false;
      refs.btnTailor.textContent = "Re-tailor for this job";
    }
  }
}

function renderTailorResult(): void {
  if (!refs || !overlayState.tailorResult) return;
  refs.tailorResult.innerHTML = buildTailorCardHtml(
    overlayState.tailorResult,
    overlayState.tailorKeywords
  );

  refs.tailorResult.querySelectorAll<HTMLButtonElement>(".ap-kw").forEach((chip) => {
    chip.addEventListener("click", () => {
      const kw = chip.dataset.kw ?? "";
      if (overlayState.tailorKeywords.has(kw)) overlayState.tailorKeywords.delete(kw);
      else overlayState.tailorKeywords.add(kw);
      chip.classList.toggle("on");
    });
  });

  refs.tailorResult
    .querySelector("#ap-tailor-regen")
    ?.addEventListener("click", () => void doTailor([...overlayState.tailorKeywords]));
  refs.tailorResult
    .querySelector("#ap-tailor-attach")
    ?.addEventListener("click", () => void attachTailored());
  refs.tailorResult
    .querySelector("#ap-tailor-download")
    ?.addEventListener("click", () => void downloadTailored());

  // "Attach to form" only works when the page actually has a résumé field.
  const attachBtn = refs.tailorResult.querySelector<HTMLButtonElement>("#ap-tailor-attach");
  if (attachBtn && !hasResumeField()) {
    attachBtn.disabled = true;
    attachBtn.title = "No résumé upload field on this page — use Download instead.";
  }
}

async function attachTailored(): Promise<void> {
  if (!refs || !callbacks || !overlayState.tailorResult) return;
  setTailorStatus("Attaching…", "");
  const res = await callbacks.onAttachTailored(overlayState.tailorResult.document);
  setTailorStatus(
    res.ok ? "Résumé attached. Review before submitting." : res.reason ?? "Could not attach.",
    res.ok ? "ok" : "error"
  );
}

async function downloadTailored(): Promise<void> {
  if (!refs || !callbacks || !overlayState.tailorResult) return;
  setTailorStatus("Preparing download…", "");
  const res = await callbacks.onDownloadTailored(overlayState.tailorResult.document);
  setTailorStatus(res.ok ? "Downloaded." : res.reason ?? "Could not download.", res.ok ? "ok" : "error");
}

function setTailorStatus(text: string, kind: "ok" | "warn" | "error" | ""): void {
  const el = refs?.tailorResult.querySelector<HTMLDivElement>("#ap-tailor-status");
  if (el) {
    el.textContent = text;
    el.className = "ap-upload-status" + (kind ? ` ${kind}` : "");
  } else if (refs) {
    // No card yet (e.g. not signed in) — fall back to the résumé status line.
    setUploadStatus(text, kind);
  }
}
```

- [ ] **Step 7: Typecheck + run the extension test suite**

Run (from `chrome-extension/`): `npm run typecheck && npm test`
Expected: typecheck clean; all vitest suites PASS (including the new `tailorCard` + `tailorResume` tests).

- [ ] **Step 8: Commit**

```bash
git add chrome-extension/src/content/tailorCard.ts chrome-extension/test/tailorCard.test.ts chrome-extension/src/content/overlay.ts
git commit -m "feat(extension): Generate Custom Resume result card in the overlay"
```

---

### Task 7: Build + manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Production build**

Run (from `chrome-extension/`): `npm run build`
Expected: `Build complete → dist/` with no esbuild errors.

- [ ] **Step 2: Backend up + full suites green**

Run: `pytest backend/tests/test_resume_pdf.py backend/tests/test_tailor_api.py backend/tests/test_ai_web_flow.py -v`
Expected: PASS.

- [ ] **Step 3: Load + drive the extension**

1. `chrome://extensions` → Load unpacked → `chrome-extension/dist`.
2. Open a real application page with a résumé upload (e.g. a Greenhouse/Workday posting). The Tailrd side panel mounts.
3. Open **Generate Custom Resume → Tailor my résumé for this job**. Confirm the result card shows a score jump + ATS/coverage + keyword chips.
4. Toggle a chip, click **Regenerate** — the card updates (no PDF render yet).
5. Click **Attach to form** — the rendered PDF appears in the page's upload widget; the form is **not** submitted.
6. Click **Download PDF** — a `resume-<company>.pdf` downloads and opens as a valid PDF.
7. On a page with **no** résumé field, confirm **Attach to form** is disabled and **Download PDF** still works.

- [ ] **Step 4: Final commit (if any build artifacts/notes changed)**

```bash
git add -A
git commit -m "chore(extension): build + verify résumé retailor end-to-end" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- PDF renderer (reportlab, structure-driven, theme-mapped) → Task 1. ✓
- `/api/tailor-resume` reusing existing services, scraped-JD, auto-weave semantics, stable `missing_keywords` from `before` → Tasks 2 + 3. ✓
- `/api/render-resume` base64 JSON, slugged `.pdf` filename → Task 3. ✓
- Shared helper so web + extension can't drift → Task 2 (with regression gate). ✓
- Extension API client + types, snake→camel mapping → Task 4. ✓
- Service-worker routes + content-script callbacks + attach/download via `injectResumeFile`/`downloadBase64File`, never-submit → Task 5. ✓
- One-click + keyword-tweak result card (score jump, chips, regenerate, attach, download), résumé-field gating → Task 6. ✓
- Error/edge handling: 400 no résumé (Task 3 test), auth `needsLogin` (Task 5), no résumé field disables Attach (Task 6), thin JD still tailors (best-effort, inherent). ✓
- Testing: backend renderer + endpoints; extension client + card builder; manual E2E → Tasks 1,3,4,6,7. ✓
- Scope/non-goals (no persistence, PDF only, web print path untouched) → respected; no task adds them. ✓

**Placeholder scan:** No TBD/TODO; every code/test step has complete content. ✓

**Type consistency:** `TailorResult` (camelCase) defined in Task 4, consumed unchanged in Tasks 5/6; `ResumeDoc` opaque passthrough used in messages + callbacks; server `TailorResumeOut`/`RenderResumeOut` (snake_case) mapped in `tailorResume.ts`; `tailor_document` signature/return identical across Tasks 2/3; overlay refs `btnTailor`/`tailorResult` defined and used consistently. ✓
