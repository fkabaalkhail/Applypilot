# Migration: Tailrd → new Vercel + Neon accounts (clean slate)

Move the app off the **`fkabaalkhail-6683`** Vercel account (and its Vercel-managed
Neon + Blob) onto fresh accounts owned by the **Tailrd identity**.

**This is a clean-slate migration.** Since we're pre-launch, all users and their
data are intentionally discarded. The **only** thing carried over is the public
job catalogue (`scraped_jobs`) so the feed isn't empty on day one.

**Decisions locked in:**
- New DB + Blob: provisioned fresh from the **new Vercel account's Marketplace** (Neon native integration + Vercel Blob). Both start empty; their env vars auto-inject.
- Domain: `tailrd.ca` is on an **external registrar** → repoint DNS at cutover.
- Repo: **stays put**; grant the new Vercel account access.
- Data: **wipe everything except `scraped_jobs`** (28,995 rows / ~26,824 visible as of 2026-07-16).

---

## What moves vs. what's wiped

| Piece | Action |
|---|---|
| App (Vite/React SPA + FastAPI fn) | Re-import repo; `vercel.json` carries build config |
| DB schema | **Self-creates** — the app runs migrations on startup |
| `scraped_jobs` (the job feed) | **Copied** old→new (one table, no PII) |
| Users, résumés, applications, matches, autofill, sessions, `neon_auth.*` | **Discarded** — new DB starts empty |
| Résumé files (Blob) | Fresh empty store; old files discarded |
| Domain `tailrd.ca` / `www` | Repoint DNS old→new |
| Env vars | 18, already in `.env.old`, ready to paste |

## What does NOT change (domain stays `www.tailrd.ca`)
- **GitHub Actions** — `scrape-jobs.yml` hits `www.tailrd.ca` with `CRON_SECRET`; `ci.yml` uses SQLite. Zero changes as long as domain + `CRON_SECRET` are preserved.
- **Google/LinkedIn OAuth** redirect URIs, **extension** IDs/origins, **CORS** — all domain-based, unchanged.

---

## Prerequisites
1. **Real login** to the old Vercel account (to detach the domain — the tool connection isn't the same as a dashboard login).
2. `npm i -g vercel`.
3. **Postgres 17 client** (`pg_dump`/`psql`) for the `scraped_jobs` copy. Windows-friendly: `docker run --rm postgres:17 pg_dump ...`.
4. **Lower `tailrd.ca` DNS TTL** to 60s a day before cutover.

## Environment variables
`.env.old` holds the **18** production vars, ready to bulk-paste into the new project's **Production** environment (add to **Preview** too if you use preview deploys).
- **Not in the file — injected by the integrations:** `DATABASE_URL`/`POSTGRES_*`/`PG*` (Neon) and `BLOB_READ_WRITE_TOKEN` (Blob). Don't add them by hand.
- **`CRON_SECRET` must equal the GitHub repo secret** `CRON_SECRET` (Settings → Secrets → Actions), or the scrape workflow stops authenticating.
- **Optional clean break:** regenerate `ENCRYPTION_KEY` (Fernet), `JWT_SECRET`, `CRON_SECRET` fresh — nothing to decrypt and no users to keep logged in. If you rotate `CRON_SECRET`, set the same value in GitHub.
- `# comment` lines are ignored by Vercel's paste importer.

---

## Phase 1 — Create the new homes
1. Sign up for **Vercel with the Tailrd identity** — it becomes the master key to Vercel **and** Neon **and** Blob (access to the managed DB/store is via Vercel SSO).
2. **Import the repo** (authorize the Vercel GitHub app). `vercel.json` sets build `cd frontend && npm install && npm run build`, output `frontend/dist`, function `api/index.py`. Don't deploy yet.
3. **Add Neon** (Storage → Marketplace → Neon → Create New Neon Account). Empty DB; injects `DATABASE_URL` etc.
4. **Add Blob** (Storage → Blob). Empty store; injects `BLOB_READ_WRITE_TOKEN`. *(Optional — the app degrades gracefully without it; résumé file storage just stays off until added.)*
5. **Paste the 18 env vars** into Production.

## Phase 2 — Deploy + verify
1. Deploy → get the `*.vercel.app` URL.
2. **Confirm the schema self-migrated** — check the first deploy/function logs show migrations ran; the empty Neon should now have all tables.
3. Smoke-test on `*.vercel.app`: signup/login (Google + LinkedIn), résumé upload/download (Blob), a match run (OpenAI). *(The job feed is empty until Phase 3.)*

## Phase 3 — Copy the job catalogue (`scraped_jobs` only)
The app has created an empty `scraped_jobs`; load the old data into it. Use the
**direct/unpooled** connection strings (`...UNPOOLED`, `?sslmode=require`) for both.

```bash
# OLD = old prod Neon.  NEW = new Neon (Storage → Open in Neon → connection string).

# 1. Clean slate on the new table (fresh DB — precautionary, avoids id collisions):
psql "$NEW_DATABASE_URL" -c 'TRUNCATE scraped_jobs CASCADE;'

# 2. Copy the table data old → new (data-only; schema already exists):
pg_dump "$OLD_DATABASE_URL" --table=scraped_jobs --data-only --no-owner \
  | psql "$NEW_DATABASE_URL"
```
- `--data-only` preserves ids and sets the id sequence, so the hourly cron keeps inserting cleanly on top.
- Run this **before the first cron run** (or after the truncate above) to avoid primary-key collisions.
- ~29k rows → completes in a minute or two.
- The **OLD** connection string can be pulled for you via Neon; the **NEW** one comes from the new project's Storage tab.
- `source_health` and `github_sources` re-seed themselves — no need to copy them.

## Phase 4 — Domain cutover (external registrar)
1. Old Vercel project → Settings → Domains → **remove** `tailrd.ca` + `www.tailrd.ca`.
2. New project → Domains → **add** both → Vercel shows the records + a one-time **TXT** verification.
3. At the registrar: add the TXT and set A/CNAME to exactly what the new project shows (apex `A` → Vercel IP; `www` → `cname.vercel-dns.com`). Both projects are on Vercel's edge, so records are often identical — the real change is the in-Vercel domain claim + TXT verify.
4. Wait for verify + SSL → test `https://www.tailrd.ca`.

## Phase 5 — Decommission old
No data-rollback need (clean slate). Once the new stack is verified stable:
- Delete the old Vercel project and uninstall its Neon + Blob integrations. *(Deleting the Neon integration permanently removes the old DB — fine, nothing's needed from it once `scraped_jobs` is copied.)*

---

## Verification checklist
- [ ] `https://www.tailrd.ca` served by the **new** project; SSL valid
- [ ] Schema present (migrations ran on first boot)
- [ ] `scraped_jobs` count on new ≈ old (~27k) — the feed is populated
- [ ] New signup/login works (Google + LinkedIn); résumé upload/download works
- [ ] Next hourly `scrape-jobs.yml` run is green (confirms `CRON_SECRET` + domain intact)

## Note on the free (Hobby) plan
Crons run via GitHub Actions (not Vercel cron), so the Hobby cron limit doesn't
bite. The real caveats: Hobby is **non-commercial** (Tailrd is a product → ToS
risk) and has lower function limits. Plan to move to **Pro** / a Team once settled.
