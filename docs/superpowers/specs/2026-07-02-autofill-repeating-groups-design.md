# Autofill Repeating Sections — index‑aware resolution

- **Date:** 2026-07-02
- **Status:** Approved (self-approved — autonomous overnight run; see memory `autonomous-autofill-phases-overnight`)
- **Branch:** `feature/autofill-repeating-groups`
- **Phase:** 4 of the Jobright‑parity rebuild (see `docs/autofill-rebuild/jobright-reference-analysis.md` §8/§15)
- **Scope owner module set:** `chrome-extension/` (client only)

## 1. Problem & goal

ATS forms often render **repeating** education/employment sections — multiple rows of `school`/`degree`/`grad year`, or `company`/`title`/`dates`, with field names like `education[1][school_name]`, `job_application[employments][2][title]`, `edu_2_degree`. Our profile already holds arrays (`education: EducationEntry[]`, `experience: ExperienceEntry[]`), but `resolveProfileValue` always resolves education/employment categories to entry **`[0]`**, so only the first row is ever filled — every later row gets the *same* first‑entry value or nothing.

**Goal:** correctly fill **every repeating row a form already shows**, by detecting each field's row index and resolving it against the matching profile array entry (`education[N]` / `experience[N]`). Pure, no DOM mutation.

## 2. Non‑goals (deferred, with rationale)

- **Auto‑adding rows** (clicking "Add another education", synthesizing new row DOM) → **deferred**. ATS add‑row markup varies wildly (Jobright ships per‑site education/employment *operations* for exactly this reason); a robust universal add‑row DOM engine is high‑risk to build unattended and could mutate arbitrary forms. Phase 4 fills the rows that are **present**; adding rows is a later, per‑adapter follow‑up.
- **Employment date fields** (`startDate`/`endDate`) → deferred: `fieldMatcher` has no date category today, so date fields don't classify; adding date categories + a date‑format utility is out of scope here (noted as a follow‑up).
- Any backend, Phase‑1 driver, Phase‑2 adapter, or Phase‑3 AI‑fill change.

## 3. Architecture

`scanPage` already computes a `signals` bundle per field and resolves a value via `resolveAnswerWithAdapter → resolveProfileValue`. Phase 4 adds one pure signal — the **row index** — and threads it into resolution:

```
 per field:
   signals = collectSignals(el)
   groupIndex = detectGroupIndex(signals)            ← NEW pure helper (null when not repeating)
   value = resolveAnswerWithAdapter(adapter, category, profile,
             { controlType, options, groupIndex }, fillEEO, el)   ← control gains groupIndex
              └─ resolveProfileValue(category, profile, { …, groupIndex }, fillEEO)
                   education cats → profile.education[groupIndex ?? 0]
                   employment cats → groupIndex!=null ? profile.experience[groupIndex] : profile.<current*>
```

Non‑repeating fields (`groupIndex === null`) behave **exactly as today** (education `[0]`, top‑level `currentCompany`/`currentTitle`) — zero regression.

## 4. Components

### 4.1 `groupIndex.ts` (new, pure)
```ts
import type { FieldSignals } from "./domUtils";

/**
 * The 0-based repeating-row index encoded in a field's name/id, or null.
 * Recognizes the common ATS shapes: `education[1][school]`, `emp_2_title`,
 * `job.0.company`, `edu-3-degree`. Returns the FIRST index found (the outermost
 * repeating group), preferring the `name` attribute over `id`.
 */
export function detectGroupIndex(signals: FieldSignals): number | null;
```
Implementation: scan `signals.nameAttr` then `signals.idAttr` for the first of `\[(\d+)\]`, `[._-](\d+)[._-]`, returning the captured integer; `null` if none. Bounded (ignore indices ≥ 50 as spurious).

### 4.2 `fieldMatcher.resolveProfileValue` — index‑aware
Extend the `control` param to `{ controlType: ControlType; options?: string[]; groupIndex?: number | null }` and change the education/employment cases:
```ts
const gi = control.groupIndex ?? null;
const edu = profile.education[gi ?? 0];
// school/degree/graduationYear → edu?.<field>
// currentCompany → gi !== null ? profile.experience[gi]?.company : profile.currentCompany
// currentTitle   → gi !== null ? profile.experience[gi]?.title   : profile.currentTitle
```
All other categories ignore `groupIndex`. `education` (the long‑text summary) still uses `formatEducation` (all entries) unchanged.

### 4.3 Threading `groupIndex`
- `AnswerContext.control` (adapters `types.ts`) gains `groupIndex?: number | null` so adapters see it too.
- `answerCache`/`planFillRoute`/`fillItems` are unaffected (they operate on `DetectedField`/targets, not the resolver's control param).
- `formScanner.scanPage`: in each of the three field branches, compute `const groupIndex = detectGroupIndex(signals);` and pass it in the `control` object to `resolveAnswerWithAdapter`. (Group branches — radio/checkbox — pass the group's `first`‑element signals; those rarely carry a row index, so `groupIndex` is typically `null` there, which is correct.)

## 5. Files
- Create: `chrome-extension/src/content/groupIndex.ts`.
- Modify: `chrome-extension/src/content/fieldMatcher.ts` (`resolveProfileValue` index‑aware); `chrome-extension/src/content/formScanner.ts` (compute + thread `groupIndex`); `chrome-extension/src/content/adapters/types.ts` (`AnswerContext.control.groupIndex`); `chrome-extension/src/content/adapters/apply.ts` (pass `groupIndex` through `resolveAnswerWithAdapter`'s `control` to `resolveProfileValue`).
- Tests: `chrome-extension/test/groupIndex.test.ts` (new), `chrome-extension/test/fieldMatcher.test.ts` (extend — index‑aware resolution).

## 6. Testing
- **`detectGroupIndex`:** `education[1][school]`→1, `job_application_employments_attributes_2_title`→2, `edu.0.degree`→0, `emp-3-company`→3; a plain `first_name`→null; an id‑only field (`#education_1_school`, no name)→1; spurious huge index (`x[999]`)→null.
- **`resolveProfileValue` (index‑aware):** `school` with `groupIndex:1` → `profile.education[1].school`; `school` with `groupIndex:null` → `education[0]` (unchanged); `currentCompany` with `groupIndex:2` → `profile.experience[2].company`; `currentCompany` with `groupIndex:null` → `profile.currentCompany`; `currentTitle` indexed → `experience[N].title`; out‑of‑range index (`education[5]` with only 2 entries) → `null` (no crash); non‑education/employment category ignores `groupIndex`.
- **Integration:** `scanPage` fills a two‑row education fixture (`education[0][school]`, `education[1][school]`) from `profile.education[0]`/`[1]` respectively; a non‑repeating form is byte‑identical to today. Verified by `npx tsc --noEmit` + `node build.mjs` + the full suite staying green.

## 7. Acceptance criteria
1. A field named `education[1][school]` resolves to `profile.education[1].school`; `education[0][school]` to `[0]`.
2. An indexed employment field (`…[2][title]`, category `currentTitle`) resolves to `profile.experience[2].title`; a non‑indexed "Current title" still resolves to `profile.currentTitle`.
3. Non‑repeating fields and non‑education/employment categories behave identically to pre‑Phase‑4 (no regression) — proven by the unchanged suite + an explicit test.
4. An out‑of‑range or undetectable index never throws (resolves `null`).
5. `npx tsc --noEmit`, `node build.mjs`, and the full unit suite pass.

## 8. Risks & mitigations
- **False index detection** on a non‑repeating field whose name coincidentally contains `[N]` → the index only changes resolution for education/employment categories (which are the repeating ones); other categories ignore it, and an out‑of‑range index resolves `null` (falls back to review/AI), so a false positive can't fill a wrong value into an unrelated field.
- **Group‑branch fields** (radio/checkbox) rarely carry a row index → `groupIndex` is `null` there; correct.
- **Scope creep toward add‑row DOM** → explicitly deferred (§2); Phase 4 is pure resolution only.
