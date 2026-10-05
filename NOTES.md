# Round 4: real users first, then new ground (2026-10-04, night)

Branch `night/autofill-round4`, from main at 775ff09. Local only: NOT pushed,
NOT deployed. Nothing was submitted anywhere: every live run blocks non-GET
requests (GraphQL queries aside), and no account was created on a real site.

## 1. Can Web Store users connect? And a release to upload

**Connecting.** I could not read the Vercel setting myself (the Vercel
connector answers 403 for the team that owns the `resumate` project), so I
checked what the setting does instead. Prod `security_events` shows completed
extension handshakes from the **Store** id (`dadbhjlflnljgailcpgehdainjdmjeej`)
on 2026-07-14, 08-07, 09-14 and 09-28, and no rejected redirect since
2026-06-27. Store installs can connect today. Please still look at
`EXTENSION_ALLOWED_IDS` on the dashboard (it should hold both ids,
`apgogjfdpleeajnngkfkfekbddcpodkl,dadbhjlflnljgailcpgehdainjdmjeej`); I did
not change any Vercel setting.

**Release 0.5.0, ready to upload (I did not upload it).** The Store still
serves 0.4.0 from July 15 (3 users), and every real fill in prod telemetry
since then ran on it. `chrome-extension/tailrd-extension-0.5.0.zip`, built
from commit 585c0fd (221 KB; checked: 8 files, no dev URLs, no key). What to do, the release notes and two listing lines that
are now out of date are in `docs/store-submission.md` ("Release 0.5.0").

**Real fills since 2026-10-04:** none in prod `autofill_reports`. The last
real ones (2026-09-28, 10-03) ran the July build; what they got wrong was
re-run on the current build first (batch R below).

## 2. How it was measured

Each batch was run blind on the build before its fixes, every write read with
`tools/review.cjs`, then fixed, re-run live and pinned.

| batch | pages | blind run: wrong values | after |
| --- | --- | --- | --- |
| R: the real users' pages (Greenhouse embeds) | 4 | 1, on 1 page (Waymo) | 0; pinned |
| 1: SmartRecruiters, JazzHR, Breezy, Workable | 5 usable (SmartRecruiters' DataDome blocks every page after the first) | 8, all on the JazzHR page | 0; pinned |
| 2: Greenhouse, 13 companies on their own career sites | 13 | 5, on 4 pages | 0; pinned |

Then a **question bank**: the public Greenhouse API serves every posting's
questions, so 80 postings (806 distinct questions) were rendered as forms and
answered for six personas at once (`test/qbank.test.ts`, opt-in with `QBANK`).
Reading 4,800 answers that way found far more than live pages could: about 40
wrong answers, each fixed with a test. It is code-level (no live widget), so
anything it found was also checked by a unit test and, where the page was in a
batch, live.

New personas (synthetic, `test/e2e/profiles.mjs`): a US worker on H-1B, one on
STEM OPT, a bootcamp graduate with a career gap and a disability, a Berlin
engineer (German Diplom, transgender, bisexual), and an Indian new graduate.

## 3. Wrong answers fixed

Live pages (the value written, and now):

| page | question | wrote | now |
| --- | --- | --- | --- |
| Waymo (real-user page) | Do you require work authorization? (Canadian, US job) | No | Yes |
| JazzHR, Directors Investment Group | misrepresentation statement (I consent / I do not Consent) | I do not Consent | I consent |
| JazzHR | second Institution Name and Major | the first school's | the second school's |
| JazzHR | second Employer Name | the current employer | the previous one |
| JazzHR | each employer's Address (x2) | the applicant's street | blank |
| JazzHR | each school's Location (x2) | the applicant's city | blank |
| Duolingo | "After the OPT, eligible for a 24-month OPT extension?" (US citizen) | Yes | No |
| Duolingo | Alternate Email | the same email | blank |
| Coveo | member of the 2SLGBTQI+ community? (bisexual, transgender) | Prefer not to say | Yes / Oui |
| Cloudflare | Legal Name (if different than above) | the same name | blank |
| Accenture Federal | Degree, the high-school row | Technical Diploma | High School Diploma/GED |
| Epic Games | Degree, the high-school row | (unseen) | High School / Secondary Education |

Question bank (each also a unit test):

| company | question | wrote | now |
| --- | --- | --- | --- |
| Sony Music, DoorDash | "…require sponsorship (e.g., H-1B, E-3, TN, O-1, STEM OPT…)?" for applicants needing it | No | Yes |
| Toast | "Do you now, or will you ever, require sponsorship?" (OPT) | No | Yes |
| Datadog | authorized to work here? (Berlin, India) | Yes, but I will need sponsorship | No, I need sponsorship now |
| Peloton | "By selecting Yes you confirm you do not require sponsorship" | the inverse, for everyone | the statement |
| Peloton | able to commute to the NYC HQ "(located at …)" | No for everyone (the office's address read as the applicant's) | Yes if moving, No if not |
| Nuro | 4 days a week "in our Mountain View, CA headquarters" (Seattle, will not move) | Yes | No |
| Sentinel (JazzHR) | "work out of our Wakefield, MA office 1 day per week" (Austin, will not move) | Yes | No |
| Relativity | "willing to commute and/or relocate? If not, explain" (text) | the applicant's city | Yes / blank |
| Squarespace | "Do you plan to move out of your state in 6-12 months?" | the current state | "I have no plans to move" / blank |
| Squarespace | most recently attended school (Turing School) | Parsons School of Design | blank |
| Waymo | state/region of residence (Berlin, India) | Other | EMEA, APAC |
| Samsara | enrolled in a bachelor's or graduated in the past 2 years (June 2026 graduate) | No | Yes |
| Stripe | "When do you expect to complete your degree?" | the degree's name | April 2027 / blank |
| Canonical | bachelor's degree result, with its grading system | the school and degree | 3.7/4.0 / blank |
| Duolingo | Undergraduate GPA (her GPA is the master's) | 3.85 | blank |
| Jane Street | Secondary Major / University Email Address | the major / the personal email | blank |
| K1 (JazzHR) | undergraduate graduation year | 2016 (the master's) | 2015 |
| Glossier | days you cannot work | the start date | blank |
| StackAdapt | salary expectations (hourly) | 185,000 | blank |
| Nuro | U.S. driver's license held 3 consecutive years (Toronto, Berlin) | Yes | blank |
| Bandwidth | how did you hear (stated "Company website") | NSBE's career site | Other |
| Twilio, Gusto, Coinbase… | how did you hear (stated "Social media") | Twitter / Facebook | Other / blank |
| Block | signature box (type your full name) | the last name | the full name |
| Pinterest | "…please list the type of support you may require" | Yes / No | blank |
| Affirm | how did you hear (stated "Job board") | Affirm's Career Site | the job board |
| AlayaCare | years of fullstack experience (Python/React) | the career total | blank |
| Sweetgreen | consent to the video recording itself | I consent | blank (yours) |
| GitLab | sponsorship to remain in your location (Berlin citizen) | Yes | No |

**False failures** (written right, reported wrong): Waymo's phone "did not
stick" (read back as +14165550142), Greenhouse's "+1" reverted, Duolingo's
13 "didn't stick" (its widgets read back), Workday's month/range/veteran
"reverts", a running job's To date, Epic's Country.

## 4. Blanks now answered

- **Epic Games**: 16 dropdowns built on an older react-select (no combobox
  role) were invisible, then unlabelled; work authorization, sponsorship, how
  you heard, 40 hours a week, two acknowledgements, School/Degree/Discipline.
  13 fields filled before, 23 now.
- **Job's country on company career sites**: "Location" label/value pairs
  (Epic), the line under the job title (Databricks). Without it, work-right
  and sponsorship questions stayed blank.
- Seattle's city on Greenhouse (the lookup lists it twice); GitLab's visa
  list ("Yes, but not one of the visas listed here", "Yes, F-1 Visa OPT");
  Airbnb's "Yes … now / Yes … in the future".
- Export-control lists of embargoed places: "None of the above" when none of
  the applicant's countries is listed (Databricks).
- Graduates: "Earlier than Fall 2026", "Prior to December 2025", "Already
  graduated", "N/A (I have graduated already)".
- Start dates: onboarding date, start year, "available to begin before
  September 2028".
- Acknowledgements: Coinbase's AI notice, OneTrust/Samsara "Acknowledge/
  Confirm", Riot's E-Verify notice for everyone (a "Select..." placeholder
  had counted as an option).
- EEO in other words: "Black / Of African descent", a cisgender woman among
  transgender-only qualified options.

## 5. Decisions (one rule each, each easy to reverse)

1. A label that lists the applicant's own status as sponsorship ("e.g., …
   STEM OPT") makes "now" Yes; otherwise an OPT/EAD holder needs it later,
   not now.
2. A visa list: the applicant's visa, else "not listed"; no visa stated, blank.
3. A school is matched by its own words; no match leaves it blank (never
   "My school is not listed").
4. The profile's one GPA belongs to its main degree: blank for an
   undergraduate GPA when the main degree is a master's.
5. Plans to move: "no plans" only for someone who will not relocate.
6. Pledges about your own words or no AI use (Canonical, Twilio) stay blank:
   Tailrd may have written the words.
7. Consent to being recorded stays yours even when it is the only option.
8. Embargoed-place lists: answered only when every fact the question asks
   about is known and none of your countries is listed.
9. "Social media" is no particular platform; "Company website" is only the
   company's own site.
10. Old react-select widgets (aria-autocomplete="list", emotion class names)
    are dropdowns.

## 6. Regression

All 157 pinned pages from rounds 1 to 4, headful, in 13 batches (build of
bf9c7fc): 143 passed. The other 14 were re-run on the final build:

- 8 passed: four fixed during the run (Figma's "Other", Shield AI's "local
  to or willing to relocate", Hermeus' U.S.-person option, and hCaptcha's own
  frame showing up in the page dump), four were page-load flakes (GitAI,
  Figma, Mindex, Waymo).
- 5 now answer questions they used to leave blank; each answer was read and
  then pinned: Sentinel (No to the Wakefield office from Austin, Yes to the
  US work right), K1 (undergraduate year 2015, LinkedIn, the commute, Southern
  California), D2L (eligible in Canada), DoorDash ("Before December 2027").
  Commvault's channel for a stated "Job board" is now blank (it was the
  company's career page).
- 1, Bosch on SmartRecruiters, now sits behind a Cloudflare challenge that
  needs a POST; live runs block it.

Also on the final build: unit tests 1713/1713, type check clean, scan smoke
passed, and every multi-page probe: Workday one click to Review 73/73, the
generic multi-page flow, Workday account creation and its gate, the
react-select driver, Workday churn.

## 7. Needs you / needs manual verification

**Your decisions**
1. **Upload 0.5.0** (`tailrd-extension-0.5.0.zip`) and consider the two
   listing lines in `docs/store-submission.md`. I did not upload anything.
2. **Look at `EXTENSION_ALLOWED_IDS` on Vercel** (both ids); the evidence
   says it works, but I could not read it.
3. **Legal waivers are inconsistent.** Anthropic's and Roblox's arbitration
   agreements are accepted (round 3's decision 8: a lone acknowledgement is
   answered); Block's (a lone "Accept" checkbox) and Sweetgreen's ("Have you
   read and do you agree to the Arbitration Agreement?" with a lone Yes) stay
   blank. Say which you want for all of them.
4. **Does OpenAI work now?** Prod shows no AI output since 2026-08-25
   (`job_match_scores`). If it does, I can find a safe way to run real
   `/api/fill` answers in the lab; none of this round used the AI.

**Not verified live**
- School and Degree on Epic go to the AI with the real options (Turing
  School and "Certificate" are not in Greenhouse's lists).
- Breezy's work-history rows ("Start dateEnd dateDelete" label) need a page
  capture.
- Airbnb's career site (no form found) and AlayaCare (its Apply button times
  out in the harness).
- SmartRecruiters past the first page (DataDome, not allowed to bypass).

# One Autofill click to the end of a Workday application (2026-10-04, night)

You asked to finish a full Workday application with a single Autofill click:
the next page shows at the bottom of the panel and the flow carries on by
itself, without another Autofill click, to the end. Same branch, still local
only: NOT pushed, NOT deployed. Nothing was submitted anywhere.

**What it does now.** Click Autofill once on the job posting. The flow opens
the application (Apply, then Apply Manually), creates the account with the
email and password saved under Autofill Information > Account creation, and
fills each page. When a page is filled, the panel's bottom button counts down
("Next page in 2s ▶", or "Create Account in 2s ▶" on the account page) and
the page turns by itself. It stops on the Review page and never clicks Submit.

- Press the button to go at once.
- **Pause** (beside it) holds the page: the button becomes "Continue To The
  Next Page ▶" and waits for you. Clicking or typing in the page while it
  counts down holds it the same way. A hold lasts one page.
- A page with a required question still empty waits for you, as before.
- If you turn a page with the site's own button, the flow follows and fills
  the new page.
- Off switch: `flowAutoContinue` in the extension's settings (on by default,
  no panel toggle yet; the e2e harness turns it off).

**How it was tested.** A real Workday application needs an account and real
submissions, both off limits here. So I built a replica of one
(`test/browser/fixtures/workdayReplica.mjs`), served under a real Workday
address so the extension's Workday code runs, with Workday's field names
taken from Workday's own application code (the Capital One page capture in
`test/e2e/results/har/`). It has the posting, the Apply Manually chooser,
Create Account (hidden consent box, live password rules, and the click
overlay Workday puts over that button, whose handler is on the overlay), My
Information, My Experience (rows behind
Add buttons, month/year boxes, search lists, the résumé drop zone),
Application Questions, Voluntary Disclosures, Self Identify and Review, as one
app with one reused footer button, loading skeletons and re-renders. What is
checked is what each page itself registered when it was saved.

`npm run test:workday-flow`, real Chromium, the packaged extension, a US
applicant with three jobs, a degree, EEO answers and a résumé:

| scenario | result |
| --- | --- |
| one click on the posting, then hands off | Review in about 47 s; all six steps saved in order, none rejected; 40 checks on what each page registered (55 answers); Submit never clicked (48/48) |
| Pause on a counting page | held 5 s, Continue turned it, the rest by itself (9/9) |
| clicking into the page during the countdown | held the same way (7/7) |
| the site's own Save and Continue during the countdown | followed, next page filled, nothing skipped or saved twice (9/9) |

**What the replica caught.** These would have stopped or corrupted a real
Workday application. All fixed, each with a test that fails on the old code:

| page | problem | now |
| --- | --- | --- |
| My Information | State (Workday's `countryRegion`) read as the country: no option matched, left empty | "Texas" |
| My Information | Phone Device Type read as the phone number: left empty | "Mobile" |
| My Information | Phone Extension read as the phone number: the number was typed into it | left blank, never guessed (nor asked of the AI) |
| any page with a required radio question | the flow believed answered radio groups were empty and waited ("Have you previously worked for Acme?"); older than this work | fixed |
| My Experience | dates written like "Jun 2012" were typed whole into each box: the Month box read "2012" | month 6, year 2012 |
| My Experience | the education "To (Actual or Expected)" year (`lastYearAttended`) never filled | the graduation year |
| Voluntary Disclosures | ethnicity read as the city ("ethni**city**Dropdown"): left empty | the stated race |
| Self Identify | the date was recognized too weakly to be filled | today's date |
| Self Identify | the disability boxes ("Please check one of the boxes below:") were not recognized as the disability question; "Prefer not to say" found no "I do not want to answer"; an answer with a comma came out twice | "I do not want to answer" |
| Review | no fields on the page, so the flow ended with "No application form found" and never set up Submit tracking | ends at Review; your submit is recorded in the dashboard |

Also fixed: `comboboxEngine.ts` had a literal NUL byte in a string since
August, so git treated it as binary (its diffs read "Binary files differ").

**Your three rules.** Kept, with one refinement to the in-person rule:
occasional visits (team gatherings, offsites, a few trips a year, a quarterly
visit) are not in-person work, so someone who will not relocate no longer
gets No for them. A regular schedule with occasional offsites still counts as
in-person. Enrollment and U.S. clearance rules unchanged.

**Decisions** (each easy to change)
1. The countdown is 2 seconds (`AUTO_ADVANCE_MS` in `flowController.ts`).
2. The account page turns by itself again, with your saved credentials. An
   August change had made it wait for a press; that was not something you
   asked for.
3. A hold (Pause, or touching the page) lasts one page, not the whole run.
4. A press restarts the flow's 10-minute limit, so a page you held while
   reading no longer times out when you press Continue.

**Tests**
- Unit: 1619/1619 (134 files). Type check clean.
- Browser: Workday replica 73/73; the generic multi-page probe (now
  hands-free), the Workday account and account-gate probes, the churn,
  shadow-click and driver probes, extension load: all pass. Browser suite
  19/19.
- Live pinned pages touched by today's shared changes (decline wording,
  disability/veteran groups, every page with a checkbox group): 37 pages and
  the synthetic Workday forms. All pass. Four pins changed on purpose:
  three held-out Lever pages now take the form's decline for an applicant who
  stated no disability answer (as every other EEO question already did;
  "I do not want to answer" was not recognized as a decline), and the
  synthetic Workday form's ethnicity is now answered. Two pages (Workable
  FSSI, Rippling 4AG) missed one field on the first run and passed on a rerun.

**Needs you / manual verification**
- **A real Workday application, end to end.** Not testable here. In
  particular, unverified on real Workday:
  - its live password-rule messages: if they stay on screen once the
    password is valid, the flow reads them as errors and waits on the
    account page for one press;
  - tenants that send a verification email after Create Account: the flow
    stops there; after verifying and signing in, click Autofill again;
  - whether a tenant uses the older ids (`addressSection_countryRegion`,
    `phone-device-type`) or the newer ones (`formField-countryRegion`,
    `formField-phoneType`): both are handled, only the older ones were in the
    replica.
- **The AI path.** These runs use a dead AI, so what the AI writes for the
  fields still sent to it (role descriptions, essays) was not seen.
- **Known noise.** The extension's own report flags some correct Workday
  answers as "reverted": a month box compared with the whole date, a
  dropdown answer compared with the profile's wording ("6" vs "5-7 years").
  The pages hold the right values; only the self-report is wrong. Telemetry
  only, nothing on screen.

# Round 3: new forms, new people (2026-10-03, night)

You asked to keep going and to vary the data, the cases and the forms. Same
branch, still local only: NOT pushed, NOT deployed. Nothing was submitted
(every non-GET request blocked except GraphQL queries and, on Paylocity only,
its read-only email lookup).

**What ran.** Five new synthetic people (in `test/e2e/profiles.mjs`, no real
data) on 33 live postings from prod `scraped_jobs`, chosen so the job and the
applicant disagree in useful ways:

| person | what makes them different |
| --- | --- |
| US veteran, Austin | Army service, an active clearance with no level, will not relocate, prefers remote |
| London senior engineer | UK only, MSc 2016 and BA 2015, transgender woman, bisexual, a stated disability |
| Montreal career changer | French degree names, teacher then developer, non-binary, Hispanic, education listed oldest first |
| Calgary new grad | no work history, declines every EEO question, starts next week |
| US green-card student | permanent resident, December 2027 graduation, a TA job and a past internship |

Forms: JazzHR, Breezy, Recruitee, Pinpoint, Paylocity, Oracle (families the
suite had never seen), Greenhouse forms embedded on company sites (MongoDB,
D2L, Zipline, Brex), Workable, BambooHR, Greenhouse, Ashby, Lever, Jobvite.

**TL;DR.** Reading every write found 20 kinds of wrong answer written on
live pages (several on more than one page), 3 more the code would have given
had the page let it, and about 30 blanks a stated fact settles. All are
fixed, each with a test that fails on the old code, and each fix was
re-checked on its live page. Commits `fbbe0bf` to `3975b2c`; the 33 pages
are now pinned (541 checks).

### Wrong answers found (fixed)

| page | question | wrote | now |
| --- | --- | --- | --- |
| Pinpoint | Address lines, Town, Postcode | the LinkedIn URL (a section's legend labelled every field) | the address parts |
| Pinpoint, Paylocity | Address Line 2 | a copy of line 1 | blank (or the unit, "app. 3") |
| Breezy (Vagaro) | years developing with C# / ASP.NET Core | "3+ years" (six years of teaching) | blank (no such experience stated) |
| Breezy (Vagaro) | race, on an EEO-1 combined list | "Two or more races (not Hispanic or Latino)" for a Hispanic applicant | the Hispanic option |
| Breezy (NinjaHoldings) | expected month and year of graduation | "2027" | "December 2027" |
| Breezy (NinjaHoldings) | "What is your major? Please describe why…" | the major alone, in an essay box | left to the essay path |
| Paylocity | how did you hear | "Online Job Board" for a stated "Career fair" | "Other", with "Career fair" in its box |
| Paylocity | an education row's City | the applicant's city | blank (it is the school's) |
| Zipline (embedded Greenhouse) | Location (City) | "San Jose, Costa Rica" for San Jose, CA | San Jose, California |
| Zipline | available next Spring (Jan to Apr/May 2027)? | Yes, for someone who cannot start before late May | No |
| Kenect (Breezy) | hybrid schedule out of Pleasant Grove, Utah? | Yes, for an Austin applicant who will not move | No |
| JazzHR | gender, race | the page's own pre-selected "Decline to answer" kept | the stated answers |
| Robinhood and others | veteran / military status | "never served" guessed from "not a protected veteran" | only what the answer says (decided with you) |
| Superhuman (Ashby) | education rows | both rows the latest school, the first row's year | each row its own |
| Superhuman (Ashby) | End Date | "October 2017": the page picks today's month when only a year is chosen | blank |
| Superhuman | sexual orientation | "Lesbian" for "Gay or Lesbian" | left for you |
| Brex, Zoox, Vagaro | gender | a decline for a stated "Non-binary" the list lacks | left for you |
| Zoox (Lever) | currently enrolled in a CS program? | Yes, for a graduate | No |
| Zoox | school schedule allowing part-time at the Foster City office? | Yes, for a developer out of school | No |
| Palantir (Lever) | major | "Other" for an MSc in Computing | Computer Science |
| Anthropic, Mindex | in person at our offices / at the Rochester office? | (code) Yes, from the accept-the-requirement default; live they reached the AI | No, for someone who will not move |
| Twitch | permanent resident after your latest citizenship? | (code) "United States" for a yes/no; the page refused it | No |
| Paylocity | School Type | (code) the school's name; no option took it | "College / University" |

### Blanks a stated fact now answers

- **SpaceX:** work authorization offered as five statements ("authorized ... for any employer"), "Citizenship Status" ((b) lawful permanent resident), a major the list lacks ("Other (Technical)").
- **School search lists** that found nothing: "San José State University" (Greenhouse, Ashby), "The University of Texas at Austin" (Greenhouse lists "University of Texas - Austin").
- **Palantir:** the university "last attended", a graduation or high-school year the list does not offer ("Other").
- **Hermeus:** a past internship with its details, a country list for "What is your location?", "If no, will you require sponsorship in the future?".
- **Mindex:** a co-op for a graduate (No), "I currently work here", the Rochester office (No; the page draws its location after the first scan).
- **Zoox:** research and grants for someone out of school (No), a checkbox question that had no label.
- **Paylocity:** per education row, "Did you Graduate?", "Degree Obtained", "Area of Study"; its react-widgets dropdowns now verify (a pick that stuck was reported as failed), and Address Line 1 keeps the street when its autocomplete suggests nothing.
- **Pinpoint:** able to obtain a U.S. clearance (No for a permanent resident).
- **Superhuman:** LinkedIn without "https://" in a URL box, the French degree's field ("Psychologie").
- **Batch B list:** a current MongoDB employee, availability, how soon, "If referred, by who?", 50 states as radios, a lone-Yes consent.

### Decisions (each one rule, easy to reverse)

1. **Education rows are told apart by position** when a form repeats the same
   ids in every row (Ashby). One row on the page is still your main education.
2. **Ashby End Date stays blank for a year-only graduation.** Checked live:
   choosing only the year makes the page set the month to the current one,
   and only the month sets the current year.
3. **Every program finished = not a student**, firmly (it was a "maybe", and
   those questions went to the AI).
4. **A student's questions asked of a graduate:** a co-op, a school schedule,
   research or grants are No; "which degree are you pursuing" and "expected
   graduation" are left blank.
5. **In-person questions that name no full place use the posting's places.**
   An office in your city: Yes. Every office in another state or country, and
   you will not relocate: No. Another city in your own state: yours.
6. **Kept from the AI** (left for you; the AI has the same profile and could
   only guess): government history when a government employer is in it (is
   the Army one?), a clearance level the profile does not name, a high
   school's name, consent to AI notetakers, "If yes, please describe"
   follow-ups, a student's school schedule, a date the profile knows only to
   the month in a day picker, Address Line 2 without a unit.
7. **A U.S. clearance needs U.S. citizenship:** "able to obtain one?" is No
   for a permanent resident or visa holder. A citizen's answer stays yours.
8. **Lists:** a year or school the list does not offer is its own "Other" /
   "not listed" option (native selects only: a search box's loaded options
   are not the whole list). Accents are folded when options are matched.

### Not cases (measured, not testable here)

ADP Workforce Now and iCIMS open their forms only behind a sign-in (no
accounts may be created). A CareerPuck board links out to Greenhouse.
Coinbase opens its form in a new tab, Samsara lazy-loads its iframe only when
scrolled to, Fivetran keeps the form behind an "Application" tab, and both
Rippling postings were taken down.

### Test results

- **Unit:** 1579/1579 (132 files).
- **Round 3, pinned (33 live pages):** 33/33 pages, 541/541 checks on
  `0d08d2f`. The three fixes after it touch none of these pages; Brex-MTL,
  the one candidate, re-ran on `6dfef72`: 20/20.
- **Older pinned suite (86 live pages + 3 framework fixtures):** the first
  run on `0d08d2f` found three regressions (below), all fixed and re-run
  live. Every other difference was read and was an intended round-3 change,
  re-pinned (`8360f68`, `6dfef72`, `079df2b`, `3975b2c`). Final: 88/89. The
  89th is SmartRecruiters' Bosch page, behind its DataDome block on this
  machine, as before this round.
- **Network:** one batch hit DNS failures (`ERR_NAME_NOT_RESOLVED`); its
  pages were re-run and passed. Nothing here is from that batch.

**Harness changes:** a case may let through exact read-only endpoints
(Paylocity's email lookup: blocked, the page broke). The page dump reads a
div combobox's shown value (react-widgets showed as empty before) and numbers
repeated label keys, so a second education row can be pinned. Ashby radios
are pinned by label (their ids change every load), dates by their shape.

**Found by the regression run (fixed, each with a test):**
- Brex's "Do you currently live in, or plan to relocate to…?" stayed blank:
  its options ("Yes, I live here", "Yes, I plan to relocate") have commas, and
  a comma was all it took to read a list as places (`7b6657b` had passed the
  applicant's place to the react-select driver). A place now names a known
  state, province or country, or a name ("Costa Rica"), never a phrase.
- FSSI's "Bachelor's Degree in Computer Science… strongly preferred" got NO
  from the rule meant for Paylocity's "Did you Graduate?", which answered
  outside an education row. It answers in a row only now.
- Paylocity's dropdowns: my first fix read the widget's kept option list as
  its value, so the fill believed a choice was already made. Caught on the
  re-run, fixed before the pins (`0d08d2f`).
- Older than this round: "today" was the UTC day, a day ahead every evening
  in the Americas ("2 weeks from today" at 9 p.m. in Ottawa started a day
  late). It is your own calendar day now.

### Needs you / manual verification

**Decisions you may want to reverse** (each is one rule)
- "Currently enrolled?" is now a firm No once every listed program has
  finished. If a profile lags behind (a new program not added yet), that No
  is wrong until the profile is updated.
- "Able to obtain a U.S. security clearance?" is No for a permanent resident
  or visa holder. U.S. rules grant clearances to citizens (a rare limited
  access for others exists); a citizen's answer is left to them.
- In-person questions get No when every office the posting lists is in
  another state or country and the applicant will not relocate. A remote-
  first company asking about occasional office visits gets the same No.

**Not verified**
- **The AI path.** These runs use a dead AI (the harness's fake API), so what
  the AI writes for the fields still sent to it (essays, "Why X?", the
  questions left to it) was not seen. Fewer fields go to it now: the "kept
  from the AI" list above leaves them for you instead.
- **Paylocity's address autocomplete with a US address.** Verified only that
  a UK street stays when nothing is suggested. If it suggests US addresses,
  the pick path is untested here.
- **Page prefills from the machine's location.** Pinpoint pre-selects
  "Canada" as the address country and Workable (Syntiant) "Gatineau, Canada"
  as the address, from this machine's IP. The extension never overwrites a
  value already in a field, so an applicant abroad keeps the page's guess.
- **Later steps** behind a captcha or the resume wall, as before.
- **Address Line 1 without its unit** when a Line 2 takes it: unit tests
  only; no round-3 page has both for the Montreal persona.

**Known limits**
- Ashby with a year-only graduation leaves End Date blank (month and year to
  fill by hand). Completed degrees store only a year; storing the month
  would let it fill.
- Telemetry still logs Greenhouse's phone country picker as changed ("+1"
  read back for "United States"): no dial-code table.
- Not testable here: ADP and iCIMS (sign-in walls), CareerPuck (link-out),
  Coinbase (new tab), Samsara (lazy iframe), Fivetran (Application tab),
  two taken-down Rippling postings.

---

# Run with your real profile (2026-10-03, evening)

You asked: "run for real with my profile". The extension ran on 40 live
application pages (the complete round's 18 and the fresh round's 22) with your
prod profile. The profile was read with SELECT-only queries and assembled by
the backend's own builder, so the extension saw exactly what prod sends it.
Nothing was submitted: every non-GET request was blocked except GraphQL
queries, so no submissions, uploads or accounts. Your profile copy and the
per-page results stay out of the repo (scratchpad, and the gitignored
`test/e2e/results/`). Same branch, still local only, not pushed, not deployed.

**TL;DR.** The first pass wrote **20 wrong answers (7 causes)** that the test
profiles never triggered, and left **17 questions blank** that your profile
can answer. All are fixed (`93f1d4a`, `5bead3d`, `7c77dac`), each with a test
that fails on the old code. On the fixed build the 20 wrong answers are gone
and the 17 blanks are filled, on the same live pages: 38 in the second full
pass, Robinhood's and Anthropic's in single-page re-runs after their later
fixes (one Lever location dropdown ignored its pick once; a known flaky
widget). What is still blank is missing from your profile (list below) or
genuinely yours to answer: essays, US work authorization and sponsorship,
citizenship, recording consent.

### Wrong answers on the first pass (fixed)

| page(s) | question | wrote | cause | now |
| --- | --- | --- | --- | --- |
| Robinhood, Superhuman | race | one subgroup of a broader answer | the matcher took the first option containing the answer's word, though several options were narrower subgroups of it | left for you: you pick |
| Robinhood | gender identity | a cisgender option | guessed from the gender answer; your gender identity is blank. The list loads only when opened, so the fix needed the retry path too (`5bead3d`) | "I don't wish to answer" |
| ActioNet | current or former government employee? (and 2 follow-ups) | No | the "never a government employee" default ignored your federal internship | left for you |
| ActioNet | Active Clearance/Public Trust? | Yes | your "Active clearance" read as a US clearance | left for you (the AI is kept out too) |
| Lever (Palantir, Hermeus, Zoox, PCC, Neighbor, Arc'teryx, Veeva, Agiloft), Commvault, Rippling (4AG, FluidAI) | Current company | your internship employer | the backend sends the resume's first job whether or not it ended (yours ended 05/2026) | blank |
| Enova | How did you hear? | Campus Career Site | a campus channel was the only "career site" option | LinkedIn (the default order) |
| Anthropic | "the address from which you plan on working? If you would need to relocate, please type \"relocating\"" | your home city | the instruction was ignored; the role is in-office in the US | "relocating" (you said you will relocate) |

### Blanks your profile answers (fixed)

| page(s) | question | now |
| --- | --- | --- |
| 7 of the 8 Lever pages | Current location | "Gatineau, QC, CAN": your bare "Gatineau" matched Gatineau, Quebec and Gatineau, Haiti. On Arc'teryx, Lever ignored the pick once (a known flaky widget) |
| Workable (Mindex, Rave, FSSI) | Title (required) | your internship title, beside the company already filled |
| ActioNet | highest education | Some College |
| SpaceX | GRE | Did not take/Do not recall |
| Voldex | available in Eastern/Pacific hours? | Yes |
| Enova | local to Chicago for summer 2027? | Yes (you are willing to relocate) |
| Netlify | accommodation for the interview? | from the profile's disability answer (No only when it states none) |
| Agiloft | disability (radios with no label) | the option matching the profile's disability answer |
| Planet | how did you first hear about Planet? (required) | Other - Job Site |

### Decisions (new policy; each is one rule, easy to reverse)

1. **An EEO answer broader than the options is left for you**, not declined:
   you stated it, so you pick the subgroup. An exact option still wins.
2. **Gender identity split by cis/trans options needs a stated identity.**
   Without one: an unqualified option that fits ("Man", "Non-binary"), else
   the decline. LGBTQ+ is Yes for a stated orientation or identity that is
   one, No only when both are stated and neither is.
3. **"Current company / title" means a job still running.** The backend sends
   the resume's first job whatever its end date; a field labelled current now
   gets nothing when every job has ended. A bare "Company" / "Title" (an
   experience entry) still gets the most recent job.
4. **A clearance holds in your own country.** A question in another country's
   terms ("Public Trust", "TS/SCI", DOE "Q") or on a job abroad is left for
   you; "None" holds everywhere.
5. **No "never a government employee" default when your history has a
   government employer.** A procurement or government OFFICIAL is a role: a
   developer intern's "No" there stands.
6. **Answers from stated facts that were "blank by design" this morning:** an
   interview accommodation is "No" only when the profile states no disability;
   "will you be local to <city>?" follows your relocation answer (as Brex's
   "plan to relocate" already did).
7. **The default "how did you hear" is never a campus channel**, and among
   several job searches it takes the one no brand names.

### Fix in your profile (these are data, not bugs)

1. **Current title is stored as "No".** The extension now ignores it.
2. **Your salary expectation has a stray space inside the number.** It is
   typed as written (Twitch, Planet, BambooHR, Agiloft), and ActioNet's
   number-only box stays blank because it is not a number.
3. **Earliest start 2026-08-28 is in the past**, so start-date questions get
   today (10/03/2026) or "Immediately". Set it if you are applying for summer
   2027 internships.
4. **No expected graduation.** Your education ends "Present"; the 2028 date is
   only in your resume's achievements text, which no field maps. About ten
   pages asked (ZipRecruiter, Astranis, Figma, Robinhood, Palantir, Hermeus,
   Superhuman, Ramp, Brattle, Enova, 4AG). Fill "Expected graduation".
5. **Work authorization is one general "yes".** US-job authorization and
   sponsorship questions stay blank (correct: nothing says what your US
   status is). Fill "Authorized to work in the US" and "in Canada".
6. **Gender identity is blank**, so cis/trans-split identity questions and
   LGBTQ+ decline. Fill it if you want them answered.
7. **No GPA, languages, cover letter or "how did you hear"**: those questions
   stay blank or take the defaults.

Items 4 and 5 are the new profile fields from today: they persist only once
the backend and web app are deployed together.

### Test results

- **Unit:** 1443/1443 (129 files).
- **Your profile, live (40 pages, nothing submitted):** first pass (build
  `a497700`) 540 writes, 20 of them wrong; second pass (build `93f1d4a`) 538
  writes, 18 of the 20 gone and the 17 blanks filled; the last two (Robinhood
  identity, Anthropic address) fixed and verified page by page on the final
  build.
- **Pinned regression suite** (`results/after-real`, build `5bead3d`): 1457/1490
  checks. Every miss was read: 11 cases differ by the intended answers above
  (re-pinned), one posting was taken down (Workable TSA: API 404, removed
  from the suite), one is SmartRecruiters' DataDome block on this machine (as
  before).
- **Final build, full re-run (`results/final-real`): stopped by the system
  for low memory after 36 of 104 cases, all 36 passing** (9 of the 12
  re-pinned cases among them, Anthropic's "relocating" included). The other
  68 were not re-run on the final build; they passed on `5bead3d` apart from
  the two above, and the final build's later changes (the relocation
  instruction, the dumper's uuid keys) touch none of their questions.
  Re-run with `node build.mjs && node test/e2e/run.mjs` when memory allows.

### Needs you / manual verification

**Your decisions** (both settled later the same evening)
- **Military status:** no longer inferred. "I am not a protected veteran"
  fills only an option saying exactly that; the profile gained "I have never
  served in the military", which fills every never-served wording (`fbbe0bf`,
  see Round 3 above).
- **Planet's "How did you find this position?"** keeps "Other - Job Site", as
  you confirmed: job sites come first in the default order (a posting found
  through Tailrd was found on a job site).

**Not verified**
- **Resume attach:** not exercised (uploads are blocked in these runs). Your
  stored PDF exists in prod (`has_file` true), so auto-attach has a file.
- **Later steps:** 17 pages stop at the captcha and 12 at "attach your resume"
  after step 1, so a second page of questions (if any) was not seen.
- **The follow-up dialog** that asks you about what stays blank (the race
  subgroup, for one) was not opened in these runs.
- **Flaky widgets, both seen with test profiles too:** Lever's location
  (Arc'teryx ignored the pick once) and Rippling FluidAI's location ("couldn't
  open the dropdown").

**Backend follow-up (not changed tonight)**
- `backend/routers/profile.py:431` sends the resume's first job as
  `currentCompany` whatever its end date, and `currentTitle` falls back to
  that job's title only when the stored job title is empty (yours holds "No",
  so the fallback never runs). The extension compensates now; anything else
  reading the profile still sees an ended internship as current.
- The stored title "No" most likely came from the extension's old follow-up
  dialog saving a yes/no into the title slot; that save is blocked since
  `3c0c919`. Onboarding no longer writes the job function there (`a497700`).

---

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
  once (filled in the previous run); Greenhouse's async School dropdown
  (Robinhood) as before. (SpaceX's GRE was listed here as a dropdown that
  opened too late. Wrong: it was blank on every run, because its two "did not
  take" options tied. Fixed in the real-profile run, see the top section.)
- **Still blank by design:** essays, opinions, skill-specific questions
  ("experience with AI?", years of Roblox Studio), the applicant's
  extracurriculars, interview-recording consent, sponsorship TYPE.
  (Accommodation requests and "local to Chicago for summer 2027?" were on this
  list; the real-profile run answers them from stated facts now, see the top
  section.)

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
