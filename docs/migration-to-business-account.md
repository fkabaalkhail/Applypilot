# Migrating Vercel + Neon to the business-email account

**Written 2026-07-14.** Numbers below were measured against prod on that date — re-check them before you start, not after.

## What you're actually moving

| | |
| --- | --- |
| Database | Neon `divine-base-11638078`, **71 MB**, 26 tables, **12 users** |
| Live sessions | **31** — of which **5 are connected Chrome extensions** |
| Résumé files | **5 blobs** in a *private* Vercel Blob store |
| Encrypted secrets in DB | **0** (no LinkedIn passwords, no cookies) |
| Env vars | 27 backend + 6 frontend (`VITE_*`) |
| Domain | `www.tailrd.ca` |

## What comes along for free — don't waste time on these

- **Schema migrations.** The app runs them itself on startup (FastAPI lifespan). Point it at an empty Neon database and it builds its own schema. You are moving *data*, never schema.
- **Build config.** `vercel.json` is in the repo — build command, output dir, all the `/api/*` rewrites, the COOP/CSP headers. It travels with the git repo.
- **Cron jobs.** They are **GitHub Actions, not Vercel crons** (`.github/workflows/scrape-jobs.yml`, hourly at minute :17). They `curl https://www.tailrd.ca/github-sources/cron-ats` with a `x-cron-secret` header. **If the domain moves with you, they keep working with zero changes.** They don't live in the Vercel account at all.
- **Google + LinkedIn OAuth.** Those apps live in Google Cloud Console and the LinkedIn developer portal, keyed to the **domain**, not to Vercel. Keep `tailrd.ca` → nothing to change.
- **The Chrome extension.** `externally_connectable` is `tailrd.ca` and it calls the API at the prod domain. It has no idea which Vercel account serves it. **No rebuild, no resubmission.**
- **`ENCRYPTION_KEY`.** It is a Fernet key protecting `linkedin_password_encrypted` and `linkedin_cookies` — and **both columns are empty for every user.** It currently protects nothing, so you may generate a fresh one. It must still be *set* (`services/crypto.py` raises without it).

---

## Path A — Transfer the project (try this first)

If it works this is ~15 minutes with **zero downtime**, because the domain, env vars, and deployment history stay attached to the project.

Vercel transfers projects **into a Team you belong to**, not into another personal account. So:

1. From your current account, create a **Vercel Team**. Set its billing email / owner to the business address. (A Team is what you actually want anyway — it's what lets you add people later without sharing a login.)
2. Project → **Settings → Advanced → Transfer Project** → choose the new Team.
3. Reconnect the GitHub repo if it asks.

**Before you commit to this path, verify one thing:** does the **Blob store** transfer with the project? Blob is a *Storage* resource attached to the account/team, and a project transfer may leave it behind — in which case your 5 résumé URLs go dead exactly as in Path B. Check Storage in the new Team after transferring; if the store isn't there, do **Step 5** below and nothing else.

Neon can be moved independently: Neon → Project Settings → **Transfer to another organization**. Or just do Path B's Step 2.

---

## Path B — Rebuild on a fresh account (the certain path)

### Step 0 — Capture the current production env vars

Do this **first**. It is the difference between a 2-hour job and a bad evening.

```bash
npm i -g vercel
vercel login              # log in as the CURRENT account
vercel link               # link this repo to the existing project
vercel env pull .env.production --environment=production
```

You now have every production value in one file. **Keep it out of git** (`.env*` is already ignored — confirm). Do not skip this and hand-copy from the dashboard; you will typo something and spend an hour finding it.

### Step 1 — Create the new accounts

Vercel and Neon, both on the business email. Don't connect anything yet.

### Step 2 — Move the database

Neon → new project. Then, with the **old** connection string as `OLD_URL` and the **new** one as `NEW_URL`:

```bash
pg_dump "$OLD_URL" --no-owner --no-privileges -Fc -f tailrd.dump
pg_restore -d "$NEW_URL" --no-owner --no-privileges tailrd.dump
```

71 MB — this takes about a minute. `--no-owner --no-privileges` matters: the new database has a different role name and the restore will otherwise fail on ownership.

Sanity-check the restore before moving on:

```sql
SELECT count(*) FROM users;          -- expect 12
SELECT count(*) FROM resume_profiles; -- expect 5
SELECT count(*) FROM sessions WHERE revoked_at IS NULL;  -- expect ~31
```

Create a `Development` branch in the new Neon project too — the test suite migrates against it (see `docs/` and the pytest setup).

### Step 3 — Create the new Vercel project

New Vercel project → import the **same GitHub repo**. `vercel.json` gives it the build config automatically. Let the first deploy fail if it wants; it has no env vars yet.

### Step 4 — Set the env vars

From `.env.production` (Step 0). Three categories:

**Copy verbatim — these are the ones that hurt if you get them wrong:**

| Var | Why |
| --- | --- |
| **`JWT_SECRET`** | **The big one.** 31 live sessions, **5 of them connected extensions.** Change this and every extension's refresh token stops verifying — all 5 users must re-run the PKCE Connect flow, at the exact moment your install banner is driving *new* people through it. Copy it exactly. |
| `CRON_SECRET` | Must match the `CRON_SECRET` in **GitHub → repo → Settings → Secrets**, or the hourly scraper starts 401-ing silently. |
| `OPENAI_API_KEY`, `RESEND_API_KEY`, `GITHUB_TOKEN` | Just secrets. Copy them. |
| `GOOGLE_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` | Must match the OAuth apps, which are unchanged. |

**These two are NEW — do not copy the old values:**

| Var | Value |
| --- | --- |
| `DATABASE_URL` | The **new Neon** connection string (pooled). |
| `BLOB_READ_WRITE_TOKEN` | From the **new** Vercel Blob store (create one under Storage). |

**Regenerate freely (protects nothing today):**

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```
→ `ENCRYPTION_KEY`

**Retype from `.env.production` (plain config, no secrets):**
`ENVIRONMENT`, `FRONTEND_URL`, `CORS_ORIGINS`, `ENABLE_DOCS`, `MAX_REQUEST_BYTES`, `RATE_LIMIT_ENABLED`, `REQUIRE_EMAIL_VERIFICATION`, `CRON_ATS_SHARDS`, `OPENAI_MODEL`, `OPENAI_MATCH_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_MAX_TOKENS`, `OPENAI_TIMEOUT`

**`EXTENSION_ALLOWED_IDS` — set it correctly this time:**
```
apgogjfdpleeajnngkfkfekbddcpodkl,dadbhjlflnljgailcpgehdainjdmjeej
```
Both ids. The Web Store strips the manifest `key` and assigns its own, so the store build's id is **not** the dev id. `auth_extension.py` fails **closed** — miss the store id and every user who installs from the listing is rejected at Connect.

**Frontend (`VITE_*`, build-time — they get baked into the bundle, so a change needs a redeploy):**
`VITE_API_URL`, `VITE_CHROME_STORE_URL`, `VITE_EXTENSION_ID`, `VITE_EXTENSION_IDS`, `VITE_GOOGLE_CLIENT_ID`, `VITE_LINKEDIN_ENABLED`

### Step 5 — Move the 5 résumé blobs

**This is the step people forget, and it fails silently.**

`backend/services/blob_storage.py` puts uploaded résumés in a **private** Vercel Blob store. The database only holds a `file_blob_url` *string*. A new Vercel account means a new Blob store — so those 5 URLs go dead while the DB rows sit there pointing at nothing. Nobody notices until a user tries to download their résumé, or the extension tries to attach it to an application.

The old store is private, so reads need the **old** token as a Bearer header.

```python
# scripts/migrate_blobs.py — run once, after Step 4, BEFORE you kill the old account.
import os, httpx, psycopg
from vercel_blob import put   # or POST to the Blob API directly

OLD_TOKEN = os.environ["OLD_BLOB_TOKEN"]      # old account's BLOB_READ_WRITE_TOKEN
NEW_TOKEN = os.environ["BLOB_READ_WRITE_TOKEN"]
NEW_DB    = os.environ["DATABASE_URL"]        # the NEW Neon

with psycopg.connect(NEW_DB) as conn, conn.cursor() as cur:
    cur.execute(
        "SELECT id, file_blob_url, file_name FROM resume_profiles "
        "WHERE file_blob_url IS NOT NULL AND file_blob_url <> ''"
    )
    for rid, old_url, name in cur.fetchall():
        blob = httpx.get(old_url, headers={"Authorization": f"Bearer {OLD_TOKEN}"}, timeout=30)
        blob.raise_for_status()                       # fail loud, do not skip
        new_url = put(name, blob.content, {"access": "private", "token": NEW_TOKEN})["url"]
        cur.execute("UPDATE resume_profiles SET file_blob_url=%s WHERE id=%s", (new_url, rid))
        print(f"{rid}: {name} -> {new_url}")
    conn.commit()
```

Then verify: every `file_blob_url` should point at the new store's hostname, and downloading one through the app should return the actual PDF.

### Step 6 — Verify on the throwaway URL, before touching DNS

The new project has a `*.vercel.app` URL. Prove it works there **first** — this is the whole reason the domain move is last.

- [ ] Sign in with email/password
- [ ] Sign in with Google *(will fail until the `*.vercel.app` origin is added to the Google OAuth app — or just accept it and re-test after the domain swap)*
- [ ] Upload a résumé, then download it back (**proves Step 5**)
- [ ] `/health` returns green
- [ ] Open Settings → Security: your existing sessions are listed (**proves the DB restore and `JWT_SECRET`**)
- [ ] `curl -X POST "<vercel-app-url>/github-sources/cron-ats" -H "x-cron-secret: $CRON_SECRET"` → not 401 (**proves `CRON_SECRET`**)

### Step 7 — Move the domain (the downtime window)

**Do this last, when everything above is green.**

A domain can only live on one Vercel project at a time, so: remove `tailrd.ca` and `www.tailrd.ca` from the **old** project, then add them to the **new** one. The gap is your downtime — a few minutes if Vercel is your registrar, longer if it's external and you're waiting on DNS TTL.

**Check first:** is `tailrd.ca` registered *at* Vercel, or at an external registrar? That decides whether this is a click or a DNS change with a propagation wait. If external, lower the TTL to 60s a day beforehand.

Once the domain is live on the new project:
- The GitHub Actions cron resumes automatically (it targets `www.tailrd.ca`).
- Google/LinkedIn OAuth resumes automatically (same redirect URIs).
- The Chrome extension resumes automatically (`externally_connectable` matches `tailrd.ca`).

### Step 8 — Only now, tear down

Keep the old Vercel project and the old Neon project **paused, not deleted**, for a week. If Step 5 missed a blob, the old store is the only place it exists.

---

## The three ways this goes wrong

1. **You regenerate `JWT_SECRET`.** Every connected extension dies and has to re-Connect. Copy it.
2. **You forget the blobs.** The DB restores perfectly, the site looks fine, and five people's résumés are quietly 404ing. Do Step 5.
3. **You move the domain before verifying.** Now you're debugging a live outage instead of a staging URL. Step 7 is last for a reason.
