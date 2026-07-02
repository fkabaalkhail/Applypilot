# Autofill Robustness & Consistency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the concrete gaps the Phase 4 reviews surfaced — de-duplicate the resolve-control type, guard the overlay profile-preview against missing arrays, make `detectGroupIndex`'s contract accurate + tested, and add a `scanPage` malformed-profile regression guard. Behavior-preserving except where a throw becomes a safe empty render.

**Architecture:** A shared `ResolveControl` type alias replaces a triplicated literal; the overlay preview coerces `p.education`/`p.experience`/`p.skills` with `?? []`; `detectGroupIndex`'s docstring is corrected + a mixed-pattern test added; a new `formScanner` test locks in "never throws on a malformed profile."

**Tech Stack:** TypeScript (strict), esbuild (IIFE), vitest + jsdom.

## Global Constraints

- Behavior-preserving. The alias is structurally identical (`tsc` proves it); `?? []` is a no-op when the array is present; `detectGroupIndex` matching logic is UNCHANGED (docstring + test only).
- No new autofill capability; no backend change.
- Branch `feature/autofill-robustness-hardening`. Run vitest DIRECTLY (`npx vitest run <path>`), `npx tsc --noEmit`, `node build.mjs` — NOT `npm test`/`npm run typecheck`. Commit after each task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. TDD where a unit test applies.

---

### Task 1: `ResolveControl` alias + `detectGroupIndex` docstring/test

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (add `ResolveControl`); `chrome-extension/src/content/adapters/types.ts`, `chrome-extension/src/content/adapters/apply.ts`, `chrome-extension/src/content/fieldMatcher.ts` (use the alias); `chrome-extension/src/content/groupIndex.ts` (docstring)
- Test: `chrome-extension/test/groupIndex.test.ts` (mixed-pattern)

**Interfaces:**
- Produces: `ResolveControl { controlType: ControlType; options?: string[]; groupIndex?: number | null }` (in `shared/types.ts`).

- [ ] **Step 1: Add the alias to `shared/types.ts`**

Immediately after the `ControlType` definition, add:
```ts
/** The control shape the resolver + adapters read when resolving/overriding an answer. */
export interface ResolveControl {
  controlType: ControlType;
  options?: string[];
  groupIndex?: number | null;
}
```

- [ ] **Step 2: Use the alias at the three+one literal sites**

- `chrome-extension/src/content/adapters/types.ts:20` — change `control: { controlType: ControlType; options?: string[]; groupIndex?: number | null };` to `control: ResolveControl;`
- `chrome-extension/src/content/adapters/apply.ts:32` — change `control: { controlType: ControlType; options?: string[]; groupIndex?: number | null },` to `control: ResolveControl,`
- `chrome-extension/src/content/fieldMatcher.ts:428` — change `control: { controlType: ControlType; options?: string[]; groupIndex?: number | null },` to `control: ResolveControl,`
- `chrome-extension/src/content/fieldMatcher.ts:391` (`isYesNoChoice`) — change `control: { controlType: ControlType; options?: string[] }` to `control: ResolveControl` (it reads only `controlType`/`options`; the extra optional `groupIndex` is compatible).

In each file, add `ResolveControl` to the existing `../shared/types` / `../../shared/types` import. If removing the inline literal leaves `ControlType` unused in that file, remove it from the import (else keep it) — `npx tsc --noEmit` will flag an unused import under the repo's settings.

- [ ] **Step 3: Reword the `detectGroupIndex` docstring**

In `chrome-extension/src/content/groupIndex.ts`, replace the docstring sentence that claims "Returns the FIRST index found (the outermost repeating group), preferring `name` over `id`." with an accurate description:
```
 * Returns the bracketed `[N]` index if present, otherwise the first `[._-]N[._-]`
 * delimited index; prefers the `name` attribute over `id`. Indices >= 50 are
 * treated as spurious and yield null.
```
Do NOT change any matching logic.

- [ ] **Step 4: Add the mixed-pattern test**

Append to the `describe("detectGroupIndex", …)` block in `chrome-extension/test/groupIndex.test.ts` (reuse the file's `sig` helper):
```ts
  it("prefers a bracketed index over an earlier delimited index (bracket-priority)", () => {
    expect(detectGroupIndex(sig({ nameAttr: "emp_2_education[5]" }))).toBe(5);
  });
```

- [ ] **Step 5: Verify + commit**

Run: `cd chrome-extension && npx vitest run test/groupIndex.test.ts && npx tsc --noEmit && npx vitest run`
Expected: groupIndex tests pass (incl. new), tsc exit 0, full suite green.
```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/adapters/types.ts chrome-extension/src/content/adapters/apply.ts chrome-extension/src/content/fieldMatcher.ts chrome-extension/src/content/groupIndex.ts chrome-extension/test/groupIndex.test.ts
git commit -m "refactor(autofill): shared ResolveControl type + accurate detectGroupIndex docstring/test" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: overlay array guards + malformed-profile scan regression test

**Files:**
- Modify: `chrome-extension/src/content/overlay.ts` (education/experience/skill preview array guards)
- Test: `chrome-extension/test/formScanner.test.ts` (malformed-profile never-throws)

- [ ] **Step 1: Write the failing regression test**

Append to `chrome-extension/test/formScanner.test.ts` (reuse existing imports). IMPORTANT: plain `<input>`s are invisible in jsdom, so the scanner would filter them and never call the resolver — this file's other `scanPage` tests make elements visible (a `stubLayout()` helper or equivalent, e.g. from `./helpers/layout`); apply the SAME visibility setup here so the fields are actually resolved (that's what exercises the guard). Check the file for how it's already done.
```ts
it("does not throw when the profile is missing education/experience/skills arrays", () => {
  // ensure the visibility setup this file uses is applied (stubLayout / beforeEach)
  document.body.innerHTML = `
    <label for="s">School</label><input id="s" name="education[0][school]" />
    <label for="c">Company</label><input id="c" name="company" />
    <label for="n">Full name</label><input id="n" name="name" />`;
  const malformed = { firstName: "A", email: "a@b.com" } as unknown as import("../src/shared/types").UserApplicationProfile;
  expect(() => scanPage(malformed, false)).not.toThrow();
});
```

- [ ] **Step 2: Run to verify it passes or fails**

Run: `cd chrome-extension && npx vitest run test/formScanner.test.ts -t "missing education"`
Expected: This should already PASS if Phase 4's resolver guards are complete (the resolver path is guarded). If it THROWS, the resolver still has an unguarded access — report it (do not mask it); otherwise proceed (the test is a lock-in regression guard). Either way the overlay guard (Step 3) is still required for the overlay path.

- [ ] **Step 3: Guard the overlay preview arrays**

In `chrome-extension/src/content/overlay.ts`, in the profile-preview switch, coerce the arrays inline with `?? []` so a missing array renders the existing empty state instead of throwing (behavior identical when the array is present):
- `education` case: change `if (p.education.length === 0)` to `if ((p.education ?? []).length === 0)`, and `for (const e of p.education)` to `for (const e of p.education ?? [])`.
- `experience` case: change `if (p.experience.length === 0)` to `if ((p.experience ?? []).length === 0)`, and `for (const e of p.experience)` to `for (const e of p.experience ?? [])`.
- `skill` case: change `if (p.skills.length === 0)` to `if ((p.skills ?? []).length === 0)`, and `p.skills.join(", ")` to `(p.skills ?? []).join(", ")`.

- [ ] **Step 4: Verify + commit**

Run: `cd chrome-extension && npx vitest run test/formScanner.test.ts && npx tsc --noEmit && node build.mjs && npx vitest run`
Expected: formScanner tests green (incl. new), tsc exit 0, build emits 3 bundles, full suite green.
```bash
git add chrome-extension/src/content/overlay.ts chrome-extension/test/formScanner.test.ts
git commit -m "fix(autofill): guard overlay profile-preview against missing arrays + scan regression test" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: docs + final verification

**Files:**
- Modify: `docs/autofill-rebuild/jobright-reference-analysis.md`

- [ ] **Step 1: Full verification**

Run: `cd chrome-extension && npx tsc --noEmit && npx vitest run && node build.mjs`
Expected: tsc exit 0; all tests green; 3 bundles emit.

- [ ] **Step 2: Record Phase 5 (deferred) + Phase 6 status**

In `docs/autofill-rebuild/jobright-reference-analysis.md` §15, add after the Phase 5 / Phase 6 lines:
```markdown
> **Phase 5 status (2026-07-02):** DEFERRED (iframe agent-apply) — security-posture + product decision needing real-browser validation. Rationale + design sketch: `docs/autofill-rebuild/phase5-iframe-agent-apply-deferred.md`.
> **Phase 6 status (2026-07-02):** Implemented on branch `feature/autofill-robustness-hardening` — robustness & consistency hardening: shared `ResolveControl` type (de-triplicated), overlay profile-preview guarded against missing arrays, `detectGroupIndex` docstring corrected + mixed-pattern test, `scanPage` malformed-profile never-throws regression test. Behavior-preserving. See the spec and plan dated 2026-07-02.
```

- [ ] **Step 3: Commit**

```bash
git add docs/autofill-rebuild/jobright-reference-analysis.md
git commit -m "docs(autofill): mark Phase 5 deferred + Phase 6 hardening complete" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review notes
- **Spec coverage:** alias (Task 1 → §3.1), docstring+test (Task 1 → §3.3), overlay guards (Task 2 → §3.2), malformed-profile regression (Task 2 → §3.4), docs (Task 3). Acceptance 1-5 → Tasks 1/2 + verification.
- **Behavior-preserving:** alias is structural (tsc proves); `?? []` no-op when present; `detectGroupIndex` logic untouched.
- **Type consistency:** `ResolveControl` defined once in `shared/types.ts`, used at all 4 sites; `import` cleanup noted to avoid unused-`ControlType` tsc errors.
- **jsdom gotcha:** the malformed-profile test needs the file's visibility setup (stubLayout) so fields are actually resolved (Task 2 Step 1 note).
