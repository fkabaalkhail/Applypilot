# Overnight run: deterministic autofill (2026-10-03)

Branch: `night/deterministic-autofill` (local only, NOT pushed, NOT deployed).
Scope: `chrome-extension/` only. AI is out of credits, so every number below is
measured with the backend's AI pass returning nothing.

> Status: IN PROGRESS. This file is updated as work lands; sections marked
> TODO are not done yet.

## 1. Testing infrastructure

**What worked (no fallback needed):** real Chromium + the real extension.
Playwright 1.61.1 and Chromium 1228 were already installed. This is Windows, so
there is no xvfb: Chromium runs HEADFUL natively (a window opens), with
`--load-extension=dist --disable-extensions-except=dist`. Nothing failed to
install. (`HEADLESS=1` switches to `--headless=new`, which also loads
extensions.)

New harness, `chrome-extension/test/e2e/`:

| File | What it does |
|---|---|
| `fakeApi.mjs` | Local stand-in for the Tailrd backend. The extension is pointed at it through its own settings, so the shipped bundle is untouched. Serves the profile sync, answers `/api/fill` the way a credit-less AI does (no answers, `ai_error`), turns diagnostic capture ON and records every telemetry report. |
| `harness.mjs` | Launches Chromium with `dist/`, seeds config/auth, serves pages at their REAL ATS URLs by route interception (so site adapters match), presses the panel's own Autofill button, follows the flow's progress beats until it parks, then dumps the page. |
| `dumpFields.mjs` | Reads EVERY field's final value and type from the page DOM (open shadow roots, every frame). This is the ground truth, independent of what the extension believes it wrote. |
| `evaluate.mjs` | Scores a case: expected values per field, PLUS every field that changed without an expectation is an UNEXPECTED write (the wrong-kind / invented-answer check). Framework pages also assert the framework's own model state. |
| `run.mjs` | `node build.mjs && node test/e2e/run.mjs [--filter x] [--report-only]`: per-case and per-ATS report, JSON in `test/e2e/results/` (gitignored). |
| `capture.mjs` | Captured the real application pages (below) from jobs in the app. |

Safety: in live mode only reads leave the browser. GET/HEAD/OPTIONS go out,
plus GraphQL POSTs whose operation is a `query` (Ashby renders from those).
Every other request is aborted (submits, uploads, mutations, autosave,
analytics beacons). No form was submitted, nothing uploaded, no account created.

Test corpora:
- **Live real pages** (`cases/real-live.mjs`): 15 application forms from active jobs
  in prod `scraped_jobs` (Greenhouse ×3, Lever ×3, Ashby ×2, Workable ×2,
  SmartRecruiters ×2, BambooHR ×2, Jobvite ×1), with a realistic sparse profile
  (one location string, "Canadian citizen", co-op in progress).
- **Captured real pages** (`test/fixtures/real/`): rendered DOM of those pages, for
  the jsdom regression suite (`test/realPages.test.ts`), 1.9 MB after trimming CSS.
- **Framework pages** (`cases/frameworks.mjs`): React 18 controlled inputs (incl. a
  phone mask and a re-render on every blur), Vue 3 `v-model` (`.lazy`, `.trim`,
  `.number`, name-less radios), AngularJS 1.8 `ng-model` (`updateOn: 'blur'`,
  `ng-options`). Asserts the value registered in the FRAMEWORK STATE, not just the
  DOM. Libraries vendored in `test/e2e/vendor/` (MIT).
- **Synthetic ATS fixtures** (`cases/synthetic.mjs`): the repo's 16 jsdom fixture
  builders, bundled and served on each ATS's real host. This is the only coverage
  for Workday, iCIMS, Taleo and SuccessFactors (see section 5).

The pre-existing in-page harness (`npm run test:browser`) still runs; it had 8 of
19 scenarios failing on clean `main` (stale expectations, see section 2).

## 2. Bugs found and fixed (each with its regression test)

Every item was reproduced first (test failing, or a wrong value on a live page),
then fixed. "Live" = observed with the real extension on a real ATS page tonight.

| # | Bug | Where seen | Regression test |
|---|---|---|---|
| 1 | **Work authorization was country-blind**: "Authorized to work in Canada" (or "Canadian citizen") answered "Are you legally authorized to work in the **United States**?" **Yes**. Same for sponsorship. | Live: Greenhouse ×2, Workable | `questionResolver.test.ts` "work authorization, country-aware"; `realPages.test.ts` Greenhouse/Ashby/Workable; `workday.test.ts` "this country" |
| 2 | Abstained legal questions still went to the backend, whose rule pass answers "authorized to work?" Yes and "sponsorship?" No **unconditionally**. They now never leave the device. | Code read (`backend/routers/fill.py` `_raw_rule_based_answer`) | `realPages.test.ts` (`deviceAbstained`) |
| 3 | **Ashby radio questions took the PREVIOUS question's label** (`<fieldset><label for=…>` with no `<legend>`): "Do you think AI will take over the world?" was read as work authorization and answered **Yes**. | Live: Ashby | `realPages.test.ts` Ashby |
| 4 | **Lever radio questions had no label** (question in a sibling `.application-label`): labelled with the input's `name`, never recognized. | Live: Lever | `realPages.test.ts` Lever |
| 5 | City got the whole "Toronto, ON, Canada"; a bare "Address" next to City/Postal got the location string. | Live: BambooHR, Jobvite | `addressFields.test.ts`, `realPages.test.ts` BambooHR/Jobvite |
| 6 | "Do you anticipate challenges clearing a background check?" got the **degree title**; "Where did you complete your undergraduate degree?" got the degree title instead of the school; "If 'Other' selected for School Name…" got the school. | Live: Lever, Greenhouse | `realPages.test.ts`, `questionResolver.test.ts` |
| 7 | "Let the company know about your interest working there" (textarea) got the **employer's name**. | Live: SmartRecruiters | `realPages.test.ts` SmartRecruiters |
| 8 | A Lever commute question ("…the Toronto office located at… Are you able to…") was answered as a residence question (Yes). | Live: Lever | `questionResolver.test.ts` "applicant must be the subject" |
| 9 | Option matching ignored negation: "I am not a protected veteran" tied 100% with "I am a protected veteran" and option ORDER decided. Also: "no" matched inside "not", ties went to the first option, a number on a bucket boundary went to the first bucket, "Over 6 years" was unparsed, a place name could land on a Yes/No option through a shared word. | Old harness tie; unit repro | `optionMatchStrict.test.ts` (14) |
| 10 | **The page observer watched the panel's own shadow root**: every panel repaint caused a rescan, which repainted the panel. A rescan every 500 ms on every page while the panel was open. | Live logs (hundreds of repaints per page) | `observePage.test.ts` |
| 11 | **Lever's location typeahead never stuck** (it clears an entry not picked from its list). Now types the city and clicks Lever's own suggestion, matched as a PLACE ("Toronto, ON, CAN"). | Live: Lever ×3 | `leverAdapter.test.ts` (live suggestion list verbatim) |
| 12 | **Comboboxes inside web components**: IDREFs were resolved with `document.getElementById`, which cannot see into shadow roots. SmartRecruiters' City menu lives in the parent component's shadow root. | Live: SmartRecruiters | `comboboxShadowControls.test.ts` |
| 13 | **Radios with no `name`** (Vue `v-model`, hand-rolled React) were one-option groups that no answer could select. | Vue 3 page | `namelessRadios.test.ts` |
| 14 | A `groupIndex` parsed from an id ("…-labeled-radio-0") disabled question shapes outside employment/education rows. | Ashby jsdom | `realPages.test.ts` Ashby |
| 15 | Experience-row "Start Date" fields were briefly read as availability questions during the work (caught by the existing suite before commit, fixed: availability needs explicit wording). | `experienceFields.test.ts`, `greenhouseLyftScan.test.ts` | existing tests |

Harness bugs found and fixed along the way (not product bugs): clicking Autofill
before an SPA form rendered (silent no-op), waiting out the full timeout when a
fill errored, treating the end of a zero-field entry page as the end of the flow.

## 3. Decisions made on your behalf

1. **Only HIGH-confidence inferences fill.** Medium/low are computed but never
   written. Where the profile does not settle a question (US work authorization for
   a Canadian citizen, "this country" when the job's country is unknown, highest
   education while a degree is in progress), the field stays blank AND is kept
   from the backend. Conservative: blanks are cheap, wrong legal answers are not.
2. **Questions without a country** ("Are you authorized to work in this
   country?") are answered for the JOB's country, read from the posting
   (schema.org JobPosting JSON-LD, then the ATS location line) and carried from
   the posting page to later application steps on the same host. Unknown job
   country → blank.
3. **The applicant's own sponsorship answer** applies to unscoped questions and to
   countries their status covers, never to a country they never mentioned.
4. **A single unindexed School/Degree/Graduation field** now means the PRIMARY
   education (in progress, else most recent graduation), not entry [0]. Test
   updated (`fieldMatcher.test.ts`).
5. **City/Country/Region/Postal are derived from one location or address
   string** ("Toronto, ON, Canada" → Toronto / Ontario / Canada). A bare
   "Toronto" stays MEDIUM (not filled as a country): there is a London, Ontario.
6. **Years of experience** = merged employment spans (overlaps counted once),
   high only when every row has dates. Domain-qualified questions ("software
   development experience") answer only when every job title is in that domain;
   skill-qualified ("experience with Kubernetes") never.
7. **Consent / attestation checkboxes are not ticked** ("I certify the
   information is accurate"). The code's comments intend to tick clear consent,
   but the selection gate has always blocked it; I kept that, because a tick there
   is a legal attestation. Flip it in `shared/selection.ts` if you want Jobright's
   behavior.
8. **Pre-filled fields are never overwritten**, even when the site guessed them
   (Workable fills Address from IP geolocation). Unchanged behavior.
9. Real-page fixtures are committed with CSS/SVG stripped (1.9 MB); the HAR
   recordings (203 MB) stay local and gitignored.
10. Nothing pushed, nothing deployed, no backend changes (the backend's
    unconditional rule answers are listed in section 5 instead).

## 4. Per-ATS pass rates

### Baseline: current `main` build (b9aebcc), before any change

Real extension (`dist/`), live pages, SPARSE_CANADIAN profile, AI dead.
"checks" = expected-value checks + every unexpected write (an unexpected
write is a failure).

| ATS | cases ok | checks | rate | fills ok | correct abstentions | wrong writes |
|---|---|---|---|---|---|---|
| ashby | 1/2 | 13/15 | 87% | 5/6 | 8/9 | 0 |
| bamboohr | 0/2 | 16/28 | 57% | 5/14 | 11/14 | 0 |
| greenhouse | 0/3 | 44/52 | 85% | 23/28 | 21/24 | 0 |
| jobvite | 0/1 | 28/31 | 90% | 6/8 | 22/23 | 0 |
| lever | 0/3 | 43/53 | 81% | 13/22 | 30/31 | 0 |
| smartrecruiters | 0/2 | 6/20 | 30% | 0/14 | 6/6 | 0 |
| workable | 0/2 | 20/27 | 74% | 8/12 | 12/13 | 1 |
| **total** | **1/15** | **170/226** | **75%** | | | |

Wrong answers the baseline actually wrote on live pages (all now pinned by tests,
see section 2):
- "Are you legally authorized to work in the United States?" → **Yes** for a
  Canadian citizen (Greenhouse ×2, Workable). Country-blind.
- "Do you anticipate having any challenges with clearing a background check?"
  → the applicant's degree title (Lever).
- "Do you think AI will take over the world?" → **Yes** (Ashby).
- "If 'Other' selected for School Name, please indicate here" → the school (Greenhouse).
- "Where did you complete your undergraduate degree?" → the degree title, not the school.
- City → "Toronto, ON, Canada" (whole location string), Address → the location string (BambooHR).
- (Not our bug, recorded so nobody chases it: Workable's Address showed
  "Gatineau, Canada". Workable pre-fills that field from the visitor's IP
  geolocation; the capture taken with NO extension loaded already contains it.
  The extension leaves non-empty fields alone, by design.)

## 5. Needs you / needs manual verification

TODO
