# Product Tour Onboarding Framework — Design

Date: 2026-07-01
Branch: `feat/product-tour-onboarding`
Status: Approved for planning

## Goal

Give first-time authenticated users a polished, Linear/Stripe-style interactive
product tour of the main app (`/app`). It runs once automatically, is stored as
completed in the database so it never reappears, and can be restarted from
Settings. Built as a reusable, configuration-driven framework — not a one-off
component.

## Scope & Decisions

- **Engine:** custom, built on `framer-motion` (already a dependency). No new
  package. All framer-motion usage is confined to `onboarding/engine/*` behind
  our own components/hooks so the engine is swappable without touching app code.
- **Existing `OnboardingWizard.tsx`** (the autofill demo on `/demo-apply`) is
  **left untouched**. The new framework is separate and serves the real `/app`
  pages.
- **Trigger:** auto-start on first authenticated `/app` load when
  `has_completed_onboarding === false` and no in-progress local state; restart
  available from Settings.
- **Theme:** use existing CSS tokens only (`--stripe-primary #533afd`,
  `--accent`, `--radius-card 12px`, `--shadow-card`, `--text*`, `--border`).

## Architecture

All new frontend code under `frontend/src/onboarding/`, lazy-loaded so it has
zero cost when inactive.

```
onboarding/
  types.ts              # TourStep, TourConfig, Placement, TourAnalytics
  tourConfig.tsx        # THE step config (single source of truth for content)
  OnboardingProvider.tsx# mounts state machine + context; auto-start + DB sync
  useTourController.ts   # reducer + persistence + analytics dispatch
  engine/
    Spotlight.tsx        # dark overlay + animated rounded cutout
    TourTooltip.tsx      # card: title/description/progress/prev/next/skip
    usePlacement.ts      # auto placement (bottom>top>right>left) + viewport clamp
    useTargetElement.ts  # wait/retry for async DOM, scroll-into-view, ResizeObserver
  onboarding.css         # token-based styling
  index.ts               # public lazy entrypoint (OnboardingProvider, useOnboarding)
```

### Layer separation
- **Configuration:** `tourConfig.tsx` — steps as data. Adding/removing a step
  edits only this file.
- **State:** `useTourController.ts` — reducer (`idle | running | finished`,
  `currentStepIndex`), pure transitions.
- **Business logic + persistence:** `OnboardingProvider.tsx` — auto-start rules,
  DB read/write, localStorage read/write, route navigation, analytics dispatch.
- **Presentation:** `engine/Spotlight.tsx`, `engine/TourTooltip.tsx`.
- **Utilities:** `usePlacement.ts`, `useTargetElement.ts`.

Nothing outside `engine/` imports `framer-motion`.

## Data Model & Persistence

### Database (source of truth for "never again")
- Add column: `users.has_completed_onboarding BOOLEAN NOT NULL DEFAULT false`.
- Migration: `backend/migrations/add_onboarding_field.py` following the existing
  idempotent pattern (inspect columns, `ALTER TABLE ... ADD COLUMN ... DEFAULT
  false`, skip if present). Registered + invoked on startup in `backend/main.py`
  alongside the other `run_*_migration()` calls.
- Model: add field to `User` in `backend/db/models.py`.
- Read: include `has_completed_onboarding` in `GET /auth/me` (and the `PUT /me`
  response) in `backend/routers/auth.py`.
- Write: new `POST /auth/me/onboarding` accepting
  `{ completed: bool }` — sets the flag (`true` on finish/skip, `false` on
  restart). Requires authenticated user.

### Frontend
- `AuthContext.UserProfile` gains `has_completed_onboarding?: boolean`.
- localStorage key `tailrd_tour_progress` (distinct from the demo wizard's
  `tailrd_wizard_step`) holds `{ currentStepId, skipped }` so a mid-tour refresh
  resumes at the same step. Cleared on finish/skip.

### Trigger flow
1. `OnboardingProvider` is mounted in `App.tsx` (inside the authenticated `/app`
   layout).
2. On mount, if `user.has_completed_onboarding === false`:
   - if localStorage has in-progress state → resume at that step;
   - else → start at step 0.
3. On finish or skip → clear localStorage, `POST /auth/me/onboarding
   {completed:true}`, optimistic update of the cached user so it never restarts
   in the session.
4. Restart (Settings) → `POST {completed:false}`, clear localStorage, start at
   step 0.

## Step Configuration Shape

```ts
type Placement = "top" | "bottom" | "left" | "right" | "auto";

interface TourStep {
  id: string;
  route?: string;               // navigate here first; wait for target to mount
  target?: string;              // CSS selector; omit => centered modal card
  title: string;
  description: string;
  placement?: Placement;        // default "auto"
  condition?: () => boolean;    // if false, step is skipped (breakpoint/feature)
  spotlightPadding?: number;    // px around target, default 8
  prepare?: () => void | Promise<void>; // run before target lookup: open a job,
                                         // expand a panel, etc. Errors are caught
                                         // and the step is skipped gracefully.
}

interface TourAnalytics {
  onTourStarted?: () => void;
  onStepViewed?: (step: TourStep, index: number) => void;
  onStepCompleted?: (step: TourStep, index: number) => void;
  onTourSkipped?: (atIndex: number) => void;
  onTourFinished?: () => void;
}
```

### Proposed tour (~12 steps, covering the full feature set)
Targets added as `data-tour="..."` attributes on existing elements. Steps 5–7
target the AI Tools sidebar, which lives inside a job's detail view — their
`prepare` hook opens the first available job (via the Jobs page selection
handler / `ApplyTracking` context) so the tools are on screen; if no job exists,
the missing-target path skips them cleanly.

1.  **Welcome** — centered card (no target). "Welcome to Tailrd — let's take a quick tour."
2.  **Dashboard / jobs list** — `/app`, jobs list container (`data-tour="jobs-list"`). Discover & track roles.
3.  **Job filters** — `/app`, filter bar (`data-tour="job-filters"`). Narrow by fit, location, work type.
4.  **Open a job** — `/app`, a job card (`data-tour="job-card"`). "Open a job to see AI tools." (`prepare` opens the first job.)
5.  **Customize resume** — AI Tools button (`data-tour="ai-tool-resume"`). Generate a resume tailored to this job.
6.  **Cover letter** — AI Tools button (`data-tour="ai-tool-cover-letter"`). One-click tailored cover letter.
7.  **Fit / ATS analysis** — AI Tools button (`data-tour="ai-tool-fit"`) + ATS panel. See how well you match and why.
8.  **Resume library** — `/app/resume` (`data-tour="resume-page"`). Manage base resume versions.
9.  **Applications tracker** — `/app/applications` (`data-tour="applications-page"`). Every application, tracked automatically.
10. **Profile** — `/app/profile` (`data-tour="profile-page"`). Details used to autofill applications.
11. **Interview prep** — `/app/interview` (`data-tour="interview-page"`). Practice for upcoming interviews.
12. **Install the extension** — `/app/settings`, extension section (`data-tour="extension-settings"`). Autofill anywhere on the web. (finish)

Sidebar nav items (`Refer & Earn`, `Feedback`) are always-present and can be
added as extra steps later by editing config only. `data-tour` attributes are
the stable contract between config and UI; changing markup/classes won't break
the tour.

## Behavior & Resilience

- **Async DOM:** `useTargetElement` polls (via `requestAnimationFrame`/timeout)
  for the target for ~2s after route settle; when found, scrolls it into view
  (`scrollIntoView({behavior:"smooth", block:"center"})`) and measures rect.
- **Live reposition:** `ResizeObserver` on target + `scroll`/`resize` listeners
  reposition spotlight and tooltip; all listeners cleaned up on unmount/step
  change (no leaks).
- **Missing target:** after timeout, skip the step; `console.warn` in dev only
  (`import.meta.env.DEV`). Tour never crashes.
- **Placement:** try bottom → top → right → left; clamp within viewport with
  margin so the tooltip is never off-screen; recompute on resize.
- **Responsive:** steps whose element is absent at the current breakpoint are
  skipped via `condition` or the missing-target path. Works desktop→mobile.
- **Route-aware:** if `step.route` differs from current path, provider navigates
  (React Router `useNavigate`) then waits for the target before showing.
- **Prepare hook:** if `step.prepare` is set, the provider awaits it after any
  route navigation and before target lookup (e.g. open the first job so the AI
  Tools sidebar mounts). Wrapped in try/catch; a throw skips the step.
- **Interaction guard:** full-screen overlay blocks clicks outside the spotlight;
  spotlight area remains visible (not necessarily interactive) per step.
- **Keyboard:** `Esc` = skip, `ArrowRight` = next, `ArrowLeft` = prev. Tooltip is
  focus-trapped with proper `role="dialog"`/`aria-*`; restores focus on close.
- **Reduced motion:** honor `prefers-reduced-motion` (crossfade only, no large
  movement).

## Animations
framer-motion: tooltip fade+slight-scale, spotlight cutout tween between steps
(no flicker — single persistent overlay whose clip-path/mask animates), subtle
button hover/press. Premium, restrained — no bounce/flashy effects.

## Analytics
Provider accepts an optional `analytics` prop of `TourAnalytics`. Defaults are
no-ops. Each transition dispatches the matching callback. Ready to wire to a
real analytics service later without touching engine/config.

## Performance
- Framework code is lazy-loaded (`React.lazy` on the provider's inner engine) so
  inactive onboarding adds ~nothing to the main bundle.
- Reducer-driven state; memoized context value; overlay only mounted while
  running. All listeners/observers cleaned up.

## Settings Integration
New "Product Tour" `settings-section` with a **Restart product tour** button that
resets the DB flag, clears localStorage, and starts at step 1.

## Testing
- `useTourController` reducer: pure transition tests (next/prev/skip/finish,
  bounds).
- `usePlacement`: placement selection + viewport clamping.
- Provider: auto-start gating on `has_completed_onboarding`; skip-missing-target
  behavior; restart resets. Rendered with existing testing-library setup.
- Backend: migration idempotency; `POST /auth/me/onboarding` flips the flag;
  `GET /auth/me` includes the field.

## Out of Scope
- Changes to the existing `/demo-apply` `OnboardingWizard`.
- Multi-tour / role-based tours (framework allows it later via multiple configs).
- Server-side per-step progress (localStorage is sufficient for resume).
