# Job Ingestion Pipeline

How Tailrd sources, structures, deduplicates, and (most importantly)
**keeps fresh** its job catalogue. The design goal is to beat aggregator
competitors (Jobright et al.) on the axes they are weakest: ghost/expired
listings, low-trust reposted data, and unexplained matching. Volume is not the
goal; a smaller catalogue where every listing is real and current is.

## Architecture at a glance

```
GitHub Actions (minutes 17 and 47)          Vercel serverless (FastAPI)
┌──────────────────────────────┐            ┌─────────────────────────────────┐
│ 60-day inactivity check      │            │                                 │
│ scripts/scrape_jobspy.py     │──POST────▶│ /jobs/ingest-batch   (Tier 3)   │
│ scripts/scrape_linkedin.py   │──POST────▶│                                 │
│                              │            │ /github-sources/cron-ats        │
│ curl cron-ats  ──────────────┼───────────▶│   least-recently-crawled shard │
│ curl cron-poll ──────────────┼───────────▶│   GitHub lists       (Tier 2)  │
│ curl cron-backfill ──────────┼───────────▶│   descriptions/locations/logos │
│ curl cron-freshness ─────────┼───────────▶│   expiry + platform liveness   │
│ curl ingest-metrics (log) ───┼───────────▶│   pipeline health snapshot     │
│ fail the run on any non-2xx  │            │                                 │
└──────────────────────────────┘            │ GET  /jobs/logo/{sha}.png|svg   │
                                            │ POST /jobs/{id}/check-live      │
Browser (job feed) ─────────────────────────▶│   (logos, click-time liveness) │
                                            └────────────────┬────────────────┘
                                                             ▼
                                                     Neon Postgres
                                        (scraped_jobs, source_health, company_logos)
```

Key modules:

| Path | Role |
|---|---|
| `backend/services/ats_scraper.py` | Tier-1 connectors (Greenhouse, Lever, Ashby, SmartRecruiters, Workday), `BoardSnapshot` |
| `backend/data/ats_companies.json` + `company_registry.py` | Which boards to crawl; sharding (`pick_shard`) |
| `backend/services/structured_extraction.py` | Deterministic salary/visa/skills/employment extraction, content hashing |
| `backend/services/listing_freshness.py` | Lifecycle: reconcile, stale/terminal/aggregator sweeps, verify sweeps, `record_liveness`, ghost scoring |
| `backend/services/platform_liveness.py` | Is this posting still open? Asked through each platform's own API (`check_listing`, `check_listings`) |
| `backend/services/source_health.py` | Per-board circuit breaker + dead-letter view |
| `backend/services/cross_source_dedup.py` | Cross-source twin collapsing (exact + conservative fuzzy), `canonical_url` |
| `backend/services/logo_cache.py` | Self-hosted logo store (`company_logos`), propagation by company, `/jobs/logo` serving |
| `backend/services/logo_harvester.py` + `logo_image.py` | Logo source cascade; image validation and normalization |
| `backend/routers/github_sources.py` (`cron-ats`, `cron-poll`) | Board crawl orchestration, GitHub-list polling |
| `backend/routers/jobs.py` (`ingest-batch`, `cron-backfill`, `cron-freshness`, `ingest-metrics`) | Aggregator ingest, repair, lifecycle cron, metrics |
| `backend/migrations/add_ingestion_freshness.py`, `add_listing_probe_columns.py`, `add_company_logos.py` | Schema migrations (idempotent DDL, run at app startup) |
| `backend/scripts/cleanup_feed.py` | One-time catalogue cleanup (see "One-time scripts") |

## Source tiers and trust

| Tier | Sources | `source_trust` | Notes |
|---|---|---|---|
| 1 | Greenhouse, Lever, Ashby, SmartRecruiters, Workday board APIs | `high` | Employer's own board: canonical copy, direct apply URL |
| 2 | Curated GitHub job lists (cron-poll) | `medium` | Direct links, human-curated, but not the employer's feed |
| 3 | LinkedIn guest API, JobSpy (Indeed/LinkedIn) | `low` | Gap-filler only; never becomes canonical when a direct twin exists |

All Tier-1 fetches use official/public JSON board APIs (the ones built for job
boards to consume), never rendered-HTML scraping of the ATS UI. Requests to a
given API host are spaced by `ATS_PER_HOST_INTERVAL` (default 0.35 s, one
lock per host). `apply_url`/`source_url` always point at the original
posting: we never present another platform's listing as ours.

### Crawl orchestration (cron-ats)

- **Shard choice:** the registry is split into `CRON_ATS_SHARDS` shards
  (default: sized so a run crawls ~150 boards). Each run crawls the shard
  whose most recent `source_health.last_success_at` is OLDEST
  (`pick_shard`); a never-crawled shard goes first. The old
  `hour % shard_count` starved a shard whenever GitHub kept skipping the
  same hours (shard 1 once went 38.5 h without a crawl).
- **Concurrency:** up to `CRON_ATS_CONCURRENCY` (default 6) boards crawl at
  once, never two on the same API host, Workday and SmartRecruiters first
  (they page the longest).
- **List budget:** paging past a board's newest-first head stops once
  `CRON_ATS_LIST_BUDGET_SECONDS` (default 150 s, from the start of the run)
  is spent. Such a board finishes partial for this run.

### Workday specifics

Workday has no global board API; each tenant exposes a CxS JSON endpoint.
A registry entry is scrapeable only when it carries the endpoint base:

```json
{
  "company_name": "BMO",
  "ats_platform": "workday",
  "board_slug": "bmo",
  "workday_url_template": "https://bmo.wd3.myworkdayjobs.com/wday/cxs/bmo/external",
  "enabled": true
}
```

To find a tenant's base: open the company's careers site, watch the network
tab for a POST to `/wday/cxs/{tenant}/{site}/jobs`, and copy everything up to
`/jobs`. `load_companies()` skips a workday entry without a template, so it
would read as covered and never be crawled: an enabled workday entry must
carry one (`test_every_enabled_workday_board_has_a_template`). A company that
is not on a public Workday site is filed under its real system (`custom`,
`avature`, `eightfold`, `successfactors`, `oracle`, `taleo`) and disabled
with the reason. When one tenant hosts several sites, each site takes its
own slug and none takes the bare tenant (BlackBerry and QNX on `bb`, PwC,
RBC, Morgan Stanley). (All 16 tenants that had rows but no template, Magna,
Parsons, Hitachi, Lilly and others, got one in 2026-09. On 2026-09-29 the 28
enabled entries that had never been crawled were sorted out: 9 sites
enabled, 5 held with a template for a product decision or a missing
feature, 17 filed under their real system, and a duplicate ServiceNow
entry removed.)

The connector pages the WHOLE list, 20 postings per POST, up to
`WORKDAY_MAX_PAGES` (default **100**; prod must not pin it to the old 8).
The first 8 pages are always fetched so new jobs are found; later pages stop
at the run's list budget or at Workday's 2,000-posting listing ceiling. A
snapshot counts as **complete** only when nothing stopped it early, the
reported total is under 2,000, and the distinct URLs cover the total; a list
that shifts mid-crawl reads as partial, never as a takedown. Descriptions
are fetched per NEW job only (`WORKDAY_DETAIL_BUDGET`, 40 per run).

SmartRecruiters works the same way: up to `SMARTRECRUITERS_MAX_PAGES`
(default 20) pages of 100. Apply URLs are
`https://jobs.smartrecruiters.com/{company}/{id}`; the old
`careers.smartrecruiters.com` links 302 to the employer's careers home for
live and closed postings alike, and legacy rows are migrated to the new URL
when the board lists them.

**Partial snapshots confirm, complete ones reconcile.** A complete snapshot
goes through `reconcile_board` (listed rows confirmed or revived, vanished
rows `removed`). A partial one still bumps `last_seen_at` for every stored
row of that board it DID list (`_confirm_listed`, positive evidence is safe)
and only skips the removal half: absence from a partial crawl is not
evidence of removal. Before this, rows past page 8 of BMO (1,012 postings)
or CIBC (513) were never confirmed and never removed.

## The listing lifecycle (freshness)

Every row has a `listing_status` separate from the user's workflow `status`:

```
          board lists it / platform API says open         board stopped listing it
   ┌────────┐ ─────────────────────────▶ last_seen_at bumped   ┌─────────┐
   │ active │ ──────────────────────────────────────────────▶ │ removed │
   └────────┘ ◀── revived (board lists it again, or the        └─────────┘
        │           platform's own API says open)                   ▲
        │ not re-confirmed for 72h                                 │ platform API / honest
        ▼                                                          │ page says dead
   ┌────────┐ ─────────────────────────────────────────────────────┘
   │ stale  │ ──── 21 days without positive evidence ───▶ ┌─────────┐
   └────────┘      (also: aggregator age, unreconcilable) │ expired │
     still visible                                        └─────────┘
```

Feed visibility: `duplicate_of IS NULL AND listing_status IN ('active',
'stale') AND trim(company) != ''`. Rows are **never deleted** (saved jobs and
applications reference them); `removed`/`expired` rows stay in a user's Liked
list with a "No longer accepting applications" badge and a disabled Apply.

### Two timestamps: `last_seen_at` vs `last_probed_at`

- `last_seen_at` is **positive evidence only**: a board crawl listed the row,
  or the platform's own API said the posting is open. The sweeps key on it.
- `last_probed_at` is stamped by EVERY liveness check, whatever the answer.
  The verify sweeps rotate on it (least-recently-probed first).

The old verifier stamped `last_seen_at` on every probe, so a bot wall or an
SPA shell passed for a confirmation and kept dead rows alive for weeks.

### Platform-aware liveness (`platform_liveness.py`)

A plain GET cannot tell a live posting from a dead one on most of the
catalogue: Workday serves the same ~6.5 KB app shell (HTTP 200) for live,
closed and made-up job ids, and Ashby/Oracle HCM pages are SPAs. So each
known ATS is asked through its own public API:

| Platform | Check | Dead when |
|---|---|---|
| Workday (`myworkdayjobs.com`, `myworkdaysite.com`) | CxS job endpoint `/wday/cxs/{tenant}/{site}/job/...` | JSON `errorCode` S21 / S22, or 404/410 |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{co}/postings/{id}` | 404, or `active: false` |
| Greenhouse boards | `boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}` | 404 |
| Any `gh_jid` URL (custom career domains) | `boards.greenhouse.io/embed/job_app?token={id}` | 404 |
| Lever (incl. EU) | `api.lever.co/v0/postings/{company}/{id}` | 404 |
| Ashby | membership in the org's posting-api board (fetched once per org per run) | not listed (an empty board is `unknown`) |
| Oracle HCM | `recruitingCEJobRequisitionDetails` finder by id | `items: []` |
| LinkedIn guest page | closed banner / `expired_jd_redirect` | banner, trk token, or 404 |
| Anything else | the page itself | 404/410, redirect to an error page, an off-site redirect to a careers home, or a dead phrase in the VISIBLE text |

Three verdicts: `dead`; `alive`, which is `authoritative` only when the
platform's own API or board said so (the only answer allowed to revive a
row); `unknown` for everything inconclusive.

**The 403 rule and its one exception.** A page answering 401, 403, 429 or 999
is a bot wall and never evidence of death. The single exception is Workday's
CxS JSON `errorCode: "S22"` (posting unpublished) returned with a 403: an
API-level signal a bot wall never produces, checked 85/85 against a board
search by requisition id. Indeed is never requested at all (Cloudflare walls
every probe).

Politeness: at most 2 requests in flight per host, 8 overall; a host that
fails 3 times in a row is skipped for the rest of the run; 25 s cap per URL;
bodies are size-capped. `check_listings(client, urls, concurrency=8,
deadline=, cache=)` never raises: URLs not started by the deadline are simply
absent from the result and wait for the next run.

`listing_freshness.record_liveness(db, row_id, listing_status, result)`
applies one verdict with the sweep rules: always stamp `last_probed_at`;
dead: `removed`; authoritative alive: bump `last_seen_at` (and revive a
stale/removed row to `active`); anything else changes nothing more.

### The sweeps (cron-freshness, in order)

1. **Legacy board_key adoption:** direct rows with no `board_key` get one
   derived from their URL (`greenhouse:acme`), or `unknown`.
2. **Stale sweep:** direct rows not re-confirmed in 72 h go `stale` (still
   visible).
3. **Aggregator expiry:** LinkedIn/Indeed rows (by source OR by URL host: the
   retired external scraper stored LinkedIn cards as `source_platform='ats'`)
   expire after 21 days; GitHub-list and other non-ATS rows after 30. Age
   runs from the EARLIEST of posted date, first seen and scraped, so a
   future-dated row cannot escape. Rows on a real board are never touched.
4. **Terminal expiry:**
   - a `stale` row with no positive evidence for 21 days: `expired` (it had
     every board crawl and ~6 verifier runs a day to prove otherwise);
   - a direct row on a board no crawl reconciles (`board_key` `''` or
     `unknown`): `expired` 30 days after its last positive evidence.
5. **Verification, one shared 150 s box** (each phase stops starting checks at
   60/80/100% of it; unused time flows on):
   - stale backlog, 600 rows per run;
   - active direct rows no crawl has confirmed for 48 h, 150 per run (rows
     past a partial crawl, boards we don't crawl);
   - visible GitHub-list and LinkedIn rows, 200 per run.

   All three work least-recently-probed first, skip rows probed in the last
   20 h, hidden duplicates, blank-company rows and Indeed, and commit every
   100 rows.
6. **Ghost-risk scoring** (below).

Removal of jobs that vanished from their board happens earlier, inside
cron-ats reconciliation. GitHub-list rows also leave when their list marks
them closed (a lock or strikethrough, matched on company + title) or drops
the URL from the README, checked on every full re-parse of a source (skipped
if it would remove more than half of the source's rows).

### Click-time check (`POST /jobs/{id}/check-live`)

When a user opens a job, the frontend asks once per job per browser session.
The endpoint runs `check_listing` on that row and applies the verdict with
`record_liveness`, so a posting that died since the last sweep is caught the
moment someone looks at it. The response carries `{listing_status,
verdict}`; a `dead` verdict (or a removed/expired status) switches the panel
to the closed state and drops the card from the feed. The frontend ignores
errors and stops asking for the session if the route is missing (405, or a
404 whose detail is exactly `Not Found`), so an unknown job id must answer
404 with a different detail (e.g. `Job not found.`).

## Company logos

Logos are **self-hosted**: one validated, squared image per employer in the
`company_logos` table, keyed by a normalized company name (`company_key`:
markdown, `(Ashby)`-style tags, punctuation, accents and legal suffixes
folded away). Rows point at `/jobs/logo/<sha1>.png` (or `.svg`), served by
`GET /jobs/logo/{sha}.png|svg` with no auth, an immutable year-long cache
header, nosniff, and a sandboxing CSP for SVG. A re-harvest that changes the
image changes the URL, so the cache can never serve a stale logo.

- **Harvester cascade** (`harvest_company_logo`), first hit wins: an existing
  real logo URL on any row; the LinkedIn guest job page; LinkedIn guest
  search; the ATS board's own logo (Ashby, Workday, Lever, Greenhouse,
  SmartRecruiters, BambooHR, Workable); homepage icons on VERIFIED domains
  only (DNS, no unrelated redirect, not parked, company token match); Wikidata
  P154; Google s2 at 256 px. Every candidate goes through
  `logo_image.normalize_logo`: decoded, at least 64 px, not a known
  placeholder, visible on white, aspect ratio within 4:1, trimmed, padded to a
  square, 128x128 PNG. SVGs are sanitized (no script, no external refs).
- **Propagation:** a stored logo is written to every row of that company,
  visible or hidden, so one LinkedIn row's logo covers the 1,000 Workday rows
  of the same employer.
- **Misses** back off 14 days per attempt, capped at 90, and never demote a
  stored logo.
- **Where it runs:** cron-backfill Phase 3 first re-points rows of already
  stored companies (no network), then harvests companies with visible rows
  and no stored logo, busiest first: 6 at once, 45 s per company, at most
  150 companies and 150 s per run.
- **Frontend chain:** stored logo; else Google s2 (`sz=256`) only for a real
  domain (never a name guess); else a letter avatar from the cleaned name.
  Anything under 40 px or wider than 2.2:1 counts as a miss. unavatar is gone
  (25 requests per day per IP, tiny favicons).

## Ghost-job scoring

`ghost_risk_score` (0-100) + `ghost_risk_factors` are **surfaced, not
silently filtered**: the product decides hide vs badge. Factors:

| Factor | Points |
|---|---|
| Open > 45 days (`> 90` days) | +25 (+40) |
| Evergreen description ("always accepting applications", "talent pool", ...) | +25 |
| Repost pattern (same employer+title previously removed) | +20 |
| Company has ≥5 active listings and >50% open >45 days | +15 |

Scoring is incremental: new rows are scored once (the only pass that reads
descriptions; the evergreen flag is cached in the factors JSON), and aging
rows are re-scored column-only as their age factors move.

## Structured extraction

`structured_extraction.py` is **deliberately regex/taxonomy based, no model
calls**. The ingest crons touch thousands of listings per hour; per-listing
LLM calls are how the OpenAI bill melted once already. Extracted at ingest
(Tier 1) or when the backfill lands a description (Tier 3):

- `salary_min/max/currency/period`: from source-structured pay fields
  (Greenhouse `pay_input_ranges`, Lever `salaryRange`, Ashby
  `compensationTierSummary`) or description text; magnitude sanity checks
  reject years/metrics masquerading as pay
- `employment_type`: source commitment field wins, then title, then text
- `visa_sponsorship`: `yes`/`no` only on explicit statements (negative
  patterns checked first); silence stays `unknown`
- `skills`: curated ~150-term taxonomy, word-boundary matched, capped at 20;
  ambiguous single tokens (`r`, `go`, `ui`) only count in titles
- `raw_hash`: whitespace-insensitive content fingerprint

## Change detection (bait-and-switch)

Re-crawls diff stored rows against fresh board data: title/location/salary
changes and description-hash changes append to a capped `change_log` and bump
`edit_count`. A posting whose salary statement disappears gets a
`salary_removed` entry: an edit-frequency/trust signal the UI can surface.

## Deduplication

1. **URL identity:** `scraped_jobs.url` is UNIQUE; `canonical_url()` strips
   only `utm_*` params (functional params like `gh_jid` survive). Rows stored
   before that existed (`?utm_source=vansh` copies) are collapsed onto the
   clean URL by `scripts/cleanup_feed.py` phase a.
2. **Stable external id:** Tier-1 rows carry
   `external_id = {platform}:{slug}:{source's own id}`, so re-crawls update in
   place even if the apply URL changes shape.
3. **Cross-source twins:** exact match on normalized employer + normalized
   title + city containment; the highest-trust copy wins, losers get
   `duplicate_of` (soft-hidden, never deleted). Direct rows never merge with
   each other: identical titles on one board are distinct requisitions. A
   hidden twin's real logo is inherited by a winner whose logo is generated.
4. **Fuzzy fallback:** aggregator rows whose *normalized* title is
   near-identical (SequenceMatcher ≥ 0.93, small length gap) to a direct row's
   may be absorbed. Deliberately not embeddings: deterministic, free, and a
   wrong merge hides a real job. A qualifier word ("... Infrastructure") blocks
   the merge by design.

## GitHub-list sources (cron-poll)

The parser (`markdown_parser.py`) reads pipe tables, several tables per
README and HTML `<table>` READMEs; takes the OUTER link of a badge-wrapped
link (never the shields.io image); strips markdown/HTML emphasis and legend
emoji from company and title cells (`**Tesla**` rendered a `*` avatar); and
gives a year-less date ("Nov 30") the most recent such day not more than 2
days in the future (the current year made 2025 postings into Oct-Dec 2026
ones that topped the date-sorted feed). Closed rows (lock, strikethrough) are
never inserted. Renamed repos are followed (the source's owner/name update in
place); only 404/410/451 park a source in `error`, other failures keep it
`active`, and retryable errors are retried after a 12-hour cooldown
(`sources_due`).

Cadence (`sources_due`, `_due_at`): a list whose file committed in the last
7 days is due hourly, a quieter one daily. A list with nothing to ingest
(every row links to a list vendor such as jobright.ai or zapply.jobs, or the
README has no job table) and no visible rows is `parked`: re-checked weekly,
and only with the slots productive lists leave free. cron-poll polls up to
`CRON_POLL_MAX_SOURCES` (12) due sources, most overdue first. The stored
commit is stamped with `PARSE_REVISION` (`<sha>@r1`): bump it when the parse
or ingest rules change and every list is re-parsed once, since a README is
otherwise only re-read when its commit changes. A list due only for the
revision, with nothing in the feed, waits behind every other due list (a
never-polled one still goes first): after the r1 bump the ~33 vendor lists
held the productive lists back for 12-15 h. An interval other than hourly
or daily set through `PUT /github-sources/{id}` sticks.

One source per file: speedyapply keeps new-grad and international roles in
`NEW_GRAD_USA.md`, `INTERN_INTL.md` and `NEW_GRAD_INTL.md` beside its README.
A `file_path` in `REPOS` makes a source at `<repo>/blob/HEAD/<file>` whose
commit check only counts commits touching that file; a `countries` allowlist
(the `*_INTL.md` files read for `CA` only) drops everything else.

List rows are dropped at ingest, and hidden on every run
(`hide_list_copies_of_board_rows`), when the board crawl carries the same
posting under another URL spelling: same employer, title and
`posting_identity` (Greenhouse job id, Workday tenant + requisition across
locale, site alias, `-1` repost and `/apply` variants, Lever/Ashby UUID; a
`-N` goes only when a requisition of 4+ digits, not a bare year, is left).
Only a visible board row, or one its board `removed`, stands in for a list
copy, a visible one before a removed sibling; an `expired` or `off_target`
one does not (the crawler's level and location filters are not the list's;
`off_target` still stands in for LinkedIn/Indeed twins). A hidden copy comes
back (`release_list_copies_of_lapsed_board_rows`) once its board row stops
standing in. `canonical_url` drops `utm_*` and `ref=` and keeps every other
query segment byte for byte. Legend marks leave titles (`🛂`/`🇺🇸` set
`visa_sponsorship='no'`, which cron-backfill keeps when a description
lands), and an escaped `\|` stays inside its cell.

One posting on two lists, or twice on one (speedyapply lists one Workday
requisition under several site aliases, and repeats negarprh postings
under another path case, title or employer name), is one card: a precise
`posting_identity` (Workday, Greenhouse, Lever, Ashby) matches whatever
the title or employer spelling, any other URL needs the same employer and
title (`list_row_key`). A list row whose posting another list row in the
feed carries is not stored, and cron-poll hides the rest
(`hide_repeated_list_rows`: under the board row a repeat is already hidden
behind, else the oldest list row); `release_repeated_list_rows` gives a
repeat back when that row leaves the feed. List rows with a plainly senior
title (`ats_scraper.HARD_SENIOR`: "Engineer I -II -III", "Level 4") are not
stored.

cron-poll time boxes, from the start of the request (the workflow's curl and
Vercel both stop at 300 s): no new source after 120 s, a source still
polling at 200 s is cut off, no description fetch after 170 s, and the
match-alert sweep is cut off at 240 s. A cut only lands at an await, so
synchronous work runs past it: a source's insert loop (~20 s for a 375-row
file), the column-only list dedup passes, and, once the sweep has stopped
scoring (`llm_unavailable`, or its scoring budget spent), every remaining
user's queries and email sends (the Resend SDK's 30 s timeout each). At
today's scale (5 eligible users) the worst run ends around 225-265 s. The
sweep runs whether or not any list was due. The response carries per-source
`seconds` and phase `timings`.

## Per-board health + circuit breaker

Every board outcome lands in `source_health`. Five consecutive failures open
the breaker: the board is skipped for 24 h, then retried. `GET
/jobs/ingest-metrics` (cron-secret) is the dead-letter view (failing boards
with their last error) plus the day-one metrics: listings ingested/24 h and
7 d, removed/24 h, dedup rate, % ghost-flagged, median active listing age,
active-by-trust. The workflow logs it every run.

## Schedules

`.github/workflows/scrape-jobs.yml`, cron `17 * * * *` and `47 * * * *`.
GitHub's scheduler is best-effort: from 2026-08-27 the single minute-17 entry
delivered ~5.7 runs a day (23 before), so a second entry doubles the chances
and every budget is sized for irregular firing (least-recently-crawled
shard, least-recently-probed verification). A `concurrency` group
(`cancel-in-progress: false`) keeps two deliveries from ever running at once.

1. **Inactivity check:** reads the newest commit on the default branch and
   fails from day 50 of GitHub's 60-day inactivity clock (see "The 60-day
   inactivity rule" below). Read-only, never re-enables anything.
2. JobSpy + LinkedIn scripts: `/jobs/ingest-batch` (Tier 3). These stay
   `continue-on-error`: blocked scrapers are routine.
3. `/github-sources/cron-ats`: the least-recently-crawled **shard** of the
   registry; ingests, confirms and reconciles.
4. `/github-sources/cron-poll`: GitHub lists.
5. `/jobs/cron-backfill`: descriptions, locations, logos (Phase 3), twin
   absorption, extraction-on-description-arrival.
6. `/jobs/cron-freshness`: board_key adoption, stale/aggregator/terminal
   sweeps, platform liveness verification, ghost scoring.
7. `/jobs/ingest-metrics`: logged snapshot, runs even after a failure.
8. A final step fails the run if the inactivity check or any endpoint step
   failed.

Every endpoint call prints its HTTP status, time and response body and fails
its step on anything but 2xx; the steps are `continue-on-error` so the rest of
the run still happens, and the final step turns the run red. (Before this,
every curl ended in `|| true` and a 401 or 500 showed green.) `--max-time` is
300 s on the four crons, Vercel's function limit: cron-ats pages for at most
150 s plus processing, cron-backfill plans its whole pass into
`BACKFILL_BUDGET_S` (240 s: up to 75 s of descriptions, then a logo harvest
of what is left, at most 150 s; a fetch the budget cuts off costs the row no
attempt), cron-freshness runs its sweeps plus a 150 s verification
box. A curl timeout at 300 s means the function itself hit Vercel's ceiling.
The job has a 40-minute timeout so a hung run can't hold the concurrency
group.

The job token is `contents: read` and nothing more. Its only users are
`actions/checkout` (with `persist-credentials: false`, so the token is not
left in `.git/config`) and the inactivity check (two REST reads). The
scrapers and the endpoint steps authenticate to Tailrd with `CRON_SECRET`,
never with the GitHub token. Because the scripts run with `CRON_SECRET` in
their env, `python-jobspy` and `httpx` are pinned to exact versions (the
ones the job resolved in 2026-09); bump them deliberately. Their transitive
dependencies still float within python-jobspy's own ranges; a hashed
requirements file (`pip install --require-hashes`) is the next step if that
ever matters.

### The 60-day inactivity rule

GitHub disables scheduled workflows in a public repository after 60 days
without repository activity (in practice, without a commit), and it does so
silently: the runs just stop. That is how the external scraper's "Hourly Job
Scraper" died on 2026-08-26, 60 days after its last commit. This repository
is public, so the same clock runs on `scrape-jobs.yml`, and every push to the
default branch resets it.

- **The detector.** The workflow's first step reads the newest commit on the
  default branch (`gh api`, `contents: read`) and fails once it is 50 days
  old; the final step then turns the run red. A failed scheduled run emails
  the user who last changed the workflow's `schedule` (or whoever last
  re-enabled the workflow), provided their Actions notifications are on.
  That leaves about 10 days, and the error names the day the schedule turns
  off. The response is either to push any commit to the default branch
  (another 60 days) or to make the durable fix below. The check uses the
  committer date, which is at or before the push, so it can fire early but
  never late.
- **No automated keepalive.** An earlier draft re-enabled the workflow on
  every run (`PUT .../actions/workflows/scrape-jobs.yml/enable`). It was
  removed: nobody has confirmed that re-enabling resets the timer
  (efrecon/gh-action-keepalive found that toggling does not), GitHub has
  blocked the best-known keepalive action's repository on ToS grounds, and
  the call needed `actions: write` on a job that runs third-party PyPI code.
  Don't replace it with automated dummy commits either.
- **A disabled workflow can't alert about itself.** The detector only speaks
  while the workflow still runs. For an alarm that survives the workflow
  being off, point an external uptime monitor at `GET /jobs/ingest-metrics`
  (header `x-cron-secret`) and alert when `ingested_24h` is 0.
- **Already disabled?** Actions tab, "Scrape Jobs", "Enable workflow", then
  push a commit.

The durable fix is to stop depending on GitHub's scheduler:

1. **An external cron calling the endpoints.** A scheduler such as
   cron-job.org POSTs `/github-sources/cron-ats`, `/github-sources/cron-poll`,
   `/jobs/cron-backfill` and `/jobs/cron-freshness` with the `x-cron-secret`
   header, one at a time. Its request timeout has to cover the up to 300 s
   each can take. This doesn't run the JobSpy and LinkedIn scripts (they
   need a Python runner), so on its own it drops Tier 3.
2. **An external cron dispatching this workflow.** A scheduler calls
   `POST /repos/{owner}/{repo}/actions/workflows/scrape-jobs.yml/dispatches`
   with `{"ref": "main"}` and a fine-grained token limited to this
   repository with Actions: write (the workflow already has
   `workflow_dispatch`). Every step keeps running, scrapers included. Once
   the dispatches arrive, delete the `schedule:` block: the 60-day rule is
   about scheduled workflows, so a dispatch-only workflow has no clock to
   run out.

### Environment variables (all optional)

| Variable | Default | Effect |
|---|---|---|
| `CRON_ATS_SHARDS` | sized to ~150 boards/run | Number of registry shards |
| `CRON_ATS_LIST_BUDGET_SECONDS` | 150 | Wall-clock budget for paging big boards past their head pages |
| `CRON_ATS_CONCURRENCY` | 6 | Boards crawled at once (never two per API host) |
| `WORKDAY_MAX_PAGES` | 100 | Workday list pages (20 postings each) per board; do not pin to 8 |
| `SMARTRECRUITERS_MAX_PAGES` | 20 | SmartRecruiters list pages (100 postings each) per board |
| `ATS_PER_HOST_INTERVAL` | 0.35 | Seconds between requests to one ATS API host |

## One-time scripts

All take `DATABASE_URL` from the environment (set it explicitly for the run;
never rely on a `.env`), read column-only and are idempotent.

- **`backend/scripts/cleanup_feed.py`** brings the catalogue, in one pass, to
  the state the lifecycle code converges to over days of cron runs:
  - phase a: GitHub-list data fixes (year-less dates stamped with the wrong
    year go back a year, markdown stripped from company/title through the
    parser's own clean-up, `utm_*` URL twins get `duplicate_of` on the utm
    copy);
  - phase b: the cron-freshness sweeps, called from `listing_freshness`;
  - phase c: every still-visible row checked with `check_listings` and the
    verdicts applied with `record_liveness`;
  - phase d: report of what stays visible with verdict `unknown`, by host.

  It is a **dry run by default**: no writes and no migrations, enforced by a
  statement guard (only SELECT/SHOW get through) and by the database itself
  (`SET TRANSACTION READ ONLY` on Postgres, `PRAGMA query_only` on SQLite).
  Phase c still makes its outbound HTTP checks so the report shows real
  verdicts. Typical use:

  ```
  # representative read-only projection on prod
  DATABASE_URL=... python backend/scripts/cleanup_feed.py --limit 300 --sample
  # the real thing (runs the idempotent last_probed_at migration first)
  DATABASE_URL=... python backend/scripts/cleanup_feed.py --apply
  # only Workday rows, or only some phases
  DATABASE_URL=... python backend/scripts/cleanup_feed.py --apply --phase c,d --host-filter myworkdayjobs.com
  # resume an interrupted apply without re-checking what it already did
  DATABASE_URL=... python backend/scripts/cleanup_feed.py --apply --phase c,d --recheck-hours 6
  ```

  Options: `--phase`, `--limit`, `--sample`/`--seed`, `--host-filter`,
  `--concurrency` (8), `--deadline-minutes` (90), `--recheck-hours`,
  `--no-migrate`. Deploy the wave-1/2 code first: the script uses the same
  `listing_freshness` / `platform_liveness` the crons use.
- `backend/scripts/dedup_jobs.py`: whole-catalogue cross-source dedup sweep.
- `backend/scripts/harvest_logos.py`: legacy exhaustive favicon harvest
  (superseded by cron-backfill Phase 3 and the logo store).
- `backend/scripts/backfill_descriptions.py`, `backfill_locations.py`:
  description and location repair.

## Adding a new source connector

1. **Find the JSON API.** Prefer the platform's public board API over HTML.
   Check the careers page's network tab for XHR JSON.
2. **Fetcher in `ats_scraper.py`:** add `_fetch_<platform>(client, slug,
   company_name)` returning unfiltered `list[ATSJob]`; set `external_id`
   (the source's own posting id), `salary_text`/`employment_type` when the
   source structures them, and `detail_ref` if descriptions need a per-job
   detail call. Paginating fetchers return `(listings, complete, total)` and
   honour the run's `deadline`.
3. **Route it in `scrape_board()`:** this is what gives cron-ats the
   `BoardSnapshot` (filtered jobs + full live-URL set). If your fetch can be
   partial, return `complete=False`: the board then confirms what it listed
   and removes nothing.
4. **Liveness:** if the platform's job pages can't tell live from dead (SPA,
   redirect-to-home), add an API check in `platform_liveness._route`, and
   only return `authoritative=True` for an answer from the platform itself.
5. **Registry:** add the platform to `SUPPORTED_PLATFORMS` in
   `company_registry.py` and entries to `ats_companies.json`
   (`ats_platform`, `board_slug`, `company_name`, `enabled`).
6. **Fixtures + tests:** save a real (sanitized) board payload under
   `backend/tests/fixtures/` and add parse tests in
   `test_connector_fixtures.py`, including one asserting that filtered-out
   jobs still appear in `all_urls`.
7. Board keys, freshness, health tracking, and dedup come for free: they key
   off `BoardSnapshot`.

Everything else (crawl cadence, circuit breaking, removal reconciliation) is
generic. A connector is ~60 lines plus fixtures.

## ToS hygiene

- Tier-1 uses public JSON board APIs intended for consumption; no login-walled
  scraping. Per-host request pacing.
- Liveness checks use the same public APIs (or the public posting page), at
  most 2 requests in flight per host, and never judge a bot wall.
- LinkedIn data comes only from the guest API/JobSpy at low trust, is never
  reposted elsewhere, and always links back to the original source.
- `robots.txt`-sensitive HTML fetching happens only in the description
  backfill for direct company pages, with a bounded attempt count.
