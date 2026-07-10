# Résumé detail — two-pane editor + live preview

- **Date:** 2026-07-10
- **Status:** Design — awaiting review
- **Area:** `frontend/src` — the single-résumé view (`ResumeDetail`)
- **Direction chosen:** #2 (two-pane form + live preview), after mockup review

## 1. Problem

A user (via a friend's feedback + screenshot) reported the résumé detail page is
"disorganized," the degree is "cut out," and there's "lots of empty space." Investigation
traced all three to the on-screen editor, `ResumeCanvas`:

- **Degree/title cut off** — every inline field is a bare `<input>` (`EditableText`), and the
  shared `.rd-edit` style sets no width, so each input falls back to the browser's default
  ~20-character box. "Honours BSc. Translation and Interpretation" renders as
  "Honours BSc. Translatio…". This affects degree, job title, location, GPA, project fields.
- **Empty space** — every short fixed-width box leaves the rest of its line blank; the right
  ~60% of the sheet is dead. The summary textarea is tall and mostly empty.
- **Disorganized** — the empty fixed-width GPA input sits before the location input, so the
  line reads "GPA … Ottawa, ON" as if GPA labels the city. Dates float in a far-right column.

Underlying all of it: the **on-screen editor and the exported PDF are two different
components that have drifted apart**. The editor is `ResumeCanvas` (the buggy `rd-*` sheet);
the PDF is `ResumeRenderer`, which already lays entries out correctly (title left / dates
right on one row, "subtitle · location" sub-line, real bullets). `ResumeRenderer.tsx` still
carries a comment calling itself "the ONE renderer" for editor + preview + PDF — no longer true.

## 2. Goals / non-goals

**Goals**
- Replace the editing sheet with a two-pane workspace: a **form editor** (left) beside a
  **live, PDF-exact preview** (right) that reuses the real `ResumeRenderer`.
- Fix all three complaints structurally: full-width fields (nothing cut off), the empty space
  becomes the live preview, each entry's fields are grouped and labelled.
- **Reuse the existing editing behaviour** — add/remove entries, bullets, skill/tech chips,
  section reorder, and the per-section analysis flags — re-skinning presentation, not rewriting logic.
- **Preserve every AI feature** with no regression (see §5). The user called this out explicitly.

**Non-goals**
- No changes to data model, backend, API, or the PDF/DOCX export format.
- No inline-WYSIWYG editing on the print node (that was Direction 3 — deferred, higher risk).
- No new AI capabilities beyond optionally surfacing the existing rewrite highlights in the
  preview (§5.4). Scope is a UI re-layout, not an AI change.

## 3. Current architecture (what exists today)

`ResumeDetail.tsx` holds all page state (`profile`, `report`, `view`, dirty tracking) and the
handlers `analyze`, `improve`, `applyImprovement`, `save`, `exportPdf`, `setPrimary`, `remove`.
It renders two mutually-exclusive views:

- `view === "report"` → `<AnalysisReportView>` (full-page analysis).
- otherwise → `<div class="rd-shell">` containing the score strip
  (`ResumeScoreStrip` / `UnanalyzedStrip`) **and** the editor `<ResumeCanvas>`.

A hidden off-screen `<ResumeRenderer ref={printRef} screen={false}>` is the PDF source;
`exportPdf` prints it via `printResume`.

`FittedResume` (in `ResumeRenderer.tsx`) already scales the real page to a container width and
exposes the unscaled page node via `innerRef` — it is built exactly for a preview pane.

## 4. Design — the two-pane workspace

### 4.1 Page structure (the `view === "resume"` branch only)

```
┌ topbar (unchanged: name · Set primary · Export PDF · Delete · Save) ┐
├ score strip (unchanged, full-width) ────────────────────────────────┤
├──────────────────────────────┬──────────────────────────────────────┤
│  LEFT — form editor          │  RIGHT — live preview (sticky)        │
│  (scrolls)                   │  FittedResume(document = doc)         │
│  Basics / Summary / …        │  the exact page that exports          │
└──────────────────────────────┴──────────────────────────────────────┘
```

The `view === "report"` branch (`AnalysisReportView`) is **unchanged**. The two-pane only
replaces what's inside the "resume" shell (score strip stays; `ResumeCanvas` is replaced by
the form+preview grid).

### 4.2 Left pane — form editor (`ResumeForm`, replaces `ResumeCanvas`)

A new `ResumeForm` component takes the **same props** as `ResumeCanvas`
(`profile`, `report`, `onChange`, `onFlagClick`) and reuses the same mutation patterns, so the
data flow into `ResumeDetail` is identical. Each section renders as a labelled-field card:

- **Basics** — Name; Email · Phone · Location; LinkedIn · GitHub · Other link. All inputs
  **full-width** (root cause fix).
- **Summary** — auto-growing textarea with a **capped max-height** (scrolls past the cap) so it
  can never become a tall empty box.
- **Experience** — one card per role: Company, Title, Location, Start → End, Bullets. Add/remove role.
- **Education** — one card per school: School, Degree (full-width), Location, Start → End, GPA
  (labelled, beside its value), Achievements (bullets), Relevant coursework (chips). Add/remove.
- **Projects** — one card per project: Name, Organization, Link, Start → End, Bullets. Add/remove.
- **Skills** — chips. **Technologies** — chips grouped per category.
- **Custom sections** — text and/or item list (title, subtitle, dates, bullets), as today.
- **Section reorder** — retained via a per-card control: up/down buttons plus keyboard
  arrow-key move (keeps the existing a11y behaviour; drag optional).
- **Per-section analysis flags** — retained: each card header shows that section's findings
  (reusing `flagsFor`); clicking calls `onFlagClick(severity)` → opens the report focused there.

The `Editable*` primitives are reused as controlled inputs, restyled as visible form fields
(label above, bordered input, full width) instead of the "invisible-until-hover" document look.

### 4.3 Right pane — live preview

`<FittedResume document={doc} highlight={…} />` where `doc = profileToDocument(profile)` (already
computed in `ResumeDetail`). It re-renders as the user types, so the preview always matches what
will export. The pane is **sticky** (offset below topbar + score strip) so it stays in view while
the form scrolls.

**Export stays as-is.** The hidden off-screen `ResumeRenderer` + `printResume(printRef)` path is
**kept**, unchanged. (An earlier idea was to delete it and print from the preview's `innerRef`;
keeping it makes Export work identically from every view with zero risk, so the preview is
purely additive. Rendering a second small renderer is negligible cost.)

### 4.4 Responsive

- **≥ 900px:** two columns (editor / preview). Preview sticky.
- **< 900px:** single column with a segmented **Edit | Preview** toggle at the top of the shell —
  never two cramped columns on a laptop/phone. Defaults to Edit.

## 5. AI features — preserved (explicit)

All AI lives in `ResumeDetail` handlers + three components that **do not change**:

1. **Analyze** (`POST /resumes/{id}/analyze`) → `AnalysisReport`. Rendered by `ResumeScoreStrip`
   (grade plaque, severity rail, legend, "View full report" / "Re-analyze") and by
   `AnalysisReportView` (summary, strengths, ranked categories, per-issue evidence + fix). The
   score strip stays full-width above the panes; the report view is unchanged.
2. **Improve / AI rewrite** (`POST /resumes/{id}/improve`) → `{ profile, changes }`. Entry point
   is the "Improve my resume" CTA at the bottom of `AnalysisReportView`. `ImproveModal` reviews
   the rewrite (applied wording changes + "needs your input" placeholders it refused to invent).
   "Apply" → `applyImprovement` → `save(profile)`. **After apply, `profile` updates → the form
   and the live preview both reflect the rewrite automatically.**
3. **Per-section finding flags** — the editor→report jump, carried into `ResumeForm` (§4.2).
4. **Optional enhancement (flag for review, not required):** `FittedResume` accepts a
   `highlight` prop (`HighlightState`: what-changed underline + fabricated-figure "verify"
   marks). After an Improve is applied we can pass a `changed` highlight so the preview visibly
   shows what the AI touched. This is additive and can ship as a follow-up; core scope does not
   depend on it.

No AI endpoint, prompt, or component behaviour is modified.

## 6. Files & components

- **`ResumeDetail.tsx`** — relayout the "resume" branch: keep score strip, replace `ResumeCanvas`
  with the two-pane grid (`ResumeForm` + `FittedResume`) and the Edit/Preview toggle state. Keep
  the off-screen print renderer and all handlers.
- **`components/resume/ResumeForm.tsx`** — new; the labelled-field editor (§4.2). Reuses
  `Editable.tsx` primitives, `resumeProfile` helpers (`orderedSections`, `sectionLabel`,
  `findCustom`, `flagsFor` logic), and the same `onChange` patch shape.
- **`components/resume/ResumeCanvas.tsx`** — retired (only used here). Its section/reorder/flag
  logic is the basis for `ResumeForm`.
- **`Editable.tsx`** — reused; add form-field styling variants (full-width, label). The width fix
  lands here regardless.
- **`resume-detail.css`** — add two-pane grid, sticky preview, form-field, and toggle styles;
  keep the report/score/modal/toast styles.
- **Unchanged:** `ResumeRenderer` / `FittedResume`, `ResumeScoreStrip`, `AnalysisReportView`,
  `ImproveModal`, `resumeExport`, all backend, all API.

## 7. Edge cases & risks

- **Form parity across all section types** (experience/education/projects/skills/technologies/
  summary/custom) — must match `ResumeCanvas`'s current coverage; this is the main surface area.
- **Section reorder** in a form layout — preserve keyboard arrow-move + live-region announcement.
- **Live preview cost** — re-renders on each keystroke; `doc` is memoized and the render is small,
  but confirm no jank on fast typing (debounce only if needed).
- **Sticky offset** — the preview's `top` must account for the sticky topbar + score strip height.
- **Empty / very long content** — empty sections render nothing extra; long fields wrap/scroll,
  never clip.
- **Export from report view** — preserved by keeping the off-screen print node (§4.3).
- **Mobile toggle** — ensure the preview mounts with a real width when toggled on (avoid a
  0-width `FittedResume` measurement).

## 8. Testing / verification

- Existing frontend tests stay green: `resume.property.test.tsx`, `resume-edit.test.ts`,
  `resume-diff.test.ts` (data/logic unaffected).
- Manual/browser verification (per the `verify` skill) on a real résumé:
  - Long degree/title render fully; GPA reads "GPA <value>"; no dead right-side space.
  - Editing a field updates the live preview; Export PDF still produces the same document.
  - Analyze → score strip + report render; per-section flags jump to the report.
  - Improve → modal → apply → form + preview reflect the rewrite.
  - Responsive: two columns ≥900px; Edit/Preview toggle below it.

## 9. Out of scope / future

- Inline-WYSIWYG editing on the print node (Direction 3).
- Making `FittedResume` the single renderer (removing the off-screen print node).
- Surfacing keyword-match highlights (JD tailoring) in this view.
