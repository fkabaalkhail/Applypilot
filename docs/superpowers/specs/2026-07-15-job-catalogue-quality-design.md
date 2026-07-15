# Job Catalogue Quality Overhaul — Descriptions, Locations, Logos, Detail UI

**Date:** 2026-07-15
**Status:** Approved (user pre-approved autonomously-produced specs for this work)
**Goal:** Make the job feed and job detail experience as good as or better than Jobright: reliable descriptions, accurate city filtering, crisp logos, and a structured Jobright-style detail view with resume-matched qualification tags.

## Problem statement (measured against prod, 2026-07-15)

Prod has 28,768 jobs. Four independent defects degrade the experience:

1. **40% of jobs have no usable description** (11,421 rows with <50 chars).
   By source: `linkedin` 96% missing (avg 186 chars — og:description snippets),
   `indeed` ~100%, `github` 97%, `ats` 20% (4,273 rows).
   Root cause: no ingest path fetches descriptions. `cron-ats` calls Greenhouse
   with `content=false` and stores `description=""`; `ingest-batch` (JobSpy/
   LinkedIn) and the GitHub aggregator do the same. The only fetch happens
   on-click (`POST /jobs/{id}/fetch-details`), with no attempt tracking, so a
   failed fetch leaves the job permanently blank. Meanwhile Greenhouse, Lever,
   and Ashby return full descriptions **in the same list responses we already
   make** — we throw them away.

2. **Location filtering is broken by design.**
   `list_jobs` splits the `location` input on commas and ORs
   `ILIKE '%part%'`. Filtering "Ottawa, ON" matches Tor**ON**to and L**ON**don;
   the "Ontario"/"Canada" parts match every job in the province/country. The
   stored data itself is chaos — prod contains "Ottawa, Ontario, Canada",
   "Ottawa, ON, CA", "CA   ON Ottawa", "Canada - Ottawa (Bill Leathem)",
   "Ottawa (Downtown) ON", multi-city strings
   ("Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland", 802 rows),
   "(+2 more)" suffixes, and even job titles leaked into the field.
   Multi-city blobs render raw on cards.

3. **Logos are blurry, wrong, or missing.**
   Writers disagree: `cron-ats` resolves domains properly, but `ingest-batch` /
   `create` / `fix-empty-companies` write `icon.horse/{squashed-name}.com`
   guesses (frequently a wrong or dead domain). The favicon service
   (`google.com/s2/favicons?sz=128`) upscales 16–32px favicons → blur.
   1,389 rows have no logo URL; 18,739 have no `company_domain`. The frontend
   only falls back on `onerror` — a blurry-but-valid image never errors.

4. **Job detail view is far from the Jobright reference.**
   Client-side regex sectioning + a hardcoded 60-item skill list; skills render
   as flat gray pills with no resume matching; Required/Preferred subsections
   only appear if the LLM path is used — but the existing
   `/jobs/{id}/structure-description` endpoint is never called by the frontend,
   runs on flagship `gpt-4o` without `json_mode`, and caches its JSON in the
   `company_description` column (a hack). `requirements_detail` is a dead
   column (`[]` everywhere).

## Goals / success criteria

- **Descriptions:** ≥95% of newly ingested `ats` jobs have a ≥500-char
  description at insert time. Existing backlog drains automatically
  (bounded per cron run) with per-job attempt caps. On-click fetch stays as
  the last-resort path.
- **Locations:** filtering "Ottawa" returns only jobs whose parsed cities
  include Ottawa; "Ottawa, ON" behaves identically. Multi-city jobs render
  "Ottawa, ON, Canada · +2 more". Existing rows are backfilled.
- **Logos:** provider cascade with a minimum-resolution guard: never render an
  upscaled 16px favicon; fall to the letter avatar instead. Wrong-domain
  guessing (`icon.horse/{name}.com`) is eliminated from all writers.
- **Detail UI:** Responsibilities / Qualification sections in the Jobright
  style; qualification skill tags highlighted green when the user's resume
  covers them ("Represents the skills you have"), neutral otherwise;
  Required / Preferred bullet subsections.
- **Cost:** no new recurring AI cost beyond one cached `gpt-4o-mini`
  `json_mode` call per job, triggered only by a real user opening the job.
  The match-score cron sweep is untouched.
- All existing backend + frontend tests stay green (modulo the documented
  pre-existing failures baseline); new behavior is covered by tests.

## Non-goals

- No changes to the match-score sweep / notifier (cost-sensitive, recently
  fixed).
- No headless-browser scraping; no paid logo APIs (logo.dev, Brandfetch).
- No LinkedIn authenticated scraping — the guest fallback stays best-effort.
- No salary work, no new experience levels, no cross-source dedup pass
  (LinkedIn-vs-ATS twin collapse is a follow-up; noted below).

## Design

### A. Descriptions at ingest + bounded backfill

**A1. Capture descriptions in the ATS scrape itself** (`ats_scraper.py`):
- `ATSJob` gains `description: str = ""`.
- Greenhouse: request `content=true` (same single request per board); clean
  `job["content"]` HTML.
- Lever: use `descriptionPlain` + `lists` already present in the JSON.
- Ashby: use `descriptionHtml` / `descriptionPlain` from the board payload.
- SmartRecruiters: the list has no ad content; after URL dedup, fetch
  `postings/{id}` for **new** jobs only (bounded by shard size).
- `cron-ats` sanitizes (`sanitize_description`) and stores at insert.
- `MAX_DESC_LEN` raised 6000 → 10000 (long postings currently lose their
  Qualifications tail).

**A2. Backfill cron** — new `POST /jobs/cron-backfill` (cron-secret auth):
- Each run: up to 40 jobs with empty/tiny description AND
  `desc_fetch_attempts < 3`, newest first; run the existing
  `extract_description_from_url`; increment attempts; store successes.
- Also repairs `company_domain`/`company_logo` (via `resolve_logo`) and the
  new location columns (via the C parser) for the rows it touches.
- Wired as a new step in `.github/workflows/scrape-jobs.yml` (hourly).
  ~40/hr ≈ ~1k/day drain rate against the 11.4k backlog, concentrated on the
  newest (most visible) rows first.

**A3. `fetch-details`** stays for on-click, but now also increments
`desc_fetch_attempts` and writes the parsed location columns when it learns a
better location.

New columns (idempotent startup migration, same pattern as existing ones):
`desc_fetch_attempts INTEGER DEFAULT 0`.

### B. Structured detail + resume-matched qualification tags

**B1. Backend** (`/jobs/{id}/structure-description`):
- Route to `model="gpt-4o-mini"`, `json_mode=True`.
- Persist in a new `description_sections` JSON column (drop the
  `company_description` cache hack; keep reading it as a legacy fallback).
- Cleared whenever a new description is written (ingest/backfill/fetch).
- Prompt tightened: sections (Responsibilities / Qualifications with
  Required + Preferred / Benefits / About), `skills` (5–18 canonical tech +
  competency tags), `experience_years`, `education`.

**B2. Frontend** (`JobDetailView.tsx`):
- Keep the instant client-side regex parse as the first paint.
- Then call `structure-description` (cached ⇒ instant on subsequent opens)
  and upgrade the render.
- **Qualification tags:** fetch the user's default resume text once per
  session (existing resumes endpoint); match each skill tag with the
  `keywordMatch` whole-word/stem logic → matched tags get the green
  "thumbs-up" pill treatment from the reference screenshot, unmatched stay
  neutral; caption "Represents the skills you have".
- Required / Preferred rendered as distinct bullet subsections under
  Qualification, per the reference.
- Failure/empty states: prominent "View original post" CTA instead of a
  dead-end message.

### C. Structured locations

**C1. New `backend/services/location_parser.py`** — pure functions:
- `parse_locations(raw) -> list[ParsedLocation(city, region, country)]`
  handling: `;`-separated multi-city, `City, Region, Country` triples,
  `City, XX, CAN[, postal]`, "(+N more)" suffixes, parentheticals
  ("Ottawa (Downtown) ON", "Canada - Ottawa (Bill Leathem)"),
  token-order noise ("CA   ON Ottawa"), "Greater X Metropolitan Area",
  "Remote - US", diacritic folding (Kraków→krakow, Montréal→montreal),
  and junk-title contamination (overlong non-location segments are dropped).
- Region normalized to 2-letter code where known (ON/BC/…, US states);
  country to US/CA/other ISO-ish names.
- `location_display(locations)` → "Ottawa, ON, Canada" /
  "Ottawa, ON, Canada · +2 more".
- `location_search_blob(locations)` → pipe-delimited folded tokens, e.g.
  `|ottawa|on|ontario|canada||krakow|poland|` — token-boundary matching
  that works identically on SQLite (tests) and Postgres (prod).

**C2. Schema:** `city` (primary city, folded), `region`,
`locations_json` (JSON array), `location_search` (TEXT). Populated by every
ingest path (cron-ats, ingest-batch, aggregator/markdown parser, create,
fetch-details repair) via one shared helper.

**C3. Filter semantics** (`list_jobs`): each comma-separated tag is folded;
per-tag predicate = `location_search LIKE '%|tag|%'` OR
(`location_search` empty → legacy `location ILIKE '%tag%'`). Tags remain
OR-combined. A "remote" tag additionally matches `work_type='remote'`.
Comma-containing single tags like "Ottawa, ON" are folded into a
city+region token probe rather than being split into independent substrings.

**C4. Backfill script** `backend/scripts/backfill_locations.py`: batches over
all rows, fills `city/region/locations_json/location_search` (and
`company_domain` where resolvable). Run against dev Neon first, verify with
SQL spot-checks, then prod.

**C5. UI:** cards + detail show the cleaned display string (from
`locations_json` when present). Filter bar gains city suggestions from a new
`GET /jobs/cities?country=CA&q=ot` endpoint (DISTINCT parsed cities with
counts) so users pick canonical cities instead of typing variants.

### D. Logos

**D1.** All writers use `resolve_logo` (domain-first); the `icon.horse`
guessed-domain writes in `ingest-batch`, `create`, and `fix-empty-companies`
are removed.

**D2.** Frontend `CompanyLogo` component (single source of truth used by job
cards, detail view, applications):
- Provider cascade per resolved domain:
  1. a stored real CDN logo (Jobright/LinkedIn/og:image) when present;
  2. `logo.clearbit.com/{domain}` (verify liveness at implementation; drop
     from the chain if dead);
  3. `google.com/s2/favicons?sz=256`;
  4. letter avatar.
- Quality guard: `onLoad` checks `naturalWidth >= 64`; small favicons are
  treated as misses so an upscaled 16px icon never renders.
- `company_domain` backfilled by C4/A2 so the cascade has a domain for old
  rows.

### E. Tests

- `location_parser` unit + property tests seeded with the 25 real prod
  formats sampled during research (incl. Kraków multi-city, "(Bill Leathem)",
  "CA   ON Ottawa", "(+4 more)").
- `list_jobs` filter tests: "Ottawa" excludes Toronto/London/Ontario-wide
  rows; "Ottawa, ON" == "Ottawa"; multi-tag OR; remote tag.
- `ats_scraper` tests: descriptions captured from mocked GH/Lever/Ashby/SR
  payloads; SR per-posting fetch only for new jobs.
- `cron-backfill` tests: attempt increments, cap at 3, description write,
  location/domain repair.
- `structure-description`: model/json_mode routing, `description_sections`
  caching, cache invalidation on description change.
- Frontend: JobDetailView structured sections + matched-tag highlighting;
  CompanyLogo cascade (error → next provider; small image → next provider).

### F. Rollout

1. Feature branch off local `main`; schema migration auto-runs on deploy
   (startup lifespan) and on dev via tests.
2. Backfill script: dev Neon → verify → prod Neon.
3. `scrape-jobs.yml` gains the backfill step.
4. Push to `main` auto-deploys prod (includes the one unpushed docs commit
   already on local main).
5. Post-deploy verification against prod: description coverage query,
   "Ottawa" filter API probe, logo spot-check on top companies, detail view
   on a fresh ATS job.

## Alternatives considered

- **Descriptions:** on-view-only extraction with a better extractor
  (rejected: leaves list/search/matching blind and users see spinners);
  headless browser fleet (rejected: heavy, slow, unnecessary — ATS APIs
  already serve content).
- **Locations:** smarter ILIKE without schema change (rejected: cannot fix
  multi-city display, still substring-fragile); geocoding API (rejected:
  external dependency + latency + cost for a finite, enumerable format set).
- **Logos:** paid logo API (rejected: key management + cost; cascade + guard
  achieves crispness); server-side image probing (rejected: serverless
  latency, the browser already knows `naturalWidth`).
- **Detail UI:** LLM-only structuring (rejected: slow first paint, cost);
  client-only (rejected: that is the current unsatisfying state).

## Follow-ups (explicitly out of scope)

- Cross-source dedup (LinkedIn row vs ATS row for the same posting) — the
  biggest remaining lever for LinkedIn's 96%-missing descriptions.
- Autocomplete-driven canonical city taxonomy shared with onboarding.
- `requirements_detail` column removal (dead).
