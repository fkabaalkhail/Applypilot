# Cost audit & job-feed recovery plan

_Written 2026-07-13, after the second-pass cost audit session. This file is the
handoff: everything a future session (or Wissam) needs to push the pending
changes, restore job volume safely, and not re-learn the July cost incidents._

---

## 1. State right now

### Deployed (origin/main @ 9effba2)
- `job_match_scores` memo table live in prod (created by `create_all()` on
  startup — this repo provisions tables that way, **no alembic**). Verified:
  table + unique index `(user_id, job_id)` exist; rows appear once the cron
  actually fires.
- Hourly scrape schedule restored (2aac34d); rogue scraper dead (password
  rotation, verified zero movement).

### Uncommitted in the working tree (THIS session — commit & push to apply)
| File | Change |
|---|---|
| `backend/services/openai_service.py` | `_generate(model=, json_mode=)` params — per-call model routing + OpenAI JSON mode |
| `backend/services/match_engine.py` | `compute_breakdown` runs on `OPENAI_MATCH_MODEL` (default **gpt-4o-mini**, ~16x cheaper than gpt-4o) in JSON mode; raises `ValueError` when the reply has no `overall_score` |
| `backend/services/match_notifier.py` | Sweep fetches full rows only for jobs it can use (unscored / stale-fingerprint / cached-≥threshold). Window LIMIT stays *before* cache filtering — reversing that would dig into the backlog and explode LLM spend |
| `backend/routers/resumes.py` | Upload-time scoring reads/writes the same `job_match_scores` cache (was double-paying ~10 calls/upload) |
| `backend/routers/ai.py` | `/ai/match-breakdown` returns 503 (not fake zeros) on unparseable LLM output |
| `.github/workflows/scrape-jobs.yml` | Dead JobSpy/LinkedIn steps parked (every POST 401s since May 24); cron moved `0 * * * *` → `17 * * * *` (top-of-hour fires get dropped by GitHub — observed) |
| tests | +9: `test_match_sweep_cost.py`, `test_openai_service.py`, `test_ai_router.py` |

**No env changes needed to deploy.** `OPENAI_MATCH_MODEL` is optional (only to
override the gpt-4o-mini default without a deploy). Caveat: gpt-5*/o* models
reject `max_tokens`, which `_generate` still sends — switch to
`max_completion_tokens` before pointing the env var at those.

### Post-push verification checklist
1. Wait for the `:17` cron (GitHub may take up to ~1h to register the edited
   schedule; manual fallback: Actions → "Scrape Jobs" → Run workflow).
2. `SELECT count(*), max(scored_at) FROM job_match_scores;` on prod
   (`divine-base-11638078`, branch main) — nonzero = scrape → cron-poll →
   sweep → cheap model → banked, end to end.
3. OpenAI usage dashboard: scoring traffic should now be gpt-4o-mini.
4. Known-failing tests on clean main (NOT regressions):
   `test_match_notifier.py` (2: alert-card logo, cron endpoint) and
   `test_resume_properties.py` (2: autofill primary-resume, skills merge).

---

## 2. Background you should not re-derive

### The two July cost incidents (both root-caused, fixed)
- **Neon transfer (4.9 GB / 96 MB DB):** a rogue `resumate-scraper` deployment
  (deployed ~May 12, host never found) wrote to Neon **directly with the DB
  password**. Its pre-May-11 dedup fetched whole rows: 6,262/hour × ~2.3 KB ≈
  340 MB/day. On **June 27** its coverage exploded ~20x (798 companies) which
  is when the burn started outpacing the 5 GB/month cap. Killed 2026-07-13 by
  rotating `neondb_owner`. Fingerprint if it returns: `company_logo` =
  `google.com/s2/favicons...`, `source_platform='ats'`, `github_source_id`
  NULL, 38-column INSERTs in `pg_stat_statements`.
- **OpenAI (~$25/day at peak):** the hourly match sweep scored every
  (user × new job) pair on gpt-4o. Fixed by the memo table (9effba2) + the
  cheap-model routing in this working tree. **Caching alone is NOT enough at
  high inflow:** the sweep scores the newest-15 window per user; at ≥15 new
  jobs/hour the window fully turns over between runs and cache hits → ~0%.
  The model price is the protection at high inflow.

### Who has ever fed `scraped_jobs`
1. The rogue (May 12 → July 13): dominant; ~all new jobs June 27 → kill.
2. `cron-ats` (registry scraper via `/github-sources/cron-ats`): ~800/month
   normally, ~0 in early July (rogue at :02 outraced it), **now the feed**.
3. GitHub aggregator (`cron-poll`): ~600 rows lifetime.
4. JobSpy/LinkedIn scripts via `/jobs/create`: legit only before **May 24**
   (commit 809c80f made the endpoint admin-only; they send no auth → 100%
   401s since). Parked in the workflow as of this session.

Current feed: **~26 jobs/day**. Pre-kill: ~500/day. That gap is the product
problem this plan addresses.

### Which model does what (after push)
| Model | Env var | Used for |
|---|---|---|
| gpt-4o-mini | `OPENAI_MATCH_MODEL` | `MatchEngine.compute_breakdown` only: cron sweep, upload scoring, `/ai/match-breakdown`, `/ai/batch-score` |
| gpt-4o | `OPENAI_MODEL` | Everything user-facing: resume parse/analysis/improve, tailor flows, cover letters, autofill `answer_question`, snippet edits, `analyze_job`/`analyze_fit` |
| text-embedding-3-small | `OPENAI_EMBEDDING_MODEL` | Autofill answer memory (reuse ≥0.80 cosine) |

---

## 3. TASK A — Restore ATS volume via registry import (main task)

**Goal:** import the rogue's company coverage into our registry so `cron-ats`
(trusted, column-only dedup, via the API) carries it.

**Registry:** `backend/data/ats_companies.json` —
`{"companies": [{company_name, ats_platform, board_slug, company_logo_url, enabled}]}`.
Data-only; `backend/data/company_registry.py` loads it, no code changes to add
companies. **`SUPPORTED_PLATFORMS = {greenhouse, lever, ashby, smartrecruiters}`**
— workday entries are kept but skipped by the scraper.

**Honest scope:** of the rogue's ~798 companies, ~233 are on supported
platforms (≈136 greenhouse / 72 ashby / 17 lever / 8 smartrecruiters), 38 are
workday (import disabled, for later), ~566 are custom career sites cron-ats
cannot scrape. So this task roughly **doubles** coverage (214 → ~430+), it does
not fully replace the rogue. Custom-site coverage is a separate, bigger project.

### A1. Extract slugs from the rogue's own rows (prod, read-only)
```sql
SELECT DISTINCT
  CASE
    WHEN url ~ 'greenhouse\.io' THEN 'greenhouse'
    WHEN url ~ 'jobs\.lever\.co' THEN 'lever'
    WHEN url ~ 'ashbyhq\.com' THEN 'ashby'
    WHEN url ~ 'smartrecruiters\.com' THEN 'smartrecruiters'
    WHEN url ~ 'myworkdayjobs\.com' THEN 'workday'
  END AS platform,
  CASE
    WHEN url ~ 'greenhouse\.io' THEN substring(url from 'greenhouse\.io/([^/?#]+)')
    WHEN url ~ 'jobs\.lever\.co' THEN substring(url from 'jobs\.lever\.co/([^/?#]+)')
    WHEN url ~ 'ashbyhq\.com' THEN substring(url from 'ashbyhq\.com/([^/?#]+)')
    WHEN url ~ 'smartrecruiters\.com' THEN substring(url from 'smartrecruiters\.com/([^/?#]+)')
    WHEN url ~ 'myworkdayjobs\.com' THEN substring(url from 'https?://([^/]+)')
  END AS slug,
  max(company) AS company_name
FROM scraped_jobs
WHERE source_platform = 'ats' AND github_source_id IS NULL
  AND url ~ '(greenhouse\.io|jobs\.lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com)'
GROUP BY 1, 2 HAVING CASE WHEN url ~ '' THEN true END IS NOT NULL;
```
(Adjust as needed — greenhouse URLs may be `boards.greenhouse.io/{slug}` or
`job-boards.greenhouse.io/{slug}`; verify against real rows before trusting the
regex. Dedupe against existing `board_slug`s in the JSON, case-insensitively.)

### A2. Append to `ats_companies.json`
- `enabled: true` for supported platforms; `enabled: false` for workday.
- `company_logo_url`: follow the existing convention
  (`https://www.google.com/s2/favicons?domain={domain}&sz=128`) — note this
  means favicon logos are NOT a rogue-only fingerprint going forward; the
  38-column INSERT and direct-DB access remain the real discriminators.

### A3. Shard cron-ats (REQUIRED before enabling ~430 companies)
One cron-ats invocation scrapes the whole registry inside a single Vercel
request with a **300 s cap** (`--max-time 300` in the workflow). Fine at 214,
not at 430+. Shard it:
- e.g. `CRON_ATS_SHARDS` (env, default sized so a slice ≈ 150 companies) and
  select `companies[i]` where `hash(board_slug) % SHARDS == current_hour % SHARDS`.
  Every board still refreshed every N hours; job posts don't need hourly.
- Keep per-run dedup column-only (`SELECT scraped_jobs.url`) — that invariant
  is what keeps transfer cheap. Never fetch entities to answer "exists?".

### A4. Verify after enabling
- Neon data-transfer graph for 24–48 h. Budget at full volume (~500 jobs/day):
  dedup ~300 MB/mo + aggregator ~50 MB/mo + sweep reads ~130 MB/mo ≈
  **0.5–0.7 GB of the 5 GB cap**.
- OpenAI: sweep at restored volume on mini ≈ **$0.50–0.80/day**
  (would be ~$10/day on gpt-4o — do not revert the model).
- `SELECT count(*) FROM scraped_jobs WHERE scraped_at > now() - interval '1 day'`
  should climb toward a few hundred.

---

## 4. TASK B — Batch ingest endpoint, then unpark JobSpy/LinkedIn

To get Indeed/LinkedIn coverage back (dead since May 24):
1. New endpoint, e.g. `POST /jobs/ingest-batch`: accepts a JSON array of jobs,
   auth via `x-cron-secret` (pattern: `verify_cron_secret` in
   `backend/routers/github_sources.py`), dedupes with **one**
   `SELECT url WHERE url IN (...)` per batch, bulk-inserts the rest.
2. Update `scripts/scrape_jobspy.py` + `scripts/scrape_linkedin.py` to collect
   and POST in chunks (e.g. 100/request) instead of one call per job.
   (`scrape_linkedin.py` also still points at stale `resumate-smoky.vercel.app`
   — fix `API_BASE`.)
3. Unpark the two workflow steps (they're preserved as comments in
   `scrape-jobs.yml`).
4. Cost note: each restored source multiplies sweep LLM volume
   (users × new jobs). Fine on mini; at 25+ resume-holding users consider the
   prefilter below first.

---

## 5. Smaller follow-ups (in rough priority order)

- **Embedding prefilter for the sweep** (when users or inflow grow ~10x):
  embed each job once globally (`text-embedding-3-small`, ~free), embed each
  resume once per fingerprint, LLM-score only pairs above a cosine floor or
  top-K. Cuts sweep calls another ~5–10x. Calibrate the floor against banked
  `job_match_scores` before trusting it.
- **Cache `/ai/match-breakdown` per (user, job, fingerprint)** — recomputed on
  every job-detail open today; needs a breakdown JSON column or table since
  `job_match_scores` only stores the overall score. Cheap on mini; do when
  traffic grows.
- **Workday board scraping** in cron-ats (38 rogue companies waiting) — tenant
  host + CXS API; description fetch already exists (b7c0441).
- **Billing alerts**: OpenAI usage limit + Neon transfer alert, so the next
  anomaly emails you before it becomes a session.
- **`test_save_batch_dedup.py`** targets a nonexistent endpoint (404s on clean
  main) — retire or repoint it when Task B lands.

## 6. Gotchas this session paid for (don't re-learn)

- **GitHub scheduled crons at minute 0 get dropped** under load; after editing
  a schedule, registration can lag ~1 h. `workflow_dispatch` is the reliable
  manual trigger. The workflow being "active" ≠ it fired.
- **Vercel runtime logs retain ~1 h on Hobby** — absence of logs older than
  that proves nothing.
- **`pg_stat_statements` resets on Neon autosuspend** (its `stats_reset` ≈ last
  compute wake). `pg_stat_user_tables` survives. Neon's branch
  `data_transfer_bytes` is trustworthy in aggregate only.
- **Tables ship via `create_all()` at startup, not alembic** — a new model
  needs no migration file, but dev/prod get it on first boot after deploy.
- The sweep only scores users with `email_verified` AND a resume with
  `raw_text` (currently 4 of 11 verified users), skips users alerted <24 h ago
  *before* spending, and stops when the daily email budget (80) is gone.
