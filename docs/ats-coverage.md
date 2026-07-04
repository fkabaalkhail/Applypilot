# ATS Coverage Tracker

Track which ATS systems have been tested and confirmed working with the Tailrd extension.

**Progress:** Full Jobright 1.15.0 detection parity — **69 / 69 sites recognized**
(48 reusable-ATS *vendor* fill adapters + 21 company *portals* recognized via the
path-gated site registry). See `2026-07-04` parity work below.

Detection is driven by `src/content/siteRegistry.ts` — a verbatim, order-preserved
port of Jobright's `SITE_REGISTRY` (domains / match-patterns / pathRegex / iframe /
pageSource), reviewed for exact fidelity. Greenhouse, Workday and Lever keep
hand-tuned modules; the reusable vendors are declared in the data-driven table
`adapters/common.ts`; single-employer portals (google, tesla, adobe…) are matched
only by the path-gated `detectSite` (a bare host match would be too broad).
Adapters are advisory: an unmatched host or a declined hook falls back to
byte-identical generic behavior.

> Reference data: `docs/superpowers/reference/jobright-site-registry.json` (the 69
> extracted entries) and `…/jobright-SITE_REGISTRY.verbatim.js`.

- `[x]` = generic pipeline tested + confirmed working.
- **adapter** column = a registered `SiteAdapter` refines detection/classification.

---

## Easy

- [x] **Greenhouse** *(Greenhouse Software)*
  Standard HTML inputs with predictable field names. Well-labeled fields, rarely dynamic. A good baseline to test against. Widely used by mid-size tech companies.

- [x] **Lever** *(Lever Inc.)*
  Simple React-based forms with consistent field structure. Standard input/textarea elements, minimal shadow DOM. Cover letter is usually a plain textarea. Common in startups.

- [x] **BambooHR** *(BambooHR LLC)*
  Simple, clean forms with standard HTML. Short application forms, minimal AI fill needed. Used mostly by small-to-mid size companies. Easy win.

- [x] **Breezy HR** *(Breezy HR Inc.)*
  Clean HTML forms with good labeling. Short application forms are the norm. One of the easiest ATSs to support reliably. Popular with small businesses.

---

## Medium

- [x] **Ashby** *(Ashby HQ)*
  Modern React SPA that rebuilds the DOM constantly as the user progresses through form steps. MutationObserver and reconciler are especially important here. Custom dropdowns are common. Growing fast among tech companies.

- [x] **Workable** *(Workable Technology)*
  Standard form structure but uses custom dropdowns for things like country/location. Multi-step forms are common. Watch for dynamic field injection. Widely used by SMBs and European companies.

- [x] **SmartRecruiters** *(SmartRecruiters Inc.)*
  Multi-step React-based forms. Custom question sections are very common, making the AI fill phase important. Used by large global companies like Visa and Bosch.

- [x] **Jobvite** *(Jobvite Inc.)*
  React-based frontend with some non-standard field patterns, especially for EEO questions. Multi-step forms are the norm. Watch for custom radio group implementations.

- [x] **Rippling** *(Rippling Inc.)*
  Modern React SPA with dynamic form rendering. Field labels are generally clean and consistent. Growing fast — many startups and mid-size tech companies now use it.

- [x] **Bullhorn** *(Bullhorn Inc.)*
  Primarily used by staffing and recruiting agencies. Forms tend to be simpler but candidates are applying to agencies, not specific roles. Field structure is fairly standard.

---

## Hard

- [x] **Workday** *(Workday Inc.)*
  Most widely used enterprise ATS. Renders fields as custom web components inside shadow DOM — standard querySelector won't reach them. Aggressively re-renders on SPA navigation. The reconciler was specifically built for this. Very common in Fortune 500 companies.

- [x] **iCIMS** *(iCIMS Inc.)*
  Heavy use of nested iframes — each section of the form often lives in its own iframe. FRAME_TOKEN and iframe coordination logic is critical here. Commonly used by large enterprises and retailers.

- [x] **Taleo** *(Oracle)*
  Legacy Oracle product built on old Java-based web tech. Expect unusual form structures, non-standard inputs, and iframe-heavy layouts. Very common in government, healthcare, and large enterprises. Notoriously painful to autofill.

- [x] **ADP Recruiting Management** *(ADP Inc.)*
  Legacy tech, iframes, and inconsistent field naming. ADP's frontend varies between clients. Common in large US corporations, especially in finance and manufacturing.

- [x] **SAP SuccessFactors** *(SAP SE)*
  Complex multi-step forms built on SAP's own UI framework — not standard HTML. Heavy shadow DOM usage and custom components throughout. One of the hardest ATSs to reliably autofill. Common in European multinationals.

---

*Check off each system by replacing `[ ]` with `[x]` once tested and confirmed working.*

---

## Extended coverage (Jobright-parity adapters)

Registered via `adapters/common.ts` — recognized ATS beyond the 15 tracked above.
Detection + social-URL / name-attribute classification are wired; deeper per-site
fill operations can be layered onto any of them through the same adapter seams.

- [x] **Oracle Cloud Recruiting** — `*.oraclecloud.com`
- [x] **Dayforce (Ceridian)** — `*.dayforcehcm.com`, `*.dayforce.com`
- [x] **UKG / UltiPro** — `*.ultipro.com`, `*.ukg.com`
- [x] **JazzHR** — `*.applytojob.com`, `*.jazz.co` (namespaced `job_application[...]` fields)
- [x] **Paylocity** — `*.paylocity.com`
- [x] **Avature** — `*.avature.net`
- [x] **Phenom People** — `*.phenompeople.com`
- [x] **Teamtailor** — `*.teamtailor.com` (namespaced `candidate[...]` fields)
- [x] **Recruitee** — `*.recruitee.com`
- [x] **Personio** — `*.personio.{de,com,es,nl,fr}`
- [x] **Eightfold** — `*.eightfold.ai`
- [x] **ClearCompany** — `*.clearcompany.com`
- [x] **Paycom** — `*.paycomonline.net`
- [x] **BrassRing / Kenexa** — `*.brassring.com`, `*.kenexa.com`

**Adapter surface (per `adapters/types.ts`):** `match` (host), `classify` (correct a
field's category), `resolveAnswer` (site-specific value), `fillOperation` (own a
tricky widget), `advanceButton` (exact multi-step Next selector). Adding a new ATS
is a one-line entry in `COMMON_ATS`; deepening one is a hook on its object.

---

## Full Jobright parity — newly added vendors (2026-07-04)

Beyond the tracked set above, the site registry now recognizes every remaining
Jobright vendor and portal. New reusable-ATS **vendor** adapters (thin host match +
generic pipeline + panel label): Kula, Dover, Zoho Recruit, Gem, HiringThing, CATS
(catsone), RippleHire, CareersPage, CareerPlug, isolved, JobDiva, GoHire, Trakstar,
Freshteam, Pinpoint, TriNet Hire, JobScore, Comeet, Polymer, Recruiterflow.

**Company portals** (single employer; recognized via path-gated `detectSite`, not a
fill adapter): Adobe, Amazon, Amazon University, Apple, ByteDance, Cisco, Google,
Gusto, HubSpot, Intuit, Jacobs, Meta, Okta, Tesla, TikTok, Uber, Walmart,
Y Combinator, Waymo, Toast, X (Alphabet).

## Fill-quality status (grounded in production `autofill_reports`)

Telemetry-measured fill rates and the concrete failure modes (2026-07-04):

| ATS | fill % | Top failure(s) | Status |
|---|---|---|---|
| Lever | 96.7% | — | good |
| Greenhouse | 93.2% | scattered | good |
| Workday | 78.9% | "Field no longer found" re-render race; Country-Phone-Code / Phone-Device-Type / How-Did-You-Hear dropdowns | **partial — see below** |
| SuccessFactors | 72.0% | EEO paginated dropdowns (gender/race/veteran, `rcmpaginatedselect`); custom question dropdowns (Conflict of Interest, Citizenship); marketing checkboxes | **partial — see below** |

**Fixed 2026-07-04 — single-checkbox intent** (`checkboxIntent.ts`): the
cross-cutting "Ambiguous checkbox value" failures on SF **and** Workday (e.g.
"I have a preferred name" → the name, "Hear more about career opportunities" → an
email, "I agree to the above" → non-bool). A single checkbox is now resolved as
boolean intent — check clear application consent, never opt into marketing, skip
misclassified/ambiguous boxes (→ not counted as failures). Fixes the checkbox rows
of both SF and Workday failures.

### Remaining fill work (needs live ATS DOM to fix safely — not guessed)

These are known-hard, widget-specific, and behind an authenticated application
step, so they require live capture to fix without regressing high-traffic ATS:

1. **Workday dropdowns** — Country Phone Code / Phone Device Type / How Did You
   Hear About Us are Workday `data-automation-id` button+listbox widgets not yet
   driven. Note: "Country Phone Code" is *misclassified* as `country` (regex order
   in `workday.ts` AUTOMATION_RULES matches `country` before a phone-code rule).
2. **Workday "Field no longer found"** — a re-render staleness race on some tenants
   (bmo.wd3); needs settle/retry hardening verified against live DOM.
3. **SuccessFactors EEO paginated dropdowns** (`rcmpaginatedselect`) + custom
   question dropdowns + résumé `<div role="button">` upload target. Needs an SF
   adapter built from captured DOM.
4. **BambooHR / Ashby** deep specials — Jobright ships `BAMBOOHR_SPECIAL` and
   `ASHBY_SEARCH` (custom typeahead). No telemetry failures yet; generic pipeline
   covers the baseline. Hand-tune from live DOM when data warrants.

## Non-ATS parity audit vs Jobright 1.15.0 (2026-07-04)

Diffed Jobright's background service worker + manifest against ours. **No genuine
gaps.** Equivalents already present:

| Jobright feature | Tailrd | Notes |
|---|---|---|
| `setUninstallURL` | ✅ `serviceWorker.ts` | uninstall feedback w/ UTM |
| `runtime.onMessageExternal` | ✅ | apply-intent from web app (`applyIntent.ts`) |
| submit → application logging | ✅ | `submitTracker.ts` + `POST /apply/log` |
| `action.onClicked` panel open | ✅ | injects content script on demand |
| `onInstalled`, sync alarm | ✅ | |
| DNR header-strip (X-Frame-Options/CSP) for lever/ashby | ⛔ **intentional** | only needed to *embed* ATS forms in Jobright's own tab; Tailrd injects a side-panel overlay **into** the real ATS page — more robust, no header manipulation |
| `cookies.getAll` auth sync | ⛔ **intentional** | Tailrd uses PKCE + `identity`, not cookie scraping |
