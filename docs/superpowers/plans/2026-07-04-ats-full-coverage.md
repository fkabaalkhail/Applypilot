# Full ATS Coverage / Jobright Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Tailrd Chrome extension to Jobright 1.15.0 parity: recognize all 69 sites Jobright recognizes with the same precision signals, fill the hard ATS with hand-tuned handlers, and match its apply-entry flow — verified by tests + live DOM.

**Architecture:** Keep the existing `SiteAdapter` model (adapters layer optional overrides on a generic pipeline). Introduce one data-driven `siteRegistry.ts` (a typed port of Jobright's `SITE_REGISTRY`) as the single detection source of truth; rewire `common.ts` and the hand-tuned adapters' `match()` to it; add hand-tuned adapters only for the ATS that need special DOM handling.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom (unit), Playwright (browser probes), Chrome MV3 content scripts. Backend: FastAPI + Neon Postgres (telemetry).

## Global Constraints

- Run tests with `node node_modules/vitest/vitest.mjs run --root chrome-extension` (from repo root) — **not** `npm test` (known stdio quirk; exits 1 with no output). Single file: append `<path>`; watch off.
- Baseline is **548 tests / 71 files green** (established 2026-07-04). Every task ends green.
- Host regexes stay anchored `(^|\.)host$` — look-alikes (`notgreenhouse.io.evil.com`) must never match.
- Never auto-submit. Apply/Submit buttons are terminal; the flow parks per page (user-gated advance — see memory `flow-user-gated-advance`).
- Adapters are advisory: every hook falls back to generic on undefined/throw. A broken adapter can only refine, never break, the pipeline.
- Injection stays `<all_urls>` + `all_frames:true` with captcha excludes. Do not narrow it.
- Reference data (authoritative port source): `docs/superpowers/reference/jobright-site-registry.json` (69 entries) and `…/jobright-SITE_REGISTRY.verbatim.js`. **Escaping caveat:** `pathRegex`/pattern backslashes in the JSON are double-escaped through JSON; when building `RegExp`, normalize `\\\\` → `\\`. Every pathRegex gets a positive+negative match test to catch escaping errors.
- Commit after each task with a conventional message ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**New**
- `chrome-extension/src/content/siteRegistry.ts` — typed `SITE_REGISTRY: SiteEntry[]` + `detectSite()` + `matchPattern()`. Single detection source of truth.
- `chrome-extension/test/siteRegistry.test.ts` — per-entry detection assertions; pattern-engine tests.
- `chrome-extension/src/content/adapters/{icims,ashby,bamboohr,taleo,successfactors,oracleCloud,smartrecruiters,workable,adp,phenom}.ts` — hand-tuned adapters (Phase 3).
- `chrome-extension/test/adapters/<ats>.test.ts` — one per hand-tuned adapter, fixture-driven.
- `chrome-extension/test/fixtures/<ats>/…` — captured real-DOM HTML fragments.

**Modified**
- `adapters/common.ts` — stop hand-listing hosts; generate thin adapters from `SITE_REGISTRY` (entries without a hand-tuned module).
- `adapters/{greenhouse,workday,lever}.ts` — source their host predicate from `detectSite`.
- `adapters/types.ts` — add optional `label`/`site` on `SiteAdapter`; thread resolved `SiteEntry`.
- `applyEntry.ts` — consult registry patterns for apply-entry detection.
- `driverDetect.ts` — Workday host test reuses registry.
- `overlay.ts` / `pageChrome.ts` — surface detected site `label`.

---

## Phase 0 — Baseline & non-ATS gap audit

### Task 0.1: Confirm green baseline
- [ ] **Step 1:** Run `node node_modules/vitest/vitest.mjs run --root chrome-extension`. Expected: `548 passed (548)`, exit 0. (Already confirmed 2026-07-04; re-confirm on the branch.)
- [ ] **Step 2:** Run `tsc --noEmit` in `chrome-extension`. Expected: no errors.

### Task 0.2: Non-ATS gap audit (documentation deliverable)
- [ ] **Step 1:** Diff Jobright capabilities vs ours. Grep `1.15.0_0/static/background/index.js` and `contents.04ff201a.js` for: `chrome.declarativeNetRequest`, `setUninstallURL`, `chrome.cookies`, `chrome.tabs.create`, apply-button injection on `linkedin.com`/`indeed.com` job listings, submit tracking. For each, confirm whether we have an equivalent (cross-check memory: `extension-application-tracking`, `multipage-apply-account-flow`, account flow done).
- [ ] **Step 2:** Write findings to `docs/ats-coverage.md` under a new "Non-ATS parity" section: table of {Jobright feature, have?, action}. Only genuine high-value gaps become Phase 5 tasks.
- [ ] **Step 3:** Commit `docs(extension): non-ATS parity audit`.

---

## Phase 1 — Data-driven site registry (foundation)

### Task 1.1: Match-pattern engine
**Files:** Create `chrome-extension/src/content/siteRegistry.ts`; Test `chrome-extension/test/siteRegistry.test.ts`.

**Interfaces:**
- Produces: `matchPattern(pattern: string, url: string): boolean` — Chrome match-pattern semantics (`*://*.host/path*`).

- [ ] **Step 1: Write failing tests**
```ts
import { describe, it, expect } from "vitest";
import { matchPattern } from "../src/content/siteRegistry";

describe("matchPattern", () => {
  it("matches scheme wildcard + subdomain wildcard", () => {
    expect(matchPattern("*://*.avature.net/*/ApplicationForm*",
      "https://careers.avature.net/x/ApplicationForm?y")).toBe(true);
    expect(matchPattern("*://*.avature.net/*/ApplicationForm*",
      "https://avature.net/foo/ApplicationForm")).toBe(true); // *. also matches apex
  });
  it("respects path anchoring", () => {
    expect(matchPattern("*://jobs.lever.co/*/*",
      "https://jobs.lever.co/acme/1234")).toBe(true);
    expect(matchPattern("*://jobs.lever.co/*/*",
      "https://jobs.lever.co/acme")).toBe(false);
  });
  it("rejects wrong host", () => {
    expect(matchPattern("*://*.avature.net/*",
      "https://evil.com/avature.net")).toBe(false);
  });
});
```
- [ ] **Step 2: Run — expect FAIL** (`matchPattern is not a function`).
- [ ] **Step 3: Implement**
```ts
/** Chrome match-pattern → RegExp. `*` scheme = http/https; `*.` host also
 *  matches the apex; path `*` matches any run of chars. */
export function matchPatternToRegex(pattern: string): RegExp {
  const m = /^(\*|https?|file):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)?$/.exec(pattern);
  if (!m) return /$^/; // never matches
  const [, scheme, host = "*", path = "/*"] = m;
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const schemeRe = scheme === "*" ? "https?" : scheme;
  let hostRe: string;
  if (host === "*") hostRe = "[^/]+";
  else if (host.startsWith("*.")) hostRe = "(?:[^/]+\\.)?" + esc(host.slice(2));
  else hostRe = esc(host);
  const pathRe = esc(path).replace(/\\\*/g, ".*");
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, "i");
}
export function matchPattern(pattern: string, url: string): boolean {
  try { return matchPatternToRegex(pattern).test(url); } catch { return false; }
}
```
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(extension): match-pattern engine for site registry`.

### Task 1.2: `SiteEntry` type + `detectSite`
**Interfaces:**
- Produces:
  - `interface SiteEntry { id; label; tier: "vendor"|"portal"; domains?; patterns?; pathRegex?: RegExp; iframeDomains?; iframeOnly?; pageSourceKeyword?; pageSourceDomain? }`
  - `detectSite(host: string, url: string, opts?: { inIframe?: boolean; pageSource?: string }): SiteEntry | null`
- Consumes: `matchPattern` (Task 1.1).

- [ ] **Step 1: Write failing tests** (use 3 representative entries inline; full table in Task 1.3)
```ts
import { detectSite, SITE_REGISTRY } from "../src/content/siteRegistry";
describe("detectSite", () => {
  it("domain match (successfactors)", () => {
    expect(detectSite("career4.successfactors.com", "https://career4.successfactors.com/career?x")?.id).toBe("successfactors");
  });
  it("iframeOnly icims only inside frame + pathRegex gate", () => {
    expect(detectSite("careers-acme.icims.com", "https://careers-acme.icims.com/jobs/12345/x", { inIframe: true })?.id).toBe("icims");
    expect(detectSite("careers-acme.icims.com", "https://careers-acme.icims.com/jobs/12345/job", { inIframe: true })).toBeNull(); // negative pathRegex
    expect(detectSite("careers-acme.icims.com", "https://careers-acme.icims.com/jobs/12345/x", { inIframe: false })).toBeNull(); // iframeOnly
  });
  it("pattern match (avature ApplicationForm)", () => {
    expect(detectSite("careers.avature.net", "https://careers.avature.net/x/ApplicationForm")?.id).toBe("avature");
  });
  it("anchored domain rejects look-alike", () => {
    expect(detectSite("notgreenhouse.io.evil.com", "https://notgreenhouse.io.evil.com/")).toBeNull();
  });
});
```
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `detectSite`** (SITE_REGISTRY stub of the 3 test entries for now; Task 1.3 fills the rest)
```ts
function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase(), d = domain.toLowerCase();
  return h === d || h.endsWith("." + d);
}
export function detectSite(host: string, url: string,
  opts: { inIframe?: boolean; pageSource?: string } = {}): SiteEntry | null {
  let path = "/";
  try { path = new URL(url).pathname; } catch { /* keep default */ }
  for (const e of SITE_REGISTRY) {
    if (e.iframeOnly && !opts.inIframe) continue;
    const byDomain = e.domains?.some((d) => hostMatches(host, d)) ?? false;
    const byPattern = e.patterns?.some((p) => matchPattern(p, url)) ?? false;
    const byFrame = opts.inIframe && (e.iframeDomains?.some((d) => hostMatches(host, d)) ?? false);
    const bySource = e.pageSourceKeyword && opts.pageSource
      ? opts.pageSource.includes(e.pageSourceKeyword) : false;
    if (!(byDomain || byPattern || byFrame || bySource)) continue;
    if (e.pathRegex && !e.pathRegex.test(path)) continue;
    return e;
  }
  return null;
}
```
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(extension): detectSite over typed SiteEntry registry`.

### Task 1.3: Port all 69 entries
**Files:** Modify `siteRegistry.ts` (fill `SITE_REGISTRY`); Modify `test/siteRegistry.test.ts`.

- [ ] **Step 1:** Transform `docs/superpowers/reference/jobright-site-registry.json` into `SITE_REGISTRY: SiteEntry[]`, **preserving Jobright's order** (greenhouse first). For each entry: copy `domains`/`patterns`/`iframeDomains`/`iframeOnly`/`pageSourceKeyword`/`pageSourceDomain`; convert `pathRegex` string → `new RegExp(raw.replace(/\\\\\\\\/g,"\\\\"))`; add `label` (human name) and `tier`. **Portals** (`tier:"portal"`): adobe, amazon, amazonuniversity, apple, bytedance, cisco, google, gusto, hubspot, intuit, jacobs, metacareers, okta, tesla, tiktok, uber, walmart, ycombinator, careerswithwaymo, careerstoasttab, xcompany. All others `tier:"vendor"`.
- [ ] **Step 2:** Add a data-integrity test:
```ts
it("registry has all 69 ids, unique, each with a matcher", () => {
  expect(SITE_REGISTRY.length).toBe(69);
  const ids = SITE_REGISTRY.map(e => e.id);
  expect(new Set(ids).size).toBe(69);
  for (const e of SITE_REGISTRY)
    expect(Boolean(e.domains || e.patterns || e.iframeDomains || e.pageSourceKeyword)).toBe(true);
});
```
- [ ] **Step 3:** Add positive+negative pathRegex tests for each entry that has one (29 entries). Table of {id, urlThatMatches, urlThatDoesnt} — derive from the reference patterns.
- [ ] **Step 4: Run — expect PASS** (all new + 548 prior).
- [ ] **Step 5: Commit** `feat(extension): port all 69 Jobright site-registry entries`.

### Task 1.4: Rewire `common.ts` to the registry
**Files:** Modify `adapters/common.ts`, `adapters/types.ts`.

- [ ] **Step 1:** Add `label?: string` and `site?: SiteEntry` to `SiteAdapter` (types.ts).
- [ ] **Step 2:** Replace the hardcoded `COMMON_ATS` host list with generation from `SITE_REGISTRY`: for every entry whose `id` is **not** in the hand-tuned set `{greenhouse, workday, lever, icims, ashby, bamboohr, taleo, successfactors, oraclecloud, smartrecruiters, workable, adp, phenom}`, build a thin adapter: `match: (host,url) => detectSite(host,url,{inIframe: self!==top}) === entry`, carrying `label`, plus the existing attribute classify rules (keep NAME_ATTR_RULES for teamtailor/recruitee/jazzhr; SOCIAL_URL_RULES for all).
- [ ] **Step 2b:** Preserve existing per-adapter classify behavior. Existing `common.test.ts` (if any) must still pass; adjust expectations only where a host now resolves via registry identically.
- [ ] **Step 3: Run — expect PASS.** Fix any test that asserted the old host-only match.
- [ ] **Step 4: Commit** `refactor(extension): generate thin ATS adapters from site registry`.

### Task 1.5: Hand-tuned adapters source detection from registry
**Files:** Modify `adapters/greenhouse.ts`, `workday.ts`, `lever.ts`, `driverDetect.ts`.

- [ ] **Step 1:** In each, replace the local host regex in `match()` with `detectSite(host,url,{inIframe:self!==top})?.id === "<id>"` (keep any extra url gating the module already does). Keep all fill/classify logic unchanged.
- [ ] **Step 2:** `driverDetect.ts`: replace `WORKDAY_HOST` with `detectSite(...).id==="workday"` check (or keep regex but add a test asserting they agree).
- [ ] **Step 3: Run — expect PASS** (greenhouse/workday/lever adapter tests unchanged).
- [ ] **Step 4: Commit** `refactor(extension): hand-tuned adapters detect via site registry`.

### Task 1.6: Surface detected site in the panel
**Files:** Modify `overlay.ts` / `pageChrome.ts` (whichever renders the panel header — confirm by reading), add a small test if the panel has one.

- [ ] **Step 1:** When an adapter/site resolves, render its `label` in the panel ("Detected: Workday"). When none resolves but fields are found, show "Generic form". Read `overlay.ts` for the existing header slot; add minimal DOM.
- [ ] **Step 2:** Manual/preview check via `npm run preview` (panel-preview.mjs) — confirm label renders.
- [ ] **Step 3: Commit** `feat(extension): show detected ATS label in panel`.

---

## Phase 2 — Apply-entry parity

### Task 2.1: Registry-driven apply-entry detection
**Files:** Modify `applyEntry.ts`; Test `test/applyEntry.test.ts`.

**Interfaces:** Consumes `detectSite`. The registry `patterns` already encode application URLs (avature `ApplicationForm`, taleo `application.jss`, oraclecloud `CandidateExperience`).

- [ ] **Step 1: Write failing test** — on a posting page matching a site's *job-detail* pattern but before the form, `findApplyEntry` still finds the generic Apply; on a page already matching an *application* pattern, entry detection defers (we're in the form).
```ts
it("does not surface entry once on an application URL", () => {
  // avature ApplicationForm URL → detectSite says we're in the form → no entry click
  // set location via jsdom; assert findApplyEntry returns null when the page has fields
});
```
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — extend `findApplyEntry` to skip entry surfacing when `detectSite` indicates the current URL is already an application step (pattern id endsWith ApplicationForm/apply/etc.). Keep generic tiers as the primary path. Keep the "no click on terminal Submit" guarantee.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(extension): registry-aware apply-entry detection`.

---

## Phase 3 — Hard-ATS hand-tuned adapters (parallelizable)

**Dispatch note:** Once Phase 1 is merged (registry is the stable interface), these are independent (disjoint hosts, isolated files) → dispatch as **parallel Opus subagents**, one ATS per agent. Each agent follows the same procedure below.

**Per-ATS procedure (the repeatable task template):**
1. **Capture DOM.** Drive a real live posting for the ATS with a Playwright probe (`chrome-extension/test/browser/`), or pull a real failing URL + field reasons from Neon prod `autofill_reports` (memory `autofill-telemetry-debugging`). Save the application-form HTML fragment to `test/fixtures/<ats>/form.html`.
2. **Write the failing fixture test** (`test/adapters/<ats>.test.ts`): load the fixture into jsdom, run the generic pipeline, assert the *specific* fields that fail (the gap). This test encodes the exact defect.
3. **Implement the adapter** (`adapters/<ats>.ts`): host predicate via `detectSite`, plus only the hooks needed — `classify` / `resolveAnswer` / `fillOperation` / `advanceButton` / `entryButton`. Register in `adapters/index.ts`.
4. **Run — fixture test passes; full suite green.**
5. **Live-verify**: re-drive the real posting; confirm the previously-failing fields now fill. Capture before/after.
6. **Commit** `feat(extension): <ats> adapter`.

**Per-ATS specifics (known from Jobright + telemetry):**

### Task 3.1: iCIMS  *(highest volume)*
- Detection: `icims.com`, **iframe-only** — the application form is in an `icims.com` iframe; content script already runs in-frame (all_frames). `pathRegex ^/jobs/\d+(?!.*/job$)`.
- Special handling: operate inside the iframe scope; iCIMS field structure (labelled `<div>`/custom selects). Confirm résumé upload + native/custom dropdowns. Entry: the "Apply" that reveals the iframe form.

### Task 3.2: Ashby
- Detection: `*.ashbyhq.com/*/*`; iframe (`jobs.ashbyhq.com`, embed marker `ashby_jid`); `pathRegex` = `/{org}/{uuid}`.
- Special: `ASHBY_SEARCH` custom search-select typeahead (type → wait for option list → pick). Model on the existing `comboboxEngine.ts`; add Ashby-specific option/menu selectors.

### Task 3.3: BambooHR
- Detection: `*.bamboohr.com/jobs*` / `/careers*`; iframe (`bamboohr.com`); `pathRegex ^/(?:jobs|careers/[\w-]*\d)`.
- Special: `BAMBOOHR_SPECIAL` — BambooHR's custom dropdown/file widgets. Capture live; implement the specific widget fill.

### Task 3.4: SuccessFactors  *(telemetry-confirmed gaps — memory `successfactors-autofill-gaps`)*
- Detection: `successfactors.eu`/`.com`, `sapsf.com`.
- Fix two confirmed failures: résumé `<div role="button">` upload not detected; `rcmpaginatedselect` EEO dropdowns fail. Add `fillOperation` for the paginated select + résumé-div click→file path.

### Task 3.5: Taleo
- Detection patterns: `*.taleo.net/*/application.jss*`, `/flow.jsf*`, `/jobapply*`, `/ats/careers/*`. Legacy, frame-heavy, multi-step. Implement advance selectors + its select/radio quirks.

### Task 3.6: Oracle Cloud
- Detection patterns: `*.oraclecloud.com/*/CandidateExperience/*/sites/*/job/*` + `/apply`; `pathRegex` gates apply. SPA with dynamic ids → classify by stable data-attrs; advance button selectors.

### Task 3.7: SmartRecruiters
- Detection: `smartr.me` + `jobs.smartrecruiters.com/oneclick-ui/company/*`. Its select widgets + file upload.

### Task 3.8: Workable
- Detection: `workable.com`, `apply.workable.com`, plus employer domains (`careers.arbor-education.com`); iframe. Its react selects.

### Task 3.9: ADP
- Detection patterns: `workforcenow.adp.com`, `recruiting.adp.com/srccar/public/*`, `myjobs.adp.com/*/cx/*` — multi-host. Its multi-step form + selects.

### Task 3.10: Phenom
- Detection: `phenompeople.com` **and** employer domains via `pageSourceKeyword:"APPLY_form_renderer.js"` (+ `pageSourceDomain phenompeople.com`). Requires page-source detection wired in the content script (pass `document.documentElement.outerHTML` slice or script srcs to `detectSite`). Its widget selects + apply flow.

---

## Phase 4 — Generic-pipeline hardening & full verification

### Task 4.1: Fold in cross-cutting fixes
- [ ] From Phase-3 findings, promote any repeated fix (iframe form-scope discovery, date/radio-group parity, constrained-option validation) into the generic pipeline with its own fixture test. One commit per fix.

### Task 4.2: Full regression + live top-5
- [ ] **Step 1:** Full suite green.
- [ ] **Step 2:** Live-drive top-5 by volume (iCIMS, Workday, Greenhouse, Taleo, Oracle Cloud) end-to-end; capture evidence.
- [ ] **Step 3:** Telemetry check: query Neon `autofill_reports` for the hard ATS; confirm previously-failing fields now fill. Record in `docs/ats-coverage.md`.
- [ ] **Step 4:** `tsc --noEmit` clean; `node build.mjs` builds.

---

## Phase 5 — Non-ATS gaps & ship gate

### Task 5.1: Implement approved non-ATS gaps
- [ ] Each gap from Task 0.2 that survived triage → its own TDD task (test, implement, verify, commit).

### Task 5.2: Ship gate
- [ ] Full suite green + `tsc` clean + build ok + top-5 hard ATS verified live + telemetry improved.
- [ ] Update memory (`ats-coverage-workflow`, add `ats-full-coverage-registry`). Summarize for the user; **do not push** until the user confirms (per repo rule — commit locally on `feat/ats-full-coverage`).

---

## Self-Review

**Spec coverage:** §5.1 registry → T1.1–1.3. §5.2 registry-driven adapters → T1.4–1.5. §5.3 hard adapters → T3.1–3.10. §5.4 apply-entry → T2.1. §5.5 panel → T1.6. §5.6 generic hardening → T4.1. §6 verification → T3.x step 5, T4.2. §7 non-ATS → T0.2, T5.1. §8 decisions honored (registry-driven, verify-don't-assume). §9 phasing = Phases 0–5. **No gaps.**

**Placeholder scan:** Phase-3 selectors are intentionally captured-from-live, not hand-waved — each task states the exact detection facts + which hook + the fixture-encodes-the-defect method. Not placeholders.

**Type consistency:** `SiteEntry`, `detectSite(host,url,opts)`, `matchPattern(pattern,url)`, `SiteAdapter.label/site` used consistently across tasks. `detectSite` signature identical in T1.2/1.4/1.5/2.1/3.10.
