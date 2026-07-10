# Résumé detail — two-pane editor + live preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the buggy inline résumé-editing sheet with a two-pane workspace — a labelled form editor beside a live, PDF-exact preview — fixing the cut-off degree, the dead space, and the disorganized entries.

**Architecture:** A new `ResumeForm` component reuses all of `ResumeCanvas`'s editing logic and the same `onChange`/`onFlagClick` props, but renders each section as labelled, full-width form fields. `ResumeDetail` places it in a two-pane grid next to the existing `FittedResume` (the real `ResumeRenderer`, already used this way in `CustomResumeModal`/`ResumeEditor`), which updates as the user types. The AI analyze/report/rewrite flows and the off-screen PDF print node are untouched.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest 4 + `@testing-library/react` + jsdom, existing `resume-detail.css`.

## Global Constraints

- **Frontend-only.** No changes to the backend, API, data model, or PDF/DOCX export format.
- **Preserve every AI feature:** Analyze (`ResumeScoreStrip`, `AnalysisReportView`), Improve/rewrite (`ImproveModal` + `improve`/`applyImprovement` handlers), and the per-section finding flags. Do not edit those three components.
- **Keep the off-screen print node** in `ResumeDetail` (`<ResumeRenderer ref={printRef} screen={false}>`) exactly as-is so Export works from every view.
- **Reuse, don't rewrite:** reuse `Editable.tsx` primitives and `resumeProfile.ts` helpers (`orderedSections`, `sectionLabel`, `findCustom`). `onChange` always receives a `Partial<ResumeProfile>` patch.
- **Styling:** use existing Stripe-indigo tokens (`--stripe-primary`, `--rd-ink`, `--rd-rule`, `--shadow-card`, etc.). Responsive breakpoint: **900px (56.25rem)**.
- **Tests:** run from `frontend/`. Single file: `npx vitest run <path>`. There is a known pre-existing frontend-test failure baseline (JobDetailView, inline-panel, resume.property) — do **not** treat those as regressions; only gate on the test files this plan adds/touches.

---

## Setup

- [ ] **Create the feature branch** (from `main`):

```bash
git checkout main && git pull
git checkout -b feat/resume-two-pane-editor
```

---

### Task 1: `sectionFlags` helper (extract the per-section finding logic)

Extract `ResumeCanvas`'s local `flagsFor` into an exported, tested helper so `ResumeForm` can reuse it.

**Files:**
- Modify: `frontend/src/lib/resumeProfile.ts` (add export near `issueMatchesSection`, ~line 289)
- Test: `frontend/src/__tests__/resume-section-flags.test.ts`

**Interfaces:**
- Produces: `export function sectionFlags(report: AnalysisReport | null, label: string): { severity: Severity; count: number }[]`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/resume-section-flags.test.ts
import { describe, it, expect } from "vitest";
import { sectionFlags } from "../lib/resumeProfile";
import type { AnalysisIssue, AnalysisReport } from "../lib/resumeProfile";

const report = (issues: AnalysisIssue[]): AnalysisReport => ({
  overall_grade: "GOOD", letter_grade: "B", score: 70,
  urgent_fix_count: 0, critical_fix_count: 0, optional_fix_count: 0,
  summary: "", highlights: [], strengths: [],
  categories: [{ id: "c", name: "Cat", score: 50, why_it_matters: "", issues }],
  analyzed_at: null,
});

const issue = (over: Partial<AnalysisIssue>): AnalysisIssue => ({
  id: "i", title: "", severity: "optional", count: 1,
  description: "", evidence: [], suggestion: "", section: "Education", ...over,
});

describe("sectionFlags", () => {
  it("returns nothing when the report is null", () => {
    expect(sectionFlags(null, "Education")).toEqual([]);
  });

  it("sums counts by severity for the matching section, ordered urgent→critical→optional", () => {
    const r = report([
      issue({ id: "1", severity: "optional", count: 1, section: "Education" }),
      issue({ id: "2", severity: "urgent", count: 2, section: "Education" }),
      issue({ id: "3", severity: "urgent", count: 1, section: "Skills" }),
    ]);
    expect(sectionFlags(r, "Education")).toEqual([
      { severity: "urgent", count: 2 },
      { severity: "optional", count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/resume-section-flags.test.ts`
Expected: FAIL — `sectionFlags` is not exported.

- [ ] **Step 3: Add the implementation**

In `frontend/src/lib/resumeProfile.ts`, add after `issueMatchesSection` (end of file):

```ts
/** The analysis findings that point at a section, summed by severity for its heading badge. */
export function sectionFlags(
  report: AnalysisReport | null,
  label: string,
): { severity: Severity; count: number }[] {
  if (!report) return [];
  const counts: Partial<Record<Severity, number>> = {};
  for (const category of report.categories) {
    for (const issue of category.issues) {
      if (issueMatchesSection(issue.section, label)) {
        counts[issue.severity] = (counts[issue.severity] ?? 0) + issue.count;
      }
    }
  }
  return (["urgent", "critical", "optional"] as Severity[])
    .filter((s) => counts[s])
    .map((s) => ({ severity: s, count: counts[s] as number }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/resume-section-flags.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/resumeProfile.ts frontend/src/__tests__/resume-section-flags.test.ts
git commit -m "$(cat <<'EOF'
feat(resume): extract sectionFlags helper for reuse in the form editor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ResumeForm` — shell, Basics, Summary

Create the form component: props identical to `ResumeCanvas`, a section iterator with reorder + finding flags, the Basics (header) card, and the Summary card. Also add an optional height cap to `EditableArea` so the summary never becomes a tall empty box.

**Files:**
- Create: `frontend/src/components/resume/ResumeForm.tsx`
- Modify: `frontend/src/components/resume/Editable.tsx` (add `maxHeight` to `EditableArea`)
- Test: `frontend/src/components/resume/ResumeForm.test.tsx`

**Interfaces:**
- Consumes: `sectionFlags` (Task 1); `orderedSections`, `sectionLabel`, `findCustom` from `resumeProfile`; `EditableText`, `EditableArea`, `BulletList`, `ChipList` from `./Editable`; `SEVERITY_LABEL` from `./SeverityRail`.
- Produces: `export default function ResumeForm(props: { profile: ResumeProfile; report: AnalysisReport | null; onChange: (patch: Partial<ResumeProfile>) => void; onFlagClick: (severity: Severity) => void }): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/resume/ResumeForm.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ResumeForm from "./ResumeForm";
import { emptyProfile } from "../../lib/resumeProfile";
import type { ResumeProfile } from "../../lib/resumeProfile";

const make = (over: Partial<ResumeProfile> = {}): ResumeProfile => ({
  ...emptyProfile(), name: "Ada Lovelace", summary: "Engineer.", ...over,
});

describe("ResumeForm — shell, basics, summary", () => {
  it("shows the name and edits it through onChange", () => {
    const onChange = vi.fn();
    render(<ResumeForm profile={make()} report={null} onChange={onChange} onFlagClick={() => {}} />);
    const name = screen.getByLabelText("Your name") as HTMLInputElement;
    expect(name.value).toBe("Ada Lovelace");
    fireEvent.change(name, { target: { value: "Ada L" } });
    expect(onChange).toHaveBeenCalledWith({ name: "Ada L" });
  });

  it("titles the summary section from summary_title", () => {
    render(<ResumeForm profile={make({ summary_title: "Objective" })} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    expect(screen.getByRole("heading", { name: "Objective" })).toBeTruthy();
  });

  it("reorders a section with the down control", () => {
    const onChange = vi.fn();
    const profile = make({ summary: "S", skills: ["ts"], section_order: ["summary", "skills"] });
    render(<ResumeForm profile={profile} report={null} onChange={onChange} onFlagClick={() => {}} />);
    fireEvent.click(screen.getByLabelText("Move Professional Summary down"));
    expect(onChange).toHaveBeenCalledWith({ section_order: ["skills", "summary"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/resume/ResumeForm.test.tsx`
Expected: FAIL — `ResumeForm` does not exist.

- [ ] **Step 3: Add `maxHeight` to `EditableArea`**

In `frontend/src/components/resume/Editable.tsx`, replace the `EditableArea` function body:

```tsx
export function EditableArea({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
  rows = 1,
  maxHeight,
}: TextProps & { rows?: number; maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const target = maxHeight ? Math.min(el.scrollHeight, maxHeight) : el.scrollHeight;
    el.style.height = `${target}px`;
    el.style.overflowY = maxHeight && el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);

  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`rd-edit ${className}`}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
```

- [ ] **Step 4: Create `ResumeForm.tsx` (shell + Basics + Summary)**

```tsx
// frontend/src/components/resume/ResumeForm.tsx
import { useMemo, useRef } from "react";
import type { AnalysisReport, CustomSection, ResumeProfile, SectionKey, Severity } from "../../lib/resumeProfile";
import { findCustom, orderedSections, sectionFlags, sectionLabel } from "../../lib/resumeProfile";
import { BulletList, ChipList, EditableArea, EditableText } from "./Editable";
import { SEVERITY_LABEL } from "./SeverityRail";

type Update = (patch: Partial<ResumeProfile>) => void;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="rd-field">
      <span className="rd-field-label">{label}</span>
      {children}
    </label>
  );
}

function DateRange({ start, end, onStart, onEnd, label }: {
  start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void; label: string;
}) {
  return (
    <div className="rd-field-row">
      <Field label="Start"><EditableText value={start} onChange={onStart} ariaLabel={`${label} start date`} placeholder="e.g. 2023" /></Field>
      <Field label="End"><EditableText value={end} onChange={onEnd} ariaLabel={`${label} end date`} placeholder="Present" /></Field>
    </div>
  );
}

function EntryCard({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }) {
  return (
    <div className="rd-entry-card">
      <div className="rd-entry-card-body">{children}</div>
      <button type="button" className="rd-entry-del" aria-label={`Remove ${label}`} onClick={onRemove}>
        <i className="fa-solid fa-trash-can" /> Remove
      </button>
    </div>
  );
}

export default function ResumeForm({
  profile,
  report,
  onChange,
  onFlagClick,
}: {
  profile: ResumeProfile;
  report: AnalysisReport | null;
  onChange: Update;
  onFlagClick: (severity: Severity) => void;
}) {
  const keys = useMemo(() => orderedSections(profile), [profile]);
  const liveRef = useRef<HTMLDivElement>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    const next = [...keys];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange({ section_order: next });
    if (liveRef.current) {
      liveRef.current.textContent = `${sectionLabel(profile, moved)} moved to position ${to + 1} of ${next.length}`;
    }
  };

  const setCustom = (id: string, patch: Partial<CustomSection>) =>
    onChange({ custom_sections: profile.custom_sections.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  return (
    <div className="rd-form">
      <div ref={liveRef} aria-live="polite" className="sr-only" style={{ position: "absolute", left: "-9999px" }} />

      <section className="rd-form-section" aria-label="Basics">
        <div className="rd-form-head"><h2 className="rd-form-title">Basics</h2></div>
        <div className="rd-form-body">
          <Field label="Full name"><EditableText value={profile.name} onChange={(name) => onChange({ name })} ariaLabel="Your name" placeholder="Your name" /></Field>
          <div className="rd-field-row">
            <Field label="Email"><EditableText value={profile.email} onChange={(email) => onChange({ email })} ariaLabel="Email" placeholder="you@email.com" /></Field>
            <Field label="Phone"><EditableText value={profile.phone} onChange={(phone) => onChange({ phone })} ariaLabel="Phone" placeholder="(555) 555-5555" /></Field>
          </div>
          <Field label="Location"><EditableText value={profile.location} onChange={(location) => onChange({ location })} ariaLabel="Location" placeholder="City, Region" /></Field>
          <div className="rd-field-row">
            <Field label="LinkedIn"><EditableText value={profile.linkedin_url} onChange={(linkedin_url) => onChange({ linkedin_url })} ariaLabel="LinkedIn URL" placeholder="linkedin.com/in/you" /></Field>
            <Field label="GitHub"><EditableText value={profile.github_url} onChange={(github_url) => onChange({ github_url })} ariaLabel="GitHub URL" placeholder="github.com/you" /></Field>
          </div>
          <Field label="Other link"><EditableText value={profile.other_link} onChange={(other_link) => onChange({ other_link })} ariaLabel="Portfolio or other link" placeholder="your-site.com" /></Field>
        </div>
      </section>

      {keys.map((key, index) => {
        const label = sectionLabel(profile, key);
        const flags = sectionFlags(report, label);
        return (
          <section key={key} className="rd-form-section" aria-label={label}>
            <div className="rd-form-head">
              <div className="rd-reorder">
                <button type="button" className="rd-reorder-btn" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => move(index, index - 1)}><i className="fa-solid fa-chevron-up" /></button>
                <button type="button" className="rd-reorder-btn" aria-label={`Move ${label} down`} disabled={index === keys.length - 1} onClick={() => move(index, index + 1)}><i className="fa-solid fa-chevron-down" /></button>
              </div>
              <h2 className="rd-form-title">{label}</h2>
              {flags.length > 0 && (
                <div className="rd-section-flags">
                  {flags.map(({ severity, count }) => (
                    <button
                      key={severity}
                      type="button"
                      className="rd-flag"
                      data-severity={severity}
                      onClick={() => onFlagClick(severity)}
                      title={`See the ${count} ${SEVERITY_LABEL[severity].toLowerCase()} finding${count === 1 ? "" : "s"} for ${label}`}
                    >
                      {count} {SEVERITY_LABEL[severity]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="rd-form-body">
              {key === "summary" && (
                <EditableArea
                  value={profile.summary}
                  onChange={(summary) => onChange({ summary })}
                  ariaLabel="Professional summary"
                  placeholder="Two or three sentences on what you do and what you've shipped."
                  className="rd-edit-area"
                  maxHeight={200}
                />
              )}
              {/* experience / education added in Task 3 */}
              {/* projects / skills / technologies / custom added in Task 4 */}
            </div>
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/resume/ResumeForm.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/resume/ResumeForm.tsx frontend/src/components/resume/ResumeForm.test.tsx frontend/src/components/resume/Editable.tsx
git commit -m "$(cat <<'EOF'
feat(resume): ResumeForm shell with Basics, Summary, reorder, and finding flags

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ResumeForm` — Experience & Education

Add the Experience and Education section bodies with labelled, full-width fields, plus add/remove entry.

**Files:**
- Modify: `frontend/src/components/resume/ResumeForm.tsx` (add two `key === …` blocks in the section body)
- Modify: `frontend/src/components/resume/ResumeForm.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `EntryCard`, `Field`, `DateRange`, `EditableText`, `BulletList`, `ChipList` (all in-file / from `./Editable`).

- [ ] **Step 1: Write the failing tests**

Append to `ResumeForm.test.tsx`:

```tsx
describe("ResumeForm — experience & education", () => {
  it("renders a role and edits its title", () => {
    const onChange = vi.fn();
    const profile = make({
      experience: [{ company: "Acme", title: "Engineer", location: "NYC", start_date: "2022", end_date: "2024", bullets: ["Shipped X"] }],
    });
    render(<ResumeForm profile={profile} report={null} onChange={onChange} onFlagClick={() => {}} />);
    const title = screen.getByLabelText("Job title 1") as HTMLInputElement;
    expect(title.value).toBe("Engineer");
    fireEvent.change(title, { target: { value: "Senior Engineer" } });
    expect(onChange).toHaveBeenCalledWith({
      experience: [expect.objectContaining({ title: "Senior Engineer" })],
    });
  });

  it("shows the full degree in a full-width input (no size cap)", () => {
    const profile = make({
      education: [{ school: "University of Ottawa", degree: "Honours BSc. Translation and Interpretation", location: "Ottawa, ON", start_date: "2025", end_date: "2027", gpa: "3.9", achievements: [], coursework: [] }],
    });
    render(<ResumeForm profile={profile} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    const degree = screen.getByLabelText("Degree 1") as HTMLInputElement;
    expect(degree.value).toBe("Honours BSc. Translation and Interpretation");
    expect(degree.getAttribute("size")).toBeNull(); // width comes from CSS, never a char cap
  });

  it("adds a school", () => {
    const onChange = vi.fn();
    const profile = make({ education: [{ school: "MIT", degree: "BSc", location: "", start_date: "", end_date: "", gpa: "", achievements: [], coursework: [] }] });
    render(<ResumeForm profile={profile} report={null} onChange={onChange} onFlagClick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a school/i }));
    expect(onChange).toHaveBeenCalledWith({ education: expect.arrayContaining([expect.objectContaining({ school: "MIT" }), expect.objectContaining({ school: "" })]) });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/resume/ResumeForm.test.tsx`
Expected: FAIL — no Experience/Education fields rendered.

- [ ] **Step 3: Add the Experience & Education blocks**

In `ResumeForm.tsx`, replace the `{/* experience / education added in Task 3 */}` comment with:

```tsx
{key === "experience" && (
  <>
    {profile.experience.map((exp, i) => {
      const patch = (p: Partial<typeof exp>) =>
        onChange({ experience: profile.experience.map((e, j) => (j === i ? { ...e, ...p } : e)) });
      return (
        <EntryCard key={i} label={exp.company || `experience ${i + 1}`} onRemove={() => onChange({ experience: profile.experience.filter((_, j) => j !== i) })}>
          <div className="rd-field-row">
            <Field label="Company"><EditableText value={exp.company} onChange={(company) => patch({ company })} ariaLabel={`Company ${i + 1}`} placeholder="Company" /></Field>
            <Field label="Job title"><EditableText value={exp.title} onChange={(title) => patch({ title })} ariaLabel={`Job title ${i + 1}`} placeholder="Job title" /></Field>
          </div>
          <div className="rd-field-row">
            <Field label="Location"><EditableText value={exp.location} onChange={(location) => patch({ location })} ariaLabel={`Location ${i + 1}`} placeholder="City, Region" /></Field>
            <div />
          </div>
          <DateRange start={exp.start_date} end={exp.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={exp.company || `Experience ${i + 1}`} />
          <Field label="Highlights"><BulletList bullets={exp.bullets} onChange={(bullets) => patch({ bullets })} label={exp.company || `Experience ${i + 1}`} /></Field>
        </EntryCard>
      );
    })}
    <button className="rd-add" onClick={() => onChange({ experience: [...profile.experience, { company: "", title: "", location: "", start_date: "", end_date: "", bullets: [""] }] })}>
      <i className="fa-solid fa-plus" /> Add a role
    </button>
  </>
)}

{key === "education" && (
  <>
    {profile.education.map((edu, i) => {
      const patch = (p: Partial<typeof edu>) =>
        onChange({ education: profile.education.map((e, j) => (j === i ? { ...e, ...p } : e)) });
      return (
        <EntryCard key={i} label={edu.school || `education ${i + 1}`} onRemove={() => onChange({ education: profile.education.filter((_, j) => j !== i) })}>
          <Field label="School"><EditableText value={edu.school} onChange={(school) => patch({ school })} ariaLabel={`School ${i + 1}`} placeholder="School" /></Field>
          <Field label="Degree"><EditableText value={edu.degree} onChange={(degree) => patch({ degree })} ariaLabel={`Degree ${i + 1}`} placeholder="e.g. Honours BSc. Translation and Interpretation" /></Field>
          <div className="rd-field-row">
            <Field label="Location"><EditableText value={edu.location} onChange={(location) => patch({ location })} ariaLabel={`Education location ${i + 1}`} placeholder="City, Region" /></Field>
            <Field label="GPA"><EditableText value={edu.gpa} onChange={(gpa) => patch({ gpa })} ariaLabel={`GPA ${i + 1}`} placeholder="e.g. 3.9 / 4.0" /></Field>
          </div>
          <DateRange start={edu.start_date} end={edu.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={edu.school || `Education ${i + 1}`} />
          <Field label="Achievements"><BulletList bullets={edu.achievements} onChange={(achievements) => patch({ achievements })} label={`${edu.school || "Education"} achievements`} /></Field>
          <Field label="Relevant coursework"><ChipList values={edu.coursework} onChange={(coursework) => patch({ coursework })} label="coursework" placeholder="Add a course…" /></Field>
        </EntryCard>
      );
    })}
    <button className="rd-add" onClick={() => onChange({ education: [...profile.education, { school: "", degree: "", location: "", start_date: "", end_date: "", gpa: "", achievements: [], coursework: [] }] })}>
      <i className="fa-solid fa-plus" /> Add a school
    </button>
  </>
)}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/components/resume/ResumeForm.test.tsx`
Expected: PASS (all shell + experience/education tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/resume/ResumeForm.tsx frontend/src/components/resume/ResumeForm.test.tsx
git commit -m "$(cat <<'EOF'
feat(resume): ResumeForm experience & education fields (full-width, no clipping)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `ResumeForm` — Projects, Skills, Technologies, Custom

Add the remaining section bodies so the form covers every section type `ResumeCanvas` did.

**Files:**
- Modify: `frontend/src/components/resume/ResumeForm.tsx`
- Modify: `frontend/src/components/resume/ResumeForm.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `ResumeForm.test.tsx`:

```tsx
describe("ResumeForm — projects, skills, technologies, custom", () => {
  it("edits a skill chip list", () => {
    const onChange = vi.fn();
    render(<ResumeForm profile={make({ skills: ["TypeScript"] })} report={null} onChange={onChange} onFlagClick={() => {}} />);
    expect(screen.getByText("TypeScript")).toBeTruthy();
    const add = screen.getByLabelText("Add to skills");
    fireEvent.change(add, { target: { value: "React" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ skills: ["TypeScript", "React"] });
  });

  it("renders a technologies group and a project", () => {
    const profile = make({
      technologies: { Languages: ["Python"] },
      projects: [{ name: "Tailrd", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: ["Built it"] }],
    });
    render(<ResumeForm profile={profile} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    expect(screen.getByText("Languages")).toBeTruthy();
    expect((screen.getByLabelText("Project 1") as HTMLInputElement).value).toBe("Tailrd");
  });

  it("renders a custom section's items", () => {
    const profile = make({
      custom_sections: [{ id: "certs", title: "Certifications", kind: "certifications", text: "", bullets: [], items: [{ title: "AWS SAA", subtitle: "Amazon", location: "", start_date: "2024", end_date: "", detail: "", link: "", bullets: [] }] }],
      section_order: ["summary", "custom:certs"],
    });
    render(<ResumeForm profile={profile} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    expect(screen.getByRole("heading", { name: "Certifications" })).toBeTruthy();
    expect((screen.getByLabelText("Certifications entry 1") as HTMLInputElement).value).toBe("AWS SAA");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/resume/ResumeForm.test.tsx`
Expected: FAIL — projects/skills/technologies/custom not rendered.

- [ ] **Step 3: Add the remaining blocks**

In `ResumeForm.tsx`, replace `{/* projects / skills / technologies / custom added in Task 4 */}` with:

```tsx
{key === "projects" && (
  <>
    {profile.projects.map((proj, i) => {
      const patch = (p: Partial<typeof proj>) =>
        onChange({ projects: profile.projects.map((e, j) => (j === i ? { ...e, ...p } : e)) });
      return (
        <EntryCard key={i} label={proj.name || `project ${i + 1}`} onRemove={() => onChange({ projects: profile.projects.filter((_, j) => j !== i) })}>
          <div className="rd-field-row">
            <Field label="Project"><EditableText value={proj.name} onChange={(name) => patch({ name })} ariaLabel={`Project ${i + 1}`} placeholder="Project name" /></Field>
            <Field label="Organization"><EditableText value={proj.organization} onChange={(organization) => patch({ organization })} ariaLabel={`Project organization ${i + 1}`} placeholder="Course, club, or company" /></Field>
          </div>
          <Field label="Link"><EditableText value={proj.link} onChange={(link) => patch({ link })} ariaLabel={`Project link ${i + 1}`} placeholder="github.com/you/project" /></Field>
          <DateRange start={proj.start_date} end={proj.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={proj.name || `Project ${i + 1}`} />
          <Field label="Highlights"><BulletList bullets={proj.bullets} onChange={(bullets) => patch({ bullets })} label={proj.name || `Project ${i + 1}`} /></Field>
        </EntryCard>
      );
    })}
    <button className="rd-add" onClick={() => onChange({ projects: [...profile.projects, { name: "", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: [""] }] })}>
      <i className="fa-solid fa-plus" /> Add a project
    </button>
  </>
)}

{key === "skills" && (
  <Field label="Skills"><ChipList values={profile.skills} onChange={(skills) => onChange({ skills })} label="skills" placeholder="Add a skill…" /></Field>
)}

{key === "technologies" && (
  <>
    {Object.entries(profile.technologies).map(([category, items]) => (
      <Field key={category} label={category}>
        <ChipList values={items} onChange={(next) => onChange({ technologies: { ...profile.technologies, [category]: next } })} label={category} />
      </Field>
    ))}
  </>
)}

{key.startsWith("custom:") && (() => {
  const custom = findCustom(profile, key);
  if (!custom) return null;
  return (
    <>
      {custom.text && (
        <EditableArea value={custom.text} onChange={(text) => setCustom(custom.id, { text })} ariaLabel={custom.title} className="rd-edit-area" maxHeight={200} />
      )}
      {custom.items.map((it, i) => (
        <EntryCard key={i} label={it.title || `${custom.title} entry ${i + 1}`} onRemove={() => setCustom(custom.id, { items: custom.items.filter((_, j) => j !== i) })}>
          <div className="rd-field-row">
            <Field label="Name"><EditableText value={it.title} onChange={(title) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, title } : x)) })} ariaLabel={`${custom.title} entry ${i + 1}`} placeholder="Name" /></Field>
            <Field label="Issuer"><EditableText value={it.subtitle} onChange={(subtitle) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, subtitle } : x)) })} ariaLabel={`${custom.title} issuer ${i + 1}`} placeholder="Issuer or organization" /></Field>
          </div>
          <DateRange start={it.start_date} end={it.end_date}
            onStart={(start_date) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, start_date } : x)) })}
            onEnd={(end_date) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, end_date } : x)) })}
            label={it.title || custom.title} />
          {it.bullets.length > 0 && (
            <Field label="Details"><BulletList bullets={it.bullets} onChange={(bullets) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, bullets } : x)) })} label={it.title || custom.title} /></Field>
          )}
        </EntryCard>
      ))}
      {custom.bullets.length > 0 && (
        <Field label="Items"><BulletList bullets={custom.bullets} onChange={(bullets) => setCustom(custom.id, { bullets })} label={custom.title} /></Field>
      )}
      {custom.items.length === 0 && custom.bullets.length === 0 && !custom.text && (
        <button className="rd-add" onClick={() => setCustom(custom.id, { bullets: [""] })}>
          <i className="fa-solid fa-plus" /> Add a line
        </button>
      )}
    </>
  );
})()}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/components/resume/ResumeForm.test.tsx`
Expected: PASS (all ResumeForm tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/resume/ResumeForm.tsx frontend/src/components/resume/ResumeForm.test.tsx
git commit -m "$(cat <<'EOF'
feat(resume): ResumeForm projects, skills, technologies, and custom sections

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Two-pane layout in `ResumeDetail` + CSS, retire `ResumeCanvas`

Swap `ResumeCanvas` for the two-pane workspace (form + live preview) with an Edit/Preview toggle, add the CSS, and delete the old component.

**Files:**
- Modify: `frontend/src/pages/ResumeDetail.tsx`
- Modify: `frontend/src/resume-detail.css` (append the workspace/form styles; delete nothing existing)
- Delete: `frontend/src/components/resume/ResumeCanvas.tsx`
- Test: `frontend/src/pages/ResumeDetail.test.tsx`

**Interfaces:**
- Consumes: `ResumeForm` (Tasks 2–4); `FittedResume` from `../components/ResumeRenderer`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/ResumeDetail.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";

const get = vi.fn();
vi.mock("../auth/api", () => ({
  default: { get: (...a: any) => get(...a), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
// The real renderer measures layout; stub it for this wiring test.
vi.mock("../components/ResumeRenderer", () => ({
  default: () => <div data-testid="print-node" />,
  FittedResume: () => <div data-testid="live-preview" />,
}));

import ResumeDetail from "./ResumeDetail";
import { emptyProfile } from "../lib/resumeProfile";

const detail = {
  id: 1, name: "My CV", target_job_title: null, is_primary: true,
  profile: { ...emptyProfile(), name: "Ada Lovelace", summary: "Engineer." },
  analysis_report: null, created_at: "", updated_at: "",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/app/resume/1"]}>
      <Routes><Route path="/app/resume/:id" element={<ResumeDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe("ResumeDetail — two-pane workspace", () => {
  beforeEach(() => get.mockReset());

  it("shows the form and the live preview side by side", async () => {
    get.mockResolvedValue({ data: detail });
    renderPage();
    expect(await screen.findByLabelText("Your name")).toBeTruthy();
    expect(screen.getByTestId("live-preview")).toBeTruthy();
  });

  it("toggles the visible pane via data-pane", async () => {
    get.mockResolvedValue({ data: detail });
    const { container } = renderPage();
    await screen.findByLabelText("Your name");
    const ws = container.querySelector(".rd-workspace")!;
    expect(ws.getAttribute("data-pane")).toBe("edit");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(ws.getAttribute("data-pane")).toBe("preview"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/pages/ResumeDetail.test.tsx`
Expected: FAIL — no form / `.rd-workspace` / Preview tab yet.

- [ ] **Step 3: Update `ResumeDetail.tsx`**

1. Swap the editor import (line 7):

```tsx
// remove:  import ResumeCanvas from "../components/resume/ResumeCanvas";
// the renderer import already exists at line 4; extend it:
import ResumeRenderer, { FittedResume } from "../components/ResumeRenderer";
import ResumeForm from "../components/resume/ResumeForm";
```

2. Add pane state next to the other `useState`s (after line 39):

```tsx
const [pane, setPane] = useState<"edit" | "preview">("edit");
```

3. Replace the resume-view shell (the current `<div className="rd-shell">…<ResumeCanvas …/></div>`, lines 226–247) with:

```tsx
<div className="rd-workspace-wrap">
  {report ? (
    <ResumeScoreStrip
      report={report}
      analyzedAt={report.analyzed_at}
      analyzing={analyzing}
      onAnalyze={analyze}
      onViewReport={() => openReport(null)}
      onFocusSeverity={(severity) => openReport(severity as Severity)}
    />
  ) : (
    <UnanalyzedStrip onAnalyze={analyze} analyzing={analyzing} />
  )}

  <div className="rd-pane-toggle" role="tablist" aria-label="Editor or preview">
    <button role="tab" aria-selected={pane === "edit"} onClick={() => setPane("edit")}>Edit</button>
    <button role="tab" aria-selected={pane === "preview"} onClick={() => setPane("preview")}>Preview</button>
  </div>

  <div className="rd-workspace" data-pane={pane}>
    <div className="rd-editor-pane">
      <ResumeForm profile={profile} report={report} onChange={update} onFlagClick={(severity) => openReport(severity)} />
    </div>
    <aside className="rd-preview-pane" aria-label="Live preview">
      <FittedResume document={doc} />
    </aside>
  </div>
</div>
```

Leave the off-screen print node (lines 258–262) and every handler unchanged.

- [ ] **Step 4: Append CSS to `resume-detail.css`**

Add before the `/* ── Responsive ── */` block:

```css
/* ── Two-pane workspace ───────────────────────────────────────────────────── */

.rd-workspace-wrap { max-width: 88rem; margin: 0 auto; padding: 1.5rem; }

.rd-pane-toggle { display: none; }

.rd-workspace { margin-top: 1.5rem; }

@media (min-width: 56.25rem) {
  .rd-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }
  .rd-editor-pane { min-width: 0; }
  .rd-preview-pane { position: sticky; top: 4.75rem; min-width: 0; }
}

.rd-form { display: flex; flex-direction: column; gap: 1.25rem; }
.rd-form-section {
  background: #fff; border: 1px solid var(--rd-rule); border-radius: 12px;
  padding: 1.1rem 1.25rem 1.25rem; box-shadow: var(--shadow-card);
}
.rd-form-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.9rem; }
.rd-form-title { flex: 1; font-size: 0.95rem; font-weight: 650; letter-spacing: -0.01em; color: var(--rd-ink); }
.rd-reorder { display: inline-flex; flex-direction: column; gap: 1px; }
.rd-reorder-btn { border: 0; background: none; color: #c3cbd6; cursor: pointer; padding: 0 0.2rem; line-height: 1; }
.rd-reorder-btn:hover:not(:disabled) { color: var(--rd-ink); }
.rd-reorder-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.rd-form-body { display: flex; flex-direction: column; gap: 0.85rem; }
.rd-field { display: block; }
.rd-field-label {
  display: block; font-size: 0.7rem; font-weight: 650; letter-spacing: 0.05em;
  text-transform: uppercase; color: var(--rd-mute); margin-bottom: 0.3rem;
}
.rd-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; }

/* Inputs fill their field — the fix for the cut-off degree. */
.rd-form .rd-edit {
  width: 100%;
  border: 1px solid var(--rd-rule);
  background: #fff;
  padding: 0.5rem 0.6rem;
  border-radius: 8px;
}
.rd-form .rd-edit:hover { background: #fff; border-color: var(--stripe-hairline-input); }
.rd-form .rd-edit:focus { background: #fff; border-color: var(--stripe-primary); box-shadow: 0 0 0 3px var(--rd-optional-soft); }
.rd-form .rd-edit-area { min-height: 3rem; }

.rd-entry-card { border: 1px solid var(--rd-rule-soft); border-radius: 10px; padding: 0.9rem 1rem; }
.rd-entry-card + .rd-entry-card { margin-top: 0.85rem; }
.rd-entry-card-body { display: flex; flex-direction: column; gap: 0.85rem; }
.rd-entry-del {
  margin-top: 0.75rem; display: inline-flex; align-items: center; gap: 0.4rem;
  border: 0; background: none; color: var(--rd-mute); font: inherit; font-size: 0.8rem; cursor: pointer;
}
.rd-entry-del:hover { color: var(--rd-urgent); }

@media (max-width: 56.24rem) {
  .rd-pane-toggle {
    display: flex; width: 100%; margin: 1rem 0; padding: 0.2rem;
    background: var(--rd-rule-soft); border-radius: 10px;
  }
  .rd-pane-toggle button {
    flex: 1; border: 0; background: none; padding: 0.45rem 1rem;
    font: inherit; font-size: 0.85rem; font-weight: 600; color: var(--rd-mute);
    border-radius: 8px; cursor: pointer;
  }
  .rd-pane-toggle button[aria-selected="true"] { background: #fff; color: var(--rd-ink); box-shadow: var(--shadow-card); }
  .rd-workspace[data-pane="edit"] .rd-preview-pane { display: none; }
  .rd-workspace[data-pane="preview"] .rd-editor-pane { display: none; }
}
```

- [ ] **Step 5: Delete `ResumeCanvas.tsx`**

```bash
git rm frontend/src/components/resume/ResumeCanvas.tsx
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/pages/ResumeDetail.test.tsx && npx tsc --noEmit`
Expected: tests PASS; no TypeScript errors (confirms nothing still imports `ResumeCanvas`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/ResumeDetail.tsx frontend/src/pages/ResumeDetail.test.tsx frontend/src/resume-detail.css
git commit -m "$(cat <<'EOF'
feat(resume): two-pane editor + live preview; retire the inline sheet

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full verification (tests + browser)

Confirm the redesign actually fixes the reported problems and keeps the AI intact.

**Files:** none (verification only).

- [ ] **Step 1: Run the touched test files**

Run:
```bash
cd frontend && npx vitest run \
  src/__tests__/resume-section-flags.test.ts \
  src/components/resume/ResumeForm.test.tsx \
  src/pages/ResumeDetail.test.tsx
```
Expected: all PASS. (The wider suite has a known pre-existing failure baseline — JobDetailView, inline-panel, resume.property — unrelated to this change.)

- [ ] **Step 2: Browser verification** — use the `verify` skill / run the app (`cd frontend && npm run dev`) against a real résumé with a long degree, and confirm each:
  - The **degree renders in full** (no "Translatio…" clip); the GPA field reads "GPA" with its own value; no dead right-side space.
  - **Typing in the form updates the live preview**; the preview matches the résumé.
  - **Export PDF** still produces the correct document (unchanged off-screen node).
  - **Analyze** → score strip + full report render; a **section finding flag** in the form jumps to the report at that severity.
  - **Improve** → review modal → Apply → the form **and** preview reflect the rewrite.
  - **Responsive:** two columns ≥900px; below it, the **Edit / Preview toggle** switches panes.

- [ ] **Step 3: Commit any fixes** found during verification, then the branch is ready for a PR.

---

## Self-Review

**Spec coverage:**
- Two-pane layout, sticky preview, score strip, topbar → Task 5. ✓
- Form editor, all section types, full-width fields, reorder, add/remove → Tasks 2–4. ✓
- Per-section finding flags → Tasks 1 (helper) + 2 (render). ✓
- Live preview via `FittedResume`; export keeps the off-screen node → Task 5. ✓
- AI preserved (Analyze/report/Improve untouched; flags carried over) → Global Constraints + Tasks 1/2/5. ✓
- Responsive Edit/Preview toggle at 900px → Task 5. ✓
- Retire `ResumeCanvas` → Task 5. ✓
- Optional AI-change highlight in preview → explicitly out of scope (spec §5.4/§9); not a task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test shows real assertions. ✓

**Type consistency:** `sectionFlags(report, label)` signature matches its call site in ResumeForm; `ResumeForm` prop names (`profile`, `report`, `onChange`, `onFlagClick`) match the `ResumeDetail` call site and the `ResumeCanvas` contract; `EditableArea` `maxHeight?: number` matches its two usages (summary, custom text). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-10-resume-detail-two-pane-editor.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
