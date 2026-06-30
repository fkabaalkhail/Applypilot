# Applied Confirmation Flow + Applications Page

## Problem

The dashboard ("Jobs") page has an "Applied" tab, but there's no way for a
job to actually get marked applied except through the fully-automated
extension apply flow (`POST /apply/{session_id}/complete`). When a user
manually clicks "Apply with Autofill" or "View Original Post" and applies
on the external site themselves, nothing in Tailrd records it. The
dashboard's "Applied" tab is therefore redundant with the (currently stub)
"Applications" page in the left sidebar, and neither reliably reflects
reality.

## Goals

1. Detect when a user returns to the Tailrd tab after clicking an apply-type
   link, and ask them "Did you apply?"
2. On "yes", record the application (with a timestamp) and mark the job
   applied.
3. Build a real Applications page (replacing the stub) that lists applied
   jobs with their applied date.
4. Remove the now-redundant "Applied" tab from the dashboard.

## Non-goals

- Editing application status (interviewing/rejected/offer) from this page —
  out of scope, no UI requested for it.
- Persisting the pending-confirmation queue across a full page reload —
  the SPA shell stays mounted while the user alt-tabs to the external site,
  so in-memory state is sufficient.
- Changing the existing extension-driven apply flow
  (`ApplyFlowModal.tsx`, `/apply/{session_id}/complete`) — untouched.

## Design

### 1. Apply-click tracking (frontend, global)

New `frontend/src/context/ApplyTracking.tsx` exporting:

- `ApplyTrackingProvider` — holds an in-memory FIFO queue of
  `{ id: number; title: string; company: string }` pending confirmations,
  plus the currently-displayed item (if any).
- `useApplyTracking()` — hook returning `registerApplyClick(job)`.

Mounted once in `App.tsx`, wrapping `<Outlet/>`, so the queue survives
in-app route changes (it must NOT be scoped to the Jobs page, since the
user could navigate elsewhere in Tailrd before refocusing the tab).

Three call sites get an `onClick` (in addition to their existing
`target="_blank"` navigation — the click is not prevented):

- `frontend/src/pages/Jobs.tsx` — "APPLY WITH AUTOFILL" anchor (job card
  footer).
- `frontend/src/components/JobDetailView.tsx` — "Apply with Autofill" and
  "View Original Post" anchors.

Each calls `registerApplyClick({ id: job.id, title: job.title, company:
job.company })`.

### 2. Tab-refocus detection → confirmation modal

`ApplyTrackingProvider` listens for `document.visibilitychange`. When
`document.visibilityState === "visible"`, the queue is non-empty, and no
confirmation is currently being shown, it shifts the front of the queue
into "current" and the provider renders `ApplyConfirmModal`.

`ApplyConfirmModal` (new component, `frontend/src/components/
ApplyConfirmModal.tsx`): "Did you apply to **{title}** at **{company}**?"
with Yes / No buttons. Reuses the existing `modal-overlay` / `modal-content`
classes already used by the Refer modal in `App.tsx`.

- **Yes** → `POST /jobs/{id}/mark-applied` (fire and forget — log/ignore
  errors, same pattern as `toggleSave`). Then clear "current" and, if the
  queue still has items, pop the next one immediately (still within the
  same visibility-visible window) — one modal at a time, queued.
- **No** or backdrop dismiss → clear "current" only, no API call. Job is
  left exactly as-is. Pop the next queued item if any.

### 3. Backend: mark-applied endpoint

`POST /jobs/{job_id}/mark-applied` in `backend/routers/jobs.py`, auth via
`get_verified_user_id`:

```python
@router.post("/{job_id}/mark-applied", response_model=ApplicationOut)
def mark_applied(job_id, user_id=Depends(get_verified_user_id), db=Depends(get_db)):
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Job not found.")

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

This mirrors the existing precedent in `apply.py`'s `complete_apply` (sets
the same global `ScrapedJob.status` field), and dedupes on
`(user_id, job_id)` so re-confirming the same job updates the timestamp
instead of creating duplicate rows.

### 4. Applications page

`GET /jobs/applications` (already implemented in `jobs.py`) gets
`response_model=list[ApplicationOut]` added — it currently returns raw
ORM rows with no schema, which is fragile. `ApplicationOut` already exists
in `backend/schemas/application.py` with exactly the fields needed
(`company`, `role`, `url`, `applied_at`, `status`, `platform`).

New `frontend/src/pages/Applications.tsx` replaces the stub route in
`main.tsx`. On mount, fetches `GET /jobs/applications`. Renders a list of
cards (styling adapted from the existing `.job-card` look used on the
dashboard, for visual consistency) showing company, role, a platform
badge, and "Applied on {formatted date}" using the same `timeAgo`/date
formatting helper pattern already in `Jobs.tsx`. Each card links out to
`url` (original posting) if present. Empty state: "No applications yet —
jobs you apply to will show up here."

### 5. Dashboard cleanup

In `frontend/src/pages/Jobs.tsx`:

- `TABS` drops the `{ label: "Applied", count: stats.applied }` entry →
  tabs become **All, Liked**.
- `filteredJobs` drops the `if (activeTab === "Applied") return j.status
  === "applied";` branch.

No change to which jobs appear in "All" — applied jobs keep showing there
exactly as before; only the redundant tab is removed.

## Data flow summary

```
click "Apply with Autofill" / "View Original Post"
  → registerApplyClick(job) enqueues {id, title, company}
  → new tab opens, external site, Tailrd tab loses focus
  ... user applies externally, switches back ...
  → visibilitychange fires (visible)
  → ApplyConfirmModal shows for queue[0]
      Yes → POST /jobs/{id}/mark-applied → ApplicationRecord upserted,
            ScrapedJob.status = applied → next queued item (if any)
      No  → no-op → next queued item (if any)
```

## Error handling

- `mark-applied` 404s if the job doesn't exist (shouldn't happen in
  practice since the id came from a job already rendered). Frontend
  swallows the error like `toggleSave` does today — the user already saw
  "Yes" register visually (modal closes); a failed write isn't worth a
  blocking error UI for this confirmation flow.
- If `GET /jobs/applications` fails, `Applications.tsx` shows the existing
  app-wide empty/error text pattern (`loading-text`/`empty-text` classes
  used elsewhere).

## Testing

- Extend `frontend/src/__tests__/jobs.property.test.tsx`: remove the
  Applied-tab case (already covered in the prior change), no further
  change needed here beyond what's already done.
- New `frontend/src/__tests__/applyTracking.test.tsx`: pure-function/unit
  tests for the queue reducer logic (register appends, yes/no both dequeue
  the front item, multiple registers process in FIFO order) — independent
  of the `visibilitychange` wiring, which is DOM-event-driven and not
  practical to unit test the same way.
- No backend test currently exists for `jobs.py`; given the per-user
  Liked-filter bug fix from earlier in this session also went untested at
  the backend level, this stays consistent with current repo conventions
  rather than introducing a new pattern unprompted.
