# Autofill Per‑Site Adapter Framework — override layer + Greenhouse & Workday reference adapters

- **Date:** 2026-07-01
- **Status:** Approved (design)
- **Branch:** `feature/autofill-site-adapters`
- **Phase:** 2 of the Jobright‑parity rebuild (see `docs/autofill-rebuild/jobright-reference-analysis.md` §8/§13/§15)
- **Scope owner module set:** `chrome-extension/`

## 1. Problem & goal

Our generic pipeline — `formScanner.scanPage` → `classifyField(signals)` → `resolveProfileValue(category, profile, control, fillEEO)` → fill (reconciler + Phase‑1 MAIN‑world drivers + combobox engine) — is solid on standard forms but has no place to encode the per‑ATS quirks that make specific platforms fail: Workday's generic labels (its real signal is `data-automation-id`), Greenhouse's custom‑question `name`/`id` shapes, site‑specific option wording, and multi‑element fields the generic writer can't drive as a unit (e.g. Workday's split date input).

**Goal:** add a **per‑site adapter framework** — a thin *override layer* over the working generic pipeline. A matched adapter may refine classification, reshape the resolved answer, and own the fill of specific fields; anything it declines, and every unrecognized site, falls through to today's generic behavior unchanged. Validate the framework with two reference adapters: **Greenhouse** (classify + answer overrides) and **Workday** (classify by automation‑id + a bounded fill operation + the Phase‑1 Workday driver).

## 2. Non‑goals (deferred)

- **Full repeating‑group operations** (adding/filling multiple education/employment rows) → Phase 4. The operation hook is *defined* here and proven by a single bounded case (Workday split‑date), not a multi‑row repeater.
- **AI‑primary answering** → Phase 3.
- **ATS adapters beyond Greenhouse + Workday** → fast‑follows on the proven framework.
- **No changes** to the Phase‑1 drivers, `writeEngine`, or `comboboxEngine` internals — adapters layer on top of them.

## 3. Architecture — override layer

```
 scanPage(profile, fillEEO)                         contentScript.onAutofill
 ───────────────────────────                        ────────────────────────
 adapter = getAdapter(host, url)   ◀── registry     adapter = scanResult.adapter
 per field:                                          per selected field:
   c = classifyField(signals)                          op = adapter?.fillOperation?.(ctx)
   c = adapter?.classify?.(ctx,c) ?? c                 op is Promise → adapter fills it
   v = adapter?.resolveAnswer?.(ctx)                   op is undefined → generic path
       ?? resolveProfileValue(...)                       (driver / combobox / reconciler)
 ScanResult { fields, registry, adapter }
```

Every hook is **optional** and **advisory**: returning `undefined`/omitting it yields generic behavior. `getAdapter` returning `null` (unrecognized host) yields fully generic behavior. This makes the change purely additive — non‑adapter sites take a byte‑identical path to today.

## 4. Interfaces (`src/content/adapters/types.ts`)

```ts
import type { Classification } from "../fieldMatcher";
import type { FieldSignals } from "../domUtils";
import type { RuntimeControl } from "../formScanner";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../../shared/types";

export interface FieldContext {
  el: HTMLElement;
  signals: FieldSignals;
  controlType: ControlType;
}

export interface AnswerContext {
  category: FieldCategory;
  profile: UserApplicationProfile;      // only called when a profile is loaded
  control: { controlType: ControlType; options?: string[] };
  fillEEO: boolean;
  el: HTMLElement;
}

export interface FillContext {
  control: RuntimeControl;              // el, controlType, driver, radios/checkboxes
  value: string;                        // the resolved value to write
  el: HTMLElement;
}

export interface AdapterFillResult {
  filled: boolean;
  reason?: string;
}

export interface SiteAdapter {
  /** Stable id, also the diagnostic tag. */
  id: string;

  /** Detection: does this adapter own the current page? Pure, no side effects. */
  match(host: string, url: string): boolean;

  /** Hook 1 — correct a field's category (e.g. from a selector / data-automation-id).
   *  Return a replacement Classification, or undefined to keep the generic one. */
  classify?(ctx: FieldContext, generic: Classification): Classification | undefined;

  /** Hook 2 — site-specific value formatting. undefined = keep generic;
   *  string|null = use this verbatim (null means "no data", a valid answer). */
  resolveAnswer?(ctx: AnswerContext): string | null | undefined;

  /** Hook 3 — site-specific fill sequence. Return undefined SYNCHRONOUSLY to
   *  decline the field (→ generic fill path), or a Promise to claim + fill it. */
  fillOperation?(ctx: FillContext): Promise<AdapterFillResult> | undefined;
}
```

### 4.1 Registry (`src/content/adapters/registry.ts`)
```ts
import type { SiteAdapter } from "./types";
import { greenhouseAdapter } from "./greenhouse";
import { workdayAdapter } from "./workday";

// Ordered; first match wins. More specific adapters go earlier.
const ADAPTERS: SiteAdapter[] = [greenhouseAdapter, workdayAdapter];

/** Resolve the adapter for the current page, or null. Total + side-effect free;
 *  a throwing match() is treated as "no match" so one bad adapter can't break scan. */
export function getAdapter(host: string, url: string): SiteAdapter | null {
  for (const a of ADAPTERS) {
    try { if (a.match(host, url)) return a; } catch { /* skip */ }
  }
  return null;
}
```
`index.ts` re‑exports `getAdapter`, `SiteAdapter`, and the adapters.

### 4.2 Hook isolation helper
All hook calls go through a wrapper so an adapter bug degrades to generic, never throws into scan/fill:
```ts
function safeHook<T>(fn: (() => T) | undefined): T | undefined {
  if (!fn) return undefined;
  try { return fn(); } catch (e) { console.warn("[adapter hook]", e); return undefined; }
}
```

## 5. Integration points

### 5.1 `formScanner.ts`
- Resolve once at the top of `scanPage`: `const adapter = getAdapter(location.hostname, location.href);`
- **classify:** after `const generic = classifyField(signals);`
  ```ts
  const override = safeHook(() => adapter?.classify?.({ el, signals, controlType }, generic));
  const { category, confidence, sensitive } = override ?? generic;
  ```
- **resolveAnswer:** replace `const proposedValue = profile ? resolveProfileValue(...) : null;` with
  ```ts
  let proposedValue: string | null = null;
  if (profile) {
    const o = safeHook(() => adapter?.resolveAnswer?.({ category, profile, control: { controlType, options }, fillEEO, el }));
    proposedValue = o !== undefined ? o : resolveProfileValue(category, profile, { controlType, options }, fillEEO);
  }
  ```
  (Applied in the single‑control branch AND the radio/checkbox‑group branches, which also call `resolveProfileValue`.)
- **`ScanResult`** gains `adapter: SiteAdapter | null` so the fill stage reuses the same resolution.

### 5.2 `contentScript.ts` — fill orchestration
In `onAutofill`, before the existing driver/combobox/reconciler partition, give the adapter first refusal per field:
```ts
const adapter = /* from the last scan result */ ;
const remaining: DetectedField[] = [];
const opOutcomes: { fieldId: string; ok: boolean }[] = [];
for (const f of selected) {
  const control = registry.get(f.id);
  const op = control && safeHook(() =>
    adapter?.fillOperation?.({ control, value: f.proposedValue as string, el: control.el as HTMLElement }));
  if (op) {
    const r = await op;                       // adapter owns this field
    opOutcomes.push({ fieldId: f.id, ok: r.filled });
  } else {
    remaining.push(f);                        // generic path
  }
}
// `remaining` then flows through the existing driver / combobox / reconciler partition.
```
`opOutcomes` fold into the existing `comboOutcomes`‑style tally (same `{fieldId, ok}` shape). The same first‑refusal is applied in the AI‑fill pass and in `onInsertAnswer` (single‑field). Non‑adapter fields and declined fields behave exactly as today.

The content script keeps the resolved adapter from the most recent `runScan()` (store `scanResult.adapter` alongside `registry`/`lastFields`), so scan and fill agree on the adapter without re‑resolving.

## 6. Reference adapters (bounded)

### 6.1 Greenhouse (`greenhouse.ts`)
- **match:** `host` ends with `greenhouse.io` (covers `boards.greenhouse.io`, `job-boards.greenhouse.io`, `*.greenhouse.io`). `match` is host/url‑only (no DOM access, consistent with §4). Detecting Greenhouse *embedded* in an employer domain via a DOM signature (`#application_form`, `[id^="job_application"]`) is a documented follow‑up, not part of the Phase‑2 reference adapter.
- **classify:** a small, explicit table correcting Greenhouse custom‑question fields whose `name`/`id` (`job_application[answers_attributes][…]`) the generic regex under‑classifies, mapping the well‑known ones (school, degree, LinkedIn "urls[LinkedIn]", etc.) to their category.
- **resolveAnswer:** normalize a handful of Greenhouse option wordings — e.g. its work‑authorization / sponsorship Yes/No option labels and its EEO/demographic option text — so the value matches an actual option.
- **fillOperation:** none required (Greenhouse's react‑select dropdowns are already handled by the Phase‑1 driver). Included as `undefined`.

### 6.2 Workday (`workday.ts`)
- **match:** `host` matches Workday domains (`myworkdayjobs.com`, `myworkday.com`, `myworkdayjobs-impl.com`, `myworkdaysite.com`).
- **classify:** map `el.closest('[data-automation-id]')`'s automation‑id to a category via an explicit table (e.g. `legalNameSection_firstName` → `firstName`, `email` → `email`, `phone-number` → `phone`, `addressSection_countryRegion` → `location`). Automation‑ids are Workday's reliable signal; this is the adapter's biggest win.
- **resolveAnswer:** format Workday prompt values — e.g. country/region to the exact prompt option wording, phone device type.
- **fillOperation:** the **Workday split date field** — when the control is a Workday date widget (a group of `[data-automation-id$="-input"]` month/day/year `spinbutton`s under a `[data-automation-id*="date" i]` container) and `value` is a parseable date, claim the field and set each sub‑input via the native value setter + `input`/`change` events, in month/day/year order. Returns `{filled:true}` on success, `{filled:false, reason}` otherwise. This is the bounded reference use of the operation hook (NOT a multi‑row repeater).

## 7. Error handling & isolation

- Every hook is invoked through `safeHook` (or the registry's `try/catch` for `match`): a throwing adapter degrades that field to generic, logs a warning, and never breaks scan or fill.
- `fillOperation` rejections are caught by the `await` site; a rejected/`{filled:false}` operation is reported like any failed fill (needs‑manual), never a hang.
- `getAdapter` is pure, total, and cheap (called once per scan). Per‑field hook calls are synchronous and bounded.

## 8. File structure

- Create: `src/content/adapters/types.ts`, `registry.ts`, `greenhouse.ts`, `workday.ts`, `index.ts`.
- Modify: `src/content/formScanner.ts` (thread adapter into classify + resolveAnswer for all three field branches; add `adapter` to `ScanResult`), `src/content/contentScript.ts` (store `scanResult.adapter`; adapter first‑refusal in `onAutofill`, the AI pass, and `onInsertAnswer`).
- Tests: `test/adapterRegistry.test.ts`, `test/greenhouseAdapter.test.ts`, `test/workdayAdapter.test.ts`, `test/scanPageAdapter.test.ts` (+ reuse `test/fixtures/workday.ts`, add a Greenhouse fixture if not present).

## 9. Testing strategy

- **Registry:** `getAdapter` host matching + precedence (Greenhouse vs Workday vs unknown → null); a throwing `match()` is skipped, not fatal.
- **Greenhouse adapter:** `classify` promotes a Greenhouse custom‑question field the generic path under‑classifies; `resolveAnswer` maps a work‑auth/EEO value to the exact option wording; declining a normal field returns `undefined` (generic).
- **Workday adapter:** `classify` maps representative `data-automation-id`s to categories; `resolveAnswer` formats a country value; `fillOperation` fills a jsdom 3‑spinbutton date fixture from a date value and returns `{filled:true}`, and returns `undefined` for a non‑date Workday field.
- **`scanPage` integration:** on a Workday‑host fixture (jsdom URL set to a Workday host), a field the generic path misses is classified via the adapter and gets a value; on a non‑adapter host, `scanPage` output is unchanged from today (regression guard). Hook error‑isolation: a deliberately throwing adapter still yields generic results.
- **Browser (existing Playwright harness):** the Greenhouse and Workday fixtures still fill end‑to‑end with adapters active (no regression; overrides take effect).

> Note on setting the jsdom host for scan/adapter tests: `getAdapter` reads `location.hostname`. Where a test needs a Workday host, drive it by calling the adapter/registry functions directly with an explicit host argument (they take `(host, url)`), rather than mutating `window.location`. The `scanPage` integration test that must exercise host resolution uses a small injectable seam (pass host/url or stub `getAdapter`) so it does not depend on jsdom `location` being reconfigurable.

## 10. Acceptance criteria

1. On a Workday page, fields the generic classifier misses (identified only by `data-automation-id`) are classified and get a proposed value via the adapter; a Workday split‑date field fills all three sub‑inputs via `fillOperation`.
2. On a Greenhouse page, a custom‑question field the generic path under‑classifies is corrected, and a work‑auth/EEO value matches an actual option.
3. On any non‑adapter host, `scanPage` and the fill flow behave byte‑identically to pre‑Phase‑2 (no regression) — proven by an unchanged‑output test and the existing suite staying green.
4. A throwing adapter hook never breaks scan or fill; the field degrades to generic.
5. Adapter‑operated fields are filled exactly once (not also by the reconciler / combobox / driver).
6. `npm run build`, `npx tsc --noEmit`, and the full unit suite pass; the Playwright Greenhouse + Workday scenarios pass.

## 11. Risks & mitigations

- **Adapter first‑refusal in `onAutofill` adds a per‑field async check** → keep `fillOperation`'s decline path synchronous (`return undefined`) so only claimed fields incur an `await`.
- **`match` on host only can miss embedded boards** (Greenhouse in an iframe under an employer domain) → primary detection is the ATS host; embedded detection via a DOM‑signature helper is a documented, bounded extension, not required for the two reference adapters' core cases.
- **Workday automation‑id coverage is broad** → the classify table is an explicit allow‑list of well‑known ids; unknown ids fall through to generic, never mis‑promoted.
- **Value plumbing for Workday dates is bounded** by which profile categories are date‑typed today → the operation is proven against a date value in tests; wider wiring is follow‑up, not a Phase‑2 gate.
