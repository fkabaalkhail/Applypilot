# Post-Signup Setup Wizard — Design

Date: 2026-07-01
Branch: (new) `feat/setup-wizard`
Status: Approved for planning

## Goal

After a user signs up and verifies their email, show a required, multi-step
setup wizard **before** they reach the dashboard. It collects job-search
preferences and (optionally) a resume, persists them, and — critically —
seeds the dashboard's job-feed filters so the very first dashboard load is
already personalized to the user's answers. The more the user answers, the
more tailored the initial feed.

Visual inspiration: Jobright's split-screen onboarding (assistant persona on
the left, form on the right), but rendered in Tailrd's existing purple theme,
not the reference green.

## Scope & Decisions

- **Flow:** sign up → verify email → **setup wizard** → dashboard → product
  tour auto-starts.
- **Required:** no "skip wizard" affordance; the header offers only Logout,
  and step buttons are Next / Start Matching. The resume step alone is
  skippable (a resume is not required to view jobs).
- **Separate from the product tour.** New flag `has_completed_setup` is
  distinct from the tour's `has_completed_onboarding`. The setup wizard
  collects data; the tour (already built) walks the UI.
- **Theme:** existing CSS tokens only (`--stripe-primary` #533afd, `--accent`,
  `--accent-light`, `--radius-card`, `--shadow-card`, `--text*`, `--border`).
- **Reuse existing infrastructure:** `UserSettings` already stores
  `job_title`, `location`, `remote_only`, `work_type`, `experience_levels`,
  `regions`; `PUT /settings` and `POST /settings/resume` already exist; the
  dashboard job feed reads `localStorage["job-aggregator-filters"]`
  (`JobFilters`) on init and queries `/jobs` with them.

## Routing & Gating

- New route `/setup` in `main.tsx`, rendered in its own full-screen layout
  (NOT inside the `/app` sidebar shell). Wrapped so only authenticated +
  email-verified users can see it.
- `frontend/src/auth/ProtectedRoute.tsx` gains one gate: after the existing
  auth + `isEmailVerified` checks, if `user.has_completed_setup === false`,
  redirect to `/setup`. This makes the wizard unavoidable before `/app`.
- `/setup` itself must guard the inverse: if `has_completed_setup === true`,
  redirect to `/app` (so finished users can't reopen it by URL).
- On finish, navigate to `/app`. The product tour's own auto-start fires there
  because `has_completed_onboarding` is still false.

### Interaction with the product tour
Sequencing is guaranteed by data, not timing: the tour only auto-starts on
`/app`, which the user cannot reach until `has_completed_setup` is true. No
coupling between the two systems is required.

## Backend

### DB flag + migration
- Add `users.has_completed_setup BOOLEAN NOT NULL DEFAULT false` to the `User`
  model (`backend/db/models.py`).
- Idempotent migration `backend/migrations/add_setup_field.py` (same pattern
  as `add_onboarding_field.py`): inspect columns, `ALTER TABLE ... ADD COLUMN
  ... BOOLEAN NOT NULL DEFAULT false`, skip if present. Register + invoke on
  startup in `backend/main.py` alongside the other `run_*_migration()` calls.

### Endpoints
- Expose `has_completed_setup` in the `GET /auth/me` and `PUT /auth/me`
  response dicts (`backend/routers/auth.py`), next to `has_completed_onboarding`.
- New `POST /auth/me/setup` with body `{ "completed": bool }` — mirrors the
  existing `set_onboarding` endpoint (depends on `get_current_user_id`, loads
  the user, sets the flag, returns the `/me` payload).
- Preference data itself is saved through the **existing** `PUT /settings`
  and `POST /settings/resume` — no new settings endpoint needed. Work
  Authorization (and any answer without a dedicated settings column) is stored
  in `prefilled_answers` (existing `dict[str,str]` field).

### Frontend auth wiring
- `UserProfile` (`AuthContext.tsx`) gains `has_completed_setup?: boolean`.
- `AuthContextValue` gains `setSetupComplete(completed: boolean): Promise<void>`;
  `AuthProvider` implements it (POST `/auth/me/setup`, `setUser(data)`), mirroring
  the existing `setOnboardingComplete`.

## Frontend Framework (`frontend/src/setup/`)

Config-driven, mirroring the tour's separation of concerns.

```
setup/
  types.ts             # SetupStep, SetupAnswers, StepProps
  setupConfig.tsx      # ordered steps (left headline + render + validate)
  SetupWizard.tsx      # state machine (answers + current step), submit orchestration
  SetupLayout.tsx      # split screen: gradient assistant panel (left) + form (right) + progress dots
  answersToFilters.ts  # pure map: SetupAnswers -> JobFilters (for localStorage seeding)
  steps/
    WelcomeNameStep.tsx
    RolePreferencesStep.tsx
    ExperienceStep.tsx
    TargetTitlesStep.tsx
    ResumeStep.tsx
  setup.css            # token-based styling
  index.ts             # public entry (SetupWizard)
```

- framer-motion for step transitions (fade/slide), matching the tour's premium
  feel. Confine framer-motion to `SetupLayout.tsx`/step components as needed;
  keep it out of the pure logic modules (`types`, `setupConfig` data,
  `answersToFilters`, the reducer).

### Types

```ts
interface SetupAnswers {
  first_name: string;
  last_name: string;
  job_function: string;            // primary target function/title
  job_types: string[];             // "full_time" | "part_time" | "contract" | "internship"
  country: string;                 // "CA" | "US" | ""
  city: string;
  open_to_remote: boolean;
  work_authorization: string[];    // e.g. ["needs_sponsorship"]
  experience_level: string;        // "intern_new_grad" | "entry" | "mid" | "senior" | "lead"
  target_titles: string[];         // extra chips to sharpen matching
}

interface SetupStep {
  id: string;
  headline: string;                // shown in the left assistant panel
  Component: React.ComponentType<StepProps>;
  validate?: (a: SetupAnswers) => string | null; // error message or null
}
```

## Steps

1. **welcome-name** — headline "Welcome to Tailrd — let's set up your search."
   Fields: first/last name (pre-filled from `user`). Required: both non-empty.
2. **role-preferences** — headline "To get started, what type of role are you
   looking for?" Fields: Job Function (single primary title/function), Job Type
   (Full-time/Contract/Part-time/Internship checkboxes), Location (country
   dropdown CA/US + city text), Open to Remote (toggle), Work Authorization
   (checkbox: needs H1B/sponsorship, phrased generically). Required: job
   function non-empty AND country non-empty.
3. **experience** — headline "How much experience do you have?" Single-select:
   Intern/New Grad, Entry, Mid, Senior, Lead. Required.
4. **target-titles** — headline "Any specific roles you're targeting?" Chip
   input for a few titles/industries. Optional.
5. **resume** — headline "One last step — level up your search with your
   resume." `POST /settings/resume` (PDF/Word ≤10MB). "Start Matching"
   finishes. Skippable via an "I'll do this later" link.

## Data Flow on Finish

`SetupWizard.submit()` runs, in order, each guarded so a failure surfaces an
inline error but never traps the user:

1. `PUT /settings` with mapped fields — `job_title`=job_function,
   `location`=city (or country label), `remote_only`=open_to_remote,
   `work_type`=derived, `experience_levels`=experience_level,
   `regions`=country, plus target titles and `prefilled_answers` for work
   authorization. Durable source of truth; also pre-fills the Settings page.
2. Resume: if a file was chosen, `POST /settings/resume` (already done inline
   in the resume step; the file is optional).
3. Seed `localStorage["job-aggregator-filters"]` via `answersToFilters(answers)`
   so the dashboard opens pre-filtered:
   - `country` ← answers.country
   - `location` ← [answers.city] (if set)
   - `work_type` ← ["remote"] if open_to_remote (extend as data allows)
   - `experience_level` ← [answers.experience_level]
   - `role_category` ← derived from job_function + target_titles
   - `date_posted` ← "" (unset)
   The written object MUST match the `JobFilters` interface exactly so the Jobs
   page reads it without migration.
4. `setSetupComplete(true)` (POST `/auth/me/setup`) → updates cached user →
   `navigate("/app")`.

Because every answer maps to an existing filter/settings field, more answers
produce a tighter initial feed — the "more questions = more customized" goal.

### Fields without a dedicated filter/column
`job_types` (employment type: full/part-time, contract, internship) and
`work_authorization` have no existing `JobFilters` field or `UserSettings`
column. Store both in `UserSettings.prefilled_answers` (JSON) as
`prefilled_answers["job_types"]` / `["work_authorization"]` so the data is
captured and available later, but do NOT attempt to seed them into
`JobFilters` (the feed cannot filter on them today). Only fields with a real
`JobFilters` counterpart are written to `localStorage["job-aggregator-filters"]`.

## Error Handling

- `PUT /settings` / resume upload failure → inline error on the step, but the
  user can still finish (the flag flip + local filter seed are what gate and
  personalize; settings can be re-saved later from Settings).
- `answersToFilters` and localStorage writes wrapped in try/catch (quota / JSON).
- If `setSetupComplete` fails (offline), the wizard shows a retry; the flag
  stays false so the user re-enters setup next session (acceptable, no data loss).

## Testing

- `answersToFilters` — pure mapping, table-driven tests for each field
  (country, city, remote, experience, titles) and empty answers.
- Setup state machine — next/prev/validate-blocks-advance/submit-order.
- Gating — verified+`!has_completed_setup` → `/setup`; `has_completed_setup`
  → `/app`; unverified → `/verify-email` (unchanged).
- Backend — `add_setup_field` migration idempotency; `POST /auth/me/setup`
  flips the flag; `GET /auth/me` includes `has_completed_setup`.

## Out of Scope

- Editing the already-built product tour (only its auto-start ordering is
  relied on, which needs no change).
- New settings storage/columns beyond the boolean flag — reuse existing
  `UserSettings` fields and `prefilled_answers`.
- Server-side derivation of job filters — the client seeds localStorage; the
  backend already filters `/jobs` from query params.
