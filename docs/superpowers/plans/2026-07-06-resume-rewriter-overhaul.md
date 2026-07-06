# AI Resume Rewriter Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the keyword-injection rewriter with a structure-aware pipeline that reorders sections, adds a summary, rewrites bullets for impact, surfaces honest gaps, flags fabricated numbers, and shows dual "what changed" / keyword-match highlighting — across the shared web + extension surfaces.

**Architecture:** One enriched structured LLM call returns `{resume, section_order, new_summary, gaps}`. `merge_rewrite` v2 applies reorder + optional summary while keeping factual fields ID-locked. `tailor_document` computes a deterministic change list and a rule-based fabricated-number list, threading `changes`/`gaps`/`figures_to_verify` through both `/ai/*` and `/api/*` into the shared `CustomResumeModal`.

**Tech Stack:** FastAPI + Pydantic (backend, pytest), React + TypeScript (frontend, vitest), OpenAI Chat Completions.

## Global Constraints

- Factual fields stay locked: only `text`/`skills`/`groups`/`bullets` come from the LLM; header/titles/employers/dates/links/ids from the original (via `merge_rewrite`).
- Fabricated numbers are **flagged (`figures_to_verify`), never stripped**.
- `changes` is derived deterministically from original↔final document diff — never self-reported by the LLM.
- Highlight decorations render as `<mark>` so `printResume`'s strip rule removes them from PDF exports; DOCX is schema-built and clean.
- Request/response shapes stay identical for web (`/ai/custom-resume`) and extension (`/api/custom-resume`, `/api/tailor-resume`); new response fields default to `[]`.
- Backend schema shapes (verbatim): `Section(id,type,title,text,items,skills,groups)`, `SectionItem(id,title,subtitle,location,start_date,end_date,detail,link,bullets)`, `ResumeDocument(header,sections,theme)`. Ids auto-generate via `uuid4().hex[:8]`.
- Leave the legacy summary path (`/ai/tailor-resume/{job_id}`, `prompts/tailor_resume.txt`, `tailor_resume_guided`) untouched.

---

### Task 1: Rule-based fabricated-number check

**Files:**
- Create: `backend/services/fabrication_check.py`
- Test: `backend/tests/test_fabrication_check.py`

**Interfaces:**
- Produces: `find_unsupported_figures(source_text: str, rewritten_texts: list[str]) -> list[str]` — de-duped, order-preserving list of figure tokens whose numeric value is absent from `source_text`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fabrication_check.py
from backend.services.fabrication_check import find_unsupported_figures


def test_flags_number_absent_from_source():
    assert find_unsupported_figures("Cut latency for the team.", ["Cut latency by 40%."]) == ["40%"]


def test_allows_number_present_in_source():
    src = "Improved performance by 40% across 3 teams."
    assert find_unsupported_figures(src, ["Boosted performance 40% for 3 teams."]) == []


def test_allows_dates_and_ids_present_in_source():
    assert find_unsupported_figures("Founded in 2020.", ["Since 2020, led the platform."]) == []


def test_flags_dollar_amount_and_dedupes():
    out = find_unsupported_figures("Grew the business.", ["Added $2M ARR.", "Reached $2M."])
    assert out == ["$2M"]


def test_ignores_text_with_no_numbers():
    assert find_unsupported_figures("anything", ["Led cross-functional teams."]) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fabrication_check.py -v`
Expected: FAIL (ModuleNotFoundError: fabrication_check)

- [ ] **Step 3: Write the implementation**

```python
# backend/services/fabrication_check.py
"""Rule-based fabricated-number guardrail.

merge_rewrite already makes fabricated employers/dates/titles structurally
impossible, but bullets are reworded freely — the one place an invented metric
can slip in. This flags (never strips) any number in the rewritten text whose
numeric value is not present anywhere in the source resume, so the UI can ask
the user to verify it.
"""
import re

# A number, optionally $-prefixed, optionally followed by a unit/magnitude.
_FIGURE_RE = re.compile(
    r"\$?\d[\d,]*(?:\.\d+)?\s?(?:%|x|k|m|bn?|\+|years?|yrs?|months?|weeks?|days?|hours?|hrs?)?",
    re.IGNORECASE,
)


def _numeric_core(token: str) -> str:
    """The comparable numeric value of a token: '40%'->'40', '$2M'->'2', '1,200'->'1200'."""
    return re.sub(r"[^\d.]", "", token.replace(",", "")).strip(".")


def find_unsupported_figures(source_text: str, rewritten_texts: list[str]) -> list[str]:
    """Figure tokens in ``rewritten_texts`` whose numeric value is absent from source."""
    source_values = {
        _numeric_core(m) for m in _FIGURE_RE.findall(source_text) if _numeric_core(m)
    }
    out: list[str] = []
    seen: set[str] = set()
    for text in rewritten_texts:
        for match in _FIGURE_RE.findall(text or ""):
            token = match.strip()
            core = _numeric_core(token)
            if not core or core in source_values:
                continue
            if token.lower() in seen:
                continue
            seen.add(token.lower())
            out.append(token)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fabrication_check.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/services/fabrication_check.py backend/tests/test_fabrication_check.py
git commit -m "feat(rewrite): rule-based fabricated-number guardrail"
```

---

### Task 2: `merge_rewrite` v2 — reorder + add summary

**Files:**
- Modify: `backend/services/resume_document.py:139` (`merge_rewrite`)
- Test: `backend/tests/test_resume_document_merge.py` (create)

**Interfaces:**
- Produces: `merge_rewrite(original, edited, section_order: list[str] | None = None, new_summary: dict | None = None) -> ResumeDocument`. `section_order` = ordered original section ids (unknown ids ignored, omitted ids appended in original order — a section can never be dropped). `new_summary` = `{"title": str, "text": str}`; prepended as a `summary` section only when the original has no `summary`/`custom` section.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_resume_document_merge.py
from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.resume_document import merge_rewrite


def _doc():
    return ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Did things"])]),
        Section(id="prj", type="projects", title="PROJECTS",
                items=[SectionItem(id="p1", title="Proj", bullets=["Built it"])]),
    ])


def test_reorders_by_section_order_without_dropping():
    edited = _doc()
    out = merge_rewrite(_doc(), edited, section_order=["prj", "exp"])
    assert [s.id for s in out.sections] == ["prj", "exp"]


def test_missing_ids_are_appended_not_lost():
    out = merge_rewrite(_doc(), _doc(), section_order=["prj"])  # exp omitted
    assert [s.id for s in out.sections] == ["prj", "exp"]


def test_adds_summary_when_none_exists():
    out = merge_rewrite(_doc(), _doc(), new_summary={"title": "PROFESSIONAL SUMMARY", "text": "Sharp engineer."})
    assert out.sections[0].type == "summary"
    assert out.sections[0].text == "Sharp engineer."


def test_does_not_add_summary_when_one_exists():
    orig = ResumeDocument(sections=[Section(id="sum", type="summary", title="SUMMARY", text="Old")])
    out = merge_rewrite(orig, orig, new_summary={"title": "X", "text": "New"})
    assert len([s for s in out.sections if s.type == "summary"]) == 1


def test_factual_fields_stay_locked():
    edited = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="HACKED",
                items=[SectionItem(id="i1", title="CEO", subtitle="FakeCo", bullets=["Reworded bullet"])]),
        Section(id="prj", type="projects", title="PROJECTS", items=[SectionItem(id="p1", title="Proj")]),
    ])
    out = merge_rewrite(_doc(), edited)
    exp = out.sections[0]
    assert exp.title == "WORK EXPERIENCE"           # section title locked
    assert exp.items[0].title == "Engineer"         # item title locked
    assert exp.items[0].subtitle == "Acme"          # employer locked
    assert exp.items[0].bullets == ["Reworded bullet"]  # bullets ARE taken from edited
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_resume_document_merge.py -v`
Expected: FAIL (merge_rewrite() got unexpected keyword 'section_order')

- [ ] **Step 3: Edit `merge_rewrite`**

Keep the existing per-section content merge (lines 149-178). Change the signature and replace the final return block. New signature + tail:

```python
def merge_rewrite(
    original: ResumeDocument,
    edited: ResumeDocument,
    section_order: list[str] | None = None,
    new_summary: dict | None = None,
) -> ResumeDocument:
    # ... existing merge loop unchanged, building `merged_sections` ...

    # Reorder (never drop): listed ids first in given order, remainder in original order.
    if section_order:
        by_id = {s.id: s for s in merged_sections}
        ordered = [by_id[sid] for sid in section_order if sid in by_id]
        ordered += [s for s in merged_sections if s.id not in set(section_order)]
        merged_sections = ordered

    # Add a summary only when the original truly has none.
    has_summary = any(s.type in ("summary", "custom") for s in original.sections)
    if new_summary and not has_summary:
        text = str(new_summary.get("text", "")).strip()
        if text:
            merged_sections = [
                Section(
                    type="summary",
                    title=str(new_summary.get("title") or "PROFESSIONAL SUMMARY"),
                    text=text,
                )
            ] + merged_sections

    return ResumeDocument(
        header=original.header.model_copy(deep=True),
        sections=merged_sections,
        theme=original.theme.model_copy(deep=True),
    )
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_resume_document_merge.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/services/resume_document.py backend/tests/test_resume_document_merge.py
git commit -m "feat(rewrite): merge_rewrite reorders sections and adds a summary"
```

---

### Task 3: Deterministic change summary

**Files:**
- Modify: `backend/services/resume_document.py` (add `describe_changes`)
- Test: `backend/tests/test_resume_document_merge.py` (append)

**Interfaces:**
- Produces: `describe_changes(original: ResumeDocument, final: ResumeDocument) -> list[str]` — human-readable change lines (reordered, summary added, N bullets rewritten, skills added), matched by section/item id.

- [ ] **Step 1: Write the failing test (append to test file)**

```python
from backend.services.resume_document import describe_changes


def test_describe_changes_reports_reorder_and_summary_and_bullets():
    orig = _doc()
    final = merge_rewrite(
        _doc(),
        ResumeDocument(sections=[
            Section(id="exp", type="experience", title="WORK EXPERIENCE",
                    items=[SectionItem(id="i1", title="Engineer", subtitle="Acme",
                                       bullets=["Led migration cutting build time"])]),
            Section(id="prj", type="projects", title="PROJECTS",
                    items=[SectionItem(id="p1", title="Proj", bullets=["Built it"])]),
        ]),
        section_order=["prj", "exp"],
        new_summary={"title": "PROFESSIONAL SUMMARY", "text": "Sharp engineer."},
    )
    changes = describe_changes(orig, final)
    joined = " ".join(changes).lower()
    assert any("reorder" in c.lower() for c in changes)
    assert "summary" in joined
    assert any("bullet" in c.lower() for c in changes)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_resume_document_merge.py::test_describe_changes_reports_reorder_and_summary_and_bullets -v`
Expected: FAIL (cannot import describe_changes)

- [ ] **Step 3: Implement `describe_changes`**

```python
def describe_changes(original: ResumeDocument, final: ResumeDocument) -> list[str]:
    """Human-readable, deterministic 'what changed' list (ids are stable across merge)."""
    changes: list[str] = []
    orig_ids = [s.id for s in original.sections]
    orig_id_set = set(orig_ids)

    # Reordering (compare the relative order of the sections that existed before).
    kept = [s.id for s in final.sections if s.id in orig_id_set]
    if kept != [i for i in orig_ids if i in set(kept)]:
        changes.append("Reordered sections to lead with the most relevant experience")

    # New sections (e.g. an added summary).
    for s in final.sections:
        if s.id not in orig_id_set and (s.text.strip() or s.items or s.skills):
            changes.append(f"Added a {(s.title or s.type).title()} section")

    # Reworded bullets (match items by id).
    orig_bullets = {
        it.id: [b.strip() for b in it.bullets]
        for sec in original.sections for it in sec.items
    }
    reworded = 0
    for sec in final.sections:
        for it in sec.items:
            before = orig_bullets.get(it.id)
            if before is not None and [b.strip() for b in it.bullets] != before:
                reworded += 1
    if reworded:
        changes.append(f"Rewrote {reworded} entr{'y' if reworded == 1 else 'ies'} for stronger impact")

    # Skills added.
    orig_skills = {s.strip().lower() for sec in original.sections for s in sec.skills}
    added = [
        s for sec in final.sections for s in sec.skills
        if s.strip().lower() not in orig_skills
    ]
    if added:
        preview = ", ".join(added[:4])
        changes.append(f"Added {len(added)} skill{'s' if len(added) > 1 else ''}: {preview}{'…' if len(added) > 4 else ''}")

    return changes
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_resume_document_merge.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/services/resume_document.py backend/tests/test_resume_document_merge.py
git commit -m "feat(rewrite): deterministic change-summary from document diff"
```

---

### Task 4: New structured prompt + wrapped output contract

**Files:**
- Modify: `backend/services/openai_service.py:240-295` (`tailor_resume_structured`)
- Test: `backend/tests/test_tailor_structured.py` (create)

**Interfaces:**
- Consumes: `merge_rewrite(..., section_order, new_summary)` (Task 2).
- Produces: `@dataclass TailorStructuredResult: document: ResumeDocument; gaps: list[str]` and `async tailor_resume_structured(document, job_description, sections=None, keywords=None) -> TailorStructuredResult`. Accepts either the wrapped object `{resume, section_order, new_summary, gaps}` or a bare resume doc (back-compat). Falls back to `(original, [])` on parse failure.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_tailor_structured.py
import json
import pytest
from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.openai_service import OpenAIService, TailorStructuredResult


def _doc():
    return ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Responsible for APIs"])]),
        Section(id="prj", type="projects", title="PROJECTS",
                items=[SectionItem(id="p1", title="Proj", bullets=["Built a thing"])]),
    ])


@pytest.mark.asyncio
async def test_parses_wrapped_contract_and_reorders(monkeypatch):
    svc = OpenAIService.__new__(OpenAIService)  # skip __init__ (no API key needed)
    payload = {
        "resume": {"header": {}, "sections": [
            {"id": "exp", "type": "experience", "title": "WORK EXPERIENCE",
             "items": [{"id": "i1", "title": "Engineer", "subtitle": "Acme", "bullets": ["Built and scaled REST APIs"]}]},
            {"id": "prj", "type": "projects", "title": "PROJECTS",
             "items": [{"id": "p1", "title": "Proj", "bullets": ["Built a thing"]}]},
        ]},
        "section_order": ["prj", "exp"],
        "new_summary": {"title": "PROFESSIONAL SUMMARY", "text": "Backend engineer."},
        "gaps": ["Role wants Kubernetes; not found in your experience"],
    }

    async def fake_generate(prompt, system=None):
        return json.dumps(payload)
    monkeypatch.setattr(svc, "_generate", fake_generate)

    out = await svc.tailor_resume_structured(_doc(), "Kubernetes backend role")
    assert isinstance(out, TailorStructuredResult)
    assert [s.type for s in out.document.sections][0] == "summary"      # summary prepended
    assert [s.id for s in out.document.sections if s.id][:2] == ["prj", "exp"]  # reordered
    assert out.document.sections[-1].items[0].bullets == ["Built a thing"]
    assert out.gaps == ["Role wants Kubernetes; not found in your experience"]


@pytest.mark.asyncio
async def test_parse_failure_falls_back_to_original(monkeypatch):
    svc = OpenAIService.__new__(OpenAIService)

    async def fake_generate(prompt, system=None):
        return "not json"
    monkeypatch.setattr(svc, "_generate", fake_generate)

    doc = _doc()
    out = await svc.tailor_resume_structured(doc, "jd")
    assert out.document == doc and out.gaps == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_tailor_structured.py -v`
Expected: FAIL (cannot import TailorStructuredResult)

- [ ] **Step 3: Rewrite `tailor_resume_structured`**

Add `from dataclasses import dataclass` at the top of the module if absent. Add the result type near the class, and replace the method:

```python
@dataclass
class TailorStructuredResult:
    document: ResumeDocument
    gaps: list[str]
```

```python
    async def tailor_resume_structured(
        self,
        document: ResumeDocument,
        job_description: str,
        sections: list[str] | None = None,
        keywords: list[str] | None = None,
    ) -> "TailorStructuredResult":
        """Structure-aware rewrite. Returns the merged document + honest gaps."""
        from backend.services.resume_document import merge_rewrite

        emphasis = ""
        if sections:
            emphasis += f"\n- Put extra effort into these sections: {', '.join(sections)}."
        if keywords:
            emphasis += (
                f"\n- Secondary: where the candidate's REAL experience already supports them, "
                f"you may surface these job terms: {', '.join(keywords)}. If a term is not "
                f"genuinely supported, DO NOT insert it — list it under \"gaps\" instead."
            )

        doc_json = document.model_dump_json()
        prompt = (
            "You are an expert resume writer and career coach. Rewrite the candidate's "
            "resume (given as JSON) to genuinely fit the target job — a real rewrite, not "
            "a keyword patch. Then return ONE JSON object with this exact shape:\n"
            '{\n'
            '  "resume":        <the same resume JSON, with rewritten content>,\n'
            '  "section_order": [<section ids in the best order for this job>],\n'
            '  "new_summary":   {"title": "PROFESSIONAL SUMMARY", "text": "..."} or null,\n'
            '  "gaps":          [<job priorities the candidate genuinely cannot support>]\n'
            "}\n\n"
            "STEP 1 — STRUCTURE: choose the section order that presents this candidate best "
            "for this job (e.g. lead with Projects when experience is thin). Only include ids "
            "that already exist. If the resume has no summary/profile section and one would "
            "help, write a concise `new_summary` from the candidate's real experience; "
            "otherwise set it to null.\n"
            "STEP 2 — CONTENT: rewrite bullets to lead with strong action verbs and outcomes, "
            "not duties ('Responsible for…'). Keep real quantified results; NEVER introduce a "
            "number, percentage, or metric that is not already in the source. Cut filler; fix "
            "tense/consistency.\n"
            "STEP 3 — ALIGNMENT: match the job's real priorities, seniority, and domain "
            "language — not just its keyword list.\n"
            "STEP 4 — HONESTY: never invent employers, titles, dates, degrees, or skills. "
            "Anything the job needs that the candidate cannot truthfully show goes in `gaps`, "
            "never into the resume.\n\n"
            "JSON RULES for `resume`: same keys, ids, types, and array lengths as the input. "
            "Keep every section `id`/`type`/`title` and every item `id`/`title`/`subtitle`/"
            "`location`/`start_date`/`end_date`/`detail`/`link` UNCHANGED. You may only "
            "reword each section's `text`, the `skills` array, `groups` values, and each "
            "item's `bullets`."
            f"{emphasis}\n\n"
            f"Target job description:\n{job_description[:3500]}\n\n"
            f"Resume JSON:\n{doc_json}\n\n"
            "Return ONLY the JSON object."
        )

        try:
            response = await self._generate(prompt)
            data = json.loads(_extract_json(response))
        except Exception as e:  # noqa: BLE001
            logger.warning("Structured tailor failed to parse (%s); returning original", e)
            return TailorStructuredResult(document=document, gaps=[])

        resume_data = data.get("resume", data) if isinstance(data, dict) else data
        section_order = data.get("section_order") if isinstance(data, dict) else None
        new_summary = data.get("new_summary") if isinstance(data, dict) else None
        gaps_raw = data.get("gaps", []) if isinstance(data, dict) else []
        gaps = [str(g).strip() for g in gaps_raw if str(g).strip()] if isinstance(gaps_raw, list) else []

        try:
            edited = ResumeDocument(**resume_data)
        except Exception as e:  # noqa: BLE001
            logger.warning("Structured tailor bad resume shape (%s); returning original", e)
            return TailorStructuredResult(document=document, gaps=gaps)

        merged = merge_rewrite(document, edited, section_order=section_order, new_summary=new_summary)
        return TailorStructuredResult(document=merged, gaps=gaps)
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_tailor_structured.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/services/openai_service.py backend/tests/test_tailor_structured.py
git commit -m "feat(rewrite): structure-aware prompt + wrapped output contract"
```

---

### Task 5: Wire `tailor_document` (changes, gaps, figures)

**Files:**
- Modify: `backend/services/resume_tailor.py:109-155` (`TailorResult`, `tailor_document`)
- Test: `backend/tests/test_tailor_document.py` (create)

**Interfaces:**
- Consumes: `tailor_resume_structured -> TailorStructuredResult` (Task 4), `describe_changes` (Task 3), `find_unsupported_figures` (Task 1).
- Produces: `TailorResult` dataclass gains `changes: list[str]`, `gaps: list[str]`, `figures_to_verify: list[str]`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_tailor_document.py
import pytest
from backend.schemas.ai import JobAnalysisOut
from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.openai_service import TailorStructuredResult
import backend.services.resume_tailor as rt


@pytest.mark.asyncio
async def test_tailor_document_threads_changes_gaps_figures(monkeypatch):
    original = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Handled billing"])]),
    ])
    rewritten = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Cut billing errors 30%"])]),
    ])

    async def fake_analyze(self, text, title, company, jd):
        return JobAnalysisOut(overall_score=70, ats_score=60, match_label="GOOD MATCH",
                              keyword_coverage=50, matched_keywords=["python"], missing_keywords=["aws"])

    async def fake_structured(self, doc, jd, sections=None, keywords=None):
        return TailorStructuredResult(document=rewritten, gaps=["Role wants AWS; not shown"])

    monkeypatch.setattr("backend.services.match_engine.MatchEngine.analyze_job", fake_analyze)
    monkeypatch.setattr("backend.services.openai_service.OpenAIService.tailor_resume_structured", fake_structured)

    result = await rt.tailor_document(db=None, original_document=original, job_title="Eng",
                                      company="X", job_description="AWS role")
    assert result.gaps == ["Role wants AWS; not shown"]
    assert result.figures_to_verify == ["30%"]           # 30% not in source → flagged
    assert any("bullet" in c.lower() or "entr" in c.lower() for c in result.changes)
```

Note: `ResumeTailor.__init__` builds an LLM service; the test monkeypatches methods, and `tailor_document` constructs `MatchEngine(db)`/`ResumeTailor(db)` with `db=None`. If `ResumeTailor.__init__` requires an API key, guard the LLM construction to be lazy (mirror `MatchEngine.llm`) as part of Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_tailor_document.py -v`
Expected: FAIL (TailorResult has no attribute figures_to_verify)

- [ ] **Step 3: Edit `resume_tailor.py`**

Make `ResumeTailor.llm` lazy so `tailor_document` works without an API key in tests:

```python
class ResumeTailor:
    def __init__(self, db: Session):
        self.db = db
        self._llm = None

    @property
    def llm(self):
        if self._llm is None:
            self._llm = get_llm_service()
        return self._llm
```

Extend `TailorResult` and `tailor_document`:

```python
from backend.services.fabrication_check import find_unsupported_figures
from backend.services.resume_document import document_to_text, describe_changes


@dataclass
class TailorResult:
    document: ResumeDocument
    original_text: str
    tailored_text: str
    before: JobAnalysisOut
    after: JobAnalysisOut
    diff_summary: str
    changes: list[str]
    gaps: list[str]
    figures_to_verify: list[str]


async def tailor_document(db, original_document, job_title, company, job_description,
                          sections=None, add_keywords=None) -> TailorResult:
    from backend.services.match_engine import MatchEngine

    engine = MatchEngine(db)
    tailor = ResumeTailor(db)
    original_text = document_to_text(original_document)
    before = await engine.analyze_job(original_text, job_title, company, job_description)
    keywords = add_keywords if add_keywords is not None else list(before.missing_keywords)
    structured = await tailor.llm.tailor_resume_structured(
        original_document, job_description, sections, keywords
    )
    document = structured.document
    tailored_text = document_to_text(document)
    after = await engine.analyze_job(tailored_text, job_title, company, job_description)
    diff_summary = tailor.compute_diff(original_text, tailored_text)
    changes = describe_changes(original_document, document)

    rewritten_texts: list[str] = []
    for sec in document.sections:
        if sec.text.strip():
            rewritten_texts.append(sec.text)
        for it in sec.items:
            rewritten_texts.extend(it.bullets)
    figures_to_verify = find_unsupported_figures(original_text, rewritten_texts)

    return TailorResult(
        document=document, original_text=original_text, tailored_text=tailored_text,
        before=before, after=after, diff_summary=diff_summary,
        changes=changes, gaps=structured.gaps, figures_to_verify=figures_to_verify,
    )
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_tailor_document.py tests/test_resume_document_merge.py tests/test_fabrication_check.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/resume_tailor.py backend/tests/test_tailor_document.py
git commit -m "feat(rewrite): thread changes/gaps/figures through tailor_document"
```

---

### Task 6: Schemas + routers pass-through

**Files:**
- Modify: `backend/schemas/ai.py` (`RewriteOut`), `backend/schemas/tailor.py` (`TailorResumeOut`)
- Modify: `backend/routers/ai.py:403` (`rewrite_resume` return), `backend/routers/tailor.py:63` + `:151` (both returns)
- Test: `backend/tests/test_tailor_api.py`, `backend/tests/test_ai_web_flow.py` (extend)

**Interfaces:**
- Produces: `RewriteOut` and `TailorResumeOut` each gain `changes: list[str] = []`, `gaps: list[str] = []`, `figures_to_verify: list[str] = []`.

- [ ] **Step 1: Add fields to both schemas**

```python
# backend/schemas/ai.py — inside RewriteOut, after version_id
    changes: list[str] = []
    gaps: list[str] = []
    figures_to_verify: list[str] = []
```
```python
# backend/schemas/tailor.py — inside TailorResumeOut, after diff_summary
    changes: list[str] = []
    gaps: list[str] = []
    figures_to_verify: list[str] = []
```

- [ ] **Step 2: Populate them in all three endpoint returns**

In `backend/routers/ai.py` `rewrite_resume` `RewriteOut(...)` add:
```python
        changes=result.changes,
        gaps=result.gaps,
        figures_to_verify=result.figures_to_verify,
```
In `backend/routers/tailor.py` `tailor_resume_endpoint` `TailorResumeOut(...)` add the same three lines. In `custom_resume_endpoint` `RewriteOut(...)` add the same three lines.

- [ ] **Step 3: Extend an API test**

```python
# append to backend/tests/test_tailor_api.py — assert the new fields surface
def test_custom_resume_returns_changes_and_gaps(self, client, db_session, monkeypatch):
    # reuse this file's existing monkeypatch pattern for analyze_job + tailor_resume_structured;
    # have the fake structured return gaps=["needs AWS"], a reworded bullet, and a "50%" not in source.
    ...
    data = resp.json()
    assert "changes" in data and "gaps" in data and "figures_to_verify" in data
```
(Fill using the file's existing fixtures/fakes — mirror `test_auto_weaves_all_missing_keywords`.)

- [ ] **Step 4: Run the backend suite for these**

Run: `cd backend && python -m pytest tests/test_tailor_api.py tests/test_ai_web_flow.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/schemas/ai.py backend/schemas/tailor.py backend/routers/ai.py backend/routers/tailor.py backend/tests/test_tailor_api.py
git commit -m "feat(rewrite): surface changes/gaps/figures_to_verify through the API"
```

---

### Task 7: Regression fixture (golden pipeline test)

**Files:**
- Test: `backend/tests/test_resume_rewrite_regression.py` (create)

**Interfaces:**
- Consumes: `tailor_document` (Task 5) with monkeypatched `analyze_job` + `tailor_resume_structured`.

- [ ] **Step 1: Write the golden test**

```python
# backend/tests/test_resume_rewrite_regression.py
"""Golden baseline: a real rewrite (structure changed), not a keyword append.
Future prompt/pipeline changes are compared against these assertions."""
import pytest
from backend.schemas.ai import JobAnalysisOut
from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.openai_service import TailorStructuredResult
import backend.services.resume_tailor as rt


ORIGINAL = ResumeDocument(sections=[
    Section(id="exp", type="experience", title="WORK EXPERIENCE", items=[
        SectionItem(id="i1", title="Software Engineer", subtitle="Acme",
                    bullets=["Responsible for maintaining the billing service",
                             "Worked on internal tools"])]),
    Section(id="prj", type="projects", title="PROJECTS", items=[
        SectionItem(id="p1", title="Realtime Dashboard",
                    bullets=["Built a dashboard with websockets for 500 users"])]),
])

# A structure-aware rewrite: projects lifted above experience, a summary added,
# duty-phrasing turned into impact, one fabricated metric ("60%") slipped in.
REWRITE = TailorStructuredResult(
    document=rt.merge_rewrite(  # exercise the real merge
        ORIGINAL,
        ResumeDocument(sections=[
            Section(id="exp", type="experience", title="WORK EXPERIENCE", items=[
                SectionItem(id="i1", title="Software Engineer", subtitle="Acme",
                            bullets=["Owned the billing service, cutting incidents 60%",
                                     "Shipped internal tooling adopted org-wide"])]),
            Section(id="prj", type="projects", title="PROJECTS", items=[
                SectionItem(id="p1", title="Realtime Dashboard",
                            bullets=["Built a websocket dashboard serving 500 users"])]),
        ]),
        section_order=["prj", "exp"],
        new_summary={"title": "PROFESSIONAL SUMMARY", "text": "Backend engineer focused on reliability."},
    ),
    gaps=["Role requires Kubernetes; no evidence in your experience"],
)


@pytest.mark.asyncio
async def test_pipeline_reorders_adds_summary_rewrites_and_flags_fabrication(monkeypatch):
    async def fake_analyze(self, text, title, company, jd):
        return JobAnalysisOut(overall_score=72, ats_score=65, match_label="GOOD MATCH",
                              keyword_coverage=50, matched_keywords=["python"], missing_keywords=["kubernetes"])

    async def fake_structured(self, doc, jd, sections=None, keywords=None):
        return REWRITE

    monkeypatch.setattr("backend.services.match_engine.MatchEngine.analyze_job", fake_analyze)
    monkeypatch.setattr("backend.services.openai_service.OpenAIService.tailor_resume_structured", fake_structured)

    result = await rt.tailor_document(None, ORIGINAL, "Backend Engineer", "Globex",
                                      "Kubernetes-heavy backend role")

    types = [s.type for s in result.document.sections]
    assert types[0] == "summary"                        # summary added, first
    assert types.index("projects") < types.index("experience")  # projects lifted
    assert result.gaps == ["Role requires Kubernetes; no evidence in your experience"]
    assert "60%" in result.figures_to_verify            # fabricated metric flagged
    assert any("reorder" in c.lower() for c in result.changes)
    assert any("summary" in c.lower() for c in result.changes)
    # It is a rewrite, not an append: the duty phrasing is gone.
    all_bullets = [b for s in result.document.sections for it in s.items for b in it.bullets]
    assert not any(b.lower().startswith("responsible for") for b in all_bullets)
```

- [ ] **Step 2: Run it**

Run: `cd backend && python -m pytest tests/test_resume_rewrite_regression.py -v`
Expected: PASS (1 passed) — `merge_rewrite`/`describe_changes` are re-exported from `resume_tailor` or import directly from `resume_document`; if `rt.merge_rewrite` is unresolved, import it in the test from `backend.services.resume_document`.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_resume_rewrite_regression.py
git commit -m "test(rewrite): golden regression fixture for structure-aware rewrite"
```

---

### Task 8: Frontend — changed-string diff + phrase matching

**Files:**
- Create: `frontend/src/lib/resumeDiff.ts`
- Modify: `frontend/src/lib/keywordMatch.ts` (export a normalizer; confirm phrase matching)
- Test: `frontend/src/__tests__/resume-diff.test.ts` (create)

**Interfaces:**
- Produces: `normalizeLine(s: string): string` (trim + collapse whitespace, lowercased) and `changedStrings(original: ResumeDocument, final: ResumeDocument): Set<string>` — normalized bullet/summary/section-text strings in `final` that are new or reworded vs `original` (matched by section/item id).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/resume-diff.test.ts
import { describe, it, expect } from "vitest";
import { changedStrings } from "../lib/resumeDiff";
import { DEFAULT_THEME, type ResumeDocument } from "../lib/resumeDocument";

const mk = (bullets: string[]): ResumeDocument => ({
  header: { name: "", email: "", phone: "", location: "", linkedin_url: "", github_url: "", other_link: "" },
  sections: [{ id: "exp", type: "experience", title: "WORK EXPERIENCE", text: "", skills: [], groups: {},
    items: [{ id: "i1", title: "Eng", subtitle: "Acme", location: "", start_date: "", end_date: "", detail: "", link: "", bullets }] }],
  theme: DEFAULT_THEME,
});

describe("changedStrings", () => {
  it("returns reworded bullets, not unchanged ones", () => {
    const out = changedStrings(mk(["Did A", "Did B"]), mk(["Led A with impact", "Did B"]));
    expect(out.has("led a with impact")).toBe(true);
    expect(out.has("did b")).toBe(false);
  });

  it("treats an added summary section as changed", () => {
    const before = mk(["Did A"]);
    const after: ResumeDocument = { ...before, sections: [
      { id: "sum", type: "summary", title: "SUMMARY", text: "Sharp engineer.", skills: [], groups: {}, items: [] },
      ...before.sections ] };
    expect(changedStrings(before, after).has("sharp engineer.")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/resume-diff.test.ts`
Expected: FAIL (cannot resolve ../lib/resumeDiff)

- [ ] **Step 3: Implement `resumeDiff.ts`**

```ts
// frontend/src/lib/resumeDiff.ts
import type { ResumeDocument } from "./resumeDocument";

export function normalizeLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalized bullet/summary/section-text strings in `final` that are new or
 *  reworded vs `original` (matched by section id + item id). Powers the
 *  "what changed" highlight layer. */
export function changedStrings(original: ResumeDocument, final: ResumeDocument): Set<string> {
  const origSections = new Map(original.sections.map((s) => [s.id, s]));
  const origItems = new Map(
    original.sections.flatMap((s) => s.items.map((it) => [it.id, it] as const))
  );
  const out = new Set<string>();

  for (const sec of final.sections) {
    const os = origSections.get(sec.id);
    // Section text (summary/custom) new or reworded.
    if (sec.text.trim() && normalizeLine(sec.text) !== normalizeLine(os?.text ?? "")) {
      out.add(normalizeLine(sec.text));
    }
    for (const it of sec.items) {
      const oi = origItems.get(it.id);
      const before = new Set((oi?.bullets ?? []).map(normalizeLine));
      for (const b of it.bullets) {
        const n = normalizeLine(b);
        if (n && !before.has(n)) out.add(n);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/__tests__/resume-diff.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/resumeDiff.ts frontend/src/__tests__/resume-diff.test.ts
git commit -m "feat(rewrite-ui): changedStrings diff for the what-changed layer"
```

---

### Task 9: Frontend — dual highlight layers + export strip

**Files:**
- Modify: `frontend/src/components/ResumeRenderer.tsx` (HighlightContext → mode-aware `HighlightState`; `HiText`; `ResumeRenderer`/`FittedResume` props)
- Modify: `frontend/src/lib/resumeExport.ts:54` (strip rule)
- Modify: `frontend/src/components/ResumeEditor.tsx` (adapt to the new `highlight` prop — keyword mode)
- Test: covered via Task 10's modal test + a small renderer unit test optional

**Interfaces:**
- Produces: `type HighlightMode = "changed" | "keyword" | "off"`; `interface HighlightState { mode: HighlightMode; terms: HighlightTerm[]; changed: Set<string>; figures: string[] }`. `ResumeRenderer`/`FittedResume` take `highlight?: HighlightState` (replaces `highlightTerms`).

- [ ] **Step 1: Replace the highlight context + `HiText`**

```tsx
// ResumeRenderer.tsx — replace the "Keyword heatmap" block (lines ~17-49)
export type HighlightTerm = { term: string; color: "green" | "yellow" };
export type HighlightMode = "changed" | "keyword" | "off";
export interface HighlightState {
  mode: HighlightMode;
  terms: HighlightTerm[];
  changed: Set<string>;
  figures: string[];
}

const HILITE_BG: Record<"green" | "yellow", string> = { green: "#bbf7d0", yellow: "#fde68a" };
const OFF: HighlightState = { mode: "off", terms: [], changed: new Set(), figures: [] };
const HighlightContext = createContext<HighlightState>(OFF);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function markFigures(text: string, figures: string[]) {
  if (!figures.length) return text;
  const pattern = figures.map(escapeRe).sort((a, b) => b.length - a.length).join("|");
  if (!pattern) return text;
  const re = new RegExp(`(${pattern})`, "g");
  return text.split(re).map((part, i) =>
    figures.includes(part)
      ? <mark key={i} title="Verify this figure — not found in your original resume"
              style={{ background: "#fed7aa", color: "inherit", borderRadius: "2px", padding: "0 1px" }}>{part}</mark>
      : <span key={i}>{part}</span>
  );
}

function HiText({ children }: { children: string }) {
  const hl = useContext(HighlightContext);
  if (hl.mode === "off" || !children) return <>{children}</>;

  if (hl.mode === "changed") {
    const inner = markFigures(children, hl.figures);
    if (hl.changed.has(norm(children))) {
      return <mark style={{ background: "transparent", borderBottom: "2px solid #86efac", padding: "0 1px" }}>{inner}</mark>;
    }
    return <>{inner}</>;
  }

  // keyword mode (unchanged heatmap behaviour)
  const terms = hl.terms;
  if (!terms.length) return <>{children}</>;
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const colorByLower = new Map(sorted.map((t) => [t.term.toLowerCase(), t.color] as const));
  const pattern = sorted.map((t) => escapeRe(t.term)).join("|");
  if (!pattern) return <>{children}</>;
  const re = new RegExp(`(?<![a-zA-Z0-9])(${pattern})(?![a-zA-Z0-9])`, "gi");
  return (
    <>
      {children.split(re).map((part, i) => {
        const color = colorByLower.get(part.toLowerCase());
        return color
          ? <mark key={i} style={{ background: HILITE_BG[color], color: "inherit", borderRadius: "2px", padding: "0 1px" }}>{part}</mark>
          : <span key={i}>{part}</span>;
      })}
    </>
  );
}
```

- [ ] **Step 2: Update `ResumeRenderer` + `FittedResume` props**

Replace `highlightTerms?: HighlightTerm[]` with `highlight?: HighlightState` on both `ResumeRendererProps` and `FittedResume`, provide `highlight ?? OFF` into `HighlightContext.Provider`, and thread `highlight` through `FittedResume → ResumeRenderer`.

- [ ] **Step 3: Extend the PDF strip rule**

```ts
// resumeExport.ts:54-55 — replace the single mark rule
      `mark{background:transparent !important;border:0 !important;border-bottom:0 !important;` +
      `box-shadow:none !important;text-decoration:none !important;padding:0 !important;}</style>` +
```

- [ ] **Step 4: Adapt `ResumeEditor.tsx`**

Wherever it passes `highlightTerms`/`keywords` to `FittedResume`, pass `highlight={{ mode: "keyword", terms: heatmapTerms(analyzeKeywords(keywords, doc)), changed: new Set(), figures: [] }}` (import `heatmapTerms`, `analyzeKeywords`). Keep the editor's highlight keyword-only.

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (all `highlightTerms` call sites updated).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ResumeRenderer.tsx frontend/src/lib/resumeExport.ts frontend/src/components/ResumeEditor.tsx
git commit -m "feat(rewrite-ui): mode-aware dual highlight layers + PDF strip"
```

---

### Task 10: Frontend — Review UI (toggle, gaps card, real changes)

**Files:**
- Modify: `frontend/src/components/AtsPanel.tsx` (three-state toggle + legend)
- Modify: `frontend/src/components/CustomResumeModal.tsx` (mode state, gaps card, real `changes`, build `HighlightState`)
- Modify: `frontend/src/components/ai-flow.css` (gaps card + segmented toggle styles)
- Test: `frontend/src/components/CustomResumeModal.test.tsx` (extend)

**Interfaces:**
- Consumes: `changedStrings` (Task 8), `HighlightState`/`HighlightMode` (Task 9), backend `changes`/`gaps`/`figures_to_verify` (Task 6).

- [ ] **Step 1: Extend `RewriteResult` + state in `CustomResumeModal.tsx`**

Add to the `RewriteResult` interface: `changes: string[]; gaps: string[]; figures_to_verify: string[];`. Replace `const [highlightOn, setHighlightOn] = useState(true);` with `const [highlightMode, setHighlightMode] = useState<HighlightMode>("changed");`. Import `changedStrings` and `HighlightMode`/`HighlightState`.

- [ ] **Step 2: Build the highlight state + render it (renderStep3)**

```tsx
const changed = useMemo(
  () => (rewrite ? changedStrings(rewrite.original_document, editedDoc) : new Set<string>()),
  [rewrite, editedDoc]
);
const highlight: HighlightState = {
  mode: highlightMode,
  terms: heatmapTerms(analyzeKeywords(jobKeywords, editedDoc)),
  changed,
  figures: rewrite?.figures_to_verify ?? [],
};
// <FittedResume document={editedDoc} innerRef={previewRef} highlight={highlight} />
```

Replace the client-built `changes` array with the backend list:
```tsx
const changes = rewrite.changes.length
  ? rewrite.changes
  : ["Tailored your resume to this role"];
```

Add the gaps card (after the "See what's changed" list) — non-blocking:
```tsx
{(rewrite.gaps.length > 0 || rewrite.figures_to_verify.length > 0) && (
  <div className="ai-gaps-card">
    <div className="ai-card-label">Gaps to consider</div>
    <ul className="ai-gaps-list">
      {rewrite.gaps.map((g, i) => <li key={`g${i}`}>{g}</li>)}
    </ul>
    {rewrite.figures_to_verify.length > 0 && (
      <div className="ai-gaps-verify">
        Verify these figures (not found in your original): <strong>{rewrite.figures_to_verify.join(", ")}</strong>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: Three-state toggle in `AtsPanel.tsx`**

Change props from `highlightOn: boolean; onToggleHighlight` to `highlightMode: HighlightMode; onHighlightModeChange: (m: HighlightMode) => void;` (import the type from ResumeRenderer). Replace the checkbox with a segmented control:
```tsx
<div className="ats-toggle-group" role="group" aria-label="Highlight mode">
  {(["changed", "keyword", "off"] as const).map((m) => (
    <button key={m} className={`ats-seg ${highlightMode === m ? "on" : ""}`}
            onClick={() => onHighlightModeChange(m)}>
      {m === "changed" ? "What changed" : m === "keyword" ? "Keyword match" : "Off"}
    </button>
  ))}
</div>
```
Add a small legend under it describing the active mode's colors (green underline = rewritten; orange = verify figure; green/yellow = keyword present/partial). Update the call site in `CustomResumeModal` to pass `highlightMode` / `setHighlightMode`.

- [ ] **Step 4: CSS**

Add to `ai-flow.css`: `.ai-gaps-card` (amber-tinted, rounded), `.ai-gaps-list`, `.ai-gaps-verify`, `.ats-toggle-group`/`.ats-seg`/`.ats-seg.on` (segmented control). Keep consistent with existing `--` tokens/spacing in the file.

- [ ] **Step 5: Extend the modal test**

```tsx
// CustomResumeModal.test.tsx — with a generate() mock returning changes/gaps/figures_to_verify,
// assert the gaps text and a change line render, and the toggle switches mode.
expect(await screen.findByText(/Gaps to consider/i)).toBeInTheDocument();
expect(screen.getByText(/Verify these figures/i)).toBeInTheDocument();
```

- [ ] **Step 6: Run frontend tests + typecheck**

Run: `cd frontend && npx vitest run src/components/CustomResumeModal.test.tsx src/__tests__/resume-diff.test.ts src/__tests__/keyword-match.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AtsPanel.tsx frontend/src/components/CustomResumeModal.tsx frontend/src/components/ai-flow.css frontend/src/components/CustomResumeModal.test.tsx
git commit -m "feat(rewrite-ui): highlight-mode toggle, gaps card, real change list"
```

---

### Task 11: Full-suite verification

- [ ] **Step 1: Backend**

Run: `cd backend && python -m pytest tests/test_fabrication_check.py tests/test_resume_document_merge.py tests/test_tailor_structured.py tests/test_tailor_document.py tests/test_resume_rewrite_regression.py tests/test_tailor_api.py tests/test_ai_web_flow.py -v`
Expected: all PASS.

- [ ] **Step 2: Frontend**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 3: Extension typecheck (shared types unaffected, sanity)**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Final commit if any residue**

```bash
git add -A && git commit -m "chore(rewrite): overhaul verification pass" || true
```

## Self-Review

- **Spec coverage:** A(contract)=T4; B(merge v2 + numbers + changes)=T2,T3,T1,T5; C(prompt)=T4; D(schema/API)=T6; E(UI/highlight/export)=T8,T9,T10; F(tests/fixture)=T1-3,T7,T10,T11. ✓
- **Types:** `TailorStructuredResult` (T4) consumed in T5; `HighlightState`/`HighlightMode` defined in T9, consumed in T10; `changedStrings`/`normalizeLine` in T8 used in T9/T10; response fields identical across `RewriteOut`/`TailorResumeOut` (T6). ✓
- **Legacy untouched:** `/ai/tailor-resume/{job_id}`, `tailor_resume` (summary), `tailor_resume_guided` unchanged. ✓
