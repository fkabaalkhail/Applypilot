# Applied Confirmation Flow + Applications Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a user returns to the Tailrd tab after clicking an apply-type link, ask "Did you apply?", record the application with a timestamp on "yes", and replace the stub Applications page with a real list of applied jobs and their applied dates. Remove the now-redundant "Applied" dashboard tab.

**Architecture:** A global React context (`ApplyTrackingProvider`, mounted in `App.tsx`) queues `{id, title, company}` whenever an apply-type link is clicked, then listens for `document.visibilitychange` to surface one `ApplyConfirmModal` per queued job when the tab regains focus. "Yes" calls a new `POST /jobs/{id}/mark-applied` backend endpoint that upserts an `ApplicationRecord` and flips `ScrapedJob.status` to `applied`. A new `Applications.tsx` page lists records from the existing `GET /jobs/applications` endpoint.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Vitest (frontend), Neon Postgres.

## Global Constraints

- Spec doc: `docs/superpowers/specs/2026-06-30-applied-confirmation-and-applications-page-design.md` — follow it for anything not explicitly repeated here.
- No backend test added for `jobs.py` (matches existing repo convention — no backend tests exist for this router today).
- Reuse existing CSS classes (`.job-card`, `.modal-overlay`, `.modal-content`, `.btn-apply`, `.btn-outline`, `.btn-outline-detail`, `.loading-text`, `.empty-text`) wherever the visual need matches, to avoid duplicate styling.
- `ApplicationOut` schema (`backend/schemas/application.py:11-23`) already has the fields needed — do not create a new schema.
- `application_records` table already has all needed columns in the Neon dev DB (verified via `describe_table_schema`) — no migration required.

---

### Task 1: Remove the "Applied" tab from the dashboard

**Files:**
- Modify: `frontend/src/pages/Jobs.tsx:243-253`
- Test: `frontend/src/__tests__/jobs.property.test.tsx` (already only has All/Liked/Applied cases from the prior session change — this task drops the Applied case)

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new (pure removal)

- [ ] **Step 1: Update the failing-first test expectations**

Edit `frontend/src/__tests__/jobs.property.test.tsx`. Remove the `"Applied"` tab case from `filterByTab` and its test, since the dashboard will no longer have an Applied tab — the Applications page now owns this. Open the file and replace the `filterByTab` function:

```typescript
// Replicate the tab filtering logic from Jobs.tsx
function filterByTab(jobs: Job[], activeTab: string): Job[] {
  return jobs.filter((j) => {
    if (activeTab === "Liked") return j.saved;
    return true; // "All" shows everything
  });
}
```

Remove the `"Applied tab returns only jobs with status 'applied'"` test block entirely (the one using `status === "applied"` assertions), and remove `fc.constant("Applied")` from the `tabArb` oneof in the `"filtered results are a subset of the original jobs"` test, leaving:

```typescript
  it("filtered results are a subset of the original jobs", () => {
    const tabArb = fc.oneof(
      fc.constant("All"),
      fc.constant("Liked")
    );
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd frontend && node node_modules/vitest/vitest.mjs run src/__tests__/jobs.property.test.tsx`
Expected: PASS, 4 tests (down from 5 — the Applied-specific test was removed)

- [ ] **Step 3: Remove the Applied tab from Jobs.tsx**

In `frontend/src/pages/Jobs.tsx`, replace:

```typescript
  const TABS = [
    { label: "All", count: null },
    { label: "Liked", count: stats.saved_count },
    { label: "Applied", count: stats.applied },
  ];

  const filteredJobs = jobs.filter((j) => {
    if (activeTab === "Applied") return j.status === "applied";
    if (activeTab === "Liked") return j.saved;
    return true;
  });
```

with:

```typescript
  const TABS = [
    { label: "All", count: null },
    { label: "Liked", count: stats.saved_count },
  ];

  const filteredJobs = jobs.filter((j) => {
    if (activeTab === "Liked") return j.saved;
    return true;
  });
```

- [ ] **Step 4: Run the full frontend test suite to check for regressions**

Run: `cd frontend && node node_modules/vitest/vitest.mjs run`
Expected: All tests pass (no other file references the "Applied" tab label — confirmed via repo-wide grep during design).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Jobs.tsx frontend/src/__tests__/jobs.property.test.tsx
git commit -m "feat(dashboard): remove redundant Applied tab (covered by Applications page)"
```

---

### Task 2: Backend — `mark-applied` endpoint + fix `list_applications` response model

**Files:**
- Modify: `backend/routers/jobs.py:11` (imports), `backend/routers/jobs.py:286-302` (`list_applications`), insert new endpoint after `unsave_job` (currently ends at `backend/routers/jobs.py:625`, before `@router.post("/fix-empty-companies")`)

**Interfaces:**
- Consumes: `ScrapedJob`, `JobStatus`, `ApplicationRecord` (from `backend.db.models`, already imported in this file), `get_verified_user_id` (already imported)
- Produces: `POST /jobs/{job_id}/mark-applied` → `ApplicationOut`; `GET /jobs/applications` now typed as `list[ApplicationOut]`

- [ ] **Step 1: Add the `datetime` and `ApplicationOut` imports**

In `backend/routers/jobs.py`, change line 11 from:

```python
import logging
```

to:

```python
import datetime
import logging
```

Then change line 22 (the schemas import) from:

```python
from backend.schemas.jobs import ScrapedJobOut
```

to:

```python
from backend.schemas.jobs import ScrapedJobOut
from backend.schemas.application import ApplicationOut
```

- [ ] **Step 2: Add `response_model=list[ApplicationOut]` to `list_applications`**

In `backend/routers/jobs.py`, change:

```python
@router.get("/applications")
def list_applications(
```

to:

```python
@router.get("/applications", response_model=list[ApplicationOut])
def list_applications(
```

(The function body below stays exactly as-is — it already queries `ApplicationRecord` filtered by `user_id` and ordered by `applied_at.desc()`.)

- [ ] **Step 3: Add the `mark-applied` endpoint**

In `backend/routers/jobs.py`, find the end of `unsave_job` (it ends with `return _overlay_saved(db, [job], user_id)[0]` followed by the `fix-empty-companies` route). Insert this new endpoint directly after `unsave_job` and before `@router.post("/fix-empty-companies")`:

```python
@router.post("/{job_id}/mark-applied", response_model=ApplicationOut)
def mark_applied(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Record that the current user applied to a job (manual apply confirmation)."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    job.status = JobStatus.APPLIED

    record = (
        db.query(ApplicationRecord)
        .filter(ApplicationRecord.user_id == user_id, ApplicationRecord.job_id == job_id)
        .first()
    )
    if record:
        record.applied_at = datetime.datetime.utcnow()
    else:
        record = ApplicationRecord(
            user_id=user_id,
            job_id=job_id,
            platform=job.source_platform or "linkedin",
            company=job.company,
            role=job.title,
            url=job.url,
            applied_at=datetime.datetime.utcnow(),
        )
        db.add(record)

    db.commit()
    db.refresh(record)
    return record
```

- [ ] **Step 4: Verify the module imports cleanly**

Run: `cd backend && python -c "import ast; ast.parse(open('routers/jobs.py', encoding='utf-8').read())" && echo OK`
Expected: `OK`

Run: `python -c "from backend.routers import jobs"` from the repo root (`C:\Users\elmas\Desktop\Tailrd`)
Expected: no exceptions (confirms all imports resolve, including the new `ApplicationOut` and `datetime`)

- [ ] **Step 5: Commit**

```bash
git add backend/routers/jobs.py
git commit -m "feat(jobs): add mark-applied endpoint, type applications list response"
```

---

### Task 3: `ApplyTrackingProvider` — pending-confirmation queue

**Files:**
- Create: `frontend/src/context/ApplyTracking.tsx`
- Test: `frontend/src/__tests__/applyTracking.test.tsx`

**Interfaces:**
- Produces:
  - `ApplyTrackingProvider` — React component, props `{ children: React.ReactNode }`
  - `useApplyTracking()` — hook returning `{ registerApplyClick: (job: { id: number; title: string; company: string }) => void; current: { id: number; title: string; company: string } | null; confirmYes: () => void; confirmNo: () => void }`
  - `current` is the job currently awaiting confirmation (or `null`); the visibility-driven "pop the next item" logic and the `confirmYes`/`confirmNo` handlers live in the provider so `ApplyConfirmModal` (Task 4) just renders `current` and calls the two handlers.

This task isolates the **queue logic** as a plain reducer function so it's unit-testable without mocking `document.visibilitychange`. The provider wraps that reducer with the actual DOM listener.

- [ ] **Step 1: Write the failing test for the pure queue reducer**

Create `frontend/src/__tests__/applyTracking.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { applyQueueReducer, type ApplyQueueState, type PendingJob } from "../context/ApplyTracking";

const jobA: PendingJob = { id: 1, title: "Software Engineer", company: "Acme" };
const jobB: PendingJob = { id: 2, title: "Backend Intern", company: "Beta Corp" };

function initialState(): ApplyQueueState {
  return { queue: [], current: null };
}

describe("applyQueueReducer", () => {
  it("REGISTER appends to the queue when nothing is current", () => {
    const state = applyQueueReducer(initialState(), { type: "REGISTER", job: jobA });
    expect(state.queue).toEqual([]);
    expect(state.current).toEqual(jobA);
  });

  it("REGISTER queues behind an already-current job", () => {
    let state = applyQueueReducer(initialState(), { type: "REGISTER", job: jobA });
    state = applyQueueReducer(state, { type: "REGISTER", job: jobB });
    expect(state.current).toEqual(jobA);
    expect(state.queue).toEqual([jobB]);
  });

  it("SHOW_NEXT promotes the front of the queue to current when current is empty", () => {
    let state: ApplyQueueState = { queue: [jobA, jobB], current: null };
    state = applyQueueReducer(state, { type: "SHOW_NEXT" });
    expect(state.current).toEqual(jobA);
    expect(state.queue).toEqual([jobB]);
  });

  it("SHOW_NEXT is a no-op when current is already set", () => {
    let state: ApplyQueueState = { queue: [jobB], current: jobA };
    state = applyQueueReducer(state, { type: "SHOW_NEXT" });
    expect(state.current).toEqual(jobA);
    expect(state.queue).toEqual([jobB]);
  });

  it("DEQUEUE clears current and promotes the next queued job (FIFO)", () => {
    let state: ApplyQueueState = { queue: [jobB], current: jobA };
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toEqual(jobB);
    expect(state.queue).toEqual([]);
  });

  it("DEQUEUE with an empty queue leaves current null", () => {
    let state: ApplyQueueState = { queue: [], current: jobA };
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toBeNull();
    expect(state.queue).toEqual([]);
  });

  it("processes multiple registers in FIFO order across repeated dequeues", () => {
    let state = initialState();
    state = applyQueueReducer(state, { type: "REGISTER", job: jobA });
    state = applyQueueReducer(state, { type: "REGISTER", job: jobB });
    expect(state.current).toEqual(jobA);
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toEqual(jobB);
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node node_modules/vitest/vitest.mjs run src/__tests__/applyTracking.test.tsx`
Expected: FAIL — `Failed to resolve import "../context/ApplyTracking"`

- [ ] **Step 3: Implement `ApplyTracking.tsx`**

Create `frontend/src/context/ApplyTracking.tsx`:

```typescript
import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import api from "../auth/api";

export interface PendingJob {
  id: number;
  title: string;
  company: string;
}

export interface ApplyQueueState {
  queue: PendingJob[];
  current: PendingJob | null;
}

type ApplyQueueAction =
  | { type: "REGISTER"; job: PendingJob }
  | { type: "SHOW_NEXT" }
  | { type: "DEQUEUE" };

export function applyQueueReducer(state: ApplyQueueState, action: ApplyQueueAction): ApplyQueueState {
  switch (action.type) {
    case "REGISTER":
      if (state.current === null) {
        return { ...state, current: action.job };
      }
      return { ...state, queue: [...state.queue, action.job] };
    case "SHOW_NEXT": {
      if (state.current !== null || state.queue.length === 0) {
        return state;
      }
      const [next, ...rest] = state.queue;
      return { current: next, queue: rest };
    }
    case "DEQUEUE": {
      if (state.queue.length === 0) {
        return { current: null, queue: [] };
      }
      const [next, ...rest] = state.queue;
      return { current: next, queue: rest };
    }
    default:
      return state;
  }
}

interface ApplyTrackingContextValue {
  registerApplyClick: (job: PendingJob) => void;
  current: PendingJob | null;
  confirmYes: () => void;
  confirmNo: () => void;
}

const ApplyTrackingContext = createContext<ApplyTrackingContextValue | null>(null);

export function ApplyTrackingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(applyQueueReducer, { queue: [], current: null });

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        dispatch({ type: "SHOW_NEXT" });
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  function registerApplyClick(job: PendingJob) {
    dispatch({ type: "REGISTER", job });
  }

  function confirmYes() {
    const job = state.current;
    if (job) {
      api.post(`/jobs/${job.id}/mark-applied`).catch(() => {
        // Silently fail — the user already confirmed visually; not worth a blocking error UI.
      });
    }
    dispatch({ type: "DEQUEUE" });
  }

  function confirmNo() {
    dispatch({ type: "DEQUEUE" });
  }

  return (
    <ApplyTrackingContext.Provider value={{ registerApplyClick, current: state.current, confirmYes, confirmNo }}>
      {children}
    </ApplyTrackingContext.Provider>
  );
}

export function useApplyTracking(): ApplyTrackingContextValue {
  const ctx = useContext(ApplyTrackingContext);
  if (!ctx) {
    throw new Error("useApplyTracking must be used within an ApplyTrackingProvider");
  }
  return ctx;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node node_modules/vitest/vitest.mjs run src/__tests__/applyTracking.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add frontend/src/context/ApplyTracking.tsx frontend/src/__tests__/applyTracking.test.tsx
git commit -m "feat(applications): add ApplyTracking context with pending-confirmation queue"
```

---

### Task 4: `ApplyConfirmModal` component + styling

**Files:**
- Create: `frontend/src/components/ApplyConfirmModal.tsx`
- Modify: `frontend/src/index.css` (append new rules near the existing `.refer-modal` block, after line 3398's `slideUp` keyframes)

**Interfaces:**
- Consumes: `useApplyTracking()` from `frontend/src/context/ApplyTracking.tsx` (Task 3) — uses `current`, `confirmYes`, `confirmNo`
- Produces: `ApplyConfirmModal` — default export, no props (reads everything from context), renders `null` when `current` is `null`

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/ApplyConfirmModal.tsx`:

```typescript
import { useApplyTracking } from "../context/ApplyTracking";

export default function ApplyConfirmModal() {
  const { current, confirmYes, confirmNo } = useApplyTracking();

  if (!current) return null;

  return (
    <div className="modal-overlay" onClick={confirmNo}>
      <div className="modal-content apply-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Did you apply?</h2>
        <p>
          Did you apply to <strong>{current.title}</strong> at <strong>{current.company}</strong>?
        </p>
        <div className="apply-confirm-actions">
          <button className="btn-outline" onClick={confirmNo}>
            No
          </button>
          <button className="btn-apply" onClick={confirmYes}>
            Yes, I applied
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add modal styling**

In `frontend/src/index.css`, after the `slideUp` keyframes block (ends around line 3398, right before the `/* Refer Modal */` comment), insert:

```css
/* Apply Confirm Modal */
.apply-confirm-modal {
  max-width: 420px;
  padding: 2rem;
}

.apply-confirm-modal h2 {
  font-size: 1.2rem;
  font-weight: 700;
  margin-bottom: 0.5rem;
}

.apply-confirm-modal p {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 1.5rem;
}

.apply-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}
```

- [ ] **Step 3: Verify the frontend still builds/typechecks**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors introduced by `ApplyConfirmModal.tsx` (existing unrelated errors, if any predate this change, are out of scope)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ApplyConfirmModal.tsx frontend/src/index.css
git commit -m "feat(applications): add ApplyConfirmModal component"
```

---

### Task 5: Wire up apply-click tracking across the app

**Files:**
- Modify: `frontend/src/App.tsx` (mount provider + modal)
- Modify: `frontend/src/pages/Jobs.tsx:411-423` (the apply link `onClick`)
- Modify: `frontend/src/components/JobDetailView.tsx:439-447` (the two apply/view links `onClick`)

**Interfaces:**
- Consumes: `ApplyTrackingProvider`, `useApplyTracking` (Task 3), `ApplyConfirmModal` (Task 4)
- Produces: nothing new for later tasks — this is the final wiring step for the confirmation flow

- [ ] **Step 1: Mount the provider and modal in `App.tsx`**

In `frontend/src/App.tsx`, add the imports at the top (after the existing `@phosphor-icons/react` import block, i.e. after line 21):

```typescript
import { ApplyTrackingProvider } from "./context/ApplyTracking";
import ApplyConfirmModal from "./components/ApplyConfirmModal";
```

Then wrap the returned JSX. Change:

```typescript
  return (
    <div className={`app-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
```

to:

```typescript
  return (
    <ApplyTrackingProvider>
    <div className={`app-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
```

And change the closing of the component's returned JSX. Find the end of the file:

```typescript
        </div>
      )}
    </div>
  );
}
```

(this is the closing `</div>` of `.app-layout`, immediately after the Refer modal's conditional block) and change it to:

```typescript
        </div>
      )}
      <ApplyConfirmModal />
    </div>
    </ApplyTrackingProvider>
  );
}
```

- [ ] **Step 2: Wire the Jobs.tsx dashboard apply link**

In `frontend/src/pages/Jobs.tsx`, add the import (after line 6, the `api` import):

```typescript
import { useApplyTracking } from "../context/ApplyTracking";
```

Inside `export default function Jobs() {`, right after the existing state declarations (after line 116, `const [filtersVisible, setFiltersVisible] = useState(true);`), add:

```typescript
  const { registerApplyClick } = useApplyTracking();
```

Then change the apply link (line 423):

```typescript
                    <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-apply">APPLY WITH AUTOFILL</a>
```

to:

```typescript
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-apply"
                      onClick={() => registerApplyClick({ id: job.id, title: job.title, company: job.company })}
                    >
                      APPLY WITH AUTOFILL
                    </a>
```

- [ ] **Step 3: Wire the JobDetailView.tsx apply/view links**

In `frontend/src/components/JobDetailView.tsx`, add the import (after line 25, the `api` import):

```typescript
import { useApplyTracking } from "../context/ApplyTracking";
```

Find the component function (it receives `{ job, onClose }: Props`) and add, near its other hooks:

```typescript
  const { registerApplyClick } = useApplyTracking();
```

Then change the two action links (lines 441-446):

```typescript
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-apply-detail">
            <PaperPlaneTilt size={16} weight="fill" /> Apply with Autofill
          </a>
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-outline-detail">
            <ArrowSquareOut size={16} weight="bold" /> View Original Post
          </a>
```

to:

```typescript
          <a
            href={applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-apply-detail"
            onClick={() => registerApplyClick({ id: job.id, title: job.title, company: job.company })}
          >
            <PaperPlaneTilt size={16} weight="fill" /> Apply with Autofill
          </a>
          <a
            href={applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-outline-detail"
            onClick={() => registerApplyClick({ id: job.id, title: job.title, company: job.company })}
          >
            <ArrowSquareOut size={16} weight="bold" /> View Original Post
          </a>
```

- [ ] **Step 4: Run the full frontend test suite**

Run: `cd frontend && node node_modules/vitest/vitest.mjs run`
Expected: All tests pass. (`JobDetailView.test.tsx` and `job-detail-inline-panel*.test.tsx` render `JobDetailView` — check their output for a new error like "must be used within an ApplyTrackingProvider"; if so, wrap the test's render call with `<ApplyTrackingProvider>` from `../context/ApplyTracking`, matching how those tests already wrap other providers, if any.)

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/Jobs.tsx frontend/src/components/JobDetailView.tsx
git commit -m "feat(applications): trigger apply confirmation on apply-link clicks"
```

---

### Task 6: Applications page

**Files:**
- Create: `frontend/src/pages/Applications.tsx`
- Modify: `frontend/src/main.tsx:21` (import), `frontend/src/main.tsx:52` (route)
- Modify: `frontend/src/index.css` (small addition for the applied-date badge)

**Interfaces:**
- Consumes: `GET /jobs/applications` (Task 2) → `ApplicationOut[]` shape: `{ id, platform, company, role, url, status, applied_at, notes, resume_version }`
- Produces: `Applications` — default export page component, no props (route-level page)

- [ ] **Step 1: Implement the page**

Create `frontend/src/pages/Applications.tsx`:

```typescript
import { useState, useEffect } from "react";
import api from "../auth/api";
import { avatarColor } from "../lib/companyLogo";
import { ArrowSquareOut, Calendar } from "@phosphor-icons/react";

interface ApplicationRecord {
  id: number;
  platform: string;
  company: string;
  role: string;
  url: string | null;
  status: string;
  applied_at: string;
  notes: string | null;
  resume_version: string | null;
}

function formatAppliedDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Applications() {
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApplications();
  }, []);

  async function fetchApplications() {
    setLoading(true);
    try {
      const res = await api.get("/jobs/applications");
      setApplications(res.data);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="jobs-page">
      <header className="jobs-header">
        <h1>Applications</h1>
      </header>

      <div className="jobs-content-area">
        <div className="jobs-feed">
          {loading && <p className="loading-text">Loading applications...</p>}
          {!loading && applications.length === 0 && (
            <p className="empty-text">No applications yet — jobs you apply to will show up here.</p>
          )}

          {applications.map((application) => (
            <div key={application.id} className="job-card">
              <div className="job-card-body">
                <div className="job-card-header">
                  <div className="company-logo-wrapper">
                    <div
                      className="company-logo"
                      style={{ backgroundColor: avatarColor(application.company) }}
                    >
                      {application.company.charAt(0).toUpperCase()}
                    </div>
                  </div>
                  <div className="job-card-info">
                    <div className="job-card-badges">
                      <span className="badge-time applied-date-badge">
                        <Calendar size={13} weight="duotone" /> Applied {formatAppliedDate(application.applied_at)}
                      </span>
                    </div>
                    <h2 className="job-title">{application.role}</h2>
                    <p className="job-company">{application.company}</p>
                  </div>
                </div>

                <div className="job-card-footer">
                  {application.url && (
                    <a href={application.url} target="_blank" rel="noopener noreferrer" className="btn-outline-detail">
                      <ArrowSquareOut size={16} weight="bold" /> View Posting
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add a small CSS rule for the applied-date badge**

In `frontend/src/index.css`, near the `.badge-time` rule (search for `.badge-time` to find it), add directly after that rule's closing brace:

```css
.applied-date-badge {
  color: var(--accent);
}
```

This tints the "Applied {date}" badge with the accent color so it reads as a status marker rather than the neutral "posted X ago" badge used on the dashboard.

- [ ] **Step 3: Wire the route in `main.tsx`**

In `frontend/src/main.tsx`, add the import after line 9 (`import JobsList from "./pages/JobsList";`):

```typescript
import Applications from "./pages/Applications";
```

Then replace the stub route (line 52):

```typescript
            <Route path="applications" element={<div className="page-stub"><h1>📋 Applications</h1><p>Track your applied jobs. Coming soon.</p></div>} />
```

with:

```typescript
            <Route path="applications" element={<Applications />} />
```

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `cd frontend && npx tsc --noEmit && node node_modules/vitest/vitest.mjs run`
Expected: no new type errors, all tests pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Applications.tsx frontend/src/main.tsx frontend/src/index.css
git commit -m "feat(applications): build Applications page, replace stub route"
```

---

## Manual verification (after all tasks)

Since this touches a live user flow (tab refocus, external navigation) that isn't fully covered by unit tests, do a manual pass after Task 6:

1. Start the backend (`uvicorn backend.main:app --reload` or the project's usual dev command) and frontend (`npm run dev` in `frontend/`).
2. On the dashboard, confirm only **All** and **Liked** tabs are present.
3. Click "APPLY WITH AUTOFILL" on a job card — it opens a new tab. Switch back to the Tailrd tab.
4. Confirm the "Did you apply?" modal appears with the correct job title/company.
5. Click "Yes, I applied" — confirm no console errors, then navigate to the Applications page (left sidebar) and confirm the job appears with today's date.
6. Repeat steps 3-4 but click "No" — confirm the job does *not* appear on the Applications page and the dashboard job is unchanged.
7. Open a job's detail panel, click "View Original Post", switch back — confirm the same modal flow triggers from the detail view too.
8. Click apply on two different jobs before switching back — confirm two modals appear sequentially (not simultaneously), one after the other.
