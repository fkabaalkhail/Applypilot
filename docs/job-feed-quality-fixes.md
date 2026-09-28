# Job feed quality fixes: logos + dead apply links

Investigation + fix plan for two user-reported problems in the job catalogue:
companies showing a letter avatar instead of their logo, and Apply leading to
a 404 / "job no longer available". First pass 2026-07-16 (this section);
second pass 2026-09-27 (at the end), when both problems were back.

## Problem 1: logos render as a letter on a colored square (esp. LinkedIn)

### Root cause (evidence from prod `divine-base-11638078`, main branch)
- Active catalogue = 5,417 rows. Logo storage: **45% (2,452) hold a Google-favicon
  URL**, 40% a real CDN logo, 15% Wikimedia. Every row has a `company_domain`.
- The frontend (`companyLogo.ts` / `CompanyLogo.tsx`) treats a stored `google.com/s2`
  URL as "generated" and rebuilds the chain to a **single** entry:
  `https://www.google.com/s2/favicons?domain=<domain>&sz=256`. `CompanyLogo`
  rejects that image when `naturalWidth < 40` (Google's globe for an unknown/wrong
  domain, or a site that only exposes a 16px favicon), and with no further chain
  entry, falls straight to the **letter avatar**.
- The domain is frequently **guessed from the company name** (`domain_from_name`
  → `<token>.com`), which is wrong for `.io/.ai/.co` companies and abbreviations,
  worst for LinkedIn, where `company_url` is empty so only the name-guess is used.
- The LinkedIn scraper (`scripts/scrape_linkedin.py`) parses only
  title/company/location/url and **discards the `media.licdn.com` company logo**
  the card carries. `ingest_batch` (`jobs.py:317`) calls `resolve_logo(job.company)`
  and **ignores any payload logo**; `IngestJobIn` has no `company_logo` field.

### Fixes
1. `IngestJobIn`: add `company_logo` + `company_domain`; `ingest_batch` uses the
   payload logo/domain when present, falls back to `resolve_logo`.
2. `scrape_linkedin.py`: parse the card logo `<img>` (`data-delayed-url`/`src`) and
   `posted_date`; include them in the payload.
3. Frontend `logoProviderChain`: append a second keyless provider
   (`unavatar.io/<domain>?fallback=false`, which 404s cleanly when it has nothing)
   after the Google favicon, so a Google miss tries a real aggregator before the
   letter avatar. Mirror in the email logo resolver.

## Problem 2: "apply" leads to 404 / "no longer exists" (esp. US jobs)

### Root cause
- The feed shows `active` **and** `stale` (only `removed`/`expired` are hidden).
  Prod: **5,417 active vs 18,343 stale**. The stale rows are dominated by
  **17,334 with `board_key=''`**: the rogue-scraper orphans (killed 2026-07-13)
  that can never be reconciled and went stale en masse ~72h later.
- The URL verifier (`probe_url_liveness`) treats **only HTTP 404/410 as dead**. It
  misses **soft-404s**: probing a real sample showed **4/7 (57%) of old *active*
  LinkedIn rows return HTTP 200 + "No longer accepting applications"**, plus real
  404s among stale (Datadog, Roblox) that the 150/run budget hasn't reached.
- **LinkedIn/Indeed are never verified**: excluded via `_UNPROBEABLE_HOSTS` and not
  covered by the github-only `verify_recent_aggregator_listings`. But the LinkedIn
  **guest view page is body-verifiable** (200 + dead-text), so the "unprobeable"
  assumption is wrong for it.
- `AGGREGATOR_MAX_AGE_DAYS = 30` is far too long for fast-churning LinkedIn/Indeed.

### Fixes
1. `probe_url_liveness`: add body soft-404 detection, gated to trusted
   server-rendered hosts (linkedin/greenhouse/lever/smartrecruiters/taleo/icims).
2. Generalize `verify_recent_aggregator_listings` to cover linkedin/indeed via
   soft-404 (remove/expire dead, never revive on a bare 200); allow LinkedIn
   soft-dead removal in `verify_stale_listings`.
3. Shorten aggregator expiry (~21d) and modestly raise verify budgets to clear the
   stale backlog faster (within the 300s cron timeout).
4. After deploy, trigger `/jobs/cron-freshness` repeatedly to clean the live backlog.

### Deferred product decision (flagged for the user)
Whether to **hide `stale` from the default feed** entirely. It would cut the visible
catalogue from ~24k to ~5k confirmed-active rows (higher link quality) but drop
still-live jobs on non-revivable hosts. Not doing this yet; verification + expiry
clean dead rows without the disruption. Revisit with the user.

## 2026-09-27: second pass (both problems back, root causes measured on prod)

Deployed code at the time: `88689df` (2026-08-14). Visible feed (feed filter
+ non-blank company): **8,948 rows**. A 797-row sample checked against each
platform's own API found 433 dead / 301 alive / 63 indeterminate; the rough
lower bound was **≥3,200 dead-but-visible rows, about a third of the feed**.

### Dead links: root causes

1. **The verifier revived dead Workday and SmartRecruiters rows.** Workday job
   pages return the same ~6.5 KB app shell (HTTP 200) for live, closed and
   made-up job ids, and `careers.smartrecruiters.com` links 302 to the
   employer's careers home either way; both hosts were on the "a 200 means
   alive" list. Dead rows looped forever: stale after 72 h, revived by the
   verifier, stale again. 2,234 active rows had been revived and never
   re-confirmed (Workday 2,071 on 19 boards, Bosch 163); 53/60 sampled were
   closed per Workday's CxS API (403 `errorCode: S22`), 10/20 Bosch rows
   `active: false`. Each verifier run revived 71-194 rows.
2. **The probe missed 87% of dead links.** Of 433 dead rows the old probe
   called 361 alive: it only trusted 404/410 plus page text on 6 hosts, and
   ignored redirects to error pages (Bombardier, Jobvite), SPAs (Ashby, Oracle
   HCM), custom-domain Greenhouse (`gh_jid`, Cloudflare-walled) and Taleo's
   "Career Section Unavailable".
3. **Big boards never reconciled.** Workday stopped at 8 pages x 20 = 160
   postings and SmartRecruiters at 500, so BMO (1,012 postings), CIBC (513),
   Salesforce (1,521) and Bosch (4,800) always came back partial, and a partial
   crawl confirmed nothing and removed nothing. 16 Workday tenants with 922
   visible rows had no CxS template at all.
4. **The verifier never reached old rows.** Newest-first ordering plus a 20 h
   recheck, with the revive loop eating ~66% of the budget: 2,428 visible stale
   rows had not been probed in 30+ days.
5. **Stale rows never ended.** 3,583 visible stale rows, all over 60 days old,
   87% dead in the sample. 2,662 of them sat on `board_key='unknown'` (the
   retired external scraper's rows), which no crawl reconciles and no expiry
   rule covered; its LinkedIn cards were stored as `source_platform='ats'` and
   escaped the 21-day LinkedIn expiry.
6. **GitHub-list rows were future-dated.** Year-less dates ("Nov 30") got the
   current year: all 276 visible GitHub rows had `posted_date` after they were
   first seen, 161 were in the future and were the top 161 rows of the default
   feed, and they never aged out. 140 were `?utm_source=vansh` twins of
   another row, and every company name kept its markdown (`**Tesla**`).
7. **The schedule itself degraded.** The "hourly" GitHub cron delivered 23
   runs a day until 2026-08-25 and ~5.7 a day from 2026-08-27 (median gap
   4.1 h, shard 1 once uncrawled for 38.5 h), every curl ended in `|| true` so
   a failing endpoint still showed green, and the public repo's last commit
   (2026-08-14) put the workflow on course for GitHub's 60-day inactivity
   auto-disable around 2026-10-13, the way the external scraper's workflow
   died on 2026-08-26.

### Letter avatars: root causes

1. **Name-guessed domains.** `company_domain` was `<name>.com` for most
   no-logo companies: of 250 no-logo companies, 142 homepages failed to
   connect (97 NXDOMAIN), 12 were GoDaddy parked pages (s2 returned GoDaddy's
   logo), and 25 of 47 verifiable domains were wrong (`notionashby.com` for
   notion.so, `keplercommunications.com` for kepler.space). s2 hit 22.8% on
   stored domains vs 80% on corrected ones.
2. **No propagation by company.** 81 of the 250 companies (1,371 rows,
   49.5%) already had a real logo on another row; nothing copied it (BMO's
   LinkedIn row had one, its 1,136 cron-ats rows did not).
3. **Harvester order and give-up.** The homepage of the guessed domain came
   first (7.6% yield), LinkedIn last (89% yield on the guest job page); any
   failure wrote a permanent sentinel; og:image banners and parked-page icons
   were stored as logos.
4. **Frontend fallback.** unavatar (25 requests a day per IP, 16-32 px icons
   with no size check) was the last step before the letter; 172 of the 250
   companies depended on it. `**Tesla**` rendered a `*` avatar.

### Fixes (waves 1 and 2)

- **Platform-aware liveness** (`services/platform_liveness.py`): Workday CxS
  (S21/S22 dead, the one documented 403 exception), SmartRecruiters, Greenhouse
  boards-api and `gh_jid` embed, Lever, Ashby board membership, Oracle HCM,
  LinkedIn's closed markers; any other host is trusted only for death signals
  in VISIBLE text, error redirects and off-site bounces to a careers home.
  Only the platform's own API may revive a row. Checked live: 21/21 known
  postings matched the ground truth.
- **Lifecycle** (`listing_freshness.py`): `last_probed_at` for every check,
  `last_seen_at` for positive evidence only; least-recently-probed rotation
  with bigger time-boxed budgets (600 stale, 150 unconfirmed-active, 200
  aggregator per run); terminal expiry (stale 21 days without evidence;
  unreconcilable boards 30 days); aggregator expiry by URL host and from the
  earliest date.
- **Crawlers** (`ats_scraper.py`, cron-ats): full Workday (100 pages) and
  SmartRecruiters (20 pages) pagination under a 150 s list budget; partial
  crawls confirm what they listed; 16 new Workday tenants;
  `jobs.smartrecruiters.com` URLs; least-recently-crawled shard; concurrent
  crawls.
- **GitHub lists** (`markdown_parser.py`, `aggregator.py`): correct years,
  clean names, outer badge links, HTML tables, closed/vanished rows removed,
  renamed repos followed, transient errors retried.
- **Logos**: self-hosted store (`company_logos`, `GET /jobs/logo/{sha}`),
  propagation by company, identity-first harvester cascade (LinkedIn, ATS,
  verified homepage, Wikidata, s2) with image validation and normalization,
  miss backoff instead of a permanent sentinel, registry domains instead of
  name guesses; frontend chain without unavatar, size-checked, cleaned names.
- **Frontend**: closed-job badge + disabled Apply, click-time
  `POST /jobs/{id}/check-live`, deep links that stay open.
- **Workflow**: second cron entry (`:47`), concurrency group, a read-only
  check that turns the run red from day 50 of GitHub's 60-day inactivity
  clock (no automated re-enable; read-only token), every endpoint's status
  and body logged and the run turned red on any non-2xx.
- **One-time cleanup**: `backend/scripts/cleanup_feed.py` (dry run by default,
  see `docs/ingestion-pipeline.md`).

### Measured projection (read-only dry run on prod, 2026-09-28 03:36Z)

`cleanup_feed.py --limit 300 --sample`, no writes (statement guard + read-only
transactions):

| Step | Effect on the visible feed |
|---|---|
| Start | 8,948 visible |
| a: GitHub fixes | 739 dates moved back a year, 1,170 company names cleaned, 555 utm twins hidden (135 visible) |
| b: sweeps | 34 rows go stale (still visible); aggregator expiry hides 342; terminal expiry hides 1,658 |
| After a+b | **6,813** |
| c: liveness, 300-row random sample of the 6,813 | 123 dead (41%: Workday S22 95, Bombardier error redirect 13, Oracle 5, `gh_jid` embed 4, ...), 112 confirmed, 3 revived, 62 unverified |
| After c, whole pool at 41% | **~4,020** |

What stays unverifiable after the cleanup: LinkedIn rows the guest page
rate-limits (429) or shows without a verdict, all Indeed rows (Cloudflare
walls every probe; the 21-day expiry covers them), a few Eightfold, iCIMS
and vanity career sites. Those rely on the age-out rules.
