# Day session: answer every question without AI (2026-10-03)

Same branch, still local only (NOT pushed, NOT deployed). You asked for three
things: Brex's form filled properly; every question answered without AI
(mapping and defaults, with AI only for essays and the genuinely unanswerable);
and new profile fields wherever no mapping could supply an answer, added to the
extension panel, the web app and onboarding. Then: test on real pages, fix,
retest. The overnight notes below are unchanged except where this section
says it supersedes them.

**TL;DR.** The extension now answers the standard screening questions on the
device: consent, posting requirements, prior applications and referrals,
relatives inside, conflicts, government officials, how you heard about the
job, relocation, EEO (declined when the profile says nothing), start dates, test
scores, export-control status and more. AI is left for essays and judgement
questions. Five profile answers no mapping can supply (US / Canada work
authorization, how you heard, expected graduation month, GPA) are in the
extension panel, the web Profile page, onboarding and the backend. Brex now
fills completely: every question is answered except three correctly blank
follow-ups.

Testing on real pages found real bugs in every round:
- **Complete-profile round:** "no sponsorship needed" for US jobs on 7 pages,
  caused by that morning's own new per-country field. Also a mangled BambooHR
  date, an invented graduation day, an H-1B history question answered as
  sponsorship, and a dropdown counted as filled when it was empty.
- **Blind round on 22 postings never seen before:** 9 wrong writes.
- **Regression runs of the pinned suite:** 3 more (ActioNet, ZipRecruiter, an
  Ashby end date).
- **Read-through of my own new rules:** 3 that would have over-reached, plus one
  answer that was right only by luck.

All are fixed, each with a test that fails on the old code. On the final build:
- the pinned regression suite passes **64/64 cases (42 live pages), 825/825
  checks**;
- the two new committed live rounds (40 more pages, 626 reviewed pins) pass
  **40/40**, the run they were pinned from;
- unit tests: **1411/1411**.

Not pushed, not deployed.

### What changed today (commits on top of the overnight `c0b43f3`)

| commit | what |
| --- | --- |
| `ce65496` | **Default answers on device** (`defaultAnswers.ts`), **EEO decline**, **consent policy**, react-select options re-resolved on device, a recovery pass for fields the page clears, a pass for questions that appear during the fill |
| `1c63c18` | e2e expectations re-pinned to the new policy (101 new writes reviewed one by one first) |
| `15ddffc` | **Five new profile answers** across the extension panel, web Profile page, onboarding and backend |
| `bd01bfe` | **The job's city**, and an embedded form asks the page around it where the job is |
| `7f217c1` | **Conditional questions** answered only when their condition holds; "what sponsorship would you require?" no longer gets the authorization statement |
| `a11f4a3` | `COMPLETE_CANADIAN` e2e profile (every screening answer filled in) |
| `22f7628` | Never "no sponsorship needed" for a country the applicant cannot work in; citizenship kept beside the explicit answers |
| `3702db9` | Month-name date pickers ("dd mon yyyy"); a graduation month never becomes a day |
| `a167849` | Education end month from the expected graduation; Ashby's unlabeled date selects; "Still Student?" |
| `d4505e3` | The blanks a complete profile left on live pages (work right, employment history, export status, test scores, channels, acknowledgements, SMS, gender identity, …) |
| `93d19b5` | Languages checklist, "Other" for an unlisted major, the disability form's signature date |
| `7f65ee4` | An open list's highlighted option is not a selection |
| `b7e71e1` | H-1B history; Ashby graduation radios; "Still Student?" selection; label-only fill diagnostics; e2e `afterFill` hook |
| `1ee0260` | Blind round on 22 fresh postings: 9 wrong writes and the blanks behind them (incl. same-job-only carry-over, "Country - City", form-implied job country) |
| `b455627` | A current student's Ashby End Date is the page's; "did you graduate from" is no date |
| `93966d7` | Three default rules narrowed before they meet a page |
| `4004008` | Start-time spans; no dates in numeric buckets; demographic synonyms at scan time; form-country hint retried |
| `926f39a` | A stated channel offered several ways picks its job-search variant |
| `23e1f67`, `441016a` | The two live rounds committed as cases (`real-live-complete.mjs`, `real-live-fresh.mjs`); re-pins after review |

### Decisions (these supersede overnight decisions #1 and #7 where they differ)

1. **Defaults answer as a typical applicant who accepts the posting's terms
   and is unencumbered.** Yes to: application consents and certifications,
   in-office / on-site / hybrid / travel / schedule requirements, background
   checks, essential functions, being considered for future roles. No to: applied
   or interviewed before, referred by an employee, relatives inside, conflicts of
   interest, non-competes, government official, background-check obstacles,
   marketing / SMS / newsletter opt-ins. A profile fact always wins over a
   default (a stated "won't relocate" answers No).
2. **Never defaulted:** work authorization, sponsorship, citizenship, criminal
   history, relocation ASSISTANCE (a request, not a requirement), recording /
   AI-notetaker consent, and in-office requirements when the profile says Remote.
   Those stay blank unless the profile states them.
3. **Consent: every application consent is given, including the
   demographic-data consent.** You asked for all questions to be answered, so
   this reverses the overnight fix for bug #36 by design. Decision #7's
   inconsistency is gone: clear consent wording is always ticked.
4. **EEO with no profile answer → the decline option** ("Decline to
   self-identify", "I don't wish to answer"). It discloses nothing and stops a
   required EEO question from blocking submit. A list with no decline option
   stays blank (Workday's veteran select).
5. **"How did you hear about us"**: the profile's answer, mapped onto the form's
   wording ("Career fair" → "University Career Fair"). With none set: a job-board
   option, else the company website, else "internet", else LinkedIn, else
   "Other". Free text gets "Online job board".
6. **"Are you located here, or would you relocate?"**: "located here" when the
   profile city is the job's city, "relocate" otherwise, "No" when the profile
   says it won't relocate.
7. **A question with a condition on the applicant** ("If you are a current or
   former government employee, …?") is answered only when the condition holds.
   False → the option saying it does not apply, or blank. Unknown → blank.
   Hypotheticals ("If you are offered the position, …") hold.
8. **A required list whose ONLY option is an acknowledgement is answered with
   it.** This includes Anthropic's "Agreement to Arbitrate" ("I understand and
   agree to the terms…"), a waiver of the right to sue. That follows from "answer
   every question" and the form offers nothing else, but it is a legal agreement
   made on the user's behalf, so **you may want it excluded** (one regex in
   `defaultAnswers.ts`, `ACK_OPTION`).
9. **No test scores on the profile → "Did not take / Do not recall"** when the
   list offers it (SpaceX's SAT/ACT/GRE). It claims nothing. A free-text score
   box stays blank.
10. **U.S. export-control status is inferred only from US work authorization.**
    Not authorized in the US means none of citizen / permanent resident / refugee
    / asylee / DACA (each of those may work there), so "Other" / "None of the
    above" / "Foreign person". Nothing said about the US → blank.
11. **"Open to relocation?" answered with a list of cities → the job's own
    city** when the applicant is willing to relocate; "No" (or the remote
    alternative for a Remote preference) when not.
12. **Backend scope widened.** The new fields needed `backend/routers/profile.py`
   and `fill.py` (no migration: they live in `user_settings.prefilled_answers`
   under exact keys, never mined from other answers). The overnight run was
   extension-only; today's request required the web app and backend too.

### New profile answers (no mapping can supply these)

`authorizedUS`, `authorizedCanada` (Yes/No), `howDidYouHear`,
`expectedGraduation` (a month, `YYYY-MM`) and `gpa`. They are in the extension
panel (Preferences), the web Profile page, the backend profile API and the AI
fill context. Onboarding asks the two authorization questions (Role step) and the
expected graduation month (Experience step), and saves only what was answered (a
blank stays "not answered", never "No"). The option lists are twins pinned by
tests on both sides (`SCREENING_CHOICES` ⇄ `SCREENING_OPTIONS`).
What they unlock: "authorized to work in the US?" for a Canadian (before:
always blank), "When do you graduate?" with month-range options ("January - June
2027", "Spring 2027", "December 2026 - November 2027"), GPA buckets, and the
user's real channel instead of the default.

### Bugs found on real pages today, each fixed with a regression test

**Wrong answers written (the serious ones):**
1. **"No sponsorship needed" for a US job from a Canadian not authorized in the
   US** (`22f7628`). The general "requires sponsorship: No" (meant for Canada)
   beat the explicit "authorized in the US: No" for every US question: Hermeus
   got "No, I do not require sponsorship" for "…employment in the USA?", and
   Robinhood, ZipRecruiter, Twitch, Mindex, Palantir and Anthropic got "No". This
   bug came in with the new per-country field (`15ddffc`) and was caught by the
   complete-profile round before it shipped anywhere. Now: not authorized there →
   sponsorship needed there; an unscoped question with the job's country unknown
   stays blank for such an applicant; "require sponsorship … to legally work in
   the U.S." is a sponsorship question, not an authorization one.
2. **"If you are a current or former government employee, have you recused
   yourself…?" answered "No"** (ActioNet, `7f217c1`), which reads as an unrecused
   conflict. The form offered "I am not a current or former government
   employee". Conditional questions now evaluate their condition first.
3. **"…what sponsorship would you require?" got "Canadian citizen"** (Brex,
   `7f217c1`): the type of sponsorship is the applicant's to say; now blank.
4. **"Date Available" typed as "05 mon yyyy"** (BambooHR, `3702db9`): its Fabric
   date picker wants "03 May 2027" and mangled our "05/03/2027".
5. **A graduation month became a day** (Ramp's Ashby picker got "04/01/2027",
   `3702db9`). The day is unknown, so a day-precise picker stays blank.
6. **"Cisgender man" could be picked for a cisgender woman** listed after it
   (`d4505e3`); identity and gender must now both match.
7. **"Relocation assistance?" answered Yes**, **"currently enrolled OR graduated"
   answered No for graduates**, and **"a university" read as a school name**
   (`ce65496`, `7f217c1`).
8. **A dropdown counted as filled when it was not** (`7f65ee4`). An open list's
   highlighted option (`aria-activedescendant`) was read as the selection, so
   SpaceX's "Employment History" was skipped as "already showing the answer",
   reported as written, and confirmed by the end-of-fill check. The page held
   nothing. This could hit any react-select left open with the answer
   highlighted.
9. **"Have you held H-1B status…?" answered as a sponsorship question** (Yes,
   Twitch; `b7e71e1`).
10. **Blind round on 22 postings never seen before** (`1ee0260`), complete
    profile, 9 wrong writes:
    - "Preferred first and last name" → last name only.
    - "enrolled in a PhD program?" → Yes for a bachelor's student.
    - "any impediments to traveling internationally?" → Yes.
    - "If you have under 2 years…" → "N/A - I have more than 2 years" (she has 1.4).
    - "1–2 years of experience" → NO.
    - "school, program and expected month/year" → "2027".
    - Arc'teryx sponsorship → Yes for a job in Canada. The job's country was
      carried over from the previous Lever posting: every Lever company shares
      one host. Carry-over now requires the same job's URL path.
    - Rippling "Current company" → the first job (sequential ids "field-31"
      read as row 31).
    - A US-citizenship requirement that resolved to "Canada". It was blank only
      because no option matched.

    All 9 are fixed with tests that fail on the old code.
11. **Regression runs of the pinned suite** found three more:
    - ZipRecruiter: "What school are you currently attending / did you graduate
      from?" → school plus graduation date. The verb "graduate" is not a date
      question.
    - Ashby (Ramp, Superhuman): a disabled End Date read "October 2027". Ticking
      "Still Student?" disables End Date, and a year written first was left
      beside a month the page picked. A current student's End Date is now left
      to the page (`b455627`).
12. **Read-through of my own new rules** (`93966d7`, `4004008`):
    - A lone "Yes" option would have been taken as an acknowledgement ("Have you
      applied before? [Yes]").
    - "Professional Certification [Yes/No]" would have been read as consent.
    - "travel with no restrictions" would have been an obstacle question.
    - Striveworks' "12+ weeks from offer acceptance" was right only by luck: the
      option matcher read the start date's year (2027) as a number of weeks. A
      start next week would have landed there too.

**Blank answers the profile could give (fixed):** Brex's "authorized to work in
the stated location" (the job's place is now read from the page around an
embedded form, `bd01bfe`); Greenhouse/Ashby education end month, "Still
Student?" and Ashby's unlabeled year selects (`a167849`); citizenship country
after the new per-country answers (`22f7628`); relocation answered with a list
of cities (the job's city), "a Twitch employee", "legally eligible to begin
employment", employment history asked through its options, US export-control
status, graduate GPA "Other/Not Applicable", SAT "Did not take/Do not recall",
"how you heard" / "how did you connect" / an unlabeled channel list, single-option
acknowledgements (Anthropic's arbitration agreement), Anthropic's "AI Policy"
Yes, SMS consent asked through options, "No" typed into "Were you referred? If
so, who?", "join as an intern" start date (`d4505e3`); languages checklist,
"Other" for an unlisted major, the disability form's signature date (`93d19b5`);
a current student's "Still Student?" and Superhuman's graduation radios
(`b7e71e1`); "in the country that you are located", "at least 18 years or
older", "previously worked for this organization", "how did you FIRST hear",
preferred start dates offered as dates, "living in the US or Canada?", the time
zone, SMS "via text", "I understand…" acknowledgement boxes, future-job opt-ins,
and the job's country implied by the form's own work-auth questions (`1ee0260`);
start-time spans ("Over a month from offer"), Ashby's gender boxes ("Woman"),
and a stated channel offered several ways (`4004008`, `926f39a`).

**Not a gap:** Workable's `#city` / `#postcode` / `#country` are `aria-hidden`,
`tabindex=-1` helper inputs, not questions. Filling hidden inputs is what
blocked Workday's submit before (overnight bug list), so they stay empty.

### Test results

- **Extension unit suite:** 1411/1411 in 129 files (1331 in 128 at the start of
  the day). Every bug above has a test that fails on the code before its fix. I
  checked each one by swapping in the old file and running it.
- **Web app:** profile parity + settings 19/19, onboarding (SetupWizard) 13/13.
  The new onboarding and Profile fields rendered in a real browser at 13
  viewports (responsive audit: 0 high, 0 medium findings).
- **Backend:** profile + fill-profile tests 40 passed (run isolated, see
  overnight notes).
- **Real-extension e2e, final build (`results/final-1`):**
  - **Regression suite: 64/64 cases (42 live pages), 825/825 checks**, scored at
    run time against pins set before the run.
  - **Two new committed live rounds:** `real-live-complete.mjs` (18 pages,
    complete profile) and `real-live-fresh.mjs` (22 new postings). 40/40 against
    pins taken from that same run, so that number is a baseline, not a test. The
    pins were checked against the earlier reviewed run (`results/all-2`), where
    every write was read by hand. The final run differed from it only by the
    reviewed improvements and one intermittent blank.
  - The earlier reviewed run, re-scored against the final regression pins:
    63/64. The miss: Twitch's Degree dropdown left blank once (Greenhouse's
    async dropdowns drop occasionally; blank, never wrong).
- **Extension panel and web Profile page:** screenshots show the five new
  answers in the panel's "Your Autofill Information → Preference" (filled from
  the profile) and as rows on the web Profile page (responsive audit: 0 high, 0
  medium).

### Needs you / needs manual verification (today)

**Your decisions**
1. **Anthropic's arbitration agreement** is now accepted on the user's behalf:
   a required list whose only option is "I understand and agree…" (decision 8
   above). Say if you want legal waivers excluded.
2. **"I have never held H-1B status" is a default** for profiles that name no
   US visa; "Did not take / Do not recall" for SAT/ACT/GRE; "Other" for an
   unlisted major. Each is the answer that claims nothing, and each is easy to
   reverse.
3. **Rippling picks its phone country from the browser locale.** This test
   machine's Chromium runs en-GB, so it shows "+44 GB" (seen with no extension
   loaded). A user on en-US or en-CA gets "+1", so this is not a real-user
   problem, and the extension never overwrites a pre-filled value (overnight
   decision 8). Tell me if your users' locales vary enough to need a
   dial-code exception.

**Needs manual verification**
- **Deploy together.** The new profile answers are saved through the backend's
  profile API (`profile.py`, `fill.py`). Until that backend is deployed, prod
  ignores the unknown keys, so answers entered in the panel, the Profile page
  or onboarding will not persist. Ship backend and web app in the same push.
- **Web onboarding and Profile page:** rendered in a real browser at phone and
  laptop sizes (responsive audit: 0 high, 0 medium; the radios and the month
  input work), and covered by unit tests. A real save against the backend was
  not run (no deployed backend with the new keys).
- **Your installed extension is the old build** (prod report 183 from Brex had
  an empty extension version). `cd chrome-extension && node build.mjs`, then
  reload the unpacked extension.
- **Intermittent, not fixed:** Hermeus's Lever location typeahead stayed blank
  once (filled in the previous run); SpaceX's GRE dropdown did not open in
  time to read its options once; Greenhouse's async School dropdown
  (Robinhood) as before.
- **Still blank by design:** essays, opinions, skill-specific questions
  ("experience with AI?", years of Roblox Studio), the applicant's
  extracurriculars, interview-recording consent, accommodation requests,
  sponsorship TYPE, a future location ("local to Chicago for summer 2027?").

---

# Overnight run: deterministic autofill (2026-10-03)

Branch: `night/deterministic-autofill` (local only, NOT pushed, NOT deployed).
Scope: `chrome-extension/` only. AI is out of credits, so every number below is
measured with the backend's AI pass returning nothing.

> Status: DONE for the night. Everything below was run and observed unless it
> is listed under "Needs manual verification" (section 5).

**TL;DR.** With the AI returning nothing, the extension now answers from the
profile alone and leaves the rest blank. On 64 real-extension cases (42 of
them live application pages) it passes **774/774 checks with zero wrong
writes** (four of those checks accept a blank; see section 4). Twenty-four of
the live pages were drawn fresh after the main fixes and reviewed blind: the
first twelve showed 14 wrong values on 6 pages, the next twelve (after fixing
those) 1 wrong write on 1 page. All fixed and pinned, but expect a few more on
pages nobody has looked at.
The `main` build, re-scored on the 40 of those cases that predate the
held-out round, scored 387/478 and wrote 13 invented answers ("authorized to
work in the US? Yes" for a Canadian citizen, among others) plus 14 wrong
values; the branch passes all 40. Nothing was pushed or deployed. Section 5
lists what needs you.

**How to run it yourself** (from `chrome-extension/`):
- Unit suite: `node node_modules/vitest/vitest.mjs run` (`npm test` exits 1 with no
  output in some shells; run vitest directly).
- Real-extension e2e: `node build.mjs && node test/e2e/run.mjs` (all 66 cases,
  about 20 min, opens a Chromium window; the two live SmartRecruiters cases
  time out while DataDome blocks this machine). `--filter live` / `framework` /
  `synthetic` / `inputs` / an ATS name / a case id narrows it; `--report-only` exits 0 for
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
- **Held-out live pages** (`cases/real-live-heldout.mjs`): two rounds of 12
  postings drawn at random from prod `scraped_jobs` AFTER the fixes above,
  from companies not in the corpus (round 1: Ashby 4, Greenhouse 4, Lever 3,
  Workable 1; round 2: Ashby 4, Greenhouse 4, Lever 4). Each first pass was
  blind: no expectations, every write reviewed by hand. Round 1 found bugs
  #30-#35; round 2 (after those were fixed) found one, #36. All pinned.
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
| 30 | **A date picker re-parsed a partial date into a wrong day.** "What is your graduation date?" is a react-datepicker; the profile's graduation YEAR "2027" was typed in and the picker showed **12/31/2026** (`new Date("2027")` is UTC midnight, the evening before in Toronto). Date controls (native type, a format placeholder, or a known picker library) now take only a whole date, re-emitted in the control's format; otherwise blank. Backend answers too. | Held-out live: Ashby (Ramp) | `dateControl.test.ts` (7), `fieldResolverKinds.test.ts` date controls, `aiFillPlanner.test.ts` |
| 31 | **A bare year inside several options was a coin flip**: "2027" picked "December 2027" over "January - June 2027" for having fewer words. A bare number in several options is refused. | Held-out live: Ashby (Superhuman) | `optionMatchStrict.test.ts` "bare year" |
| 32 | **Greenhouse education rows got the first JOB's dates**: the education block has its own start/end month and year (`.education--date-container`), which classified as employment dates. End date = graduation (a bare year fills only the year); start date (unknown) stays blank. Older Greenhouse markup wraps EMPLOYMENT in `.education-experience-block`, so a wrapper naming both is ignored. | Held-out live: Greenhouse (Twitch, Astranis) | `educationRowDates.test.ts` (4; 3 fail without the fix) |
| 33 | **"Mechanical Engineering" for a Mechatronics student**: the matcher counted any shared 5-letter stem as the same word. A variant now differs only by an ending of at most 3 letters (Canada/Canadian/Canadien still match). | Held-out live: Greenhouse (Astranis) | `optionMatchStrict.test.ts` "sharing a stem" |
| 34 | **"High School Name" got "University of Waterloo"**, and "Year of High School Graduation" the university's 2027. High-school detail questions abstain (a yes/no about a diploma is left to the education-level rules). | Held-out live: Lever (Palantir) | `questionResolver.test.ts`, `fieldResolverKinds.test.ts` high school |
| 35 | **The react-select / Workday driver had its own looser matcher**: substring containment, first containing option wins. A graduation year committed "December 2026 - November 2027" though "December 2027 - November 2028" fits too, and "male" sits inside "female". `matchOption` moved to `optionMatch.ts` (pure) and the page-world driver now uses it. | Held-out live: Greenhouse (ZipRecruiter) | `mainWorldDriver.test.ts` (fails on the old matcher) |
| 36 | **A demographic-data consent checkbox was ticked for the user**: "By checking this box, I consent to Robinhood collecting, storing, and processing my responses to the demographic data surveys above", for an applicant who answered none of them. It classifies as a demographic field at high confidence, so the consent "yes" passed the selection gate. A sensitive box now carries only the user's own answer. | Held-out round 2 live: Greenhouse (Robinhood) | `checkboxIntent.test.ts`, `fieldResolverKinds.test.ts` (fails without the fix) |

Old in-page harness (`test/browser/run.mjs`): its résumé-upload scenario failed only
because the harness did not `await` the now-async `injectResumeFile` (harness bug,
fixed). With the product fixes above it is **19/19** (was 11/19 on clean `main`).
The other real-browser probes (`flow-probe`, the three Workday account/churn
probes, `react-select-driver`, `click-shadow-probe`, `load-extension`) all pass.

New test files: `optionMatchStrict`, `profileFacts`, `questionResolver`,
`realPages` (32 assertions on captured real pages), `namelessRadios`,
`longSelects`, `comboboxShadowControls`, `jobLocation`, `fieldResolverKinds`,
`fillSelection`, `hiddenForm`, `overlayAutofillClick`, `dateControl`,
`educationRowDates`, plus additions to `leverAdapter`, `observePage`,
`fieldMatcher`, `aiFillPlanner`, `workdayFieldOfStudy`, `workday`,
`flowController`, `mainWorldDriver`. Unit suite: **1303 passing in 127 files**
(was 1101).

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
7. **Consent / attestation checkboxes: CORRECTED, and the policy needs you.**
   An earlier version of this note said consent boxes are never ticked because
   the selection gate blocks them. That was wrong. `checkboxIntent.ts`
   (commit d5d087f, Jobright parity) proposes "yes" for clear consent wording,
   and whether the box is then ticked depends on how confidently its label
   happens to classify: most consent boxes classify as unknown and stay
   unticked, but one that also matches a confident category gets ticked.
   Robinhood's demographic-data consent was ticked that way (bug #36). Tonight
   I fixed only the sensitive case: a demographic (EEO) box is never ticked for
   its wording. For every other consent box the behavior is unchanged and
   inconsistent; pick one policy (tick all clear application consent like
   Jobright, or none) and make the gate enforce it.
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
17. **Date controls get whole dates only.** A picker that does not state its
    format is assumed MM/DD/YYYY (react-datepicker's default, and what Ashby
    shows). A graduation year never goes into a day-precise picker: the
    profile does not know the day.
18. **A broader parent option is acceptable, a sibling is not.** With no
    "Mechatronics" option, "Engineering" may be picked (it is true);
    "Mechanical Engineering" may not (it is a different discipline).
19. **High-school questions stay blank.** Profiles hold post-secondary
    education only.

## 4. Per-ATS pass rates

Every number here is the real packaged extension in Chromium, pressing the
panel's own Autofill button, with the backend's AI returning nothing. "checks" =
expected-value checks (a value where one is expected, a BLANK where the right
answer is to abstain) plus one failure per unexpected write. All read back from
the page DOM (and the framework's own state on the framework pages).

### Final: branch HEAD `c0b43f3`, 64 cases

| ATS | cases ok | checks | rate | fills ok | correct abstentions | wrong writes |
|---|---|---|---|---|---|---|
| ashby | 11/11 | 83/83 | 100% | 51/51 | 32/32 | 0 |
| bamboohr | 5/5 | 60/60 | 100% | 38/38 | 22/22 | 0 |
| greenhouse | 13/13 | 211/211 | 100% | 128/128 | 83/83 | 0 |
| jobvite | 3/3 | 66/66 | 100% | 24/24 | 42/42 | 0 |
| lever | 11/11 | 147/147 | 100% | 81/81 | 66/66 | 0 |
| workable | 5/5 | 70/70 | 100% | 47/47 | 23/23 | 0 |
| smartrecruiters (synthetic) | 1/1 | 3/3 | 100% | 3/3 | 0/0 | 0 |
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
| **total** | **64/64** | **774/774** | **100%** | | | **0** |

Failure kinds on this run: 0 left blank where a value was expected, 0 wrong
values, 0 invented answers, 0 stray writes.

- **Read the 100% with this caveat.** Four checks accept "the right answer OR
  blank" (a blank there is a miss, never a wrong write), and all four came out
  blank in this run: Greenhouse School on ZipRecruiter and on Robinhood (the
  intermittent in section 5), "Are you currently a Twitch employee?" (No would
  be right), and Workable's "Based in Austin, TX?" (NO would be right).
- Live real pages: 42 cases, 606/606 checks. Greenhouse 12 (incl. the
  cross-origin embed), Lever 10, Ashby 10, Workable 4, BambooHR 4, Jobvite 2.
  Workday, iCIMS, Taleo, SuccessFactors, ADP, Breezy, Bullhorn and Rippling
  are synthetic fixtures served on each ATS's real host (section 5 says why).
- **Live SmartRecruiters is not in this run**: both postings answer this
  machine with HTTP 403 + a DataDome captcha (re-checked with `curl` before the
  run). Earlier the same night both passed 100%; in the run on `c7fca08` they
  were the only failures (477/499 with them, 477/477 without).
- Stability: BambooHR, the one race-prone site, passed 20/20 case runs on
  `c7fca08` (5 combined runs) and 24/24 on the commit before it.

### Held-out pages: blind first passes, then fixed

Two rounds of twelve postings drawn at random from prod `scraped_jobs` after
the main fixes, from companies not in the corpus, each first run with NO
expectations and every write reviewed by hand (`cases/real-live-heldout.mjs`
now pins them):

- **Round 1 (Ashby 4, Greenhouse 4, Lever 3, Workable 1): 14 wrong values on 6
  of 12 pages.** Ramp's graduation date picker 12/31/2026; Superhuman's and
  ZipRecruiter's graduation option chosen from a bare year that fits two;
  Twitch's and Astranis's education start/end dates set to the first job's (8
  values); Astranis's Discipline "Mechanical Engineering"; Palantir's "High
  School Name" and its graduation year. Bugs #30-#35.
- **Round 2 (Ashby 4, Greenhouse 4, Lever 4), after those fixes: 1 wrong write
  on 1 of 12 pages**: Robinhood's demographic-data consent checkbox ticked.
  Bug #36.
- Everything else written on those pages was right, including what the night's
  work targeted: US work authorization and sponsorship left blank for a
  Canadian on every US posting, dial code "+1", citizenship "Canada",
  "previously employed by Amazon / Figma / Robinhood?" answered No from the
  work history, legal-name / preferred-name cards on Lever, current company
  "Kinaxis", Lever and Ashby location pickers "Toronto", arbitration
  agreements and SMS consents left alone.
- After the fixes: round 1 12/12 cases, 172/172 checks; round 2 12/12, 125/125.

### Before/after on identical cases and expectations

The baseline build (`b9aebcc`, `main` when the night started) re-scored with
`E2E_EXT_DIR` against the SAME cases and expectations, the 40 cases that
existed before the held-out round (the branch column is `c7fca08`; `c0b43f3`
passes the same 40). Live SmartRecruiters is left out of both columns
(DataDome).

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
1. **Review and merge** `night/deterministic-autofill` (26 commits on top of
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
3. **Decision #7 needs your call**: consent checkboxes are ticked or not
   depending on incidental classification today (only the demographic case is
   fixed). Choose "tick clear application consent" or "never tick", and I would
   enforce it in `shared/selection.ts`.
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
- **Misses the held-out pages showed (blank, never wrong; not fixed):** Ashby's
  education Start/End month-year selects and "Still Student?"; Gecko's Ashby
  location combobox (filled on the other Ashby pages); Workable TSA's
  city/postcode/country sub-fields; "Based in Austin, TX?" (should be NO for a
  Toronto applicant); graduation-range options ("January - June 2027") could be
  matched when the profile has a month (it usually has only the year).
- **Known intermittent (not fixed):** Greenhouse's async School react-select
  (ZipRecruiter, Robinhood) sometimes ignores the extension's interaction in
  combined runs, about 1 in 5 ("Couldn't open the dropdown"): the field stays
  blank, never wrong. Run alone it filled 8/8. A probe WITHOUT the extension
  hit the same thing once in 13 tries (the widget sent no search request at
  all), so it looks like page readiness, not matching. No reliable repro, so no
  fix I could verify.
- **Partial answers (right but incomplete):** "Where do you live? (City and
  State/Province)" gets "Toronto" (no province); a graduation asked as "(Term &
  Year)" gets "2027".

**Housekeeping**
- Live e2e cases use real postings that will expire. Re-capture with
  `node test/e2e/capture.mjs` (edit `TARGETS`) and update `cases/real-live*.mjs`.
- HAR recordings of every captured page (203 MB, full-fidelity offline replay)
  are in `chrome-extension/test/e2e/results/har/` (gitignored, local only).
- The result JSON/text of every run quoted in section 4 is in
  `chrome-extension/test/e2e/results/` (gitignored): `final5-all` (final, 64
  cases), `final3-all` (with live SmartRecruiters), `heldout-1` and
  `heldout2-1` (the two blind held-out passes), `baseline-rescored` (b9aebcc on the same cases),
  `baseline-live` (first measurement), `round3-live`, `round4-live`.
- Nothing was pushed, deployed, or sent anywhere. The only network writes were
  to the local fake backend.
