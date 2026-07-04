# Tailrd Extension — Full ATS Coverage & Jobright Parity (Design)

**Date:** 2026-07-04
**Status:** Approved (user granted blanket pre-approval — "automatically approve all plans or specs and just go with it"; user is away)
**Owner:** autonomous session
**Goal:** Take the Tailrd Chrome extension out of MVP and to a *final product* that matches or exceeds Jobright 1.15.0 on ATS coverage, detection precision, and autofill quality — changing internal structure where that serves quality.

---

## 1. Objective & scope

The explicit ask: *"Implement all the ATS systems Jobright has. Evaluate any gap between our extension and theirs and add it. This is no longer MVP — make it the final Chrome extension product, as good as or better than Jobright."*

**In scope**
1. **Detection parity** — recognize every site Jobright recognizes (69 entries: ~47 reusable ATS vendors + ~22 marquee-company career portals), with the same precision signals (domain, url pattern, path regex, iframe-embedded, iframe-only, page-source keyword).
2. **Fill quality parity** — the generic pipeline must fill the "standard-form" ATS well, and the hard ATS (iCIMS, Ashby, BambooHR, Taleo, SuccessFactors, Oracle Cloud, SmartRecruiters, Workable, ADP, Phenom) get hand-tuned handling matching Jobright's special-case logic.
3. **Apply-entry parity** — recognize the "Apply / Apply Manually / Continue" entry points per ATS so the multi-page flow works everywhere Jobright's does.
4. **Non-ATS gap closure** — a focused audit of everything else Jobright's extension does that we don't (see §7), folding in the high-value items.
5. **Verification** — unit fixtures for every adapter + live-DOM smoke checks + Neon `autofill_reports` telemetry validation for the hard ATS.

**Out of scope (explicitly not this effort)**
- Rebuilding the side-panel UI from scratch (the Jobright-style panel already shipped — see memory `extension-panel-redesign`). We *extend* it to surface the detected ATS, nothing more.
- Résumé tailoring / job-match / cover-letter generation backends (already built).
- Changing the injection strategy (already `all_urls` + `all_frames`, matching Jobright — memory `autofill-scope-and-captcha-decisions`).

---

## 2. Baseline — what Tailrd has today

- **Injection:** `<all_urls>` + `all_frames: true`, captcha hosts excluded. Matches Jobright exactly.
- **Adapter model** (`src/content/adapters/`): an `ADAPTERS[]` array, first-match-wins. Each `SiteAdapter` layers *optional* overrides on the generic pipeline: `match(host,url)`, `classify?`, `resolveAnswer?`, `fillOperation?`, `advanceButton?`, `entryButton?`. Fallbacks are total — a broken/declining adapter can only refine, never break, the pipeline. **This architecture is good and we keep it.**
- **Hand-tuned adapters:** Greenhouse (`greenhouse.ts` — react-select v5), Workday (`workday.ts` — data-automation-id widgets, entry button), Lever (`lever.ts` — location typeahead + org rule).
- **Thin adapters** (`common.ts`): 26 ATS recognized by anchored host regex + attribute classification only — bamboohr, breezy, ashby, workable, smartrecruiters, jobvite, rippling, bullhorn, icims, taleo, adp, successfactors, oraclecloud, dayforce, ukg, jazzhr, paylocity, avature, phenom, teamtailor, recruitee, personio, eightfold, clearcompany, paycom, brassring.
- **Generic pipeline:** `formScanner.ts` (DOM → `RuntimeControl[]`), `fieldMatcher.ts` (classify + resolve profile value), `writeEngine.ts`, `comboboxEngine.ts` (typeahead/combobox), `demographicMatch.ts` (on-device EEO), `aiFillPlanner.ts` + `api/aiFill.ts` (AI for freeform), grounding contract + `__NO_ANSWER__` sentinel.
- **Apply-entry:** `applyEntry.ts` — generic anchored-text tiers + adapter `entryButton` hook. Multi-page flow parks per page; user turns each page (memory `flow-user-gated-advance`).
- **Cross-frame:** `crossFrame.ts`; MAIN-world driver injection (`mainWorld*.ts`, `driverDetect.ts`) for react-select/Workday widgets.
- **Tests:** ~526 green at last count (vitest, `chrome-extension/test/`).

**Baseline verdict:** the *architecture* is already at parity; the *coverage table* and the *hard-ATS fill quality* are not.

---

## 3. Jobright 1.15.0 — what we're matching

Extracted verbatim from `1.15.0_0/click-jr-injector.62a5c2f4.js` and `filler.17f3ba95.js`. Canonical `SITE_REGISTRY` (69 entries, 12.9 KB) saved to the session scratchpad as `jobright-SITE_REGISTRY.js`; per-entry JSON as `jobright-registry-injector.json`.

**Detection model.** One data-driven `SITE_REGISTRY` keyed by site id, each entry carrying any of:
- `domains: string[]` — hostname suffixes (anchored).
- `patterns: string[]` — `@webext-core/match-patterns` globs (e.g. `*://*.avature.net/*/ApplicationForm*`).
- `pathRegex: string` — gate to real application paths (29 entries).
- `iframeDomains: string[]` — the form is embedded in an iframe from these hosts (16 entries).
- `iframeOnly: true` — only operate inside the iframe (iCIMS).
- `pageSourceKeyword` + `pageSourceDomain` — detect ATS by a script/keyword in page HTML when the page is served on the *employer's* own domain (teamtailor, phenom, eightfold, recruitee, avature, recruiterflow).

The **same registry** drives the injector (apply-button injection on postings) and the filler (which site am I on → which handler). Special field handling in the filler is a small enum: generic `DROPDOWN`, `DATE`, `RADIOGROUP`, `SECTION`, plus exactly two named specials — `BAMBOOHR_SPECIAL` and `ASHBY_SEARCH` — on top of Greenhouse's react-select and Workday's automation-id handling.

**The 69 sites.** Reusable ATS vendors: greenhouse, workday, icims, lever, taleo, successfactors, ashby, smartrecruiters, jobvite, bamboohr, workable, breezy, recruitee, teamtailor, eightfold, avature, oraclecloud, brassring, jazzhr, paycomonline, paylocity, ultipro, dayforce, adp, rippling, dover, gem, jobscore, phenom, jobdiva, clearcompany, personio, zohorecruit, comeet, careerplug, careerspage, catsone, freshteam, gohire, hiringthing, isolved, recruiterflow, ripplehire, trinethire, trakstar, pinpointhq, kula, polymer. Marquee company portals: adobe, amazon, amazonuniversity, apple, bytedance, cisco, google, gusto, hubspot, intuit, jacobs, metacareers, okta, tesla, tiktok, uber, walmart, ycombinator, careerswithwaymo, careerstoasttab, xcompany.

---

## 4. Gap analysis

| Gap | Jobright | Tailrd today | Action |
|---|---|---|---|
| **Detection breadth** | 69 sites | 29 recognized | Port full registry → recognize all 69 |
| **Detection precision** | domain + pattern + pathRegex + iframe + pageSource | host regex only | Port all five signal types |
| **iframe-embedded forms** | 16 sites flagged; iCIMS iframe-only | relies on all_frames only | Add iframe-aware detection + panel/entry handling |
| **Employer-domain ATS** | pageSourceKeyword for 6 | none | Add page-source detection |
| **Apply-entry per ATS** | url patterns per site | generic text + 2 hooks | Port per-ATS entry patterns |
| **Hard-ATS fill** | special handlers | thin/generic | Hand-tune iCIMS, Ashby, BambooHR, Taleo, SuccessFactors, OracleCloud, SmartRecruiters, Workable, ADP, Phenom |
| **Company portals** | 22 | ~0 | Add (thin adapters + patterns) |
| **Panel shows ATS** | yes | unknown | Surface detected ATS id/label |

**Missing sites to add (≈40):** dover, gem, jobscore, jobdiva, comeet, zohorecruit, careerplug, careerspage, catsone, freshteam, gohire, hiringthing, isolved, recruiterflow, ripplehire, trinethire, trakstar, pinpointhq, kula, polymer, gusto + all 22 company portals. (paycom host fix: Jobright matches `paycomonline.com` **and** `.net`; we only have `.net`.)

---

## 5. Design

### 5.1 New module: `src/content/siteRegistry.ts` (data-driven detection)
A typed port of Jobright's `SITE_REGISTRY`. Shape:
```ts
interface SiteEntry {
  id: string;                 // "workday", "icims", …
  label: string;              // "Workday" (human, for the panel)
  domains?: string[];         // anchored hostname suffixes
  patterns?: string[];        // match-pattern globs
  pathRegex?: RegExp;
  iframeDomains?: string[];
  iframeOnly?: boolean;
  pageSourceKeyword?: string; // + pageSourceDomain
  tier: "vendor" | "portal";  // vendor = reusable ATS; portal = single employer
}
export function detectSite(host, url, opts?): SiteEntry | null;
export const SITE_REGISTRY: SiteEntry[];
```
- Match-pattern globs implemented with a tiny internal matcher (no runtime dep on `@webext-core`), unit-tested against Jobright's exact patterns.
- `detectSite` is pure (host/url/optional page-source string) and is the single source of truth. It replaces the scattered host regexes.

### 5.2 Adapter layer becomes registry-driven
- `common.ts` stops hand-listing hosts. Instead, for every `SITE_REGISTRY` entry **without** a hand-tuned module, auto-build a thin `SiteAdapter` whose `match()` delegates to `detectSite`. One data table → 69 adapters, no per-site file.
- Hand-tuned modules (greenhouse/workday/lever/+new) keep their own `match()` but source their host/pattern predicate from `detectSite(id)` so detection logic lives in one place.
- `SiteAdapter` gains an optional `label` and the resolved `SiteEntry` is threaded to the panel + telemetry.

### 5.3 Hand-tuned adapters to add (priority order)
Each ships with: fixture-based unit tests, a real-DOM smoke assertion, and a telemetry check against Neon `autofill_reports` where live data exists.
1. **iCIMS** — iframe-only; form lives in `icims.com` iframe. Field detection + apply-entry inside the frame. (Highest real-world volume — 249 refs in Jobright.)
2. **Ashby** — `ASHBY_SEARCH` custom search-select typeahead + Ashby's field structure.
3. **BambooHR** — `BAMBOOHR_SPECIAL` widget handling.
4. **SuccessFactors** — fixes the two telemetry-confirmed gaps (memory `successfactors-autofill-gaps`): résumé `<div role=button>` upload + `rcmpaginatedselect` EEO dropdowns. Needs DOM snippets (capture live or from telemetry).
5. **Taleo** — legacy multi-step, frame-based, `application.jss` patterns.
6. **Oracle Cloud** (`CandidateExperience`) — SPA, dynamic ids.
7. **SmartRecruiters** — `oneclick-ui`, its select widgets.
8. **Workable** — apply form + its selects.
9. **ADP** (`workforcenow` / `recruiting.adp.com` / `myjobs.adp.com`) — multi-host.
10. **Phenom** — `phenompeople.com` + pageSourceKeyword `APPLY_form_renderer.js`; widget selects.

The remaining ~35 vendors + 22 portals ride the generic pipeline via thin registry adapters; we **verify**, not assume — any that fail live get promoted to hand-tuned.

### 5.4 Apply-entry parity
- Port per-ATS entry url patterns into the registry (`patterns` already encode application URLs for avature/taleo/oraclecloud/etc.).
- `applyEntry.ts` consults `detectSite` → if the current page matches an entry pattern (not yet the form), surface the site's apply button. Keep the existing generic anchored-text tiers as fallback.
- Preserve the user-gated advance decision (memory `flow-user-gated-advance`) — no silent auto-submit, ever.

### 5.5 Panel / UI
- Surface the detected site `label` in the existing panel ("Detected: Workday") so the user has Jobright-equivalent feedback. Minimal change to `overlay.ts` / `pageChrome.ts`.

### 5.6 Generic-pipeline hardening (as needed)
Cross-cutting improvements discovered while adding ATS (fold in only what serves coverage): iframe form-scope discovery, radio-group + date parity, constrained-option validation (already partly present via `formScanner` option guard). Track each as its own plan step.

---

## 6. Testing & verification strategy

- **Unit:** every registry entry asserted in `siteRegistry.test.ts` (host/pattern/path → id). Every hand-tuned adapter gets a fixture DOM test (classify + fill).
- **Regression:** keep the full vitest suite green at every phase boundary (baseline established first).
- **Live-DOM:** for each hard ATS, drive a real posting (browser probe) and confirm fields fill; capture DOM snippets into fixtures.
- **Telemetry:** query Neon prod `autofill_reports` (memory `autofill-telemetry-debugging`) for real per-field failure reasons on the hard ATS before and after — the bar is "telemetry shows the previously-failing fields now fill."
- **No push without:** full suite green + at least the top-5 hard ATS verified live.

---

## 7. Non-ATS gap audit (Jobright features to check for parity)

To be enumerated in Phase 0 by diffing Jobright's `contents`/`background` against ours. Known candidates (many already done — confirm, don't rebuild): apply-button injection on job boards (LinkedIn/Indeed listings), submit tracking → application logging (done: memory `extension-application-tracking`), uninstall URL, account-creation flow (done), résumé auto-attach (done), declarativeNetRequest usage, `cookies`/`tabs` permission uses. Fold in only genuine, high-value gaps.

---

## 8. Decisions taken (user away — no blocking questions)

1. **Keep the existing adapter architecture**; make it registry-driven rather than rewriting. Rationale: it's already at parity and has 526 passing tests — restructuring detection (not the model) is the highest-leverage change.
2. **Data-driven registry over per-site files.** 69 sites as one table; only special-handling ATS get files.
3. **Verify-don't-assume for generic-path ATS.** We don't hand-tune all 69; we hand-tune the ~10 hard ones and promote others only if live/telemetry shows failure.
4. **Company portals included** (adobe, amazon, …) for full parity, as thin/pattern adapters — low cost once the registry exists.
5. **Ship gate = tests green + top-5 hard ATS verified live.** Push to origin only after that (prod backend already has the ground-truth fill changes from `1559b27`).

---

## 9. Phasing (feeds writing-plans)

- **Phase 0** — Green baseline; non-ATS gap audit (§7).
- **Phase 1** — `siteRegistry.ts` + match-pattern engine + full 69-entry port + tests. Rewire `common.ts` and hand-tuned `match()` to it. Panel shows label.
- **Phase 2** — Apply-entry parity from registry patterns.
- **Phase 3** — Hard-ATS adapters, in priority order (§5.3), each with fixtures + live verify. Parallelizable across subagents (one ATS per agent, Opus).
- **Phase 4** — Generic-pipeline hardening from Phase-3 findings; full regression; live top-5; telemetry check.
- **Phase 5** — Non-ATS gaps; final review; ship gate.

Parallelism: Phase 3 ATS adapters are independent (disjoint hosts, isolated files) → dispatch as parallel Opus subagents once Phase 1's registry is the stable interface.
