# Student-first experience taxonomy + onboarding consolidation

Date: 2026-07-13
Status: Approved (user pre-authorised approval while away)

## Problem

Friend-of-user feedback on onboarding:

1. The experience-level options are not understandable to the target user. They should
   speak in student terms (internship, co-op, …).
2. "Director" and "Executive" must go.
3. Job Type belongs on the same page as experience level.
4. The optional "specific roles you're targeting" page is not needed — remove it.
5. All of the above must hold **app-wide**, not just in onboarding.

## Ground truth that reframes the problem

The production database (`scraped_jobs`, Neon project `divine-base-11638078`) contains
exactly two experience levels:

| experience_level | rows   |
|------------------|--------|
| `new_grad`       | 24,254 |
| `internship`     | 3,594  |

Nothing else. Ever. Jobs are seeded from GitHub internship / new-grad repos, and
`AggregatorService._get_experience_level()` can only ever emit those two strings.

Meanwhile the UI (`EXPERIENCE_OPTIONS` in `JobFilterBar.tsx`) offers six levels, and
`EXPERIENCE_FILTER_MAP` (`backend/services/job_filters.py`) expands them to:

| UI option              | expands to                            | jobs returned |
|------------------------|---------------------------------------|---------------|
| Intern/New Grad        | internship, new_grad, intern_new_grad | **all**       |
| Entry Level            | new_grad, entry, internship           | **all** (dupe)|
| Mid Level              | mid, associate                        | **0**         |
| Senior                 | senior, sr                            | **0**         |
| Lead/Staff             | lead, staff, principal                | **0**         |
| Director/Executive     | director, executive, vp               | **0**         |

So the experience picker is decorative: four options are dead ends that silently return
an empty job list, and the two live options are duplicates of each other. The friend's
"people won't understand the options" is the *symptom*; the disease is that the options
describe a job catalogue we do not have. Tailrd is an internship / new-grad board.

This is the fix: make the taxonomy tell the truth, in the words students use.

## Design

### 1. Canonical taxonomy (single source of truth)

`EXPERIENCE_OPTIONS` in `frontend/src/components/JobFilterBar.tsx` is already imported by
both the Jobs filter bar and the onboarding step, so it stays the one definition:

```ts
export const EXPERIENCE_OPTIONS = [
  { value: "internship", label: "Internship / Co-op" },
  { value: "new_grad",   label: "New Grad / Entry Level" },
];
```

Deliberate choices:

- **Values equal the DB spellings** (`internship`, `new_grad`). This means **no
  `scraped_jobs` data migration** — the UI now speaks the database's own language.
- **Co-op is a label, not a separate option.** Co-op postings live in the same
  `internship` bucket, so a distinct "Co-op" option would return a result set identical
  to "Internship" — two buttons that do the same thing is worse than one button that
  names both. The label carries both the US ("internship", "entry level") and Canadian
  ("co-op", "new grad") vocabulary, which is what the feedback was really asking for.
- Mid / Senior / Lead/Staff / Director/Executive are **deleted**, satisfying (2).

### 2. Onboarding: 5 steps → 4

| # | Step      | Contents                                                        |
|---|-----------|-----------------------------------------------------------------|
| 1 | welcome   | first / last name (unchanged)                                   |
| 2 | role      | job function, location, work authorisation — **Job Type leaves**|
| 3 | experience| **experience level + Job Type** (new combined step)              |
| 4 | resume    | required upload (unchanged)                                     |

- The `targets` step (`TargetTitlesStep`) is **deleted**, satisfying (4).
- Job Type moves onto the experience step, satisfying (3).
- Headline changes from "How much **experience** do you have?" (the phrasing being
  complained about) to "Are you looking for an **internship** or a **new grad** role?",
  and the field label from "Experience level" to "I'm looking for".

### 3. Job Type

Moves verbatim to the experience step with one change: the `internship` option is
**removed** from the Job Type list, because the experience question now owns that
concept. Leaving it in both places is the exact overlap that makes the page confusing.

```ts
const JOB_TYPES = [
  { value: "full_time", label: "Full-time" },
  { value: "part_time", label: "Part-time" },
  { value: "contract",  label: "Contract" },
];
```

Job Type remains **optional and captured-only** — there is no `job_type` column on
`scraped_jobs`, so it has never filtered anything, and this change does not pretend
otherwise. Storage is unchanged (`settings.prefilled_answers.job_types`).

### 4. App-wide propagation (requirement 5)

**a. Shared constant.** The Jobs filter bar (desktop dropdown + mobile drawer) and the
onboarding step both read `EXPERIENCE_OPTIONS`, so both update from the single edit.

**b. Legacy filter self-heal — the real app-wide bug.** `Jobs.tsx` rehydrates
`localStorage["job-aggregator-filters"]` without validating it. An existing user with
`experience_level: ["senior"]` (or `["intern_new_grad"]`) saved would, after this change,
carry an **invisible filter** — no checkbox renders for it, so it cannot be cleared, and
it silently returns zero jobs. New helper in `JobFilterBar.tsx`:

```ts
export function normalizeExperienceLevels(values: unknown): string[]
```

- `intern_new_grad` → `["internship", "new_grad"]`
- `entry` → `["new_grad"]`
- `mid` | `senior` | `lead` | `director` → dropped (they matched nothing anyway; dropping
  restores a working, unfiltered view instead of a silent empty one)
- unknown / malformed → dropped
- output deduped, order-stable

Applied in `Jobs.tsx` on rehydrate, so stale filters heal on next page load.

**c. Backend tolerance.** `EXPERIENCE_FILTER_MAP` gains the canonical values and keeps
the legacy keys, so a stale client, an in-flight tab, or a bookmarked
`/jobs?experience_level=intern_new_grad` URL keeps working:

```py
EXPERIENCE_FILTER_MAP = {
    "internship": ["internship"],          # canonical
    "new_grad":   ["new_grad"],            # canonical
    "intern_new_grad": ["internship", "new_grad"],  # legacy
    "entry":      ["new_grad", "internship"],       # legacy
}
```

Legacy `mid`/`senior`/`lead`/`director` are dropped from the map; the existing
fall-through (`out.add(key)`) makes them expand to themselves and match zero rows —
exactly today's behaviour, so no old client changes behaviour for the worse.

**d. No data migrations.**
- `scraped_jobs`: not touched — UI values now *are* the stored values.
- `user_settings.experience_levels`: **deliberately not migrated.** No service reads this
  column (verified: zero consumers in `backend/services`, `backend/routers` outside the
  settings CRUD itself). It is write-only state, so a production `UPDATE` would carry
  risk for zero benefit. New writes are canonical; old rows are inert.

## Testing

Updated:
- `frontend/src/setup/__tests__/SetupWizard.test.tsx` — 4-step flow, new labels.
- `frontend/src/setup/__tests__/answersToFilters.test.ts` — canonical values.
- `frontend/src/__tests__/jobFilters.property.test.tsx` — canonical value set.
- `backend/tests/test_job_filters_api.py` — legacy alias still resolves.

New:
- `normalizeExperienceLevels` unit + property tests: legacy migration, unknown-value
  rejection, dedup, idempotence (`normalize(normalize(x)) === normalize(x)`).
- Backend: canonical `internship` / `new_grad` filter values resolve to the right rows;
  legacy `intern_new_grad` still spans both.

## Out of scope

- Making Job Type actually filter jobs (needs a `job_type` column + scraper support).
- Moving `job_types` / `work_authorization` out of the `prefilled_answers` grab-bag.
- Broadening the job catalogue beyond internship / new-grad.
