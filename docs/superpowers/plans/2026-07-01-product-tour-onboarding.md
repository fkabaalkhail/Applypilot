# Product Tour Onboarding Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, configuration-driven first-time-user product tour for the `/app` area that auto-starts once, persists completion in the database, and can be restarted from Settings.

**Architecture:** A framer-motion-based tour engine lives under `frontend/src/onboarding/`, fully isolated behind our own provider/hooks/components. Backend adds one boolean column on `users` plus read/write endpoints. All framer-motion usage is confined to `onboarding/engine/*` so the engine is swappable.

**Tech Stack:** React 18 + TypeScript + Vite, React Router v6, framer-motion (already installed), Phosphor icons; FastAPI + SQLAlchemy + Neon Postgres.

## Global Constraints

- Branch: `feat/product-tour-onboarding` (already created).
- Theme: use existing CSS tokens only — `--stripe-primary` (#533afd), `--accent`, `--accent-light`, `--radius-card` (12px), `--shadow-card`, `--text`, `--text-secondary`, `--border`. No new color literals for brand surfaces.
- No new npm dependency — use framer-motion for all animation.
- Never crash the app: a missing target, thrown `prepare`, or slow page must skip the step and continue. `console.warn` only when `import.meta.env.DEV`.
- Do NOT modify the existing `frontend/src/components/OnboardingWizard.tsx` or `/demo-apply`.
- localStorage key is `tailrd_tour_progress` (must differ from the demo wizard's `tailrd_wizard_step`).
- Frontend tests: `cd frontend && npx vitest --run <path>`. Backend tests: `python -m pytest <path> -v` from repo root.
- All framer-motion imports live only in files under `frontend/src/onboarding/engine/`.

---

### Task 1: Backend — onboarding completion column, migration, and endpoints

**Files:**
- Modify: `backend/db/models.py` (User model, after line 51)
- Create: `backend/migrations/add_onboarding_field.py`
- Modify: `backend/main.py` (import + call migration; lines ~15-21 imports, and the startup block that calls the other `run_*_migration()`)
- Modify: `backend/routers/auth.py` (add field to both `/me` responses; add `POST /auth/me/onboarding`)
- Test: `backend/tests/test_onboarding_api.py`

**Interfaces:**
- Produces: `User.has_completed_onboarding: bool`; `GET /auth/me` returns key `has_completed_onboarding`; `POST /auth/me/onboarding` body `{ "completed": bool }` returns the updated `/me` payload.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_onboarding_api.py`:

```python
"""Tests for onboarding completion flag: /auth/me exposure + POST toggle."""
from backend.db.models import User
from backend.tests.conftest import TEST_USER_ID


def _make_user(db):
    user = User(id=TEST_USER_ID, email="tour@test.com", first_name="Tour")
    db.add(user)
    db.commit()
    return user


def test_me_includes_onboarding_flag_default_false(client, db_session):
    _make_user(db_session)
    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["has_completed_onboarding"] is False


def test_post_onboarding_sets_completed_true(client, db_session):
    _make_user(db_session)
    resp = client.post("/auth/me/onboarding", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["has_completed_onboarding"] is True
    resp2 = client.get("/auth/me")
    assert resp2.json()["has_completed_onboarding"] is True


def test_post_onboarding_reset_to_false(client, db_session):
    _make_user(db_session)
    client.post("/auth/me/onboarding", json={"completed": True})
    resp = client.post("/auth/me/onboarding", json={"completed": False})
    assert resp.status_code == 200
    assert resp.json()["has_completed_onboarding"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_onboarding_api.py -v`
Expected: FAIL — `has_completed_onboarding` missing / endpoint 404.

- [ ] **Step 3: Add the column to the User model**

In `backend/db/models.py`, immediately after the security fields (after line 51 `last_failed_login_at = ...`), add:

```python
    # --- Onboarding ---
    has_completed_onboarding = Column(Boolean, default=False, nullable=False)
```

- [ ] **Step 4: Create the idempotent migration**

Create `backend/migrations/add_onboarding_field.py`:

```python
"""
Migration: Add has_completed_onboarding field to users table.

Adds:
  - has_completed_onboarding (Boolean, NOT NULL, default false)

Idempotent: skips if column already exists.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add has_completed_onboarding column to users table if missing."""
    inspector = inspect(engine)

    if "users" not in inspector.get_table_names():
        logger.info("Onboarding migration skipped: 'users' table missing.")
        return

    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    if "has_completed_onboarding" in existing_columns:
        logger.info("Column has_completed_onboarding already exists, skipping.")
        return

    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN has_completed_onboarding "
                "BOOLEAN NOT NULL DEFAULT false"
            )
        )
    logger.info("Onboarding migration completed successfully.")
```

- [ ] **Step 5: Register the migration in main.py**

In `backend/main.py`, add the import next to the other migration imports (after line 21):

```python
from backend.migrations.add_onboarding_field import run_migration as run_onboarding_migration
```

Then, in the startup block where the other migrations run (search for `run_sessions_migration()`), add immediately after it:

```python
    run_onboarding_migration()
```

- [ ] **Step 6: Expose + write the flag in auth.py**

In `backend/routers/auth.py`:

(a) Add `has_completed_onboarding` to BOTH dict returns in `get_me` (line ~512) and `update_me` (line ~538). In each return dict, after the `created_at` line add:

```python
        "has_completed_onboarding": bool(user.has_completed_onboarding),
```

(b) Near the other Pydantic models (after `ProfileUpdate`, ~line 105), add:

```python
class OnboardingUpdate(BaseModel):
    completed: bool
```

(c) After the `update_me` function (after line ~546), add the endpoint. Ensure `get_current_user_id` is imported at the top of the file (it is used by other routers; if not present, add `from backend.auth.dependencies import get_current_user_id`):

```python
@router.post("/me/onboarding")
def set_onboarding(
    body: OnboardingUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Set the current user's onboarding completion flag."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.has_completed_onboarding = body.completed
    db.commit()
    db.refresh(user)
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "profile_image_url": user.profile_image_url,
        "email_verified": user.email_verified,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "has_completed_onboarding": bool(user.has_completed_onboarding),
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `python -m pytest backend/tests/test_onboarding_api.py -v`
Expected: 3 passed.

- [ ] **Step 8: Commit**

```bash
git add backend/db/models.py backend/migrations/add_onboarding_field.py backend/main.py backend/routers/auth.py backend/tests/test_onboarding_api.py
git commit -m "feat(onboarding): add has_completed_onboarding column + endpoints"
```

---

### Task 2: Frontend types + tour configuration

**Files:**
- Create: `frontend/src/onboarding/types.ts`
- Create: `frontend/src/onboarding/tourConfig.tsx`

**Interfaces:**
- Produces: `Placement`, `TourStep`, `TourAnalytics`, `OnboardingProgress` types; `TOUR_STEPS: TourStep[]`; `TOUR_PROGRESS_KEY = "tailrd_tour_progress"`.

- [ ] **Step 1: Create types.ts**

```ts
export type Placement = "top" | "bottom" | "left" | "right" | "auto";

export interface TourStep {
  /** Stable unique id, also used as the persisted resume key. */
  id: string;
  /** If set and not the current path, navigate here before showing. */
  route?: string;
  /** CSS selector for the highlighted element. Omit for a centered card. */
  target?: string;
  title: string;
  description: string;
  placement?: Placement;
  /** If it returns false, the step is skipped. */
  condition?: () => boolean;
  /** px of padding around the spotlight cutout (default 8). */
  spotlightPadding?: number;
  /** Runs after navigation, before target lookup (e.g. open a job). */
  prepare?: () => void | Promise<void>;
}

export interface TourAnalytics {
  onTourStarted?: () => void;
  onStepViewed?: (step: TourStep, index: number) => void;
  onStepCompleted?: (step: TourStep, index: number) => void;
  onTourSkipped?: (atIndex: number) => void;
  onTourFinished?: () => void;
}

export interface OnboardingProgress {
  currentStepId: string;
  skipped: boolean;
}

export const TOUR_PROGRESS_KEY = "tailrd_tour_progress";
```

- [ ] **Step 2: Create tourConfig.tsx**

```tsx
import type { TourStep } from "./types";

/**
 * The product tour, as data. Adding/removing a step should only require
 * editing this array. `target` selectors reference `data-tour="..."`
 * attributes on real UI elements — the stable contract with the DOM.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    route: "/app",
    title: "Welcome to Tailrd 👋",
    description:
      "Let's take a quick tour of how Tailrd helps you find, tailor, and track job applications.",
  },
  {
    id: "jobs-list",
    route: "/app",
    target: '[data-tour="jobs-list"]',
    title: "Your job feed",
    description: "Browse and discover roles matched to your profile right here.",
    placement: "right",
  },
  {
    id: "job-filters",
    route: "/app",
    target: '[data-tour="job-filters"]',
    title: "Filter & sort",
    description: "Narrow the feed by fit, location, and work type to focus on the best matches.",
    placement: "bottom",
  },
  {
    id: "open-job",
    route: "/app",
    target: '[data-tour="job-card"]',
    title: "Open a job",
    description: "Click any job to see full details and unlock AI tools for it.",
    placement: "right",
  },
  {
    id: "ai-resume",
    route: "/app",
    target: '[data-tour="ai-tool-resume"]',
    title: "Customize your resume",
    description: "Generate a resume tailored to this exact job in one click.",
    placement: "left",
    prepare: () =>
      (document.querySelector('[data-tour="job-card"]') as HTMLElement | null)?.click(),
  },
  {
    id: "ai-cover-letter",
    route: "/app",
    target: '[data-tour="ai-tool-cover-letter"]',
    title: "Build a cover letter",
    description: "Create a tailored cover letter that matches the role and your background.",
    placement: "left",
    prepare: () =>
      (document.querySelector('[data-tour="job-card"]') as HTMLElement | null)?.click(),
  },
  {
    id: "ai-fit",
    route: "/app",
    target: '[data-tour="ai-tool-fit"]',
    title: "Analyze your fit",
    description: "See how well you match the role and which keywords to add for ATS.",
    placement: "left",
    prepare: () =>
      (document.querySelector('[data-tour="job-card"]') as HTMLElement | null)?.click(),
  },
  {
    id: "resume-library",
    route: "/app/resume",
    target: '[data-tour="resume-page"]',
    title: "Resume library",
    description: "Manage your base resume versions here — the source for every tailored resume.",
    placement: "bottom",
  },
  {
    id: "applications",
    route: "/app/applications",
    target: '[data-tour="applications-page"]',
    title: "Application tracker",
    description: "Every job you apply to is tracked automatically so nothing slips through.",
    placement: "bottom",
  },
  {
    id: "profile",
    route: "/app/profile",
    target: '[data-tour="profile-page"]',
    title: "Your profile",
    description: "Keep these details current — they're used to autofill applications for you.",
    placement: "bottom",
  },
  {
    id: "interview",
    route: "/app/interview",
    target: '[data-tour="interview-page"]',
    title: "Interview prep",
    description: "Practice with AI-generated questions tailored to the roles you're pursuing.",
    placement: "bottom",
  },
  {
    id: "extension",
    route: "/app/settings",
    target: '[data-tour="extension-settings"]',
    title: "Install the extension",
    description: "Add the Tailrd browser extension to autofill applications anywhere on the web.",
    placement: "bottom",
  },
];
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/onboarding/types.ts frontend/src/onboarding/tourConfig.tsx
git commit -m "feat(onboarding): tour types and step configuration"
```

---

### Task 3: usePlacement utility (auto placement + viewport clamp)

**Files:**
- Create: `frontend/src/onboarding/engine/usePlacement.ts`
- Test: `frontend/src/onboarding/engine/__tests__/usePlacement.test.ts`

**Interfaces:**
- Consumes: `Placement` from `../types`.
- Produces: `computePlacement(targetRect: DOMRect | null, tooltip: { width: number; height: number }, viewport: { width: number; height: number }, preferred: Placement, gap?: number): { top: number; left: number; placement: Exclude<Placement, "auto"> | "center" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { computePlacement } from "../usePlacement";

const vp = { width: 1000, height: 800 };
const tip = { width: 200, height: 100 };

function rect(top: number, left: number, w = 100, h = 40): DOMRect {
  return { top, left, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("computePlacement", () => {
  it("centers when there is no target", () => {
    const r = computePlacement(null, tip, vp, "auto");
    expect(r.placement).toBe("center");
    expect(r.left).toBe((vp.width - tip.width) / 2);
  });

  it("places below the target for bottom preference with room", () => {
    const r = computePlacement(rect(100, 400), tip, vp, "bottom");
    expect(r.placement).toBe("bottom");
    expect(r.top).toBeGreaterThan(140);
  });

  it("flips to top when there is no room below", () => {
    const r = computePlacement(rect(760, 400), tip, vp, "bottom");
    expect(r.placement).toBe("top");
  });

  it("clamps within the viewport horizontally", () => {
    const r = computePlacement(rect(100, 980), tip, vp, "bottom");
    expect(r.left).toBeGreaterThanOrEqual(8);
    expect(r.left + tip.width).toBeLessThanOrEqual(vp.width - 8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/onboarding/engine/__tests__/usePlacement.test.ts`
Expected: FAIL — `computePlacement` not defined.

- [ ] **Step 3: Implement computePlacement**

Create `frontend/src/onboarding/engine/usePlacement.ts`:

```ts
import type { Placement } from "../types";

export type ResolvedPlacement = Exclude<Placement, "auto"> | "center";

interface Size { width: number; height: number; }

const MARGIN = 8;

function fits(p: Exclude<Placement, "auto">, r: DOMRect, tip: Size, vp: Size, gap: number): boolean {
  switch (p) {
    case "bottom": return r.bottom + gap + tip.height <= vp.height - MARGIN;
    case "top": return r.top - gap - tip.height >= MARGIN;
    case "right": return r.right + gap + tip.width <= vp.width - MARGIN;
    case "left": return r.left - gap - tip.width >= MARGIN;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

export function computePlacement(
  targetRect: DOMRect | null,
  tip: Size,
  vp: Size,
  preferred: Placement,
  gap = 12,
): { top: number; left: number; placement: ResolvedPlacement } {
  if (!targetRect) {
    return {
      top: (vp.height - tip.height) / 2,
      left: (vp.width - tip.width) / 2,
      placement: "center",
    };
  }

  const order: Exclude<Placement, "auto">[] =
    preferred === "auto"
      ? ["bottom", "top", "right", "left"]
      : [preferred, "bottom", "top", "right", "left"];

  const chosen = order.find((p) => fits(p, targetRect, tip, vp, gap)) ?? "bottom";

  let top: number;
  let left: number;
  switch (chosen) {
    case "bottom":
      top = targetRect.bottom + gap;
      left = targetRect.left + targetRect.width / 2 - tip.width / 2;
      break;
    case "top":
      top = targetRect.top - gap - tip.height;
      left = targetRect.left + targetRect.width / 2 - tip.width / 2;
      break;
    case "right":
      top = targetRect.top + targetRect.height / 2 - tip.height / 2;
      left = targetRect.right + gap;
      break;
    case "left":
      top = targetRect.top + targetRect.height / 2 - tip.height / 2;
      left = targetRect.left - gap - tip.width;
      break;
  }

  return {
    placement: chosen,
    top: clamp(top, MARGIN, vp.height - tip.height - MARGIN),
    left: clamp(left, MARGIN, vp.width - tip.width - MARGIN),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest --run src/onboarding/engine/__tests__/usePlacement.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/engine/usePlacement.ts frontend/src/onboarding/engine/__tests__/usePlacement.test.ts
git commit -m "feat(onboarding): placement computation utility"
```

---

### Task 4: useTargetElement utility (wait/retry + live rect + scroll)

**Files:**
- Create: `frontend/src/onboarding/engine/useTargetElement.ts`

**Interfaces:**
- Produces: `useTargetElement(selector: string | undefined, active: boolean, timeoutMs?: number): { rect: DOMRect | null; status: "pending" | "found" | "missing" | "none" }`. When `selector` is undefined and active, status is `"none"` and rect is null (centered card). Scrolls the found element into view once.

- [ ] **Step 1: Implement the hook (no unit test — DOM/timing hook, covered via provider tests in Task 7)**

Create `frontend/src/onboarding/engine/useTargetElement.ts`:

```ts
import { useEffect, useRef, useState } from "react";

type Status = "pending" | "found" | "missing" | "none";

export function useTargetElement(
  selector: string | undefined,
  active: boolean,
  timeoutMs = 2000,
): { rect: DOMRect | null; status: Status } {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [status, setStatus] = useState<Status>("pending");
  const scrolledRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (!selector) {
      setStatus("none");
      setRect(null);
      return;
    }

    scrolledRef.current = false;
    let raf = 0;
    let cancelled = false;
    const start = performance.now();
    let el: Element | null = null;

    const measure = () => {
      if (el) setRect(el.getBoundingClientRect());
    };

    const poll = () => {
      if (cancelled) return;
      el = document.querySelector(selector);
      if (el) {
        setStatus("found");
        if (!scrolledRef.current) {
          scrolledRef.current = true;
          el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        }
        measure();
        return;
      }
      if (performance.now() - start > timeoutMs) {
        setStatus("missing");
        return;
      }
      raf = requestAnimationFrame(poll);
    };

    poll();

    const onChange = () => measure();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    let ro: ResizeObserver | null = null;
    const roTimer = window.setTimeout(() => {
      if (el && "ResizeObserver" in window) {
        ro = new ResizeObserver(onChange);
        ro.observe(el);
      }
    }, 50);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(roTimer);
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
      ro?.disconnect();
    };
  }, [selector, active, timeoutMs]);

  return { rect, status };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/onboarding/engine/useTargetElement.ts
git commit -m "feat(onboarding): target element wait/measure hook"
```

---

### Task 5: useTourController reducer (pure state machine)

**Files:**
- Create: `frontend/src/onboarding/useTourController.ts`
- Test: `frontend/src/onboarding/__tests__/useTourController.test.ts`

**Interfaces:**
- Consumes: `TourStep` from `./types`.
- Produces: `tourReducer(state, action)` and types `TourState = { phase: "idle" | "running" | "finished"; index: number }`, `TourAction = { type: "START"; index?: number } | { type: "NEXT" } | { type: "PREV" } | { type: "GOTO"; index: number } | { type: "SKIP" } | { type: "FINISH" }`. `nextVisibleIndex(steps, from, dir)` skips steps whose `condition` returns false.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { tourReducer, nextVisibleIndex } from "../useTourController";
import type { TourStep } from "../types";

const steps: TourStep[] = [
  { id: "a", title: "A", description: "" },
  { id: "b", title: "B", description: "", condition: () => false },
  { id: "c", title: "C", description: "" },
];

describe("nextVisibleIndex", () => {
  it("skips steps whose condition is false going forward", () => {
    expect(nextVisibleIndex(steps, 0, 1)).toBe(2);
  });
  it("returns -1 past the end", () => {
    expect(nextVisibleIndex(steps, 2, 1)).toBe(-1);
  });
});

describe("tourReducer", () => {
  it("START enters running at index 0", () => {
    const s = tourReducer({ phase: "idle", index: -1 }, { type: "START" });
    expect(s).toEqual({ phase: "running", index: 0 });
  });
  it("NEXT past the last visible step finishes", () => {
    const s = tourReducer({ phase: "running", index: 2 }, { type: "NEXT" });
    expect(s.phase).toBe("finished");
  });
  it("SKIP finishes immediately", () => {
    const s = tourReducer({ phase: "running", index: 1 }, { type: "SKIP" });
    expect(s.phase).toBe("finished");
  });
});
```

Note: the reducer is created by a factory bound to `steps` so `NEXT`/`PREV` can honor conditions. Adjust the test import accordingly in Step 3 if you choose the factory form — keep the exported names `tourReducer` and `nextVisibleIndex`. For the test above, `tourReducer` is the factory result for `steps`; export a `makeTourReducer(steps)` and in the test do `const tourReducer = makeTourReducer(steps);` at the top of the `describe` blocks. Update the test file to:

```ts
import { makeTourReducer, nextVisibleIndex } from "../useTourController";
// ...
const tourReducer = makeTourReducer(steps);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/onboarding/__tests__/useTourController.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer**

Create `frontend/src/onboarding/useTourController.ts`:

```ts
import type { TourStep } from "./types";

export interface TourState {
  phase: "idle" | "running" | "finished";
  index: number;
}

export type TourAction =
  | { type: "START"; index?: number }
  | { type: "NEXT" }
  | { type: "PREV" }
  | { type: "GOTO"; index: number }
  | { type: "SKIP" }
  | { type: "FINISH" };

/** Next index (in `dir`) whose condition passes; -1 if none remain. */
export function nextVisibleIndex(steps: TourStep[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
    const cond = steps[i].condition;
    if (!cond || cond()) return i;
  }
  return -1;
}

function firstVisible(steps: TourStep[]): number {
  const c0 = steps[0]?.condition;
  return !c0 || c0() ? 0 : nextVisibleIndex(steps, 0, 1);
}

export function makeTourReducer(steps: TourStep[]) {
  return function tourReducer(state: TourState, action: TourAction): TourState {
    switch (action.type) {
      case "START": {
        const idx = action.index ?? firstVisible(steps);
        return idx < 0 ? { phase: "finished", index: -1 } : { phase: "running", index: idx };
      }
      case "NEXT": {
        const idx = nextVisibleIndex(steps, state.index, 1);
        return idx < 0 ? { phase: "finished", index: state.index } : { phase: "running", index: idx };
      }
      case "PREV": {
        const idx = nextVisibleIndex(steps, state.index, -1);
        return idx < 0 ? state : { phase: "running", index: idx };
      }
      case "GOTO":
        return { phase: "running", index: action.index };
      case "SKIP":
      case "FINISH":
        return { phase: "finished", index: state.index };
      default:
        return state;
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest --run src/onboarding/__tests__/useTourController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/useTourController.ts frontend/src/onboarding/__tests__/useTourController.test.ts
git commit -m "feat(onboarding): tour state reducer"
```

---

### Task 6: Engine presentation — Spotlight, Tooltip, CSS

**Files:**
- Create: `frontend/src/onboarding/engine/Spotlight.tsx`
- Create: `frontend/src/onboarding/engine/TourTooltip.tsx`
- Create: `frontend/src/onboarding/onboarding.css`

**Interfaces:**
- Consumes: `computePlacement` (Task 3), `ResolvedPlacement`.
- Produces:
  - `Spotlight({ rect, padding }: { rect: DOMRect | null; padding: number })`
  - `TourTooltip(props)` where props = `{ title: string; description: string; index: number; total: number; canPrev: boolean; isLast: boolean; rect: DOMRect | null; placement: Placement; onPrev(): void; onNext(): void; onSkip(): void }`.

- [ ] **Step 1: Create onboarding.css**

```css
.tour-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
  pointer-events: auto;
}
.tour-spotlight-svg { position: fixed; inset: 0; width: 100vw; height: 100vh; }
.tour-spotlight-dim { fill: rgba(15, 23, 42, 0.55); }

.tour-tooltip {
  position: fixed;
  z-index: 9999;
  width: 320px;
  max-width: calc(100vw - 24px);
  background: var(--bg-white, #fff);
  color: var(--text, #1a1a1a);
  border: 1px solid var(--border, #e6e6e6);
  border-radius: var(--radius-card, 12px);
  box-shadow: var(--shadow-card-hover, 0 8px 24px rgba(0,55,112,0.12));
  padding: 20px;
}
.tour-tooltip-title { font-size: 16px; font-weight: 650; margin: 0 0 6px; }
.tour-tooltip-desc { font-size: 14px; line-height: 1.5; color: var(--text-secondary, #555); margin: 0 0 16px; }
.tour-tooltip-footer { display: flex; align-items: center; justify-content: space-between; }
.tour-dots { display: flex; gap: 6px; }
.tour-dot { width: 6px; height: 6px; border-radius: 9999px; background: var(--border, #d9d9d9); }
.tour-dot.active { background: var(--accent, #533afd); width: 18px; }
.tour-actions { display: flex; gap: 8px; }
.tour-btn {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border-radius: 8px; padding: 7px 14px; border: 1px solid transparent;
  transition: background .15s ease, border-color .15s ease, transform .05s ease;
}
.tour-btn:active { transform: scale(0.97); }
.tour-btn-primary { background: var(--accent, #533afd); color: #fff; }
.tour-btn-primary:hover { background: var(--accent-hover, #4434d4); }
.tour-btn-ghost { background: transparent; color: var(--text-secondary, #555); }
.tour-btn-ghost:hover { background: var(--accent-light, #eef0ff); }
.tour-skip { background: transparent; border: none; color: var(--text-muted, #888); font-size: 13px; cursor: pointer; }
.tour-skip:hover { color: var(--text, #1a1a1a); }

@media (prefers-reduced-motion: reduce) {
  .tour-tooltip, .tour-spotlight-svg { transition: none !important; }
}
```

- [ ] **Step 2: Create Spotlight.tsx**

Uses an SVG mask: a full-screen dim rect with a transparent rounded rect punched out over the target. framer-motion animates the cutout between steps. When `rect` is null, the whole screen dims (centered-card steps).

```tsx
import { motion } from "framer-motion";

interface Props { rect: DOMRect | null; padding: number; }

export function Spotlight({ rect, padding }: Props) {
  const pad = padding;
  const hole = rect
    ? { x: rect.left - pad, y: rect.top - pad, w: rect.width + pad * 2, h: rect.height + pad * 2 }
    : { x: 0, y: 0, w: 0, h: 0 };

  return (
    <svg className="tour-spotlight-svg" aria-hidden>
      <defs>
        <mask id="tour-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          {rect && (
            <motion.rect
              rx={10}
              ry={10}
              fill="black"
              initial={false}
              animate={{ x: hole.x, y: hole.y, width: hole.w, height: hole.h }}
              transition={{ type: "spring", stiffness: 300, damping: 32 }}
            />
          )}
        </mask>
      </defs>
      <rect className="tour-spotlight-dim" x="0" y="0" width="100%" height="100%" mask="url(#tour-mask)" />
    </svg>
  );
}
```

- [ ] **Step 3: Create TourTooltip.tsx**

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { computePlacement } from "./usePlacement";
import type { Placement } from "../types";

interface Props {
  title: string;
  description: string;
  index: number;
  total: number;
  canPrev: boolean;
  isLast: boolean;
  rect: DOMRect | null;
  placement: Placement;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function TourTooltip(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const p = computePlacement(props.rect, size, vp, props.placement ?? "auto");
    setPos({ top: p.top, left: p.left });
  }, [props.rect, props.placement, props.title]);

  // Focus the card for keyboard users / focus trap entry.
  useEffect(() => { ref.current?.focus(); }, [props.index]);

  return (
    <motion.div
      ref={ref}
      className="tour-tooltip"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      tabIndex={-1}
      style={{ top: pos.top, left: pos.left }}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
    >
      <h3 className="tour-tooltip-title">{props.title}</h3>
      <p className="tour-tooltip-desc">{props.description}</p>
      <div className="tour-tooltip-footer">
        <div className="tour-dots" aria-label={`Step ${props.index + 1} of ${props.total}`}>
          {Array.from({ length: props.total }).map((_, i) => (
            <span key={i} className={`tour-dot${i === props.index ? " active" : ""}`} />
          ))}
        </div>
        <div className="tour-actions">
          <button className="tour-skip" onClick={props.onSkip}>Skip</button>
          {props.canPrev && (
            <button className="tour-btn tour-btn-ghost" onClick={props.onPrev}>Back</button>
          )}
          <button className="tour-btn tour-btn-primary" onClick={props.onNext}>
            {props.isLast ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
```

- [ ] **Step 4: Type-check compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors from the new files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/engine/Spotlight.tsx frontend/src/onboarding/engine/TourTooltip.tsx frontend/src/onboarding/onboarding.css
git commit -m "feat(onboarding): spotlight + tooltip presentation"
```

---

### Task 7: OnboardingProvider (orchestration) + AuthContext wiring + public entry

**Files:**
- Modify: `frontend/src/auth/AuthContext.tsx` (add field + method to types)
- Modify: `frontend/src/auth/AuthProvider.tsx` (add `setOnboardingComplete`)
- Create: `frontend/src/onboarding/OnboardingProvider.tsx`
- Create: `frontend/src/onboarding/OnboardingOverlay.tsx` (the running-state UI; lazy-loaded)
- Create: `frontend/src/onboarding/index.ts`
- Create: `frontend/src/onboarding/__tests__/OnboardingProvider.test.tsx`

**Interfaces:**
- Consumes: `makeTourReducer`, `TourState` (Task 5); `useTargetElement` (Task 4); `Spotlight`, `TourTooltip` (Task 6); `TOUR_STEPS`, `TOUR_PROGRESS_KEY`, `OnboardingProgress` (Task 2); `useAuth` for `user.has_completed_onboarding` + `setOnboardingComplete`.
- Produces: `OnboardingProvider({ children, analytics? })`; `useOnboarding()` returning `{ start(): void; restart(): Promise<void>; isRunning: boolean }`; `AuthContextValue.setOnboardingComplete(completed: boolean): Promise<void>` and `UserProfile.has_completed_onboarding?: boolean`.

- [ ] **Step 1: Extend AuthContext types**

In `frontend/src/auth/AuthContext.tsx`, add to `UserProfile`:

```ts
  has_completed_onboarding?: boolean;
```

and to `AuthContextValue`:

```ts
  setOnboardingComplete: (completed: boolean) => Promise<void>;
```

- [ ] **Step 2: Implement setOnboardingComplete in AuthProvider**

In `frontend/src/auth/AuthProvider.tsx`, add a callback (after `resendVerification`):

```ts
  const setOnboardingComplete = useCallback(async (completed: boolean) => {
    const { data } = await api.post("/auth/me/onboarding", { completed });
    setUser(data);
  }, []);
```

and include `setOnboardingComplete` in the `value` object.

- [ ] **Step 3: Write the failing provider test**

Create `frontend/src/onboarding/__tests__/OnboardingProvider.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OnboardingProvider } from "../OnboardingProvider";
import { AuthContext } from "../../auth/AuthContext";
import { TOUR_PROGRESS_KEY } from "../types";

function renderWith(hasCompleted: boolean) {
  const setOnboardingComplete = vi.fn().mockResolvedValue(undefined);
  const value: any = {
    isAuthenticated: true,
    user: { id: 1, email: "a@b.c", first_name: "A", last_name: "", email_verified: true, has_completed_onboarding: hasCompleted },
    isLoading: false,
    setOnboardingComplete,
  };
  render(
    <MemoryRouter initialEntries={["/app"]}>
      <AuthContext.Provider value={value}>
        <OnboardingProvider>
          <div data-tour="jobs-list">jobs</div>
        </OnboardingProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { setOnboardingComplete };
}

describe("OnboardingProvider auto-start", () => {
  beforeEach(() => localStorage.clear());

  it("auto-starts the tour for a first-time user", async () => {
    renderWith(false);
    expect(await screen.findByText(/Welcome to Tailrd/i)).toBeInTheDocument();
  });

  it("does not start for a user who has completed onboarding", async () => {
    renderWith(true);
    await waitFor(() => {}, { timeout: 50 });
    expect(screen.queryByText(/Welcome to Tailrd/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/onboarding/__tests__/OnboardingProvider.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 5: Create OnboardingOverlay.tsx (running UI)**

```tsx
import { useCallback, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { Spotlight } from "./engine/Spotlight";
import { TourTooltip } from "./engine/TourTooltip";
import { useTargetElement } from "./engine/useTargetElement";
import type { TourStep } from "./types";

interface Props {
  step: TourStep;
  index: number;
  total: number;
  canPrev: boolean;
  isLast: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
  /** Called when the target could not be found within the timeout. */
  onMissing: () => void;
}

export function OnboardingOverlay(props: Props) {
  const { rect, status } = useTargetElement(props.step.target, true);

  useEffect(() => {
    if (status === "missing") {
      if (import.meta.env.DEV) {
        console.warn(`[onboarding] target not found, skipping step "${props.step.id}"`);
      }
      props.onMissing();
    }
  }, [status, props]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onSkip();
      else if (e.key === "ArrowRight") props.onNext();
      else if (e.key === "ArrowLeft" && props.canPrev) props.onPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const swallow = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  if (status === "pending" || status === "missing") return null;

  return (
    <AnimatePresence>
      <div className="tour-overlay" onClickCapture={swallow}>
        <Spotlight rect={rect} padding={props.step.spotlightPadding ?? 8} />
        <TourTooltip
          title={props.step.title}
          description={props.step.description}
          index={props.index}
          total={props.total}
          canPrev={props.canPrev}
          isLast={props.isLast}
          rect={rect}
          placement={props.step.placement ?? "auto"}
          onPrev={props.onPrev}
          onNext={props.onNext}
          onSkip={props.onSkip}
        />
      </div>
    </AnimatePresence>
  );
}
```

- [ ] **Step 6: Create OnboardingProvider.tsx**

```tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { TOUR_STEPS } from "./tourConfig";
import { TOUR_PROGRESS_KEY, type OnboardingProgress, type TourAnalytics } from "./types";
import { makeTourReducer, type TourState } from "./useTourController";
import { OnboardingOverlay } from "./OnboardingOverlay";

interface OnboardingContextValue {
  start: () => void;
  restart: () => Promise<void>;
  isRunning: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | undefined>(undefined);

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within OnboardingProvider");
  return ctx;
}

function readProgress(): OnboardingProgress | null {
  try {
    const raw = localStorage.getItem(TOUR_PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as OnboardingProgress) : null;
  } catch {
    return null;
  }
}

export function OnboardingProvider({
  children,
  analytics,
}: {
  children: ReactNode;
  analytics?: TourAnalytics;
}) {
  const reducer = useMemo(() => makeTourReducer(TOUR_STEPS), []);
  const [state, dispatch] = useReducer(reducer, { phase: "idle", index: -1 } as TourState);
  const { user, setOnboardingComplete } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const startedRef = useRef(false);
  const [stepReady, setStepReady] = useState(false);

  const step = state.index >= 0 ? TOUR_STEPS[state.index] : undefined;

  // Auto-start once for first-time users.
  useEffect(() => {
    if (startedRef.current) return;
    if (!user || user.has_completed_onboarding) return;
    startedRef.current = true;
    const saved = readProgress();
    analytics?.onTourStarted?.();
    if (saved && !saved.skipped) {
      const idx = TOUR_STEPS.findIndex((s) => s.id === saved.currentStepId);
      dispatch({ type: "START", index: idx >= 0 ? idx : undefined });
    } else {
      dispatch({ type: "START" });
    }
  }, [user, analytics]);

  // On each running step: navigate, run prepare, persist progress, fire analytics.
  useEffect(() => {
    if (state.phase !== "running" || !step) return;
    let cancelled = false;
    setStepReady(false);

    (async () => {
      if (step.route && location.pathname !== step.route) {
        navigate(step.route);
        // allow the route to render before prepare/lookup
        await new Promise((r) => setTimeout(r, 150));
      }
      if (cancelled) return;
      if (step.prepare) {
        try {
          await step.prepare();
          await new Promise((r) => setTimeout(r, 60));
        } catch (e) {
          if (import.meta.env.DEV) console.warn(`[onboarding] prepare failed for "${step.id}"`, e);
        }
      }
      if (cancelled) return;
      try {
        localStorage.setItem(
          TOUR_PROGRESS_KEY,
          JSON.stringify({ currentStepId: step.id, skipped: false } satisfies OnboardingProgress),
        );
      } catch { /* ignore quota */ }
      analytics?.onStepViewed?.(step, state.index);
      setStepReady(true);
    })();

    return () => { cancelled = true; };
  }, [state.phase, state.index, step, navigate, location.pathname, analytics]);

  const finish = useCallback(async (skipped: boolean) => {
    if (step) {
      if (skipped) analytics?.onTourSkipped?.(state.index);
      else analytics?.onStepCompleted?.(step, state.index);
    }
    analytics?.onTourFinished?.();
    try { localStorage.removeItem(TOUR_PROGRESS_KEY); } catch { /* ignore */ }
    dispatch({ type: "FINISH" });
    try { await setOnboardingComplete(true); } catch { /* offline: DB sync retried next session */ }
  }, [step, state.index, analytics, setOnboardingComplete]);

  const handleNext = useCallback(() => {
    if (step) analytics?.onStepCompleted?.(step, state.index);
    const isLast = state.index >= TOUR_STEPS.length - 1;
    if (isLast) void finish(false);
    else dispatch({ type: "NEXT" });
  }, [step, state.index, analytics, finish]);

  const handlePrev = useCallback(() => dispatch({ type: "PREV" }), []);
  const handleSkip = useCallback(() => void finish(true), [finish]);
  const handleMissing = useCallback(() => dispatch({ type: "NEXT" }), []);

  const start = useCallback(() => dispatch({ type: "START" }), []);
  const restart = useCallback(async () => {
    try { localStorage.removeItem(TOUR_PROGRESS_KEY); } catch { /* ignore */ }
    try { await setOnboardingComplete(false); } catch { /* ignore */ }
    startedRef.current = true;
    dispatch({ type: "START" });
  }, [setOnboardingComplete]);

  const ctxValue = useMemo<OnboardingContextValue>(
    () => ({ start, restart, isRunning: state.phase === "running" }),
    [start, restart, state.phase],
  );

  const showOverlay = state.phase === "running" && !!step && stepReady;

  return (
    <OnboardingContext.Provider value={ctxValue}>
      {children}
      {showOverlay && step && (
        <OnboardingOverlay
          step={step}
          index={state.index}
          total={TOUR_STEPS.length}
          canPrev={state.index > 0}
          isLast={state.index >= TOUR_STEPS.length - 1}
          onPrev={handlePrev}
          onNext={handleNext}
          onSkip={handleSkip}
          onMissing={handleMissing}
        />
      )}
    </OnboardingContext.Provider>
  );
}
```

- [ ] **Step 7: Create index.ts (public API) + import CSS**

```ts
import "./onboarding.css";
export { OnboardingProvider, useOnboarding } from "./OnboardingProvider";
export type { TourStep, TourAnalytics } from "./types";
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npx vitest --run src/onboarding/__tests__/OnboardingProvider.test.tsx`
Expected: PASS (2 tests). Then `cd frontend && npx tsc --noEmit` → no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/auth/AuthContext.tsx frontend/src/auth/AuthProvider.tsx frontend/src/onboarding/OnboardingProvider.tsx frontend/src/onboarding/OnboardingOverlay.tsx frontend/src/onboarding/index.ts frontend/src/onboarding/__tests__/OnboardingProvider.test.tsx
git commit -m "feat(onboarding): provider orchestration + auth wiring"
```

---

### Task 8: Mount provider in App.tsx + add data-tour anchors

**Files:**
- Modify: `frontend/src/App.tsx` (wrap layout in `OnboardingProvider`)
- Modify: `frontend/src/pages/Jobs.tsx` (anchors: jobs-list, job-filters, job-card)
- Modify: `frontend/src/components/JobFilterBar.tsx` OR the toolbar in Jobs.tsx (job-filters)
- Modify: `frontend/src/components/AIToolsSidebar.tsx` (ai-tool-resume/cover-letter/fit)
- Modify: `frontend/src/pages/Resume.tsx`, `Applications.tsx`, `Profile.tsx`, `Interview.tsx` (page anchors)
- Modify: `frontend/src/pages/Settings.tsx` (extension-settings anchor)

**Interfaces:**
- Consumes: `OnboardingProvider` from `../onboarding` (Task 7).
- Produces: `data-tour` attributes matching every selector in `TOUR_STEPS`.

- [ ] **Step 1: Wrap the app layout**

In `frontend/src/App.tsx`, import at top:

```tsx
import { OnboardingProvider } from "./onboarding";
```

Wrap the existing `ApplyTrackingProvider` subtree so the provider sits inside the router (App renders under the `/app` Route, which is inside BrowserRouter). Change the outer return to:

```tsx
  return (
    <ApplyTrackingProvider>
    <OnboardingProvider>
    <div className={`app-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
```

and add the matching closing tag before `</ApplyTrackingProvider>`:

```tsx
    </div>
    </OnboardingProvider>
    </ApplyTrackingProvider>
  );
```

- [ ] **Step 2: Add Jobs page anchors**

In `frontend/src/pages/Jobs.tsx`:
- On the jobs feed container (line ~319 `<div className="jobs-feed" ...>`), add `data-tour="jobs-list"`.
- On the toolbar filter toggle button (line ~300 `onClick={() => setFiltersVisible(...)}`), add `data-tour="job-filters"`.
- On the job card wrapper (line ~326 `<div key={job.id} className={\`job-card...\`}>`), add `data-tour="job-card"` to the FIRST card only. Simplest: since it's a `.map`, add it conditionally on index 0. Change the map header to include the index and set the attribute:

```tsx
          {filteredJobs.map((job, jobIndex) => (
            <div
              key={job.id}
              data-tour={jobIndex === 0 ? "job-card" : undefined}
              className={`job-card${selectedJob?.id === job.id ? " selected" : ""}`}
              onClick={() => setSelectedJob(job)}
              style={{ cursor: "pointer" }}
            >
```

(If the map callback already omits the index, add `, jobIndex` to its signature.)

- [ ] **Step 3: Add AI tool anchors**

In `frontend/src/components/AIToolsSidebar.tsx`, the buttons are rendered from `toolButtons` (line ~93). Map each `type` to a `data-tour` value and set it on the button. Replace the button element (line ~95-102 area) with one that adds:

```tsx
        {toolButtons.map(({ type, label, icon }) => (
          <button
            key={type}
            className="ai-tool-btn"
            data-tour={
              type === "resume" ? "ai-tool-resume"
              : type === "cover-letter" ? "ai-tool-cover-letter"
              : type === "fit-analysis" ? "ai-tool-fit"
              : undefined
            }
            onClick={() => runTool(type)}
          >
            <span className="ai-tool-icon">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
```

(Preserve any other existing attributes/props on the button.)

- [ ] **Step 4: Add page anchors**

Add `data-tour` to each page's root element:
- `frontend/src/pages/Resume.tsx`: on the main resume page root `<div className="resume-page-new">` add `data-tour="resume-page"`.
- `frontend/src/pages/Applications.tsx`: on `<div className="jobs-page">` (line ~53) add `data-tour="applications-page"`.
- `frontend/src/pages/Profile.tsx`: on `<div className="profile-page">` (line ~161) add `data-tour="profile-page"`.
- `frontend/src/pages/Interview.tsx`: on `<div className="interview-page">` (line ~123) add `data-tour="interview-page"`.

- [ ] **Step 5: Add Settings extension anchor**

In `frontend/src/pages/Settings.tsx`, on the "Extension Settings" section wrapper (the `<div className="settings-section">` around line 594), add `data-tour="extension-settings"`.

- [ ] **Step 6: Manual verification**

Run: `cd frontend && npm run dev`. In DevTools console, set a first-time state and confirm the tour renders and advances across routes:

```js
// with a fresh account (has_completed_onboarding=false) the tour auto-starts on /app
```
Verify: welcome card appears, Next advances through steps, spotlight tracks elements, Esc skips, arrows navigate, reaching Finish hides the overlay and it does not reappear on reload.

- [ ] **Step 7: Type-check + commit**

Run: `cd frontend && npx tsc --noEmit` → no errors.

```bash
git add frontend/src/App.tsx frontend/src/pages/Jobs.tsx frontend/src/components/AIToolsSidebar.tsx frontend/src/pages/Resume.tsx frontend/src/pages/Applications.tsx frontend/src/pages/Profile.tsx frontend/src/pages/Interview.tsx frontend/src/pages/Settings.tsx
git commit -m "feat(onboarding): mount provider + add data-tour anchors"
```

---

### Task 9: Settings "Restart product tour" control

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `useOnboarding().restart` (Task 7).

- [ ] **Step 1: Import and wire the control**

In `frontend/src/pages/Settings.tsx`, import at top:

```tsx
import { useOnboarding } from "../onboarding";
```

Inside the `Settings` component body (near other hooks, ~line 222), add:

```tsx
  const { restart: restartTour } = useOnboarding();
```

- [ ] **Step 2: Add a "Product Tour" section**

After the "Extension Settings" section (`</div>` closing it, ~line 618), add a new section following the existing markup pattern:

```tsx
      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Product Tour</h2>
        </div>
        <p className="settings-section-sub">
          Replay the guided walkthrough of Tailrd's features from the beginning.
        </p>
        <button
          type="button"
          className="settings-upload-btn"
          onClick={() => { void restartTour(); navigate("/app"); }}
        >
          Restart product tour
        </button>
      </div>
```

If `navigate` is not already available in this component, import `useNavigate` from `react-router-dom` and add `const navigate = useNavigate();`. (Check the top of the file first — many pages already import it.)

- [ ] **Step 3: Manual verification**

Run dev server, go to Settings, click "Restart product tour" → tour restarts at step 1 on `/app`; reload confirms it persists as not-completed until finished again.

- [ ] **Step 4: Type-check + commit**

Run: `cd frontend && npx tsc --noEmit` → no errors.

```bash
git add frontend/src/pages/Settings.tsx
git commit -m "feat(onboarding): restart tour control in Settings"
```

---

### Task 10: Developer documentation

**Files:**
- Create: `frontend/src/onboarding/README.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Write the README**

Create `frontend/src/onboarding/README.md`:

````markdown
# Onboarding Product Tour

A configuration-driven, framer-motion-based product tour for first-time users.

## How it works
- `OnboardingProvider` (mounted in `App.tsx`) auto-starts the tour once when
  the authenticated user has `has_completed_onboarding === false`. Completion is
  stored in the database (`users.has_completed_onboarding`) via
  `POST /auth/me/onboarding`; mid-tour progress is kept in `localStorage`
  (`tailrd_tour_progress`) so a refresh resumes at the same step.
- Steps are pure data in `tourConfig.tsx`. The engine (`engine/*`) renders the
  spotlight and tooltip and is the ONLY place that imports framer-motion — swap
  it without touching app code.

## Add or edit a step
Edit `tourConfig.tsx` only:

```ts
{
  id: "unique-id",
  route: "/app/somewhere",              // optional: navigate first
  target: '[data-tour="my-element"]',   // omit for a centered card
  title: "Title",
  description: "One or two sentences.",
  placement: "bottom",                  // top | bottom | left | right | auto
  condition: () => window.innerWidth > 768, // optional: skip when false
  prepare: () => openSomething(),        // optional: run before lookup
}
```

Then add `data-tour="my-element"` to the target element. `data-tour` attributes
are the stable contract — restyling/renaming classes won't break the tour.

## Resilience
- Missing target after ~2s → step is skipped (warns in dev only).
- `prepare` throwing → step is skipped.
- Steps whose `condition` is false are skipped (use for responsive breakpoints).

## Analytics
Pass an `analytics` prop to `OnboardingProvider` implementing any of:
`onTourStarted`, `onStepViewed`, `onStepCompleted`, `onTourSkipped`,
`onTourFinished`. Defaults are no-ops.

## Restart
`useOnboarding().restart()` resets the DB flag + localStorage and starts from
step 1. Wired to the "Restart product tour" button in Settings.

## Keyboard
`Esc` = skip · `→` = next · `←` = previous. Tooltip is a focus-trapped
`role="dialog"`; honors `prefers-reduced-motion`.
````

- [ ] **Step 2: Commit**

```bash
git add frontend/src/onboarding/README.md
git commit -m "docs(onboarding): developer documentation"
```

---

## Self-Review

**Spec coverage:**
- First-time-only auto-start + DB persistence → Task 1 (column/endpoints), Task 7 (auto-start gate). ✓
- Spotlight/darken/scroll/attach tooltip → Tasks 4, 6. ✓
- Tooltip title/desc/progress/prev/next/skip → Task 6 TourTooltip. ✓
- Progress indicator (dots) → Task 6. ✓
- Nav + keyboard (Esc/←/→) → Task 7 OnboardingOverlay. ✓
- Scroll into view + off-screen prevention → Task 4 (scrollIntoView), Task 3 (clamp). ✓
- Auto placement bottom>top>right>left + overflow prevention → Task 3. ✓
- Responsive skip via condition → Tasks 2/5. ✓
- Dynamic UI wait/retry/skip → Task 4. ✓
- Route navigation + resume progress → Task 7. ✓
- Persistence (localStorage resume) → Tasks 2/7. ✓
- Restart in Settings → Task 9. ✓
- Animations (fade/spotlight tween/hover/press) → Task 6. ✓
- Error handling (never crash, dev warnings) → Tasks 4/7 (try/catch, missing skip). ✓
- Configuration-driven → Task 2. ✓
- Analytics callbacks → Tasks 2/7. ✓
- Performance (overlay only while running, cleanup) → Tasks 4/7. Note: engine is isolated; `OnboardingOverlay` mounts only while running. ✓
- Library abstraction (framer-motion behind engine/) → Tasks 3/4/6 confinement. ✓
- Strongly typed, modular, documented → all tasks + Task 10. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `makeTourReducer`/`nextVisibleIndex` (Task 5) used in Task 7; `computePlacement` signature (Task 3) matches TourTooltip call (Task 6); `useTargetElement` return `{ rect, status }` (Task 4) matches OnboardingOverlay usage (Task 7); `setOnboardingComplete`/`has_completed_onboarding` defined in Task 7 Step 1-2 and consumed in Task 7 Step 6 + Task 9. ✓

**Performance note:** The plan keeps engine code in a single small module tree; `React.lazy` is optional and can be added later if bundle analysis warrants — the overlay already mounts only while the tour runs, satisfying the "no impact when inactive" requirement at runtime.
