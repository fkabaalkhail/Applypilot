# Resume fidelity, deep analysis, and the resume workspace

Date: 2026-07-08
Status: approved (user pre-approved; implement directly)

## Problem

Four defects, all in the resume upload → view → analyze loop.

**1. Uploaded resumes lose sections.** `prompts/analyze_resume.txt` asks the model for
only eight keys (`name, email, phone, location, linkedin_url, skills, experience,
education`), and `OpenAIService.analyze_resume` reads only those. Everything else the
user actually has on their CV is silently discarded:

| Lost | Why |
|---|---|
| Projects | never requested, never read |
| Technologies (categorized) | never requested, never read |
| GitHub / portfolio links | never read from the response |
| Employment + education dates | prompt asks for `duration`/`year`; schema wants `start_date`/`end_date`, so pydantic drops them |
| Experience location, education GPA / coursework / achievements | never requested |
| Professional summary | no field exists |
| Certifications, awards, volunteering, publications, languages, leadership… | no field exists |

`db_record_to_document` then builds documents from those same columns, so the loss
propagates into the Profile page, the preview, the PDF, and the rewriter.

**2. Analysis is shallow.** `analyze_resume_quality` returns a grade, three counts, a
summary, and a flat list of strings. Nothing tells the user *where* the problem is,
*why* it matters, or *how* to fix it. The model also has no grounded view of the
resume's structure, so its counts are guesses.

**3. Timestamps are wrong.** Columns are naive UTC (`datetime.utcnow`). FastAPI
serializes them without an offset (`2026-07-08T14:00:00`). JavaScript parses an
offset-less date-time as **local** time, so for a UTC-4 user `Date.now() - parsed`
is −4 h → the UI prints "-240m ago".

**4. The resume UI does not look like a resume.** `ResumeDetail.tsx` is a stack of
generic form cards. The analysis is four lines in one of them.

## Design

### A. Full-fidelity extraction

Extend `ResumeProfile` (backend + DB + frontend) with the missing shape:

```python
class CustomSectionItem(BaseModel):   # mirrors SectionItem
    title, subtitle, location, start_date, end_date, detail, link: str = ""
    bullets: list[str] = []

class CustomSection(BaseModel):
    id: str            # stable, generated
    title: str         # verbatim heading, e.g. "CERTIFICATIONS"
    kind: str          # "certifications" | "custom"
    text: str = ""     # prose sections
    bullets: list[str] = []   # flat bullet sections (Awards, Languages…)
    items: list[CustomSectionItem] = []   # entry sections (Volunteering…)

class ResumeProfile(...):
    summary: str = ""
    summary_title: str = ""       # the user's own heading ("PROFILE", "OBJECTIVE"…)
    custom_sections: list[CustomSection] = []
    section_order: list[str] = [] # e.g. ["summary","experience","projects","custom:a1b2"]
```

New DB columns on `resume_profiles`: `summary` (Text), `summary_title` (String),
`custom_sections` (JSON), `section_order` (JSON). Idempotent migration, registered in
`main.py` like the others.

`prompts/analyze_resume.txt` is rewritten as a **transcription** task, not a
summarization task: every bullet verbatim, no rewriting, no invention, no omission;
one JSON object with every field above; anything that does not fit a known section
becomes a `custom_sections` entry keeping the user's own heading; `section_order`
records the order the headings appear in the file.

`db_record_to_document` gains:
- a `summary` section when `summary` is set,
- one section per `custom_section`,
- ordering driven by `section_order` (unknown/missing keys fall back to the
  conventional order; nothing is ever dropped),
- **stable semantic section/item ids** (`experience`, `experience-0`, `custom-a1b2`)
  so a document can be folded back into a profile after a rewrite.

`document_to_profile(doc, base)` is the inverse, keyed on those ids.

The `PUT /resumes/{id}` handler only overwrites `summary` / `custom_sections` /
`section_order` when the client explicitly sent them (`model_fields_set`), so an older
client (e.g. the extension) can never wipe them.

### B. Deep analysis

`backend/services/resume_metrics.py` computes a **deterministic digest** from the raw
text + parsed profile: detected headings in order, bullet count, mean bullet length,
share of bullets that open with a strong action verb, share that carry a number, the
literal weak-verb / passive / pronoun / filler hits, date-format consistency, contact
completeness, word count, estimated pages. This goes into the prompt so the model
critiques observed facts instead of inventing counts.

`AnalysisReport` grows (all new fields default, so stored reports still load):

```python
class AnalysisIssue:    id, title, severity("urgent"|"critical"|"optional"),
                        count, description, evidence: list[str], suggestion: str,
                        section: str
class AnalysisCategory: id, name, score(0-100), why_it_matters, issues
class AnalysisReport:   overall_grade, letter_grade, score, *_fix_count,
                        summary, highlights, strengths, categories, analyzed_at
```

Six fixed categories keep the UI stable: Impact & Achievements, Wording & Language,
Structure & Flow, Brevity & Effectiveness, ATS & Formatting, Skills & Keywords.

The quality prompt is rewritten to demand: exact `evidence` quoted from the resume, a
concrete `suggestion` that rewrites the offending line, and — critically — a
**no-invented-numbers rule**. Where a bullet should be quantified, the suggestion uses
an explicit placeholder (`"…cut deploy time by [X]%"`) and says what to measure. The
model must also flag vague, unverifiable claims ("improved efficiency by 75%" with no
basis) as its own issue type. Counts are recomputed server-side from the issues, so
the headline numbers can never disagree with the list.

### C. Improve flow

`POST /resumes/{id}/improve` → `{profile, changes[]}`. It builds the document, hands it
plus the analysis findings to `improve_resume_structured`, folds the result through the
existing `merge_rewrite` (which locks every factual field: employers, titles, dates,
degrees, links), converts back with `document_to_profile`, and returns a preview plus a
deterministic change list from `describe_changes`. Nothing is persisted; the UI applies
it with the existing `PUT /resumes/{id}`. "Make this my primary CV" reuses
`PUT /resumes/{id}/primary`.

### D. Timestamps

Backend: an annotated `UtcDateTime` type on the resume schemas serializes naive values
as UTC (`…Z`). Frontend: `lib/datetime.ts` exposes `parseServerDate` (treats an
offset-less string as UTC) and a `timeAgo` that clamps small negative deltas to
"just now" rather than printing a negative number.

### E. UI

Two new surfaces, sharing `resume-detail.css`. They take the *structure* of the
reference screenshots (grade badge, three fix tiles, numbered category sections, a
document canvas with an inline-editable header) but not their look: our palette is the
existing Stripe-indigo brand (`--stripe-primary #533afd`), the badge is a rounded
shield with a score ring rather than a mint hexagon, severity uses ruby / amber /
indigo rather than pink / yellow / blue, and the fix tiles are a single segmented bar
rather than three floating cards.

- `ResumeScoreStrip` — score ring + letter grade, rating chip, segmented fix counts,
  "View full report", "Re-analyze".
- `AnalysisReportView` — full report: summary, numbered categories, per-issue rows with
  evidence + suggestion, collapsible "why this matters", and a footer CTA pair
  ("Improve my resume" / "Make it my primary CV").
- `ResumeCanvas` — the resume rendered as a document: centered header with inline
  contact fields, section blocks in `section_order`, drag-free reorder controls, inline
  add/remove/edit of every entry, per-section severity chips that jump to the report.
- `ImproveModal` — the change list from `/improve`, apply or discard.

`Profile.tsx` additionally renders `summary` and `custom_sections` so nothing extracted
is invisible there.

## Testing

- `test_resume_extraction.py` — the analyze_resume mapping keeps projects, dates,
  technologies, github, summary, custom sections, section_order; missing keys degrade
  to empty rather than raising.
- `test_resume_metrics.py` — digest counts on a known fixture.
- `test_resume_document_roundtrip.py` — `db_record_to_document` → `document_to_profile`
  is identity on a full profile; section_order honored; unknown keys never drop a
  section.
- `test_resume_improve_api.py` — `/improve` locks facts and returns changes.
- Timestamp serialization test: `created_at` ends in `Z`.
- Frontend: `resume.property.test.tsx` updated to the new DOM; `datetime.test.ts` for
  the naive-UTC + future-clamp cases.

## Out of scope

The Chrome extension (untouched, per instruction). Job-targeted tailoring already
exists and is not changed beyond reusing `merge_rewrite`.
