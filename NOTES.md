# Overnight run: deterministic autofill (2026-10-03)

Branch: `night/deterministic-autofill` (local only, NOT pushed, NOT deployed).
Scope: `chrome-extension/` only. AI is out of credits, so every number below is
measured with the backend's AI pass returning nothing.

> Status: DONE for the night. Everything below was run and observed unless it
> is listed under "Needs manual verification" (section 5).

**How to run it yourself** (from `chrome-extension/`):
- Unit suite: `node node_modules/vitest/vitest.mjs run` (`npm test` exits 1 with no
  output in some shells; run vitest directly).
- Real-extension e2e: `node build.mjs && node test/e2e/run.mjs` (all 42 cases,
  about 10 min, opens a Chromium window). `--filter live` / `framework` / `synthetic` /
  `inputs` / an ATS name / a case id narrows it; `--report-only` exits 0 for
  measurement runs. `E2E_DEBUG=1` prints the extension's console per case.
- Older harness and probes: `npm run test:browser`, `npm run test:flow`,
  `npm run test:workday-account`, `npm run test:workday-gate`,
  `npm run test:workday-churn`, `npm run test:driver`, `npm run test:click-shadow`,
  `npm run test:extension`.

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
- **Live real pages** (`cases/real-live.mjs`): application forms from active jobs
  in prod `scraped_jobs` (Greenhouse, Lever, Ashby, Workable, SmartRecruiters,
  BambooHR, Jobvite), with a realistic sparse profile (one location string,
  "Canadian citizen", co-op in progress). BambooHR is also run the way a user
  does it: open the form, press Autofill a second later
  (`live-bamboo-nexthop-user-opened`). One Greenhouse form is embedded the way
  career sites do it: an employer page with a cross-origin `grnhse_iframe`
  (`cases/real-live-embedded.mjs`).
- **Same live pages, other applicants** (`cases/real-live-profiles.mjs`): a US
  F-1 student with a structured Cambridge, MA address (Workable, Jobvite), and a
  profile whose whole address is one street line (BambooHR).
- **Inputs** (`cases/inputs.mjs`): date inputs (native `date`, split M/D/Y,
  masked text) and a real résumé file upload, checked in the page.
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
| 16 | **Options past the 60th were dropped as "not offered"**: the scan-time gate checked proposals against the panel's 60-option copy. Every native country select with a full list dropped "United States" (position ~235); Lever's picker dropped "University of Waterloo". Pre-existing. | Live: Lever | `longSelects.test.ts` |
| 17 | **select2 / chosen selects**: the hidden native `<select>` was skipped (hidden + aria-hidden) and the styled proxy fought. Now the native select is filled, labelled by its question, and the proxy is ignored. | Live: Lever | `realPages.test.ts` "select2" |
| 18 | "Are you **able to work** from our Kepler office as required?" was answered as a work-authorization question (from citizenship). | Live: Lever | `questionResolver.test.ts` "'able to work'" |
| 19 | A phone "Country code" picker classified as the applicant's location. | Live: SmartRecruiters | `fieldMatcher.test.ts` "phone country code" |
| 20 | **Comboboxes built from web components**: options slotted into a shadow-DOM listbox were not found; option and selected-value text projected through `<slot>` read as empty; IDREFs into a sibling component's shadow root unresolved. SmartRecruiters' City and Country code never filled. | Live: SmartRecruiters | `comboboxShadowControls.test.ts` (5) |
| 21 | **Place suggestions matched by tokens**: "Toronto, OH, US" scored as a PERFECT match for "Toronto, ON, Canada" (short tokens dropped). City/location dropdowns now pick by place (city, region by code or name, country by name/ISO-2/ISO-3); ambiguous lists are refused. | Live: SmartRecruiters, Lever | `comboboxShadowControls.test.ts` placeHint, `leverAdapter.test.ts` |
| 22 | Material UI wraps native radios in `role="radiogroup"` elements; each was scanned as an empty ARIA group and logged a failed fill next to the native group that filled. | Live: BambooHR | `realPages.test.ts` "wrappers" |
| 23 | **Backend answers skipped the kind gate**: the backend's rule pass answers "city" for any label mentioning a location, which could put "Toronto" into a yes/no text question. Backend answers now pass the same gate. | Code + unit repro | `aiFillPlanner.test.ts` "must fit the field's kind" |
| 24 | Field of study "Applied Science in Mechatronics Engineering" (prefix list misses "of Applied Science"); "Bachelor's degree in progress" gave "progress" (pre-existing). | Live: Workable | `workdayFieldOfStudy.test.ts` |
| 25 | Workday application steps show no job location, so "authorized to work in this country?" could never be answered there. The job country now comes from Workday's URL slug (`/job/Cambridge-MA/…`) or is carried from the posting page. | Code read | `jobLocation.test.ts` |
| 26 | "Will you require relocation assistance or visa sponsorship?" would have been answered from the sponsorship half alone; "120k" salary into a number field gave 120. | Unit repro | `questionResolver.test.ts`, `fieldResolverKinds.test.ts` |
| 27 | **Rows the fill pass adds itself were never filled**: the pass clicks "Add education / experience" for the profile's entries, but only the ids picked at click time were written. | Live: Workable | `fillSelection.test.ts` |
| 28 | **A form the site still holds hidden was scanned as empty.** BambooHR keeps its form mounted inside a `display:none` box for 2.5-5 s after "Apply for This Job" (measured with a page-side probe). No node is added at the reveal, so the DOM-quiet wait passed at once, every control looked hidden, and the flow parked on an empty page: live-bamboo-nexthop failed about half of combined runs. Now waits (bounded, 10 s) while most of the page's typeable controls are mounted-but-hidden, and rescans as they render. | Live: BambooHR | `hiddenForm.test.ts` (7), `flowController.test.ts` "apply entry", live `live-bamboo-*`: 24/24 over 6 runs, then 20/20 over 5 on the final build |
| 29 | **Autofill silently did nothing** when no field was picked and no "Apply" button was visible, although the button is deliberately always live. Hit by anyone who opens a BambooHR form and presses Autofill within those 5 s. | Live: BambooHR | `overlayAutofillClick.test.ts` (fails on the old code), live `live-bamboo-nexthop-user-opened` |

Old in-page harness (`test/browser/run.mjs`): its résumé-upload scenario failed only
because the harness did not `await` the now-async `injectResumeFile` (harness bug,
fixed). With the product fixes above it is **19/19** (was 11/19 on clean `main`).
The other real-browser probes (`flow-probe`, the three Workday account/churn
probes, `react-select-driver`, `click-shadow-probe`, `load-extension`) all pass.

New test files: `optionMatchStrict`, `profileFacts`, `questionResolver`,
`realPages` (32 assertions on captured real pages), `namelessRadios`,
`longSelects`, `comboboxShadowControls`, `jobLocation`, `fieldResolverKinds`,
`fillSelection`, `hiddenForm`, `overlayAutofillClick`, plus additions to
`leverAdapter`, `observePage`, `fieldMatcher`, `aiFillPlanner`,
`workdayFieldOfStudy`, `workday`, `flowController`. Unit suite: **1280 passing
in 125 files** (was 1101).

Harness bugs found and fixed along the way (not product bugs): clicking Autofill
before an SPA form rendered, waiting out the full timeout when a fill errored,
treating the end of a zero-field entry page as the end of the flow, an ATS draft
(Workable restores the previous applicant's answers from site storage) leaking
into the next case (storage and cookies are now cleared per case), and the
harness clicking BambooHR's "Apply" on top of the extension's own click, which
toggled the form shut.

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
11. **What the backend still gets.** Only abstentions on legal status (work
    authorization, sponsorship, citizenship, age) are withheld from the backend.
    Essays, opinions and skill-specific questions still go to it, so they work
    again the day the AI has credits. Every backend answer must now pass the same
    kind gate as an on-device one.
12. **Place pickers choose a place or nothing.** With several "Toronto"
    suggestions and no region/country to tell them apart, nothing is picked.
13. **Options are snapped at scan time.** A select's proposal is now the exact
    option text it will select ("I am not a veteran"), so the panel shows what
    will actually be written.
14. **Waiting for a hidden form is bounded at 10 s** and only happens on the
    page an "Apply" entry click just opened, or on an Autofill click that picked
    nothing; and there only while the page's typeable controls are mostly
    mounted-but-hidden AND (nothing is fillable yet, OR at most two controls are
    rendered). Ordinary wizard steps never wait: a wizard that keeps its other
    steps mounted but hidden would otherwise stall on pages with nothing to
    fill, such as a review page. Pages whose form is not hidden pay nothing.
15. **An Autofill click with nothing picked now always runs** (fill pass, then
    the flow: open the form, wait for it, or say "No application form found on
    this page"). Before, it returned silently. The panel's own comment says the
    button "stays live whenever a profile is loaded", so a dead click was the bug.
16. **The panel covering BambooHR's Apply button (section 5) was NOT changed.**
    Moving or shrinking the panel is a layout decision with knock-on effects on
    every site; recorded for you instead.

## 4. Per-ATS pass rates

Every number here is the real packaged extension in Chromium, pressing the
panel's own Autofill button, with the backend's AI returning nothing. "checks" =
expected-value checks (a value where one is expected, a BLANK where the right
answer is to abstain) plus one failure per unexpected write. All read back from
the page DOM (and the framework's own state on the framework pages).

### Final: branch HEAD `c7fca08`, all 42 cases

| ATS | cases ok | checks | rate | fills ok | correct abstentions | wrong writes |
|---|---|---|---|---|---|---|
| ashby | 3/3 | 19/19 | 100% | 10/10 | 9/9 | 0 |
| bamboohr | 5/5 | 60/60 | 100% | 38/38 | 22/22 | 0 |
| greenhouse | 5/5 | 77/77 | 100% | 45/45 | 32/32 | 0 |
| jobvite | 3/3 | 66/66 | 100% | 24/24 | 42/42 | 0 |
| lever | 4/4 | 59/59 | 100% | 28/28 | 31/31 | 0 |
| smartrecruiters | 1/3 | 3/25 | 12% | 3/3 | 0/0 | 0 |
| workable | 4/4 | 59/59 | 100% | 37/37 | 22/22 | 0 |
| workday | 2/2 | 21/21 | 100% | 18/18 | 3/3 | 0 |
| icims | 1/1 | 9/9 | 100% | 9/9 | 0/0 | 0 |
| taleo | 1/1 | 9/9 | 100% | 9/9 | 0/0 | 0 |
| successfactors | 1/1 | 9/9 | 100% | 9/9 | 0/0 | 0 |
| adp | 1/1 | 9/9 | 100% | 9/9 | 0/0 | 0 |
| breezy | 1/1 | 5/5 | 100% | 5/5 | 0/0 | 0 |
| bullhorn | 1/1 | 4/4 | 100% | 4/4 | 0/0 | 0 |
| rippling | 1/1 | 4/4 | 100% | 4/4 | 0/0 | 0 |
| framework (React 18 / Vue 3 / AngularJS) | 3/3 | 49/49 | 100% | 46/46 | 3/3 | 0 |
| inputs (dates, résumé upload) | 2/2 | 9/9 | 100% | 9/9 | 0/0 | 0 |
| smoke | 1/1 | 6/6 | 100% | 6/6 | 0/0 | 0 |
| **total** | **40/42** | **477/499** | **96%** | | | **0** |

- The two failures are both LIVE SmartRecruiters pages, which answered this
  machine with HTTP 403 + a DataDome captcha page by the final run (checked
  with a plain `curl` GET for each; section 5). Their forms never rendered.
  Earlier the same night both passed 100%. **Excluding them: 40/40 cases,
  477/477 checks.**
- Live real pages: Greenhouse 4 (incl. the cross-origin embed), Lever 3, Ashby 2,
  Workable 3, BambooHR 4, Jobvite 2, SmartRecruiters 2. Workday, iCIMS, Taleo,
  SuccessFactors, ADP, Breezy, Bullhorn and Rippling are synthetic fixtures
  served on each ATS's real host (section 5 says why).
- Stability: BambooHR, the one race-prone site, passed 20/20 case runs on this
  build (5 combined runs) and 24/24 on the commit before it.

### Before/after on identical cases and expectations

The baseline build (`b9aebcc`, `main` when the night started) re-scored with
`E2E_EXT_DIR` against the SAME final cases and expectations. Live
SmartRecruiters is left out of both columns (DataDome).

| ATS | baseline cases | baseline checks | branch cases | branch checks |
|---|---|---|---|---|
| adp | 0/1 | 8/9 (89%) | 1/1 | 9/9 (100%) |
| ashby | 2/3 | 17/19 (89%) | 3/3 | 19/19 (100%) |
| bamboohr | 1/5 | 46/60 (77%) | 5/5 | 60/60 (100%) |
| breezy | 1/1 | 5/5 (100%) | 1/1 | 5/5 (100%) |
| bullhorn | 1/1 | 4/4 (100%) | 1/1 | 4/4 (100%) |
| framework | 0/3 | 31/49 (63%) | 3/3 | 49/49 (100%) |
| greenhouse | 1/5 | 66/77 (86%) | 5/5 | 77/77 (100%) |
| icims | 0/1 | 8/9 (89%) | 1/1 | 9/9 (100%) |
| inputs | 1/2 | 6/9 (67%) | 2/2 | 9/9 (100%) |
| jobvite | 1/3 | 59/66 (89%) | 3/3 | 66/66 (100%) |
| lever | 1/4 | 49/59 (83%) | 4/4 | 59/59 (100%) |
| rippling | 1/1 | 4/4 (100%) | 1/1 | 4/4 (100%) |
| smartrecruiters (synthetic) | 1/1 | 3/3 (100%) | 1/1 | 3/3 (100%) |
| smoke | 1/1 | 6/6 (100%) | 1/1 | 6/6 (100%) |
| successfactors | 0/1 | 8/9 (89%) | 1/1 | 9/9 (100%) |
| taleo | 0/1 | 8/9 (89%) | 1/1 | 9/9 (100%) |
| workable | 1/4 | 42/60 (70%) | 4/4 | 59/59 (100%) |
| workday | 0/2 | 17/21 (81%) | 2/2 | 21/21 (100%) |
| **total** | **13/40** | **387/478 (81%)** | **40/40** | **477/477 (100%)** |

What the failures were:

| | left blank (value expected) | wrong value written | invented answer (blank expected) | stray write |
|---|---|---|---|---|
| baseline `b9aebcc` | 63 | 14 | 13 | 1 |
| branch `c7fca08` | 0 | 0 | 0 | 0 |

The baseline's 13 invented answers include "Are you legally authorized to work
in the United States?" **Yes** for a Canadian citizen (Greenhouse ×3, Workable)
and for an F-1 student (Workable, its radio and the ARIA twin), "Do you think AI will take over the
world?" **Yes**, "highest education: Bachelors" for a student whose degree is
in progress, and the degree title typed into a background-check question. Its
14 wrong values are the whole location string ("Toronto, ON, Canada",
"Ottawa, ON, Canada") in City fields, and the degree title where the school was
asked.

### Live pages through the night

The original 15 live cases, scored with the expectations as they stood at each
point (expectations were corrected during the night, e.g. Workable's
IP-prefilled Address, so the re-scored table above is the fair comparison).

| point | checks | cases |
|---|---|---|
| baseline `b9aebcc` | 170/226 (75%) | 1/15 |
| inference layer + kind gate | 185/228 (81%) | 1/15 |
| round 3 (labels, Lever, shadow listboxes) | 205/228 (90%) | 7/15 |
| round 4 (web components, place matching) | 215/226 (95%) | 10/15 |
| final `c7fca08` | 211/233 (91%); 211/211 (100%) without SmartRecruiters | 13/15; 13/13 |

### First measurement: `main` build (b9aebcc), before any change

Live pages only, SPARSE_CANADIAN profile, expectations as first written.

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

**Your decisions / actions**
1. **Review and merge** `night/deterministic-autofill` (20 commits on top of
   `b9aebcc`, the last one adding this file; local only, not pushed). Then
   `cd chrome-extension && node build.mjs` and **reload the unpacked
   extension** at chrome://extensions (Chrome caches it).
2. **Backend bug, not touched (out of scope tonight):**
   `backend/routers/fill.py::_raw_rule_based_answer` answers any "sponsorship"
   question "No", and any "authorized to work" / "18 or older" question "Yes",
   unconditionally. `answer_gate` only checks the POLARITY of the stored
   statement, never the country, so "Authorized to work in Canada" passes a
   "Yes" to "authorized to work in the United States?". The extension now keeps
   those questions away from the backend when it has abstained on them, but any
   other client of `/api/fill` still gets the guess. Recommend deleting those
   three rules (derived_facts already computes age from the DOB).
3. Decision #7 (attestation checkboxes not ticked) is the one most likely to
   want your call.
4. **The panel covers the site's own Apply button on BambooHR** at 1366×900 (a
   very common laptop size). The auto-mounted panel is a 380 px overlay on the
   right, and BambooHR's "Apply for This Job" sits in the right column
   underneath it: a real pointer click lands on the panel. Our own Autofill
   clicks Apply programmatically, so the extension flow works, but a user who
   wants to open the form by hand has to close the panel first. Options: push
   the page left (margin on `<html>`) while the panel is open, start collapsed
   on job-description pages, or leave it. Not changed tonight (decision #16).
   Seen and measured with `elementFromPoint` on the live posting.

**Needs manual verification (I could not test these for real)**
- **Workday application steps.** The real form sits behind account creation, and
  creating accounts on employers' tenants is an outward action I did not take.
  Covered only by the synthetic fixtures (incl. shadow DOM) and the captured
  sign-in wall. The Workday-specific code paths (prompt dropdowns, date
  spinbuttons, "How did you hear" multiselect, Add-row sections) were not
  exercised against a live tenant tonight. The new URL-based job-country
  detection is unit-tested on real Workday URLs.
- **iCIMS and Taleo** application forms (login walls; the app has no active Taleo
  listings). Synthetic fixtures only. **SuccessFactors and ADP**: synthetic only.
- **SmartRecruiters**: both live pages passed 100% earlier in the night (City
  "Toronto, Ontario, Canada", dial code "+1"; ServiceNow again 12/12 in the
  second-to-last full run). By the final run both postings answer this machine
  with **HTTP 403 and a DataDome captcha page** (checked with a plain `curl` GET
  each), so their forms never render and every check reads as missing. That is
  bot protection reacting to repeated automated runs from one IP, not an
  extension failure. Re-check both by hand once from a normal browser.
- **Real profiles with unusual work-authorization text.** The parser handles
  citizen / permanent resident / green card / H-1B / TN / OPT / F-1 / study and
  work permits / "authorized to work in X [and Y]" / bare yes-no. Anything else
  abstains (blank), which is safe but may leave fields empty.
- The panel's gap list still shows abstained fields as unanswered, which is
  intended, but I did not review the panel UX visually.

**Housekeeping**
- Live e2e cases use real postings that will expire. Re-capture with
  `node test/e2e/capture.mjs` (edit `TARGETS`) and update `cases/real-live*.mjs`.
- HAR recordings of every captured page (203 MB, full-fidelity offline replay)
  are in `chrome-extension/test/e2e/results/har/` (gitignored, local only).
- The result JSON/text of every run quoted in section 4 is in
  `chrome-extension/test/e2e/results/` (gitignored): `final3-all` (final),
  `baseline-rescored` (b9aebcc on the final cases), `baseline-live` (first
  measurement), `round3-live`, `round4-live`.
- Nothing was pushed, deployed, or sent anywhere. The only network writes were
  to the local fake backend.
