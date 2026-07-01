# Post-Signup Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After email verification, gate the dashboard behind a required, config-driven setup wizard that collects job-search preferences + resume, persists them, and seeds the dashboard's job-feed filters so the first load is personalized.

**Architecture:** New `frontend/src/setup/` framework (split-screen layout, config-driven steps, pure answers→filters mapping), gated via `ProtectedRoute` on a new `users.has_completed_setup` flag. Reuses existing `PUT /settings`, `POST /settings/resume`, and the dashboard's `localStorage["job-aggregator-filters"]` seed.

**Tech Stack:** React 18 + TS + Vite, React Router v6, framer-motion (installed), Phosphor icons; FastAPI + SQLAlchemy + Neon.

## Global Constraints

- Branch: `feat/setup-wizard` (already created).
- Theme: existing CSS tokens only (`--stripe-primary` #533afd, `--accent`, `--accent-light`, `--radius-card`, `--shadow-card`, `--text*`, `--border`). No reference-green. No new brand color literals.
- No new npm dependency (framer-motion only).
- Wizard is REQUIRED: header shows only Logout; no "skip wizard". Only the resume STEP is skippable.
- Never trap the user: a failed `PUT /settings` or resume upload shows an inline error but must not prevent finishing (the flag flip + localStorage seed are what gate + personalize).
- `localStorage` key for filters is `job-aggregator-filters` (const `FILTER_STORAGE_KEY` in Jobs.tsx); the written object MUST match the `JobFilters` interface exactly.
- Flag is `has_completed_setup`, DISTINCT from the tour's `has_completed_onboarding`.
- Frontend tests: from `frontend/`, `npx vitest --run <path>` (NOT `npm test` — stdio quirk exits 1 no output; fallback `node ./node_modules/vitest/vitest.mjs run <path>`). Typecheck: `npx tsc --noEmit`.
- Backend tests from repo root: `python -m pytest <path> -v` (the shared conftest's `TestClient(app)` enters the app lifespan → runs real startup migrations against the Neon DEV DB; slower, touches Neon; the new migration is idempotent so this is safe).

---

### Task 1: Backend — has_completed_setup column, migration, endpoints

**Files:**
- Modify: `backend/db/models.py` (User model, next to `has_completed_onboarding`)
- Create: `backend/migrations/add_setup_field.py`
- Modify: `backend/main.py` (import + call migration in lifespan)
- Modify: `backend/routers/auth.py` (expose field in both `/me` returns; add `POST /auth/me/setup`)
- Test: `backend/tests/test_setup_api.py`

**Interfaces:**
- Produces: `User.has_completed_setup: bool`; `GET /auth/me` returns `has_completed_setup`; `POST /auth/me/setup` body `{ "completed": bool }` returns the `/me` payload.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_setup_api.py`:

```python
"""Tests for the setup-completion flag: /auth/me exposure + POST toggle."""
from backend.db.models import User
from backend.tests.conftest import TEST_USER_ID


def _make_user(db):
    user = User(id=TEST_USER_ID, email="setup@test.com", first_name="Setup")
    db.add(user)
    db.commit()
    return user


def test_me_includes_setup_flag_default_false(client, db_session):
    _make_user(db_session)
    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["has_completed_setup"] is False


def test_post_setup_sets_completed_true(client, db_session):
    _make_user(db_session)
    resp = client.post("/auth/me/setup", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["has_completed_setup"] is True
    assert client.get("/auth/me").json()["has_completed_setup"] is True


def test_post_setup_reset_to_false(client, db_session):
    _make_user(db_session)
    client.post("/auth/me/setup", json={"completed": True})
    resp = client.post("/auth/me/setup", json={"completed": False})
    assert resp.status_code == 200
    assert resp.json()["has_completed_setup"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_setup_api.py -v`
Expected: FAIL — `has_completed_setup` missing / endpoint 404.

- [ ] **Step 3: Add the column**

In `backend/db/models.py`, immediately after the `has_completed_onboarding` column, add:

```python
    has_completed_setup = Column(Boolean, default=False, nullable=False)
```

- [ ] **Step 4: Create the idempotent migration**

Create `backend/migrations/add_setup_field.py`:

```python
"""
Migration: Add has_completed_setup field to users table.

Adds:
  - has_completed_setup (Boolean, NOT NULL, default false)

Idempotent: skips if column already exists.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add has_completed_setup column to users table if missing."""
    inspector = inspect(engine)

    if "users" not in inspector.get_table_names():
        logger.info("Setup migration skipped: 'users' table missing.")
        return

    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    if "has_completed_setup" in existing_columns:
        logger.info("Column has_completed_setup already exists, skipping.")
        return

    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN has_completed_setup "
                "BOOLEAN NOT NULL DEFAULT false"
            )
        )
    logger.info("Setup migration completed successfully.")
```

- [ ] **Step 5: Register the migration**

In `backend/main.py`, add the import next to `run_onboarding_migration`:

```python
from backend.migrations.add_setup_field import run_migration as run_setup_migration
```

And in the lifespan block, immediately after `run_onboarding_migration()`:

```python
    run_setup_migration()
```

- [ ] **Step 6: Expose + write the flag in auth.py**

(a) In `backend/routers/auth.py`, add `"has_completed_setup": bool(user.has_completed_setup),` to BOTH return dicts in `get_me` and `update_me` (next to the `has_completed_onboarding` line).

(b) Near `OnboardingUpdate`, add:

```python
class SetupUpdate(BaseModel):
    completed: bool
```

(c) After the `set_onboarding` endpoint, add (mirroring it — `get_current_user_id` is already imported):

```python
@router.post("/me/setup")
def set_setup(
    body: SetupUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Set the current user's setup-completion flag."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.has_completed_setup = body.completed
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
        "has_completed_setup": bool(user.has_completed_setup),
    }
```

Also add `"has_completed_setup": bool(user.has_completed_setup),` to the existing `set_onboarding` return dict so both flags are always present in `/me`-shaped payloads.

- [ ] **Step 7: Run tests to verify they pass**

Run: `python -m pytest backend/tests/test_setup_api.py -v`
Expected: 3 passed.

- [ ] **Step 8: Commit**

```bash
git add backend/db/models.py backend/migrations/add_setup_field.py backend/main.py backend/routers/auth.py backend/tests/test_setup_api.py
git commit -m "feat(setup): add has_completed_setup column + endpoints"
```

---

### Task 2: Frontend auth wiring for the setup flag

**Files:**
- Modify: `frontend/src/auth/AuthContext.tsx`
- Modify: `frontend/src/auth/AuthProvider.tsx`

**Interfaces:**
- Consumes: `POST /auth/me/setup` (Task 1).
- Produces: `UserProfile.has_completed_setup?: boolean`; `AuthContextValue.setSetupComplete(completed: boolean): Promise<void>`.

- [ ] **Step 1: Extend AuthContext types**

In `frontend/src/auth/AuthContext.tsx`, add to `UserProfile`:

```ts
  has_completed_setup?: boolean;
```

and to `AuthContextValue`:

```ts
  setSetupComplete: (completed: boolean) => Promise<void>;
```

- [ ] **Step 2: Implement setSetupComplete in AuthProvider**

In `frontend/src/auth/AuthProvider.tsx`, after `setOnboardingComplete`:

```ts
  const setSetupComplete = useCallback(async (completed: boolean) => {
    const { data } = await api.post("/auth/me/setup", { completed });
    setUser(data);
  }, []);
```

and add `setSetupComplete` to the `value` object.

- [ ] **Step 3: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit` → no errors.

```bash
git add frontend/src/auth/AuthContext.tsx frontend/src/auth/AuthProvider.tsx
git commit -m "feat(setup): auth context wiring for setup flag"
```

---

### Task 3: Setup types, shared option exports, and answers→filters mapping

**Files:**
- Modify: `frontend/src/components/JobFilterBar.tsx` (export 3 option consts)
- Create: `frontend/src/setup/types.ts`
- Create: `frontend/src/setup/answersToFilters.ts`
- Test: `frontend/src/setup/__tests__/answersToFilters.test.ts`

**Interfaces:**
- Consumes: `JobFilters` type from `../components/JobFilterBar`.
- Produces: `SetupAnswers`, `SetupStep`, `StepProps`, `emptyAnswers`; `answersToFilters(a: SetupAnswers): JobFilters`; exported `JOB_FUNCTION_OPTIONS`, `EXPERIENCE_OPTIONS`, `COUNTRY_OPTIONS` from JobFilterBar.

- [ ] **Step 1: Export the option constants**

In `frontend/src/components/JobFilterBar.tsx`, add `export` to these three existing declarations (do not change their values):
- `const JOB_FUNCTION_OPTIONS = [ ... ]` → `export const JOB_FUNCTION_OPTIONS`
- `const EXPERIENCE_OPTIONS = [ ... ]` → `export const EXPERIENCE_OPTIONS`
- `const COUNTRY_OPTIONS = [ ... ]` → `export const COUNTRY_OPTIONS`

Also ensure `JobFilters` is exported (it already is).

- [ ] **Step 2: Create types.ts**

```ts
import type { ComponentType } from "react";

export interface SetupAnswers {
  first_name: string;
  last_name: string;
  job_functions: string[];      // values from JOB_FUNCTION_OPTIONS -> role_category
  job_types: string[];          // "full_time"|"part_time"|"contract"|"internship" (captured only)
  country: string;              // "CA" | "US" | ""
  city: string;
  open_to_remote: boolean;
  work_authorization: string[]; // e.g. ["needs_sponsorship"] (captured only)
  experience_level: string;     // one EXPERIENCE_OPTIONS value
  target_titles: string[];      // free-text chips (captured only)
}

export interface StepProps {
  answers: SetupAnswers;
  update: (patch: Partial<SetupAnswers>) => void;
}

export interface SetupStep {
  id: string;
  headline: string;                         // left assistant-panel headline
  Component: ComponentType<StepProps>;
  validate?: (a: SetupAnswers) => string | null; // error string or null
}

export const emptyAnswers: SetupAnswers = {
  first_name: "",
  last_name: "",
  job_functions: [],
  job_types: [],
  country: "",
  city: "",
  open_to_remote: false,
  work_authorization: [],
  experience_level: "",
  target_titles: [],
};
```

- [ ] **Step 3: Write the failing test**

Create `frontend/src/setup/__tests__/answersToFilters.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { answersToFilters } from "../answersToFilters";
import { emptyAnswers } from "../types";

describe("answersToFilters", () => {
  it("maps an empty answer set to empty filters", () => {
    expect(answersToFilters(emptyAnswers)).toEqual({
      country: "", location: [], work_type: [], role_category: [],
      experience_level: [], date_posted: "",
    });
  });

  it("maps country, city, remote, functions, and experience", () => {
    const r = answersToFilters({
      ...emptyAnswers,
      country: "CA",
      city: "Ottawa",
      open_to_remote: true,
      job_functions: ["Software Engineering", "Data Analysis"],
      experience_level: "intern_new_grad",
    });
    expect(r.country).toBe("CA");
    expect(r.location).toEqual(["Ottawa"]);
    expect(r.work_type).toEqual(["remote"]);
    expect(r.role_category).toEqual(["Software Engineering", "Data Analysis"]);
    expect(r.experience_level).toEqual(["intern_new_grad"]);
  });

  it("omits city from location when blank and remote when false", () => {
    const r = answersToFilters({ ...emptyAnswers, country: "US" });
    expect(r.location).toEqual([]);
    expect(r.work_type).toEqual([]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/setup/__tests__/answersToFilters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement answersToFilters.ts**

```ts
import type { JobFilters } from "../components/JobFilterBar";
import type { SetupAnswers } from "./types";

/**
 * Pure mapping from wizard answers to the dashboard's JobFilters shape.
 * Only fields with a real JobFilters counterpart are mapped; job_types,
 * work_authorization, and target_titles are captured in settings elsewhere.
 * The returned object must match JobFilters exactly (written to
 * localStorage["job-aggregator-filters"], read on the Jobs page).
 */
export function answersToFilters(a: SetupAnswers): JobFilters {
  return {
    country: a.country,
    location: a.city.trim() ? [a.city.trim()] : [],
    work_type: a.open_to_remote ? ["remote"] : [],
    role_category: [...a.job_functions],
    experience_level: a.experience_level ? [a.experience_level] : [],
    date_posted: "",
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest --run src/setup/__tests__/answersToFilters.test.ts`
Expected: PASS (3 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/JobFilterBar.tsx frontend/src/setup/types.ts frontend/src/setup/answersToFilters.ts frontend/src/setup/__tests__/answersToFilters.test.ts
git commit -m "feat(setup): answers types + answers-to-filters mapping"
```

---

### Task 4: Split-screen layout + CSS

**Files:**
- Create: `frontend/src/setup/SetupLayout.tsx`
- Create: `frontend/src/setup/setup.css`

**Interfaces:**
- Produces: `SetupLayout({ headline, stepIndex, total, children })` — left assistant panel (gradient + persona + headline), right form area with progress dots and a top-right Logout button.

- [ ] **Step 1: Create setup.css**

```css
.setup-root { position: fixed; inset: 0; display: grid; grid-template-columns: 45% 55%; background: var(--bg-white, #fff); z-index: 60; }
.setup-left {
  position: relative; padding: 48px; display: flex; flex-direction: column; justify-content: center;
  background: linear-gradient(150deg, var(--accent-light, #eef0ff) 0%, #e7e9ff 45%, #f3edff 100%);
}
.setup-assistant { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
.setup-assistant-avatar {
  width: 44px; height: 44px; border-radius: 9999px; display: grid; place-items: center;
  background: var(--accent, #533afd); color: #fff;
}
.setup-assistant-name { font-weight: 650; font-size: 15px; color: var(--text, #1a1a1a); }
.setup-assistant-sub { font-size: 12px; color: var(--text-secondary, #555); }
.setup-headline { font-size: 30px; line-height: 1.2; font-weight: 600; color: var(--text, #1a1a1a); max-width: 460px; }
.setup-headline b { color: var(--accent, #533afd); font-weight: 750; }

.setup-right { position: relative; padding: 40px 56px; overflow-y: auto; display: flex; flex-direction: column; }
.setup-logout { position: absolute; top: 20px; right: 24px; background: transparent; border: 1px solid var(--border, #e6e6e6); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; color: var(--text-secondary, #555); }
.setup-logout:hover { border-color: var(--accent, #533afd); color: var(--accent, #533afd); }
.setup-dots { display: flex; gap: 6px; margin: 8px 0 28px; }
.setup-dot { width: 22px; height: 5px; border-radius: 9999px; background: var(--border, #e2e2e2); transition: background .2s ease; }
.setup-dot.active { background: var(--accent, #533afd); }
.setup-dot.done { background: var(--accent-soft, #d8d4ff); }
.setup-form { flex: 1; max-width: 620px; width: 100%; }
.setup-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 32px; max-width: 620px; }
.setup-field { margin-bottom: 22px; }
.setup-label { display: block; font-size: 13px; font-weight: 600; color: var(--text, #1a1a1a); margin-bottom: 8px; }
.setup-label .req { color: #d1435b; margin-right: 4px; }
.setup-input, .setup-select {
  width: 100%; padding: 11px 14px; border: 1px solid var(--border, #e6e6e6); border-radius: 10px;
  font: inherit; font-size: 14px; background: var(--bg-page, #fafbfc); color: var(--text, #1a1a1a);
}
.setup-input:focus, .setup-select:focus { outline: none; border-color: var(--accent, #533afd); background: #fff; }
.setup-checkgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.setup-check {
  display: flex; align-items: center; gap: 10px; padding: 11px 14px; border: 1px solid var(--border, #e6e6e6);
  border-radius: 10px; cursor: pointer; background: var(--bg-page, #fafbfc); font-size: 14px;
}
.setup-check.checked { border-color: var(--accent, #533afd); background: var(--accent-light, #eef0ff); }
.setup-error { color: #d1435b; font-size: 13px; margin-top: -12px; margin-bottom: 16px; }
.setup-btn {
  font: inherit; font-size: 14px; font-weight: 650; cursor: pointer; border: none; border-radius: 9999px;
  padding: 11px 30px; background: var(--accent, #533afd); color: #fff; transition: background .15s ease, transform .05s ease;
}
.setup-btn:hover { background: var(--accent-hover, #4434d4); }
.setup-btn:active { transform: scale(0.98); }
.setup-btn:disabled { opacity: .55; cursor: not-allowed; }
.setup-back { background: transparent; border: none; color: var(--text-secondary, #555); font-size: 14px; cursor: pointer; }
.setup-back:hover { color: var(--text, #1a1a1a); }
.setup-skip { background: transparent; border: none; color: var(--text-muted, #888); font-size: 13px; cursor: pointer; text-decoration: underline; }

@media (max-width: 860px) { .setup-root { grid-template-columns: 1fr; } .setup-left { display: none; } }
@media (prefers-reduced-motion: reduce) { .setup-anim { transition: none !important; } }
```

- [ ] **Step 2: Create SetupLayout.tsx**

```tsx
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { ChatCircleDots } from "@phosphor-icons/react";
import { useAuth } from "../auth/useAuth";

interface Props {
  headline: string;
  stepIndex: number;
  total: number;
  children: ReactNode;
}

export function SetupLayout({ headline, stepIndex, total, children }: Props) {
  const { logout } = useAuth();
  return (
    <div className="setup-root">
      <div className="setup-left">
        <div className="setup-assistant">
          <span className="setup-assistant-avatar">
            <ChatCircleDots size={22} weight="fill" />
          </span>
          <span>
            <div className="setup-assistant-name">Tailrd Assistant</div>
            <div className="setup-assistant-sub">Your AI job copilot</div>
          </span>
        </div>
        <motion.h1
          key={headline}
          className="setup-headline setup-anim"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          dangerouslySetInnerHTML={{ __html: headline }}
        />
      </div>
      <div className="setup-right">
        <button className="setup-logout" onClick={logout}>Logout</button>
        <div className="setup-dots" aria-label={`Step ${stepIndex + 1} of ${total}`}>
          {Array.from({ length: total }).map((_, i) => (
            <span key={i} className={`setup-dot${i === stepIndex ? " active" : i < stepIndex ? " done" : ""}`} />
          ))}
        </div>
        <motion.div
          key={stepIndex}
          className="setup-form setup-anim"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22 }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}
```

Note: `headline` supports simple `<b>` emphasis via `dangerouslySetInnerHTML`; headlines are static strings from config (no user input), so this is safe.

- [ ] **Step 3: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit` → no errors.

```bash
git add frontend/src/setup/SetupLayout.tsx frontend/src/setup/setup.css
git commit -m "feat(setup): split-screen layout + theme css"
```

---

### Task 5: Step components + config

**Files:**
- Create: `frontend/src/setup/steps/WelcomeNameStep.tsx`
- Create: `frontend/src/setup/steps/RolePreferencesStep.tsx`
- Create: `frontend/src/setup/steps/ExperienceStep.tsx`
- Create: `frontend/src/setup/steps/TargetTitlesStep.tsx`
- Create: `frontend/src/setup/steps/ResumeStep.tsx`
- Create: `frontend/src/setup/setupConfig.tsx`

**Interfaces:**
- Consumes: `StepProps`, `SetupAnswers` (Task 3); `JOB_FUNCTION_OPTIONS`, `EXPERIENCE_OPTIONS`, `COUNTRY_OPTIONS` (Task 3 exports).
- Produces: `SETUP_STEPS: SetupStep[]`; each step component. `ResumeStep` additionally accepts an `onResumeSelected(file: File) => void` via context-free prop drilling (see below).

- [ ] **Step 1: WelcomeNameStep.tsx**

```tsx
import type { StepProps } from "../types";

export function WelcomeNameStep({ answers, update }: StepProps) {
  return (
    <>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>First name</label>
        <input className="setup-input" value={answers.first_name}
          onChange={(e) => update({ first_name: e.target.value })} placeholder="Jane" />
      </div>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Last name</label>
        <input className="setup-input" value={answers.last_name}
          onChange={(e) => update({ last_name: e.target.value })} placeholder="Doe" />
      </div>
    </>
  );
}
```

- [ ] **Step 2: RolePreferencesStep.tsx**

```tsx
import type { StepProps } from "../types";
import { JOB_FUNCTION_OPTIONS, COUNTRY_OPTIONS } from "../../components/JobFilterBar";

const JOB_TYPES = [
  { value: "full_time", label: "Full-time" },
  { value: "contract", label: "Contract" },
  { value: "part_time", label: "Part-time" },
  { value: "internship", label: "Internship" },
];

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function RolePreferencesStep({ answers, update }: StepProps) {
  return (
    <>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Job Function</label>
        <div className="setup-checkgrid">
          {JOB_FUNCTION_OPTIONS.map((fn) => (
            <label key={fn} className={`setup-check${answers.job_functions.includes(fn) ? " checked" : ""}`}>
              <input type="checkbox" checked={answers.job_functions.includes(fn)}
                onChange={() => update({ job_functions: toggle(answers.job_functions, fn) })} />
              {fn}
            </label>
          ))}
        </div>
      </div>

      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Job Type</label>
        <div className="setup-checkgrid">
          {JOB_TYPES.map((t) => (
            <label key={t.value} className={`setup-check${answers.job_types.includes(t.value) ? " checked" : ""}`}>
              <input type="checkbox" checked={answers.job_types.includes(t.value)}
                onChange={() => update({ job_types: toggle(answers.job_types, t.value) })} />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Location</label>
        <div className="setup-checkgrid">
          <select className="setup-select" value={answers.country}
            onChange={(e) => update({ country: e.target.value })}>
            <option value="">Select country</option>
            {COUNTRY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <input className="setup-input" value={answers.city}
            onChange={(e) => update({ city: e.target.value })} placeholder="City (optional)" />
        </div>
        <label className={`setup-check${answers.open_to_remote ? " checked" : ""}`} style={{ marginTop: 10 }}>
          <input type="checkbox" checked={answers.open_to_remote}
            onChange={(e) => update({ open_to_remote: e.target.checked })} />
          Open to Remote
        </label>
      </div>

      <div className="setup-field">
        <label className="setup-label">Work Authorization</label>
        <label className={`setup-check${answers.work_authorization.includes("needs_sponsorship") ? " checked" : ""}`}>
          <input type="checkbox" checked={answers.work_authorization.includes("needs_sponsorship")}
            onChange={() => update({ work_authorization: toggle(answers.work_authorization, "needs_sponsorship") })} />
          I will need visa sponsorship
        </label>
      </div>
    </>
  );
}
```

- [ ] **Step 3: ExperienceStep.tsx**

```tsx
import type { StepProps } from "../types";
import { EXPERIENCE_OPTIONS } from "../../components/JobFilterBar";

export function ExperienceStep({ answers, update }: StepProps) {
  return (
    <div className="setup-field">
      <label className="setup-label"><span className="req">*</span>Experience level</label>
      <div className="setup-checkgrid">
        {EXPERIENCE_OPTIONS.map((opt) => (
          <label key={opt.value} className={`setup-check${answers.experience_level === opt.value ? " checked" : ""}`}>
            <input type="radio" name="experience" checked={answers.experience_level === opt.value}
              onChange={() => update({ experience_level: opt.value })} />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: TargetTitlesStep.tsx**

```tsx
import { useState } from "react";
import type { StepProps } from "../types";

export function TargetTitlesStep({ answers, update }: StepProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !answers.target_titles.includes(v)) update({ target_titles: [...answers.target_titles, v] });
    setDraft("");
  };
  return (
    <div className="setup-field">
      <label className="setup-label">Target roles or industries (optional)</label>
      <input className="setup-input" value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        placeholder="e.g. Frontend Engineer — press Enter to add" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {answers.target_titles.map((t) => (
          <span key={t} className="setup-check checked" style={{ padding: "6px 12px" }}
            onClick={() => update({ target_titles: answers.target_titles.filter((x) => x !== t) })}>
            {t} ✕
          </span>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: ResumeStep.tsx**

The resume file is held in the wizard (Task 6) and uploaded on finish. This step reports the chosen file up via a module-level callback prop pattern: it reads/writes through `answers`-adjacent state passed by the wizard. To keep `StepProps` uniform, store the selected file name in `answers` is NOT desired (File isn't serializable); instead the wizard passes an extra optional prop. Define ResumeStep to accept `StepProps & { file: File | null; onFile: (f: File | null) => void }`:

```tsx
import type { StepProps } from "../types";
import { FileArrowUp } from "@phosphor-icons/react";

type Props = StepProps & { file: File | null; onFile: (f: File | null) => void };

export function ResumeStep({ file, onFile }: Props) {
  return (
    <div className="setup-field" style={{ textAlign: "center" }}>
      <label className="setup-check" style={{ justifyContent: "center", cursor: "pointer", padding: "16px" }}>
        <FileArrowUp size={20} weight="bold" />
        {file ? file.name : "Upload your resume"}
        <input type="file" accept=".pdf,.docx" hidden
          onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      </label>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 12 }}>
        PDF or Word, up to 10MB. Your resume is used only for job matching.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: setupConfig.tsx**

```tsx
import type { SetupStep } from "./types";
import { WelcomeNameStep } from "./steps/WelcomeNameStep";
import { RolePreferencesStep } from "./steps/RolePreferencesStep";
import { ExperienceStep } from "./steps/ExperienceStep";
import { TargetTitlesStep } from "./steps/TargetTitlesStep";

// ResumeStep is rendered specially by the wizard (needs file props), so it is
// NOT in this array — the wizard appends it as the final step.
export const SETUP_STEPS: SetupStep[] = [
  {
    id: "welcome",
    headline: "Welcome to <b>Tailrd</b> — let's set up your job search.",
    Component: WelcomeNameStep,
    validate: (a) => (a.first_name.trim() && a.last_name.trim() ? null : "Please enter your first and last name."),
  },
  {
    id: "role",
    headline: "To get started, <b>what type of role</b> are you looking for?",
    Component: RolePreferencesStep,
    validate: (a) => {
      if (a.job_functions.length === 0) return "Please select at least one job function.";
      if (!a.country) return "Please select a location.";
      return null;
    },
  },
  {
    id: "experience",
    headline: "How much <b>experience</b> do you have?",
    Component: ExperienceStep,
    validate: (a) => (a.experience_level ? null : "Please select your experience level."),
  },
  {
    id: "targets",
    headline: "Any <b>specific roles</b> you're targeting?",
    Component: TargetTitlesStep,
  },
];
```

- [ ] **Step 7: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit` → no errors.

```bash
git add frontend/src/setup/steps frontend/src/setup/setupConfig.tsx
git commit -m "feat(setup): wizard step components + config"
```

---

### Task 6: SetupWizard state machine + submit orchestration

**Files:**
- Create: `frontend/src/setup/SetupWizard.tsx`
- Create: `frontend/src/setup/index.ts`
- Test: `frontend/src/setup/__tests__/SetupWizard.test.tsx`

**Interfaces:**
- Consumes: `SETUP_STEPS` (Task 5), `ResumeStep` (Task 5), `SetupLayout` (Task 4), `answersToFilters` (Task 3), `emptyAnswers` (Task 3), `useAuth().setSetupComplete` + `user` (Task 2), `api` (`../auth/api`), React Router `useNavigate`.
- Produces: `SetupWizard()` default export; `frontend/src/setup/index.ts` re-exporting it. On finish: `PUT /settings`, seed `localStorage["job-aggregator-filters"]`, `setSetupComplete(true)`, navigate `/app`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/setup/__tests__/SetupWizard.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SetupWizard from "../SetupWizard";
import { AuthContext } from "../../auth/AuthContext";

const putMock = vi.fn().mockResolvedValue({ data: {} });
const navigateMock = vi.fn();
vi.mock("../../auth/api", () => ({ default: { put: (...a: unknown[]) => putMock(...a), post: vi.fn() } }));
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock,
}));

function renderWizard() {
  const setSetupComplete = vi.fn().mockResolvedValue(undefined);
  const value: any = {
    isAuthenticated: true, isLoading: false, logout: vi.fn(),
    user: { id: 1, email: "a@b.c", first_name: "Jane", last_name: "Doe", email_verified: true, has_completed_setup: false },
    setSetupComplete,
  };
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <AuthContext.Provider value={value}>
        <SetupWizard />
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { setSetupComplete };
}

describe("SetupWizard", () => {
  beforeEach(() => { localStorage.clear(); putMock.mockClear(); navigateMock.mockClear(); });

  it("blocks advancing past a step that fails validation", () => {
    renderWizard();
    // welcome step has name pre-filled from user, so it passes; role step is next
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i })); // role step, nothing selected
    expect(screen.getByText(/at least one job function/i)).toBeInTheDocument();
  });

  it("prefills name from the authenticated user", () => {
    renderWizard();
    expect((screen.getByPlaceholderText("Jane") as HTMLInputElement).value).toBe("Jane");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/setup/__tests__/SetupWizard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create SetupWizard.tsx**

```tsx
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import api from "../auth/api";
import { SetupLayout } from "./SetupLayout";
import { SETUP_STEPS } from "./setupConfig";
import { ResumeStep } from "./steps/ResumeStep";
import { answersToFilters } from "./answersToFilters";
import { emptyAnswers, type SetupAnswers, type SetupStep } from "./types";

const FILTER_STORAGE_KEY = "job-aggregator-filters";

export default function SetupWizard() {
  const { user, setSetupComplete } = useAuth();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [answers, setAnswers] = useState<SetupAnswers>(() => ({
    ...emptyAnswers,
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
  }));

  // Resume is the final step, appended after the config steps.
  const resumeStep: SetupStep = useMemo(
    () => ({ id: "resume", headline: "One last step — <b>level up</b> your search with your resume.", Component: () => null }),
    [],
  );
  const steps = useMemo(() => [...SETUP_STEPS, resumeStep], [resumeStep]);
  const isLast = index === steps.length - 1;
  const step = steps[index];

  const update = (patch: Partial<SetupAnswers>) => setAnswers((a) => ({ ...a, ...patch }));

  const persist = async () => {
    // 1) Settings (durable). Failure surfaces but does not trap the user.
    try {
      await api.put("/settings", {
        first_name: answers.first_name,
        last_name: answers.last_name,
        job_title: answers.job_functions[0] ?? "",
        location: answers.city,
        remote_only: answers.open_to_remote,
        work_type: answers.open_to_remote ? "remote" : "",
        experience_levels: answers.experience_level ? [answers.experience_level] : [],
        regions: answers.country ? [answers.country] : [],
        prefilled_answers: {
          job_types: answers.job_types.join(","),
          work_authorization: answers.work_authorization.join(","),
          target_titles: answers.target_titles.join(","),
        },
      });
    } catch {
      /* non-fatal: user can re-save in Settings */
    }
    // 2) Resume upload (optional). Failure is non-fatal.
    if (resumeFile) {
      try {
        const fd = new FormData();
        fd.append("file", resumeFile);
        await api.post("/settings/resume", fd);
      } catch {
        /* non-fatal */
      }
    }
    // 3) Seed dashboard filters so first load is personalized.
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(answersToFilters(answers)));
    } catch {
      /* ignore quota */
    }
  };

  const handleNext = async () => {
    if (step.validate) {
      const msg = step.validate(answers);
      if (msg) { setError(msg); return; }
    }
    setError(null);
    if (!isLast) { setIndex((i) => i + 1); return; }
    // finish
    setSubmitting(true);
    await persist();
    try {
      await setSetupComplete(true);
      navigate("/app");
    } catch {
      setError("Something went wrong finishing setup. Please try again.");
      setSubmitting(false);
    }
  };

  const handleBack = () => { setError(null); setIndex((i) => Math.max(0, i - 1)); };

  return (
    <SetupLayout headline={step.headline} stepIndex={index} total={steps.length}>
      {step.id === "resume"
        ? <ResumeStep answers={answers} update={update} file={resumeFile} onFile={setResumeFile} />
        : <step.Component answers={answers} update={update} />}
      {error && <div className="setup-error" role="alert">{error}</div>}
      <div className="setup-footer">
        {index > 0
          ? <button className="setup-back" onClick={handleBack} disabled={submitting}>Back</button>
          : <span />}
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {isLast && <button className="setup-skip" onClick={handleNext} disabled={submitting}>I'll do this later</button>}
          <button className="setup-btn" onClick={handleNext} disabled={submitting}>
            {isLast ? (submitting ? "Starting…" : "Start Matching") : "Next"}
          </button>
        </div>
      </div>
    </SetupLayout>
  );
}
```

Note: on the resume step, both "I'll do this later" and "Start Matching" call `handleNext`; the only difference is whether a file was chosen (`resumeFile`), so the skip path simply finishes without a file. This satisfies "resume step is skippable" with no separate code path.

- [ ] **Step 4: Create index.ts**

```ts
import "./setup.css";
export { default as SetupWizard } from "./SetupWizard";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npx vitest --run src/setup/__tests__/SetupWizard.test.tsx` → PASS (2). Then `npx vitest --run src/setup` → all setup tests pass. Then `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/setup/SetupWizard.tsx frontend/src/setup/index.ts frontend/src/setup/__tests__/SetupWizard.test.tsx
git commit -m "feat(setup): wizard state machine + submit orchestration"
```

---

### Task 7: Routing + gating

**Files:**
- Modify: `frontend/src/main.tsx` (add `/setup` route)
- Modify: `frontend/src/auth/ProtectedRoute.tsx` (gate `/app` on setup completion)
- Create: `frontend/src/auth/SetupRoute.tsx` (guard for `/setup` itself)
- Test: `frontend/src/auth/__tests__/setup-gating.test.tsx`

**Interfaces:**
- Consumes: `SetupWizard` (Task 6), `useAuth()` with `user.has_completed_setup`, `isAuthenticated`, `isEmailVerified`, `isLoading`.
- Produces: `/setup` route; `ProtectedRoute` redirects verified+incomplete users to `/setup`; `SetupRoute` redirects completed users to `/app` and unauth/unverified users appropriately.

- [ ] **Step 1: Write the failing gating test**

Create `frontend/src/auth/__tests__/setup-gating.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProtectedRoute } from "../ProtectedRoute";
import * as useAuthMod from "../useAuth";

function mockAuth(over: Record<string, unknown>) {
  vi.spyOn(useAuthMod, "useAuth").mockReturnValue({
    isAuthenticated: true, isLoading: false, isEmailVerified: true,
    user: { id: 1, email: "a@b.c", first_name: "A", last_name: "B", email_verified: true, has_completed_setup: true },
    ...over,
  } as never);
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<ProtectedRoute><div>DASHBOARD</div></ProtectedRoute>} />
        <Route path="/setup" element={<div>SETUP</div>} />
        <Route path="/verify-email" element={<div>VERIFY</div>} />
        <Route path="/sign-in" element={<div>SIGNIN</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute setup gate", () => {
  it("redirects a verified user who has not completed setup to /setup", () => {
    mockAuth({ user: { id: 1, email: "a@b.c", email_verified: true, has_completed_setup: false } });
    renderApp();
    expect(screen.getByText("SETUP")).toBeInTheDocument();
  });

  it("allows a verified user who completed setup into the dashboard", () => {
    mockAuth({});
    renderApp();
    expect(screen.getByText("DASHBOARD")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/auth/__tests__/setup-gating.test.tsx`
Expected: FAIL — first test shows DASHBOARD (no gate yet).

- [ ] **Step 3: Add the gate to ProtectedRoute.tsx**

In `frontend/src/auth/ProtectedRoute.tsx`, pull `user` from `useAuth()` and add a check AFTER the `isEmailVerified` redirect and BEFORE `return <>{children}</>`:

```tsx
  const { isAuthenticated, isLoading, isEmailVerified, user } = useAuth();
  // ... existing isLoading / !isAuthenticated / !isEmailVerified returns ...

  if (user && user.has_completed_setup === false) {
    return <Navigate to="/setup" replace />;
  }

  return <>{children}</>;
```

(Use `=== false` so a missing/undefined flag does not trap existing sessions before `/me` reports it; the backend defaults it to false for genuinely new users.)

- [ ] **Step 4: Create SetupRoute.tsx**

```tsx
import { Navigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { SetupWizard } from "../setup";

export function SetupRoute() {
  const { isAuthenticated, isLoading, isEmailVerified, user } = useAuth();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/sign-in" replace />;
  if (!isEmailVerified) return <Navigate to="/verify-email" replace />;
  if (user?.has_completed_setup) return <Navigate to="/app" replace />;
  return <SetupWizard />;
}
```

- [ ] **Step 5: Register the route in main.tsx**

In `frontend/src/main.tsx`, import and add the route as a SIBLING of `/app` (not nested inside the App shell). Add the import:

```tsx
import { SetupRoute } from "./auth/SetupRoute";
```

and inside `<Routes>`, before the `/app` route:

```tsx
          <Route path="/setup" element={<SetupRoute />} />
```

- [ ] **Step 6: Run tests + typecheck + full onboarding/setup suites**

Run:
- `cd frontend && npx vitest --run src/auth/__tests__/setup-gating.test.tsx` → PASS (2).
- `npx vitest --run src/setup src/onboarding` → all pass (setup + prior onboarding suites unaffected).
- `npx tsc --noEmit` → clean.

- [ ] **Step 7: Manual verification (deferred to controller/human)**

With a fresh verified account (`has_completed_setup=false`): visiting `/app` redirects to `/setup`; completing the wizard lands on `/app` pre-filtered and the product tour auto-starts; reloading does not reshow setup; `/setup` visited after completion redirects to `/app`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/main.tsx frontend/src/auth/ProtectedRoute.tsx frontend/src/auth/SetupRoute.tsx frontend/src/auth/__tests__/setup-gating.test.tsx
git commit -m "feat(setup): route + gate dashboard behind setup wizard"
```

---

## Self-Review

**Spec coverage:**
- Required wizard before dashboard, verified users only → Task 7 (ProtectedRoute gate + SetupRoute). ✓
- Separate `has_completed_setup` flag + DB persistence → Task 1. ✓
- Verify → Setup → Tour sequencing (tour auto-start unchanged, gated by data) → Task 7 (lands `/app`). ✓
- Split-screen layout in our theme, assistant persona, progress dots, Logout-only header → Task 4. ✓
- Config-driven steps (welcome/name, role prefs, experience, target titles, resume) → Tasks 5–6. ✓
- Resume step skippable via `POST /settings/resume` → Tasks 5–6. ✓
- Persist to existing settings + prefilled_answers for job_types/work_auth/target_titles → Task 6 `persist()`. ✓
- Immediate dashboard personalization via `localStorage["job-aggregator-filters"]` seed → Tasks 3 + 6. ✓
- answers→filters only maps real JobFilters fields → Task 3. ✓
- Never trap the user on failures → Task 6 (try/catch around settings/resume; retry on flag failure). ✓
- Analytics/keyboard: not required by this spec (setup is a form, not a tour). N/A.
- Tests: mapping, wizard validation/prefill, gating, backend flag+migration → Tasks 1,3,6,7. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete.

**Type consistency:** `SetupAnswers`/`emptyAnswers`/`StepProps`/`SetupStep` (Task 3) used consistently in Tasks 5–6; `answersToFilters(a): JobFilters` (Task 3) matches the localStorage seed in Task 6; `setSetupComplete` + `has_completed_setup` (Tasks 1–2) consumed in Tasks 6–7; exported option consts (Task 3) imported in Task 5; `SETUP_STEPS` excludes resume (Task 5) and the wizard appends it (Task 6) — consistent.

**Refinement vs spec:** spec named `job_function: string`; the plan uses `job_functions: string[]` (multi-select) to match the reference's "select at least one job function" and to map directly to `role_category[]`. Intentional improvement, noted here.
