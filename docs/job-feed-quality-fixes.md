# Job feed quality fixes — logos + dead apply links (2026-07-16)

Investigation + fix plan for two user-reported problems in the job catalogue.

## Problem 1 — logos render as a letter on a colored square (esp. LinkedIn)

### Root cause (evidence from prod `divine-base-11638078`, main branch)
- Active catalogue = 5,417 rows. Logo storage: **45% (2,452) hold a Google-favicon
  URL**, 40% a real CDN logo, 15% Wikimedia. Every row has a `company_domain`.
- The frontend (`companyLogo.ts` / `CompanyLogo.tsx`) treats a stored `google.com/s2`
  URL as "generated" and rebuilds the chain to a **single** entry:
  `https://www.google.com/s2/favicons?domain=<domain>&sz=256`. `CompanyLogo`
  rejects that image when `naturalWidth < 40` (Google's globe for an unknown/wrong
  domain, or a site that only exposes a 16px favicon) — and with no further chain
  entry, falls straight to the **letter avatar**.
- The domain is frequently **guessed from the company name** (`domain_from_name`
  → `<token>.com`), which is wrong for `.io/.ai/.co` companies and abbreviations —
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

## Problem 2 — "apply" leads to 404 / "no longer exists" (esp. US jobs)

### Root cause
- The feed shows `active` **and** `stale` (only `removed`/`expired` are hidden).
  Prod: **5,417 active vs 18,343 stale**. The stale rows are dominated by
  **17,334 with `board_key=''`** — the rogue-scraper orphans (killed 2026-07-13)
  that can never be reconciled and went stale en masse ~72h later.
- The URL verifier (`probe_url_liveness`) treats **only HTTP 404/410 as dead**. It
  misses **soft-404s**: probing a real sample showed **4/7 (57%) of old *active*
  LinkedIn rows return HTTP 200 + "No longer accepting applications"**, plus real
  404s among stale (Datadog, Roblox) that the 150/run budget hasn't reached.
- **LinkedIn/Indeed are never verified** — excluded via `_UNPROBEABLE_HOSTS` and not
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
