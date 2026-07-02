# Autofill Robustness & Consistency Hardening

- **Date:** 2026-07-02
- **Status:** Approved (self-approved — autonomous overnight run; see memory `autonomous-autofill-phases-overnight`)
- **Branch:** `feature/autofill-robustness-hardening`
- **Phase:** 6 of the Jobright-parity rebuild (hardening). Phase 5 (iframe agent-apply) was deferred — see `docs/autofill-rebuild/phase5-iframe-agent-apply-deferred.md`.
- **Scope owner module set:** `chrome-extension/` (client only)

## 1. Problem & goal

The autofill engine is mature (Phases 1–4 shipped; re-scan, cross-frame, drivers, adapters, AI answering, and index-aware repeating sections all exist). This phase is a focused **hardening pass** that closes the concrete gaps the Phase 4 reviews surfaced — no new feature, no new risk:

1. **Crash-safety asymmetry.** Phase 4 hardened the resolver against a profile missing `education`/`experience` arrays, but the overlay profile-preview (`overlay.ts` ~1617–1659) still does unguarded `p.education.length` / `for (const e of p.education)` / `p.experience` / `p.skills` — it would throw on a malformed profile. (Production-safe today via `api/sync.ts` array normalization, so this is defense-in-depth, but the asymmetry is a real latent gap.)
2. **Type drift risk.** The resolve-control literal `{ controlType: ControlType; options?: string[]; groupIndex?: number | null }` is duplicated across `adapters/types.ts`, `adapters/apply.ts`, and `fieldMatcher.ts` — a field added to one could silently diverge.
3. **Docstring inaccuracy.** `detectGroupIndex`'s docstring says it returns the "FIRST index found (the outermost repeating group)", but the implementation is **bracket-priority** (a `[N]` match wins even when a `_N_`/`.N.` index appears earlier). No test pins the mixed-pattern behavior.

**Goal:** eliminate the crash-safety asymmetry, de-duplicate the control type, and make `detectGroupIndex`'s contract accurate + tested — all behavior-preserving except where a throw becomes a safe empty render.

## 2. Non-goals

- No new autofill capability (submit-detection, telemetry, add-row DOM, iframe apply — all out of scope / deferred).
- No change to `detectGroupIndex`'s *matching logic* — only its docstring + a test that documents the existing bracket-priority behavior (rewording is zero-risk; changing the logic would add edge cases).
- No backend change.

## 3. Components

### 3.1 `ResolveControl` shared type (new alias)
Add to `chrome-extension/src/shared/types.ts` (where `ControlType` lives):
```ts
/** The control shape the resolver + adapters read when resolving/overriding an answer. */
export interface ResolveControl {
  controlType: ControlType;
  options?: string[];
  groupIndex?: number | null;
}
```
Use it in place of the inline literal at: `adapters/types.ts` (`AnswerContext.control`), `adapters/apply.ts` (`resolveAnswerWithAdapter`'s `control` param), `fieldMatcher.ts` (`resolveProfileValue`'s `control` param, and `isYesNoChoice`'s param — it reads only `controlType`/`options`, so the wider optional `groupIndex` is compatible). Pure refactor; `npx tsc --noEmit` proves equivalence.

### 3.2 Overlay preview array guards
In `overlay.ts` the `education`/`experience`/`skill` preview cases, coerce the arrays before use so a missing array renders the existing "No … yet" empty state instead of throwing: read `p.education ?? []`, `p.experience ?? []`, `p.skills ?? []` (e.g. a local `const education = p.education ?? [];` per case, then use `education.length`/`for (const e of education)`). Behavior identical when arrays are present; a missing array now renders empty instead of crashing the panel.

### 3.3 `detectGroupIndex` docstring accuracy + test
Reword the `groupIndex.ts` docstring to describe the real contract: *"Returns the bracketed `[N]` index if present, otherwise the first `[._-]N[._-]` delimited index; prefers `name` over `id`."* Add a test that documents the bracket-priority tie-break on a mixed-pattern string.

### 3.4 `scanPage` malformed-profile regression guard (new test)
A `formScanner` test that runs `scanPage` against a fixture form (education/experience/plain fields) with a **malformed profile missing the array fields**, asserting the scan does not throw and returns a result — locking in the "never throws on a malformed profile" property across the whole scan path (the resolver guards from Phase 4 + this phase).

## 4. Files
- Modify: `chrome-extension/src/shared/types.ts` (add `ResolveControl`); `chrome-extension/src/content/adapters/types.ts`, `chrome-extension/src/content/adapters/apply.ts`, `chrome-extension/src/content/fieldMatcher.ts` (use the alias); `chrome-extension/src/content/groupIndex.ts` (docstring); `chrome-extension/src/content/overlay.ts` (array guards).
- Tests: `chrome-extension/test/groupIndex.test.ts` (mixed-pattern), `chrome-extension/test/formScanner.test.ts` (malformed-profile never-throws).

## 5. Testing
- **Alias:** `npx tsc --noEmit` passes (structural equivalence) + full suite unchanged.
- **`detectGroupIndex` mixed pattern:** `emp_2_education[5]` → `5` (bracket wins), documented by a test asserting the current behavior.
- **Overlay guards:** verified by `npx tsc --noEmit` + `node build.mjs` (overlay is DOM UI, not unit-tested); the array-coercion is a local, obvious transform.
- **Malformed profile:** `scanPage` with a profile lacking `education`/`experience`/`skills` does not throw (new `formScanner` test).
- Full suite + build green throughout.

## 6. Acceptance criteria
1. `ResolveControl` is defined once and used at all four control-literal sites; `tsc --noEmit` passes with no behavior change.
2. The overlay `education`/`experience`/`skill` previews render the empty state (not a thrown error) when the corresponding profile array is missing.
3. `detectGroupIndex`'s docstring accurately describes bracket-priority; a test documents the mixed-pattern tie-break.
4. `scanPage` never throws on a profile missing the array fields (new regression test).
5. `npx tsc --noEmit`, `node build.mjs`, and the full unit suite pass.

## 7. Risks & mitigations
- **Alias refactor changing a type subtly** → it's structurally identical; `tsc` + the unchanged suite prove equivalence.
- **Overlay guard changing a rendered value** → `?? []` is a no-op when the array is present; only the missing-array (previously-throwing) path changes, to the existing empty state.
- **Over-scoping into behavior changes** → explicitly behavior-preserving; `detectGroupIndex` logic is untouched (docstring + test only).
