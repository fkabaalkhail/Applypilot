# Autofill AI‑Primary Answering — hybrid routing + session answer cache

- **Date:** 2026-07-02
- **Status:** Approved (design)
- **Branch:** `feature/autofill-ai-answering`
- **Phase:** 3 of the Jobright‑parity rebuild (see `docs/autofill-rebuild/jobright-reference-analysis.md` §5/§13/§15)
- **Scope owner module set:** `chrome-extension/` (client only — no backend changes)

## 1. Problem & goal

The backend `POST /api/fill` is already a full answering engine: it does rule‑based answers, pulls the user's resume/profile from the DB, consults saved‑answer **memory**, then uses Claude for the rest, and returns per answer a `source` (`rule`/`profile`/`memory`/`ai`) and a `needsReview` flag (confident answers fill silently; AI suggestions are drafted for Accept/Edit/Skip). Today the client **starves** it: `aiFillCandidates` only sends fields local resolution *failed* on (`proposedValue === null`). So the backend never sees the judgment fields we answered locally with weak heuristics (work‑auth phrasing, screening questions, education, salary, custom questions), and its memory/AI never improves them.

**Goal:** make the backend the **primary** answer source for **judgment** fields while keeping local/profile + adapters the instant fast‑path for **deterministic** fields — a hybrid. Add an in‑memory session cache keyed by question text so the frequent MutationObserver re‑scans don't re‑hit the API. Client‑only; the backend contract is unchanged.

## 2. Non‑goals (deferred)

- **Persistent / IndexedDB caching** — session in‑memory only (the backend already has cross‑session memory).
- **Any backend change** — `/api/fill` is already capable; we only change what the client sends and how it routes.
- **Repeating‑group education/employment operations** → Phase 4. **iframe agent‑apply** → Phase 5.
- **Sending EEO/sensitive fields to the backend** — EEO stays local, gated by `fillEEO`, never transmitted (privacy default, preserved from today via `isAiCandidate` excluding `sensitive`).

## 3. Architecture — hybrid routing

```
 onAutofill(userSelectedIds)
   selected = wanted ∩ fillable ∩ proposedValue!=null           (fields with a local answer)
   route = planFillRoute(selected, 0.7)                          (pure planner)
     ├─ localTargets   : deterministic profile-lookup fields  → fill NOW (Phase A)
     └─ backendFields  : judgment fields (proposedValue = fallback)
   backendFields ∪= aiFillCandidates(lastFields)                (eligible EMPTY fields — today's behavior)
   ── Phase A (instant) ── fill localTargets via adapter→driver/combobox/reconciler
   ── Phase B (async, best-effort) ──
        {hits, misses} = answerCache.split(backendFields)        (dedupe by normalized question)
        if misses: resp = AI_FILL(/api/fill, misses); answerCache.put(resp)
        answers = hits ∪ resp
        plan = planAiFill(backendFields, answers)                (needsReview → drafts; rest → fill)
        fill plan.simpleTargets; surface plan.drafts             (fallback to local proposedValue on miss/error)
```

Deterministic fields fill immediately (offline‑capable, zero API). Judgment fields are answered by the backend's rule/profile/memory/AI, deduped by the cache, drafted when the backend says `needsReview`.

## 4. Components

### 4.1 Planner — `aiFillPlanner.ts` (evolve; add routing)
Keep the existing pure helpers (`isAiCandidate`, `aiFillCandidates`, `toAiFillField`, `planAiFill`, `tallyOutcomes`, `AiFillPlan`, `PlannedAnswer`). Add:

```ts
import type { FieldCategory } from "../shared/types";

/** Profile-lookup categories answered locally when confident — instant, offline, free. */
export const LOCAL_FAST_PATH: ReadonlySet<FieldCategory> = new Set([
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
 * deterministic local fast-path vs backend-primary judgment fields.
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
      backendFields.push(f);                       // judgment field → backend primary
    } else if (f.proposedValue !== null) {
      localTargets.push({ fieldId: f.id, value: f.proposedValue }); // sensitive/EEO w/ value → local
    }
    // else: not deterministic, not AI-eligible, no value → skip
  }
  return { localTargets, backendFields };
}
```

### 4.2 Session answer cache — `answerCache.ts` (new)
Per‑frame in‑memory cache keyed by **normalized question text** (a page is one job; field ids churn across re‑scans, the question is stable).

```ts
import type { DetectedField } from "../shared/types";
import type { PlannedAnswer } from "./aiFillPlanner";

/** Cached backend answer (id-agnostic — keyed by question). */
type CachedAnswer = Omit<PlannedAnswer, "id">;

const cache = new Map<string, CachedAnswer>();

/** Normalize a question label for stable keying (case/whitespace/punctuation-insensitive). */
export function normalizeQuestion(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

/** Split backend-bound fields into cache hits (answers ready) and misses (to send). */
export function splitByCache(fields: DetectedField[]): { hits: PlannedAnswer[]; misses: DetectedField[] } {
  const hits: PlannedAnswer[] = [];
  const misses: DetectedField[] = [];
  for (const f of fields) {
    const key = normalizeQuestion(f.label);
    const c = key ? cache.get(key) : undefined;
    if (c) hits.push({ id: f.id, ...c });          // re-attach the current field id
    else misses.push(f);
  }
  return { hits, misses };
}

/** Store backend answers by their field's normalized question (call after a fetch). */
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
export function __resetCache(): void { cache.clear(); }
```
Empty‑label fields never cache (empty key). Only non‑empty answers are cached.

### 4.3 Orchestration — `contentScript.onAutofill`
Restructure into Phase A (instant local) + Phase B (async backend), using `planFillRoute`, `splitByCache`/`cacheAnswers`, and the existing `planAiFill`/adapter/driver/combobox/reconciler machinery:

- **Phase A:** `route = planFillRoute(selected, AUTOFILL_CONFIDENCE_THRESHOLD)`. Fill `route.localTargets` immediately through the existing adapter‑first‑refusal → `remaining` → driver/combobox/reconciler partition (the current `runAdapterOperations` + partition code, fed `route.localTargets` instead of all of `selected`).
- **Phase B (best‑effort, in the existing try/catch):** `backendFields = dedupeById([...route.backendFields, ...aiFillCandidates(lastFields)])`; `{hits, misses} = splitByCache(backendFields)`; if `misses.length` → `AI_FILL` with `misses.map(toAiFillField)` → `cacheAnswers(misses, resp.answers)`; `answers = [...hits, ...resp.answers]`; `plan = planAiFill(backendFields, answers)`; fill `plan.simpleTargets` (through adapter/driver/combobox/reconciler, as today) and push `plan.drafts`. On error/offline, backend fields fall back to their local `proposedValue` where present (fill those) — additive, never blocks Phase A.
- `tallyOutcomes` folds Phase A + Phase B outcomes exactly as today.

## 5. Backend (no changes)
`buildFillRequestBody`/`aiFillFields` (`api/aiFill.ts`) and the `AI_FILL` service‑worker handler are unchanged. We simply send more fields (the judgment ones) via the same contract; the backend's rule/profile/memory/AI + `needsReview` logic does the rest. Confirm (no change expected): the endpoint answers profile‑category fields from the DB (`source: "profile"/"rule"`) and flags AI suggestions `needsReview: true`.

## 6. Error handling & offline
- `/api/fill` failure or offline → Phase A local fill already done; Phase B caught (today's swallow) → backend fields fall back to local `proposedValue` (filled) or remain needs‑manual. AI is strictly additive.
- Cache is per‑frame, cleared on navigation (module lifetime); a stale answer can't outlive the page. `__resetCache` isolates tests.
- A backend answer that fails option‑matching in a dropdown degrades like any failed fill (needs‑manual), unchanged.

## 7. Files
- Create: `chrome-extension/src/content/answerCache.ts`.
- Modify: `chrome-extension/src/content/aiFillPlanner.ts` (add `LOCAL_FAST_PATH`, `FillRoute`, `planFillRoute`); `chrome-extension/src/content/contentScript.ts` (Phase A/B restructure of `onAutofill`).
- Tests: `chrome-extension/test/aiFillPlanner.test.ts` (extend — routing), `chrome-extension/test/answerCache.test.ts` (new).

## 8. Testing
- **Planner (`planFillRoute`):** deterministic category + high confidence + value → `localTargets`; same category with low confidence or no value → `backendFields`; a judgment category (workAuthorization/education/salary/unknown/custom question) → `backendFields` even with a local value; a sensitive/EEO field with a value → `localTargets` (never backend); a non‑eligible field with no value → skipped.
- **Cache (`answerCache`):** `normalizeQuestion` collapses case/space/punctuation; `splitByCache` returns a hit (with the current field id re‑attached) for a previously‑cached question and a miss otherwise; `cacheAnswers` stores non‑empty answers only and skips empty‑label fields; `__resetCache` clears.
- **Integration:** verified by `npx tsc --noEmit` + `node build.mjs` + the full unit suite staying green (contentScript is the IIFE entry — its wiring is exercised through the pure planner/cache units, as in Phases 1‑2).

## 9. Acceptance criteria
1. A deterministic profile field (e.g. email, high confidence, profile value) fills **without** an `/api/fill` call (local fast‑path).
2. A judgment field (e.g. a work‑authorization or custom screening question) is routed to `/api/fill` **even when local produced a guess**, and the backend answer is used (its local value is the fallback on backend failure).
3. Re‑running autofill (or a MutationObserver re‑scan) does **not** re‑call `/api/fill` for a question already answered this session (cache hit).
4. EEO/sensitive fields are never sent to the backend; file/customDropdown untouched.
5. `/api/fill` failure/offline leaves the local fast‑path fills intact and backend fields falling back to local values — no hang, no blocked fill.
6. `npx tsc --noEmit`, `node build.mjs`, and the full unit suite pass.

## 10. Risks & mitigations
- **Latency/cost for judgment fields** → the session cache dedupes re‑scans; deterministic fields never hit the API; Phase B is async so it never delays Phase A.
- **Backend mis‑answering a field local nailed** → the `LOCAL_FAST_PATH` whitelist keeps deterministic identity/contact/link (and stable profile‑fact) categories local; only judgment fields are promoted.
- **Category‑split tuning** → `LOCAL_FAST_PATH` is a single, easily‑adjusted constant; the threshold reuses `AUTOFILL_CONFIDENCE_THRESHOLD`.
- **Question‑keyed cache collisions** (two different fields with the same label) → acceptable within one job/page (same label ⇒ same intended answer); the key is per‑frame and short‑lived.
