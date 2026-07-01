# Beta Security & Rate-Limiting — Go/No-Go Checklist

Hardening pass for the Friday beta. Scope: rate limiting / traffic control and
data-leak prevention. This documents what changed, what **you** must do before
launch, and what was deliberately deferred.

---

## TL;DR

- **No client-facing data leaks and no IDOR/authorization holes were found.** The
  auth layer (lockout, token rotation + revocation, session registry, PKCE
  extension flow) and per-user ownership checks are solid.
- The real gap was **cost/abuse protection on the AI endpoints** — now closed
  with a database-backed limiter (per-minute burst + per-user daily quota) that
  works correctly on Vercel serverless.
- A few defense-in-depth headers and a request-size cap were added.

---

## What changed (code)

| Area | Change | Files |
|------|--------|-------|
| Rate limiting | New DB-backed fixed-window limiter (shared across serverless instances) | `backend/services/usage_limiter.py`, `backend/db/models.py` (`RateCounter`) |
| AI cost control | Per-minute burst + per-user daily quota on every LLM endpoint | `backend/routers/ai.py`, `fill.py`, `tailor.py`, `cover_letter.py` |
| Headers | Added `Content-Security-Policy`; existing headers kept | `backend/main.py` |
| Traffic control | Reject oversized request bodies (HTTP 413) | `backend/main.py` |
| Attack surface | API docs (`/docs`, `/redoc`, `/openapi.json`) off in production by default | `backend/main.py` |
| Log hygiene | Stopped logging Google's raw response body / client id | `backend/routers/auth.py` |
| Tests | Limiter unit + end-to-end 429 tests | `backend/tests/test_usage_limiter.py` |

The `rate_counters` table is created automatically on startup
(`Base.metadata.create_all` in the lifespan) — **no manual migration needed**.

---

## ⚠️ MUST DO before Friday — set these in Vercel

All have safe defaults, so the app runs without them, but review and set
explicitly for production:

| Env var | Purpose | Suggested beta value |
|---------|---------|----------------------|
| `ENVIRONMENT` | Enables HSTS, disables `/docs`, fails cron closed | `production` |
| `RATE_LIMIT_ENABLED` | Master switch for the AI limiter | `true` |
| `LLM_PER_MINUTE` | Per-user AI requests / minute (burst guard) | `12` |
| `LLM_DAILY_QUOTA` | Per-user AI requests / day (cost cap) | `150` (tune to your OpenAI budget) |
| `MAX_REQUEST_BYTES` | Max request body size | `10485760` (10 MB) |
| `CORS_ORIGINS` | Comma-separated allowed origins | your real web origin(s) **only** — no `localhost`, no `*` |

**Already required (confirm they're set):** `JWT_SECRET`, `OPENAI_API_KEY`,
`DATABASE_URL`, `GOOGLE_CLIENT_ID`, `CRON_SECRET`, `RESEND_API_KEY`.

> Tune `LLM_DAILY_QUOTA` to your wallet: worst case cost ≈
> `(active users) × LLM_DAILY_QUOTA × cost-per-call`. Start conservative; you can
> raise it from the Vercel dashboard without redeploying code.

---

## Verify after deploy (2-minute smoke test)

- [ ] `GET /health` returns 200.
- [ ] In production, `GET /docs` returns 404 (set `ENABLE_DOCS=true` to re-enable if you need it).
- [ ] Any response includes `Content-Security-Policy` and `X-Frame-Options` headers.
- [ ] Hammer an AI endpoint (e.g. `/api/fill`) past `LLM_PER_MINUTE` → you get
      HTTP 429 with a `Retry-After` header.
- [ ] A normal user flow (login → upload resume → generate cover letter) still works.

---

## Known limitation (read this)

The limiter **fails open**: if the `rate_counters` table is briefly unreachable,
requests are *allowed* rather than blocked. This is intentional — a limiter
outage must never take the whole app down — but it means the quota is a cost
guardrail, not a hard financial ceiling. For a beta this is the right trade-off.

The legacy in-memory limiter on the **auth** endpoints (`register`, `login`,
extension handshake) is unchanged. It still works per-instance and is backed by
account lockout + email verification, so it's adequate for beta. If auth abuse
becomes a problem, migrate those to `usage_limiter` too (one-line swap each).

---

## Deferred (not blockers — post-beta)

- **Shared Redis/Upstash limiter** for sub-second precision and atomic counters.
  The DB limiter is sufficient for beta traffic; revisit if write volume on
  `rate_counters` grows. Upgrade path: reimplement `_hit()` against Redis
  `INCR`/`EXPIRE` — the call sites don't change.
- **PII in server logs** (user emails on register/verify, tracebacks in
  `github_sources.py`). These are server-side only (not exposed to clients) and
  useful for ops/debugging, so they were left as-is. Scrub later if you ship logs
  to a third party.
- **Periodic cleanup** of expired `rate_counters` rows (use the `expires_at`
  column). Low volume for beta; add a cron sweep later.
- Replace deprecated `datetime.utcnow()` usages (warnings only).
