# Job Ingestion Pipeline

How Tailrd sources, structures, deduplicates, and — most importantly —
**keeps fresh** its job catalogue. The design goal is to beat aggregator
competitors (Jobright et al.) on the axes they are weakest: ghost/expired
listings, low-trust reposted data, and unexplained matching. Volume is not the
goal; a smaller catalogue where every listing is real and current is.

## Architecture at a glance

```
GitHub Actions (hourly, minute 17)          Vercel serverless (FastAPI)
┌──────────────────────────────┐            ┌─────────────────────────────────┐
│ scripts/scrape_jobspy.py     │──POST────▶│ /jobs/ingest-batch   (Tier 3)   │
│ scripts/scrape_linkedin.py   │──POST────▶│                                 │
│                              │            │ /github-sources/cron-ats        │
│ curl cron-ats  ──────────────┼───────────▶│   shard of ATS boards (Tier 1) │
│ curl cron-poll ──────────────┼───────────▶│   GitHub lists       (Tier 2)  │
│ curl cron-backfill ──────────┼───────────▶│   descriptions/locations/logos │
│ curl cron-freshness ─────────┼───────────▶│   expiry + ghost scoring       │
│ curl ingest-metrics (log) ───┼───────────▶│   pipeline health snapshot     │
└──────────────────────────────┘            └────────────────┬────────────────┘
                                                             ▼
                                                     Neon Postgres
                                                     (scraped_jobs, source_health)
```

Key modules:

| Path | Role |
|---|---|
| `backend/services/ats_scraper.py` | Tier-1 connectors (Greenhouse, Lever, Ashby, SmartRecruiters, Workday), `BoardSnapshot` |
| `backend/data/ats_companies.json` + `company_registry.py` | Which boards to crawl; hourly sharding |
| `backend/services/structured_extraction.py` | Deterministic salary/visa/skills/employment extraction, content hashing |
| `backend/services/listing_freshness.py` | Lifecycle: reconcile, stale/expiry sweeps, ghost scoring, URL verification |
| `backend/services/source_health.py` | Per-board circuit breaker + dead-letter view |
| `backend/services/cross_source_dedup.py` | Cross-source twin collapsing (exact + conservative fuzzy) |
| `backend/routers/github_sources.py` (`cron-ats`) | Board crawl orchestration |
| `backend/routers/jobs.py` (`ingest-batch`, `cron-backfill`, `cron-freshness`, `ingest-metrics`) | Aggregator ingest, repair, lifecycle cron, metrics |
| `backend/migrations/add_ingestion_freshness.py` | Schema migration (idempotent, runs at app startup) |

## Source tiers and trust

| Tier | Sources | `source_trust` | Notes |
|---|---|---|---|
| 1 | Greenhouse, Lever, Ashby, SmartRecruiters, Workday board APIs | `high` | Employer's own board: canonical copy, direct apply URL |
| 2 | Curated GitHub job lists (cron-poll) | `medium` | Direct links, human-curated, but not the employer's feed |
| 3 | LinkedIn guest API, JobSpy (Indeed/LinkedIn) | `low` | Gap-filler only; never becomes canonical when a direct twin exists |

All Tier-1 fetches use official/public JSON board APIs (the ones built for job
boards to consume), never rendered-HTML scraping of the ATS UI. Requests to a
given API host are spaced by `ATS_PER_HOST_INTERVAL` (default 0.35 s).
`apply_url`/`source_url` always point at the original posting — we never
present another platform's listing as ours.

### Workday specifics

Workday has no global board API — each tenant exposes a CxS JSON endpoint.
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
`/jobs`. Entries without a template are kept in the registry but skipped.

The connector pages 20 postings at a time (`WORKDAY_MAX_PAGES`, default 8) and
fetches descriptions per NEW job only (budgeted at 40/run) — huge boards mark
their snapshot `complete=false`, which disables removal reconciliation for
that board (absence from a partial crawl is not evidence of removal; the
stale sweep + URL verification cover those rows instead).

## The listing lifecycle (freshness)

Every row has a `listing_status` separate from the user's workflow `status`:

```
              board still lists it              board stopped listing it
   ┌────────┐ ──────────────────────▶ last_seen_at bumped
   │ active │
   └────────┘ ◀── revived ──┐          ┌─────────┐
        │                   ├──────────│ removed │  (same hour it vanished)
        │ not re-confirmed  │          └─────────┘
        │ for 72h           │               ▲ 404/410 on URL spot-check
        ▼                   │               │
   ┌────────┐───────────────┘          ┌─────────┐
   │ stale  │─────────────────────────▶│ expired │  (aggregator rows > 30 days)
   └────────┘  still visible           └─────────┘
```

- **Reconcile (cron-ats):** each board crawl carries `BoardSnapshot.all_urls`
  — every live posting on the board *including ones our entry-level/NA
  filters rejected*. Stored rows for that `board_key` whose URL is missing are
  marked `removed` immediately; rows that reappear are revived. A complete-but-
  empty response on a board that had >10 live rows degrades to the stale sweep
  (API hiccup protection).
- **Stale sweep (cron-freshness):** direct rows not re-confirmed in 72 h
  (broken board, partial Workday crawls) go `stale` — still visible.
- **URL verification (cron-freshness):** up to 30 stale rows per run get a
  real GET; honest 404/410 → `removed`, 200 → back to `active`. Hosts that
  200-everything (Ashby SPA) are excluded.
- **Aggregator expiry (cron-freshness):** LinkedIn/Indeed/GitHub rows older
  than 30 days go `expired` — nothing will ever re-confirm them.
- Rows are **never deleted** (saved jobs and applications reference them), and
  `removed`/`expired` rows stay visible in a user's Liked list.

`/jobs` hides `removed` + `expired`; `stale` stays visible.

## Ghost-job scoring

`ghost_risk_score` (0–100) + `ghost_risk_factors` are **surfaced, not
silently filtered** — the product decides hide vs badge. Factors:

| Factor | Points |
|---|---|
| Open > 45 days (`> 90` days) | +25 (+40) |
| Evergreen description ("always accepting applications", "talent pool", …) | +25 |
| Repost pattern (same employer+title previously removed) | +20 |
| Company has ≥5 active listings and >50% open >45 days | +15 |

Scoring is incremental: new rows are scored once (the only pass that reads
descriptions — the evergreen flag is cached in the factors JSON), and aging
rows are re-scored column-only as their age factors move.

## Structured extraction

`structured_extraction.py` is **deliberately regex/taxonomy based — no model
calls**. The ingest crons touch thousands of listings per hour; per-listing
LLM calls are how the OpenAI bill melted once already. Extracted at ingest
(Tier 1) or when the backfill lands a description (Tier 3):

- `salary_min/max/currency/period` — from source-structured pay fields
  (Greenhouse `pay_input_ranges`, Lever `salaryRange`, Ashby
  `compensationTierSummary`) or description text; magnitude sanity checks
  reject years/metrics masquerading as pay
- `employment_type` — source commitment field wins, then title, then text
- `visa_sponsorship` — `yes`/`no` only on explicit statements (negative
  patterns checked first); silence stays `unknown`
- `skills` — curated ~150-term taxonomy, word-boundary matched, capped at 20;
  ambiguous single tokens (`r`, `go`, `ui`) only count in titles
- `raw_hash` — whitespace-insensitive content fingerprint

## Change detection (bait-and-switch)

Re-crawls diff stored rows against fresh board data: title/location/salary
changes and description-hash changes append to a capped `change_log` and bump
`edit_count`. A posting whose salary statement disappears gets a
`salary_removed` entry — an edit-frequency/trust signal the UI can surface.

## Deduplication

1. **URL identity** — `scraped_jobs.url` is UNIQUE; `canonical_url()` strips
   only `utm_*` params (functional params like `gh_jid` survive).
2. **Stable external id** — Tier-1 rows carry
   `external_id = {platform}:{slug}:{source's own id}`, so re-crawls update in
   place even if the apply URL changes shape.
3. **Cross-source twins** — exact match on normalized employer + normalized
   title + city containment; the highest-trust copy wins, losers get
   `duplicate_of` (soft-hidden, never deleted). Direct rows never merge with
   each other — identical titles on one board are distinct requisitions.
4. **Fuzzy fallback** — aggregator rows whose *normalized* title is
   near-identical (SequenceMatcher ≥ 0.93, small length gap) to a direct row's
   may be absorbed. Deliberately not embeddings: deterministic, free, and a
   wrong merge hides a real job. A qualifier word ("… Infrastructure") blocks
   the merge by design.

## Per-board health + circuit breaker

Every board outcome lands in `source_health`. Five consecutive failures open
the breaker: the board is skipped for 24 h, then retried. `GET
/jobs/ingest-metrics` (cron-secret) is the dead-letter view — failing boards
with their last error — plus the day-one metrics: listings ingested/24 h and
7 d, removed/24 h, dedup rate, % ghost-flagged, median active listing age,
active-by-trust. The workflow logs it every run.

## Schedules

`.github/workflows/scrape-jobs.yml`, hourly at minute 17 (top-of-hour fires
get dropped on GitHub's shared queue):

1. JobSpy + LinkedIn scripts → `/jobs/ingest-batch` (Tier 3)
2. `/github-sources/cron-ats` — this hour's **shard** of the registry
   (~150 boards/run, every board every 2–3 h) — ingests + reconciles
3. `/github-sources/cron-poll` — GitHub lists
4. `/jobs/cron-backfill` — descriptions, locations, logos, twin absorption,
   extraction-on-description-arrival
5. `/jobs/cron-freshness` — stale/expiry sweeps, URL verification, ghost
   scoring, legacy `board_key` adoption
6. `/jobs/ingest-metrics` — logged snapshot

## Adding a new source connector

1. **Find the JSON API.** Prefer the platform's public board API over HTML.
   Check the careers page's network tab for XHR JSON.
2. **Fetcher in `ats_scraper.py`:** add `_fetch_<platform>(client, slug,
   company_name)` returning unfiltered `list[ATSJob]` — set `external_id`
   (the source's own posting id), `salary_text`/`employment_type` when the
   source structures them, and `detail_ref` if descriptions need a per-job
   detail call. Paginating fetchers return `(listings, complete, total)`.
3. **Route it in `scrape_board()`** — this is what gives cron-ats the
   `BoardSnapshot` (filtered jobs + full live-URL set). If your fetch can be
   partial, return `complete=False` so reconciliation stands down.
4. **Registry:** add the platform to `SUPPORTED_PLATFORMS` in
   `company_registry.py` and entries to `ats_companies.json`
   (`ats_platform`, `board_slug`, `company_name`, `enabled`).
5. **Fixtures + tests:** save a real (sanitized) board payload under
   `backend/tests/fixtures/` and add parse tests in
   `test_connector_fixtures.py` — including one asserting that filtered-out
   jobs still appear in `all_urls`.
6. Board keys, freshness, health tracking, and dedup come for free — they key
   off `BoardSnapshot`.

Everything else (crawl cadence, circuit breaking, removal reconciliation) is
generic. A connector is ~60 lines plus fixtures.

## ToS hygiene

- Tier-1 uses public JSON board APIs intended for consumption; no login-walled
  scraping. Per-host request pacing.
- LinkedIn data comes only from the guest API/JobSpy at low trust, is never
  reposted elsewhere, and always links back to the original source.
- `robots.txt`-sensitive HTML fetching happens only in the description
  backfill for direct company pages, with a bounded attempt count.
