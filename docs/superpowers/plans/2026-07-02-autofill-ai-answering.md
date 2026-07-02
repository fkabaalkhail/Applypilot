# Autofill AI‑Primary Answering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route judgment fields to the backend `/api/fill` as the primary answer source while keeping deterministic profile fields on the instant local fast‑path, deduped by an in‑memory session cache.

**Architecture:** A pure planner (`planFillRoute`) splits the user‑selected fields into `localTargets` (deterministic, fill now) and `backendFields` (judgment, route to `/api/fill`). A per‑frame `answerCache` (keyed by normalized question) dedupes API calls. `contentScript.onAutofill` becomes Phase A (instant local) + Phase B (async backend via cache), with the local `proposedValue` as the fallback so a judgment field never regresses when the backend is unavailable. Client‑only; no backend changes.

**Tech Stack:** TypeScript (strict), esbuild (IIFE bundles), MV3, vitest + jsdom.

## Global Constraints

- Hybrid routing: deterministic profile‑lookup categories (`LOCAL_FAST_PATH`) at confidence ≥ `AUTOFILL_CONFIDENCE_THRESHOLD` (0.7) with a non‑null value → local fast‑path; all other AI‑eligible fields → backend primary (local `proposedValue` = fallback); EEO/sensitive → local only, NEVER sent to the backend.
- Session cache is in‑memory, per frame, keyed by **normalized question text**; only non‑empty answers with non‑empty labels are cached.
- Phase B is async + best‑effort: a `/api/fill` failure or offline must leave Phase A fills intact and fall back judgment fields to their local `proposedValue` — never hang or block.
- No backend changes; the `AI_FILL` message + `/api/fill` contract are unchanged.
- Branch `feature/autofill-ai-answering`. Run vitest DIRECTLY: `cd chrome-extension && npx vitest run <path>` (NOT `npm test`/`npm run typecheck` — they exit 1 with no output in this shell; use `npx tsc --noEmit`, `node build.mjs` directly). Commit after each task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. TDD throughout.

---

### Task 1: Fill‑route planner

**Files:**
- Modify: `chrome-extension/src/content/aiFillPlanner.ts` (add `LOCAL_FAST_PATH`, `FillRoute`, `planFillRoute`)
- Test: `chrome-extension/test/aiFillPlanner.test.ts` (extend)

**Interfaces:**
- Consumes: `DetectedField` (`../shared/types`), existing `isAiCandidate`.
- Produces: `LOCAL_FAST_PATH: ReadonlySet<FieldCategory>`; `FillRoute { localTargets: {fieldId,value}[]; backendFields: DetectedField[] }`; `planFillRoute(selected: DetectedField[], threshold: number): FillRoute`.

- [ ] **Step 1: Write the failing tests**

Append to `chrome-extension/test/aiFillPlanner.test.ts` (reuse the file's existing vitest imports; do NOT re-import `describe`/`it`/`expect` if already imported):

```ts
import { planFillRoute } from "../src/content/aiFillPlanner";
import type { DetectedField } from "../src/shared/types";

function pfField(over: Partial<DetectedField>): DetectedField {
  return {
    id: "f", category: "unknown", confidence: 1, label: "", controlType: "text",
    required: false, proposedValue: "v", fillable: true, sensitive: false,
    ...over,
  } as DetectedField;
}

describe("planFillRoute", () => {
  it("routes a deterministic high-confidence profile field to localTargets", () => {
    const r = planFillRoute([pfField({ id: "a", category: "email", confidence: 0.9, proposedValue: "me@x.com" })], 0.7);
    expect(r.localTargets).toEqual([{ fieldId: "a", value: "me@x.com" }]);
    expect(r.backendFields).toEqual([]);
  });
  it("routes a deterministic category with LOW confidence to the backend", () => {
    const r = planFillRoute([pfField({ id: "a", category: "email", confidence: 0.5, controlType: "select", options: ["x"], proposedValue: "x" })], 0.7);
    expect(r.backendFields.map((f) => f.id)).toEqual(["a"]);
    expect(r.localTargets).toEqual([]);
  });
  it("routes a judgment field (workAuthorization) to the backend even with a local value", () => {
    const r = planFillRoute([pfField({ id: "a", category: "workAuthorization", confidence: 0.9, controlType: "radioGroup", proposedValue: "Yes" })], 0.7);
    expect(r.backendFields.map((f) => f.id)).toEqual(["a"]);
    expect(r.localTargets).toEqual([]);
  });
  it("keeps a sensitive (EEO) field local and never routes it to the backend", () => {
    const r = planFillRoute([pfField({ id: "a", category: "eeoGender", confidence: 0.9, controlType: "select", options: ["Female"], proposedValue: "Female", sensitive: true })], 0.7);
    expect(r.localTargets).toEqual([{ fieldId: "a", value: "Female" }]);
    expect(r.backendFields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/aiFillPlanner.test.ts -t "planFillRoute"`
Expected: FAIL — `planFillRoute` not exported.

- [ ] **Step 3: Implement in `aiFillPlanner.ts`**

Add the `FieldCategory` type to the existing type import:
```ts
import type { AiDraft, AiFillField, DetectedField, FieldCategory } from "../shared/types";
```
Append (after `aiFillCandidates`, so `isAiCandidate` is in scope):
```ts
/** Profile-lookup categories answered locally when confident — instant, offline, free. */
export const LOCAL_FAST_PATH: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "firstName", "lastName", "fullName", "email", "phone",
  "linkedin", "github", "portfolio", "location", "currentCompany", "currentTitle",
]);

export interface FillRoute {
  /** Deterministic fields to fill immediately from proposedValue. */
  localTargets: { fieldId: string; value: string }[];
  /** Judgment fields to route to the backend (proposedValue is the fallback). */
  backendFields: DetectedField[];
}

/**
 * Split the user-selected (already `fillable` + `proposedValue!=null`) fields into
 * the deterministic local fast-path vs the backend-primary judgment fields. EEO/
 * sensitive fields are never AI-eligible, so they stay local (never transmitted).
 */
export function planFillRoute(selected: DetectedField[], threshold: number): FillRoute {
  const localTargets: { fieldId: string; value: string }[] = [];
  const backendFields: DetectedField[] = [];
  for (const f of selected) {
    const deterministic =
      LOCAL_FAST_PATH.has(f.category) && f.confidence >= threshold && f.proposedValue !== null;
    if (deterministic) {
      localTargets.push({ fieldId: f.id, value: f.proposedValue as string });
    } else if (isAiCandidate(f)) {
      backendFields.push(f);
    } else if (f.proposedValue !== null) {
      localTargets.push({ fieldId: f.id, value: f.proposedValue });
    }
  }
  return { localTargets, backendFields };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/aiFillPlanner.test.ts`
Expected: PASS (new + existing planner tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0.
```bash
git add chrome-extension/src/content/aiFillPlanner.ts chrome-extension/test/aiFillPlanner.test.ts
git commit -m "feat(ai-fill): planFillRoute — deterministic local vs backend-primary routing" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Session answer cache

**Files:**
- Create: `chrome-extension/src/content/answerCache.ts`
- Test: `chrome-extension/test/answerCache.test.ts`

**Interfaces:**
- Consumes: `DetectedField` (`../shared/types`), `PlannedAnswer` (`./aiFillPlanner`).
- Produces: `normalizeQuestion(label): string`; `splitByCache(fields): { hits: PlannedAnswer[]; misses: DetectedField[] }`; `cacheAnswers(fields, answers): void`; `__resetCache(): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// chrome-extension/test/answerCache.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { normalizeQuestion, splitByCache, cacheAnswers, __resetCache } from "../src/content/answerCache";
import type { DetectedField } from "../src/shared/types";

beforeEach(() => __resetCache());

function acField(id: string, label: string): DetectedField {
  return {
    id, label, category: "unknown", confidence: 1, controlType: "text",
    required: false, proposedValue: null, fillable: true, sensitive: false,
  } as DetectedField;
}

describe("normalizeQuestion", () => {
  it("collapses case, whitespace and punctuation", () => {
    expect(normalizeQuestion("  Are you  AUTHORIZED to work?  ")).toBe("are you authorized to work");
  });
});

describe("splitByCache / cacheAnswers", () => {
  it("returns a hit (with the current field id re-attached) for a cached question, others miss", () => {
    cacheAnswers([acField("id1", "Work authorization?")], [{ id: "id1", answer: "Yes", needsReview: false, source: "rule" }]);
    const { hits, misses } = splitByCache([acField("id2", "work  AUTHORIZATION?"), acField("id3", "Salary?")]);
    expect(hits).toEqual([{ id: "id2", answer: "Yes", needsReview: false, source: "rule" }]);
    expect(misses.map((f) => f.id)).toEqual(["id3"]);
  });
  it("does not cache empty answers or empty-label fields", () => {
    cacheAnswers([acField("a", "")], [{ id: "a", answer: "X" }]);       // empty label
    cacheAnswers([acField("b", "Q")], [{ id: "b", answer: "   " }]);    // empty answer
    const { hits, misses } = splitByCache([acField("c", "Q")]);
    expect(hits).toEqual([]);
    expect(misses.map((f) => f.id)).toEqual(["c"]);
  });
  it("__resetCache clears everything", () => {
    cacheAnswers([acField("a", "Q")], [{ id: "a", answer: "Yes" }]);
    __resetCache();
    expect(splitByCache([acField("b", "Q")]).misses.map((f) => f.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/answerCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `answerCache.ts`**

```ts
// chrome-extension/src/content/answerCache.ts
/**
 * Per-frame, in-memory session cache for backend answers, keyed by NORMALIZED
 * QUESTION TEXT (a page is one job, so field ids churn across re-scans but the
 * question is stable). Dedupes /api/fill calls across the frequent MutationObserver
 * re-scans/re-fills. Cleared on navigation (module lifetime); the backend keeps
 * cross-session memory, so no persistence is needed here.
 */
import type { DetectedField } from "../shared/types";
import type { PlannedAnswer } from "./aiFillPlanner";

/** Cached answer, id-agnostic (keyed by question). */
type CachedAnswer = Omit<PlannedAnswer, "id">;

const cache = new Map<string, CachedAnswer>();

/** Normalize a question label for stable keying. */
export function normalizeQuestion(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Split backend-bound fields into cache hits (answers ready) and misses (to fetch). */
export function splitByCache(fields: DetectedField[]): { hits: PlannedAnswer[]; misses: DetectedField[] } {
  const hits: PlannedAnswer[] = [];
  const misses: DetectedField[] = [];
  for (const f of fields) {
    const key = normalizeQuestion(f.label);
    const c = key ? cache.get(key) : undefined;
    if (c) hits.push({ id: f.id, ...c });
    else misses.push(f);
  }
  return { hits, misses };
}

/** Store non-empty answers by their field's normalized question. */
export function cacheAnswers(fields: DetectedField[], answers: PlannedAnswer[]): void {
  const byId = new Map(answers.map((a) => [a.id, a]));
  for (const f of fields) {
    const a = byId.get(f.id);
    const key = normalizeQuestion(f.label);
    if (a && a.answer && a.answer.trim() && key) {
      const { id, ...rest } = a;
      cache.set(key, rest);
    }
  }
}

/** Test-only reset. */
export function __resetCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/answerCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0.
```bash
git add chrome-extension/src/content/answerCache.ts chrome-extension/test/answerCache.test.ts
git commit -m "feat(ai-fill): in-memory session answer cache keyed by normalized question" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: onAutofill Phase A / Phase B restructure

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts` (imports; add `fillItems` + `dedupeById` helpers; rewrite the `onAutofill` body)

**Interfaces:**
- Consumes: `planFillRoute`, `PlannedAnswer` (`./aiFillPlanner`); `splitByCache`, `cacheAnswers` (`./answerCache`); `AUTOFILL_CONFIDENCE_THRESHOLD` (`../shared/constants`); existing `runAdapterOperations`, `getEngine`, `fillComboboxTargets`, `fillDriverTargets`, `isDriverField`, `isComboboxField` (reused by `fillItems` so it doesn't become unused), `planAiFill`, `aiFillCandidates`, `toAiFillField`, `tallyOutcomes`.

- [ ] **Step 1: Add/extend imports**

Add `planFillRoute` and the `PlannedAnswer` type to the existing `./aiFillPlanner` import; add the `./answerCache` import; add `AUTOFILL_CONFIDENCE_THRESHOLD` from `../shared/constants`.

Update the aiFillPlanner import line (currently `import { aiFillCandidates, planAiFill, tallyOutcomes, toAiFillField } from "./aiFillPlanner";`) to:
```ts
import { aiFillCandidates, planAiFill, planFillRoute, tallyOutcomes, toAiFillField, type PlannedAnswer } from "./aiFillPlanner";
```
Add:
```ts
import { splitByCache, cacheAnswers } from "./answerCache";
```
Add `AUTOFILL_CONFIDENCE_THRESHOLD` to the import from `../shared/constants` (if the file has no such import yet, add `import { AUTOFILL_CONFIDENCE_THRESHOLD } from "../shared/constants";`).

- [ ] **Step 2: Add the `fillItems` + `dedupeById` helpers**

Inside `initialize()`, next to `fillComboboxTargets`/`fillDriverTargets`, add:
```ts
  /** Dedupe DetectedFields by id (first wins). */
  function dedupeById(fields: DetectedField[]): DetectedField[] {
    const seen = new Set<string>();
    const out: DetectedField[] = [];
    for (const f of fields) {
      if (!seen.has(f.id)) { seen.add(f.id); out.push(f); }
    }
    return out;
  }

  /**
   * Fill a list of {fieldId,value} through the same path as onAutofill: the site
   * adapter gets first refusal, then react-select/Workday drivers, custom ARIA
   * dropdowns, and the reconciler for the rest. `merge` adds to the running
   * reconciler state (a later pass); otherwise it starts a fresh run.
   */
  async function fillItems(
    items: { fieldId: string; value: string }[],
    merge: boolean
  ): Promise<{ reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[] }> {
    if (items.length === 0) return { reports: [], outcomes: [] };
    const { opOutcomes, remaining } = await runAdapterOperations(lastAdapter, items, (id) => registry.get(id));
    const driverTargets = remaining.filter((it) => isDriverField(it.fieldId));
    const comboTargets = remaining.filter((it) => !isDriverField(it.fieldId) && isComboboxField(it.fieldId));
    const reconTargets = remaining.filter((it) => !isDriverField(it.fieldId) && !isComboboxField(it.fieldId));
    const reports = reconTargets.length
      ? merge
        ? await getEngine().addTargets(reconTargets, registry)
        : await getEngine().run(reconTargets, registry)
      : [];
    const outcomes = [
      ...(comboTargets.length ? await fillComboboxTargets(comboTargets) : []),
      ...(driverTargets.length ? await fillDriverTargets(driverTargets) : []),
      ...opOutcomes,
    ];
    return { reports, outcomes };
  }
```

- [ ] **Step 3: Rewrite the `onAutofill` body**

Replace the entire `onAutofill` handler body (from `const wanted = new Set(ids);` through the final `return { ok, fail, total, drafts };`) with:
```ts
      const wanted = new Set(ids);
      const selected = lastFields.filter(
        (f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null
      );

      // Phase A — deterministic profile fields fill instantly (local fast-path).
      const route = planFillRoute(selected, AUTOFILL_CONFIDENCE_THRESHOLD);
      const localFill = await fillItems(route.localTargets, false);

      // Phase B — judgment fields answered by the backend (primary), deduped by the
      // session cache; also the eligible EMPTY fields (today's AI candidates). The
      // local proposedValue is the fallback so a judgment field never regresses when
      // the backend is unavailable.
      const backendFields = dedupeById([...route.backendFields, ...aiFillCandidates(lastFields)]);
      const drafts: AiDraft[] = [];
      let aiFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[] } = { reports: [], outcomes: [] };
      let fallbackFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[] } = { reports: [], outcomes: [] };
      if (backendFields.length > 0) {
        const { hits, misses } = splitByCache(backendFields);
        let answers: PlannedAnswer[] = hits;
        try {
          if (misses.length > 0) {
            const resp = await sendToBackground<AiFillResponse>({
              type: "AI_FILL",
              fields: misses.map(toAiFillField),
              jobContext: extractJobContext(),
            });
            if (resp?.ok) {
              cacheAnswers(misses, resp.answers);
              answers = [...hits, ...resp.answers];
            }
          }
        } catch {
          // Backend unavailable — the local fallback below still fills judgment fields.
        }
        const plan = planAiFill(backendFields, answers);
        drafts.push(...plan.drafts);
        aiFill = await fillItems(plan.simpleTargets, true);

        // Local fallback: judgment fields that had a local value but weren't answered
        // (or drafted) by the backend still fill from proposedValue — no regression.
        const answered = new Set<string>([
          ...plan.simpleTargets.map((t) => t.fieldId),
          ...plan.drafts.map((d) => d.fieldId),
        ]);
        const fallbackTargets = route.backendFields
          .filter((f) => !answered.has(f.id) && f.proposedValue !== null)
          .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
        fallbackFill = await fillItems(fallbackTargets, true);
      }

      const { ok, fail, total } = tallyOutcomes(
        localFill.reports,
        aiFill.reports,
        fallbackFill.reports,
        localFill.outcomes,
        aiFill.outcomes,
        fallbackFill.outcomes
      );
      return { ok, fail, total, drafts };
```

Note: `tallyOutcomes(...groups: {fieldId,ok}[][])` accepts both `FieldReport[]` (has `fieldId`+`ok`) and `{fieldId,ok}[]`; later groups win for the same id, so ordering the fallback after the AI fill is correct. If `resp.answers` (`AiFillAnswer[]`) isn't directly assignable to `PlannedAnswer[]` at the `answers = [...hits, ...resp.answers]` line, cast the spread: `...(resp.answers as PlannedAnswer[])` (the existing `planAiFill(candidates, resp.answers)` call already relies on this structural compatibility).

- [ ] **Step 4: Typecheck**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0. (If `AiDraft.fieldId`/`FieldReport` imports are missing, they are already imported in this file — the old `onAutofill` used `AiDraft`, `FieldReport`, `AiFillResponse`, `sendToBackground`, `extractJobContext`.)

- [ ] **Step 5: Build**

Run: `cd chrome-extension && node build.mjs`
Expected: exit 0; `dist/contentScript.js`, `dist/serviceWorker.js`, `dist/mainWorld.js` emitted.

- [ ] **Step 6: Full suite (no regression)**

Run: `cd chrome-extension && npx vitest run`
Expected: all green (contentScript has no direct unit test — its wiring is exercised through the `planFillRoute`/`answerCache`/`fillItems`-composed units; typecheck + build + the unchanged suite confirm no regression).

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/contentScript.ts
git commit -m "feat(ai-fill): AI-primary onAutofill — instant local Phase A + async backend Phase B via cache" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Docs + final verification

**Files:**
- Modify: `docs/autofill-rebuild/jobright-reference-analysis.md`

- [ ] **Step 1: Full verification**

Run: `cd chrome-extension && npx tsc --noEmit && npx vitest run && node build.mjs`
Expected: tsc exit 0; all unit tests green; build emits the three bundles.

- [ ] **Step 2: Record Phase 3 status**

In `docs/autofill-rebuild/jobright-reference-analysis.md` §15, add after the Phase 3 line (near the existing Phase 1/2 status notes):
```markdown
> **Phase 3 status (2026-07-02):** Implemented on branch `feature/autofill-ai-answering` — hybrid AI-primary answering: `planFillRoute` routes deterministic profile fields to the instant local fast-path and judgment fields to the backend `/api/fill` (primary), deduped by an in-memory session `answerCache` (normalized-question key). `onAutofill` is Phase A (instant local) + Phase B (async backend), with the local `proposedValue` as fallback. Client-only. See the spec and plan dated 2026-07-02.
```

- [ ] **Step 3: Commit**

```bash
git add docs/autofill-rebuild/jobright-reference-analysis.md
git commit -m "docs(autofill): mark Phase 3 AI-primary answering complete" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** planner (Task 1 → §4.1), cache (Task 2 → §4.2), onAutofill Phase A/B + fallback (Task 3 → §4.3/§6), backend unchanged (Task 3 uses the existing `AI_FILL`/`toAiFillField`), testing (Tasks 1‑2 pure units + Task 3 build/suite → §8), acceptance criteria 1‑6 (Tasks 1/2/3 + verification gates).
- **No-regression guard:** judgment fields that today fill from the local pass (they're in `selected` with a value) move to Phase B but keep a local `proposedValue` fallback (Task 3 Step 3), so an offline/failed backend can't leave them unfilled.
- **`fillItems` faithfulness:** it reproduces the current Phase‑2 adapter‑first‑refusal → driver/combobox/reconciler partition exactly; `merge=false` maps to the old `getEngine().run` (primary pass), `merge=true` to `getEngine().addTargets` (AI/fallback passes) — matching today's `run` vs `addTargets` split.
- **Type consistency:** `planFillRoute(selected, threshold): FillRoute{localTargets,backendFields}`, `splitByCache(fields):{hits:PlannedAnswer[],misses}`, `cacheAnswers(fields,answers)`, `fillItems(items,merge):{reports,outcomes}`, `dedupeById(fields)`, `LOCAL_FAST_PATH`, `AUTOFILL_CONFIDENCE_THRESHOLD` used consistently across tasks.
