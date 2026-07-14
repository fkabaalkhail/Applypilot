# Profile: Application Answers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give web users a place to see and correct the four autofill answers the extension writes on their behalf — job title, work authorization, sponsorship, salary expectation — and fix the write-only `salaryExpectation` bug that makes one of them unreadable.

**Architecture:** No new endpoint, no migration, **no extension change**. `PUT /api/user/application-profile` already accepts all four keys (`profile.py:392` maps `currentTitle → job_title`; `:424-429` writes the screening answers into `prefilled_answers`), and `Profile.tsx` already calls both `GET` and `PUT` on that exact endpoint. The fields simply aren't bound to any client-side model — the GET returns them and `Profile.tsx` throws them away, because `ProfileExtras` only models address + EEO. This binds them.

**Tech Stack:** FastAPI + SQLAlchemy + pytest; React 18 + TypeScript + Vite; Vitest + @testing-library/react.

## Global Constraints

- **No database migration.** `job_title` and `prefilled_answers` are existing columns on `user_settings`.
- **Do NOT edit anything under `chrome-extension/`.** Its `UserApplicationProfile` type (`shared/types.ts:42-67`) **already declares all four fields**, including `salaryExpectation?: string` at line 65. The extension has always been coded to consume them; the backend just never sent `salaryExpectation` back. Adding it to `ApplicationProfileOut` therefore fixes the **already-shipped, already-approved v0.4.0 build for free, on the next backend deploy** — no rebuild, no re-upload, no Web Store review.
- **These four fields must be FREE TEXT, never a `<select>`.** The extension learns them from *real job application forms* and writes back the form's literal option text (`shared/profileCategories.ts:37-54` maps form field categories → profile keys). A stored `workAuthorization` may well read *"Yes, I am legally authorized to work in the United States for any employer"* — the exact wording that matched a real form. Constraining the input to a Yes/No enum would silently destroy a more specific, better-matching answer. Show the literal stored string and let the user correct it.
- **The extension is the other writer.** `PUT /api/user/application-profile` is a partial update (only sent keys change) and bumps a shared sync version (`bump_profile_version`, `profile.py:434`), which the extension re-reads (`chrome-extension/src/api/sync.ts:130`). This is the same mechanism the Profile page already uses for address and EEO — don't reinvent it.
- Backend tests run from the repo root: `python -m pytest backend/tests/<file> -v`. Entering the app lifespan migrates the dev Neon DB — expected, not an error.
- Frontend: `cd frontend && npx vitest --run <pattern>` and `npx tsc --noEmit`. **`npm test` / `npm run build` exit 1 with no output in this shell** — an npm stdio quirk, not a failure; use the `npx` forms.
- Three frontend suites already fail on this branch's base and are **not** regressions: `JobDetailView`, `job-detail-inline-panel`, `job-detail-inline-panel.property`.
- Shared working tree: **`git add` by explicit path only — never `git add -A`.** Run `git reflog -3` before committing.
- Branch: `feat/profile-application-answers`, base `243a46b`.

---

## File Structure

| File | Change |
| --- | --- |
| `backend/routers/profile.py` | Add `salaryExpectation` to `ApplicationProfileOut`; `_mine_screening` returns 3 values |
| `backend/tests/test_application_profile.py` | Add round-trip cases (file exists) |
| `frontend/src/lib/profileExtras.ts` | 4 fields onto `ProfileExtras` + `ProfileUpdatePayload` + `computeProfileDiff` |
| `frontend/src/__tests__/settings-profile.test.ts` | Its local `EMPTY` const gains the 4 keys, or `tsc` fails |
| `frontend/src/pages/Profile.tsx` | Read the 4 fields in `load()`; new "Application Answers" card; register it in `SECTIONS` |
| `frontend/src/components/SettingsModal.tsx` | Restore the honest copy — the promise becomes true |

**Task order:** Task 1 (backend) must land before Task 2, because Task 2's UI cannot display `salaryExpectation` until the GET returns it.

---

## Task 1: `salaryExpectation` round-trips through the application profile

**Files:**
- Modify: `backend/routers/profile.py` — `_mine_screening` (:154-170), `ApplicationProfileOut` (:60-90), the profile construction (:283)
- Test: `backend/tests/test_application_profile.py`

**Interfaces:**
- Produces: `GET /api/user/application-profile` gains `salaryExpectation: str`. Task 2's UI consumes it.

**The bug.** `ApplicationProfileIn` accepts `salaryExpectation` and stores it at `profile.py:428-429` as `prefilled_answers["Salary expectation"]`. But `ApplicationProfileOut` has **no** `salaryExpectation` field and `_mine_screening` only mines work-auth + sponsorship back out. So the value goes in and can never be read back — not by the web app, not by the extension (whose type declares it and always gets `undefined`). It is a one-way door.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_application_profile.py` (read the file first and match its existing fixture style — `client` / `db_session` come from `backend/tests/conftest.py`):

```python
def test_salary_expectation_round_trips(client, db_session):
    """It is written into prefilled_answers, so it must also be mined back out."""
    _make_user(db_session)  # use whatever the file's existing helper is called

    put = client.put(
        "/api/user/application-profile",
        json={"salaryExpectation": "90000 CAD"},
    )
    assert put.status_code == 200

    got = client.get("/api/user/application-profile")
    assert got.status_code == 200
    assert got.json()["salaryExpectation"] == "90000 CAD"


def test_screening_answers_round_trip_together(client, db_session):
    _make_user(db_session)

    client.put(
        "/api/user/application-profile",
        json={
            "currentTitle": "Software Engineer Intern",
            "workAuthorization": "Yes, authorized to work for any employer",
            "requiresSponsorship": "No",
            "salaryExpectation": "$85,000",
        },
    )

    body = client.get("/api/user/application-profile").json()
    assert body["currentTitle"] == "Software Engineer Intern"
    assert body["workAuthorization"] == "Yes, authorized to work for any employer"
    assert body["requiresSponsorship"] == "No"
    assert body["salaryExpectation"] == "$85,000"
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

Run: `python -m pytest backend/tests/test_application_profile.py -v -k salary`
Expected: FAIL with `KeyError: 'salaryExpectation'` — the key is absent from the response, which is exactly the bug.

- [ ] **Step 3: Mine the salary back out**

In `backend/routers/profile.py`, change `_mine_screening` to return three values. It has exactly **one** call site (`:283`), so the signature change is contained.

```python
def _mine_screening(prefilled: dict | None) -> tuple[str, str, str]:
    """
    Pull the work-authorization, sponsorship and salary answers out of the
    free-form prefilled_answers question→answer map. Mirrors the client-side
    logic that used to live in chrome-extension/src/api/client.ts
    (mapSettingsToProfile).

    The PUT side writes these under fixed question keys (see update_application_
    profile), but the extension also writes whatever question text a real form
    used — hence substring matching rather than exact keys.
    """
    work_authorization = ""
    requires_sponsorship = ""
    salary_expectation = ""
    for question, answer in (prefilled or {}).items():
        if not isinstance(answer, str):
            continue
        q = question.lower()
        if not requires_sponsorship and "sponsor" in q:
            requires_sponsorship = answer
        elif not work_authorization and ("authoriz" in q or "eligible" in q):
            work_authorization = answer
        elif not salary_expectation and ("salary" in q or "compensation" in q):
            salary_expectation = answer
    return work_authorization, requires_sponsorship, salary_expectation
```

- [ ] **Step 4: Add the field to the output schema**

In `ApplicationProfileOut` (`profile.py:60`), add `salaryExpectation` immediately after `requiresSponsorship` so the shape mirrors the input:

```python
    currentTitle: str = ""
    workAuthorization: str = ""
    requiresSponsorship: str = ""
    salaryExpectation: str = ""
```

- [ ] **Step 5: Wire it into the profile construction**

At `profile.py:283`, unpack the third value and pass it through:

```python
    work_authorization, requires_sponsorship, salary_expectation = _mine_screening(
        settings.prefilled_answers if settings else None
    )
```

then add `salaryExpectation=salary_expectation,` to the `ApplicationProfileOut(...)` call, beside `requiresSponsorship=...`.

- [ ] **Step 6: Run the tests**

Run: `python -m pytest backend/tests/test_application_profile.py -v`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 7: Prove the test bites**

Temporarily delete the `salaryExpectation=salary_expectation,` line, confirm `test_salary_expectation_round_trips` goes RED, restore. Paste the evidence — a test that passes against the un-fixed code is not a test.

- [ ] **Step 8: Commit**

```bash
git reflog -3
git add backend/routers/profile.py backend/tests/test_application_profile.py
git commit -m "fix(profile): salaryExpectation was write-only; mine it back out"
```

---

## Task 2: Application Answers card on the Profile page

**Files:**
- Modify: `frontend/src/lib/profileExtras.ts`
- Modify: `frontend/src/__tests__/settings-profile.test.ts`
- Modify: `frontend/src/pages/Profile.tsx`
- Modify: `frontend/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `GET /api/user/application-profile` now returns `salaryExpectation` (Task 1).

- [ ] **Step 1: Write the failing test**

`computeProfileDiff` is the load-bearing unit — it decides what gets sent to the endpoint the extension reads. Add to `frontend/src/__tests__/settings-profile.test.ts`:

```ts
it("emits only changed application answers", () => {
  const diff = computeProfileDiff(EMPTY, {
    ...EMPTY,
    currentTitle: "Software Engineer Intern",
    salaryExpectation: "$85,000",
  });
  expect(diff).toEqual({
    currentTitle: "Software Engineer Intern",
    salaryExpectation: "$85,000",
  });
});

it("does not send an application answer that did not change", () => {
  const filled = { ...EMPTY, workAuthorization: "Yes", requiresSponsorship: "No" };
  expect(computeProfileDiff(filled, filled)).toBeNull();
  expect(computeProfileDiff(filled, { ...filled, requiresSponsorship: "Yes" })).toEqual({
    requiresSponsorship: "Yes",
  });
});
```

**You must also add the four keys to that file's local `EMPTY` const**, or `tsc` fails once `ProfileExtras` requires them:

```ts
const EMPTY = {
  addressStreet: "",
  addressCity: "",
  addressState: "",
  postalCode: "",
  country: "",
  currentTitle: "",
  workAuthorization: "",
  requiresSponsorship: "",
  salaryExpectation: "",
  eeo: { /* unchanged */ },
};
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest --run settings-profile`
Expected: FAIL — the diff comes back `null` / missing the new keys, because `computeProfileDiff` does not know about them.

- [ ] **Step 3: Extend the shared model**

In `frontend/src/lib/profileExtras.ts`:

Add to `ProfileExtras` (after `country`, before `eeo`):

```ts
  /**
   * Answers the extension fills into screening questions. FREE TEXT, not enums:
   * the extension learns these from real application forms and writes back the
   * form's literal option text (see chrome-extension/src/shared/profileCategories.ts),
   * so a stored workAuthorization may read "Yes, I am legally authorized to work
   * in the United States for any employer". Constraining these to a select would
   * destroy the more specific answer that actually matched a form.
   */
  currentTitle: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
```

Add the same four as optional to `ProfileUpdatePayload`:

```ts
  currentTitle?: string;
  workAuthorization?: string;
  requiresSponsorship?: string;
  salaryExpectation?: string;
```

Add them to `EMPTY_PROFILE_EXTRAS`:

```ts
  currentTitle: "",
  workAuthorization: "",
  requiresSponsorship: "",
  salaryExpectation: "",
```

And diff them in `computeProfileDiff` — extend the existing flat-key loop rather than writing a second one:

```ts
  const flatKeys: (keyof Omit<ProfileExtras, "eeo">)[] = [
    "addressStreet",
    "addressCity",
    "addressState",
    "postalCode",
    "country",
    "currentTitle",
    "workAuthorization",
    "requiresSponsorship",
    "salaryExpectation",
  ];
  for (const key of flatKeys) {
    if (current[key] !== original[key]) {
      diff[key] = current[key];
    }
  }
```

(The existing local is named `addressKeys`; rename it to `flatKeys` since it is no longer address-only.)

- [ ] **Step 4: Run the test green**

Run: `cd frontend && npx vitest --run settings-profile`
Expected: PASS, including the pre-existing address and EEO cases.

- [ ] **Step 5: Read the fields in `Profile.tsx`'s `load()`**

In the `loadedExtras` object (`Profile.tsx:261-275`), add the four keys beside the address ones:

```ts
        loadedExtras = {
          addressStreet: d.addressStreet ?? "",
          addressCity: d.addressCity ?? "",
          addressState: d.addressState ?? "",
          postalCode: d.postalCode ?? "",
          country: d.country ?? "",
          currentTitle: d.currentTitle ?? "",
          workAuthorization: d.workAuthorization ?? "",
          requiresSponsorship: d.requiresSponsorship ?? "",
          salaryExpectation: d.salaryExpectation ?? "",
          eeo: { /* unchanged */ },
        };
```

`buildProfilePayload()` needs **no change** — it already spreads `computeProfileDiff(originalExtras, extras)`, which now carries the new keys.

- [ ] **Step 6: Register the new section in the nav**

In `SECTIONS` (`Profile.tsx:101`), add an entry before `eeo`:

```ts
const SECTIONS = [
  { id: "personal", label: "Personal" },
  { id: "education", label: "Education" },
  { id: "experience", label: "Work Experience" },
  { id: "skills", label: "Skills" },
  { id: "projects", label: "Projects" },
  { id: "screening", label: "Application Answers" },
  { id: "eeo", label: "Equal Employment" },
] as const;
```

`EditingSection` (the union type driving `toggleEdit`) must also gain `"screening"` — find it and add it, or `toggleEdit("screening")` will not typecheck.

- [ ] **Step 7: Add the card**

Insert directly **before** the `<Section id="eeo" …>` block (`Profile.tsx:605`), following the exact pattern that card uses — view mode renders `InfoRow`s, edit mode renders an editor:

```tsx
      {/* ── Application answers (screening questions the extension fills) ── */}
      <Section id="screening" title="Application Answers" onEdit={() => toggleEdit("screening")}>
        <p className="profile-section-sub">
          The answers Tailrd fills into screening questions on job applications. These
          are the exact words that get submitted — edit them if an employer's form
          needs different wording.
        </p>
        {editingSection === "screening" ? (
          <div className="profile-form-grid">
            <Field
              label="Current / Target Job Title"
              value={extras.currentTitle}
              onChange={(v) => setExtras({ ...extras, currentTitle: v })}
            />
            <Field
              label="Salary Expectation"
              value={extras.salaryExpectation}
              onChange={(v) => setExtras({ ...extras, salaryExpectation: v })}
            />
            <Field
              label="Work Authorization"
              value={extras.workAuthorization}
              onChange={(v) => setExtras({ ...extras, workAuthorization: v })}
              full
            />
            <Field
              label="Requires Sponsorship"
              value={extras.requiresSponsorship}
              onChange={(v) => setExtras({ ...extras, requiresSponsorship: v })}
              full
            />
          </div>
        ) : (
          <div className="profile-info-grid">
            <InfoRow label="Current / Target Job Title" value={extras.currentTitle} />
            <InfoRow label="Salary Expectation" value={extras.salaryExpectation} />
            <InfoRow label="Work Authorization" value={extras.workAuthorization} />
            <InfoRow label="Requires Sponsorship" value={extras.requiresSponsorship} />
          </div>
        )}
      </Section>
```

Free text, deliberately — see Global Constraints. Do not "improve" these into `<select>`s.

- [ ] **Step 8: Make the settings modal tell the truth again**

In `frontend/src/components/SettingsModal.tsx`, the "Profile & résumé" row's copy was cut back to `Name, contact details, address and EEO answers.` **precisely because** Profile could not edit screening answers. It now can. Restore it:

```tsx
          <span className="sm-muted">
            Name, contact details, address, EEO answers and saved screening answers.
          </span>
```

And fix the type comment above `interface ExtensionSettings` (it currently documents the gap you just closed). Replace the "One honest gap:" paragraph with:

```
 * job_title and the screening answers live on the same application-profile
 * endpoint and are edited on /app/profile's "Application Answers" card.
```

- [ ] **Step 9: Typecheck and run the suites**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean. (If it fails on `settings-profile.test.ts`, you skipped the `EMPTY` update in Step 1.)

Run: `cd frontend && npx vitest --run settings-profile SettingsModal`
Expected: PASS.

Run: `cd frontend && npx vitest --run`
Expected: only the three known-bad suites red. Anything else is your regression.

- [ ] **Step 10: Prove it in the app**

Start the dev server, sign in, go to `/app/profile`. Confirm:
1. "Application Answers" appears in the sticky nav and scrolls to the card.
2. Edit → type a salary → Save → **reload** → the value is still there. (This is the round-trip Task 1 unblocked; before it, salary would come back blank.)
3. The Settings modal's Account tab reads "…and saved screening answers".

- [ ] **Step 11: Responsive audit**

The Profile page has an existing audit state. Run: `node scripts/responsive-audit/audit.cjs --state app-profile`
Expected: **0 high / 0 medium.** The new card must not overflow at 320px — `workAuthorization` can hold a long sentence.

- [ ] **Step 12: Commit**

```bash
git reflog -3
git add frontend/src/lib/profileExtras.ts frontend/src/__tests__/settings-profile.test.ts frontend/src/pages/Profile.tsx frontend/src/components/SettingsModal.tsx
git commit -m "feat(profile): edit the autofill answers the extension fills"
```

---

## Self-Review Notes

**Spec coverage.** The write-only `salaryExpectation` bug → Task 1. The four unbound fields → Task 2 (model, load, UI, nav). The false-then-true settings copy → Task 2 Step 8.

**Type consistency.** `ProfileExtras` gains four **required** strings (so `EMPTY_PROFILE_EXTRAS` and the test's local `EMPTY` must both be updated, or `tsc` fails — called out in Steps 1 and 3). `ProfileUpdatePayload` gains the same four as **optional**, matching how the endpoint treats them (partial update). `_mine_screening`'s arity changes from 2 to 3 with exactly one call site.

**Deliberate, do not "fix":** free-text inputs rather than selects (the extension stores real form option text); no extension change (its type already declares all four fields).
