# Friday Beta — Go-Live Checklist (account + login path)

Scope: make sure a beta tester can **create an account, log in, and use the app
(extension + web) without getting stuck**, with credentials stored securely.

Verdict: the auth/credential layer is solid (bcrypt, JWT rotation + revocation,
session registry, lockout, rate limiting, Fernet-encrypted secrets). The only
thing standing between a new tester and a working session is the **email
verification gate**, which is now made optional for the beta.

---

## The one blocker we found (confirmed live in prod)

A freshly registered, unverified user is blocked from every real endpoint:

```
GET https://www.tailrd.ca/api/extension/sync
-> 403 {"detail":"Email verification required"}
```

Every meaningful surface — extension `sync`, the extension PKCE `authorize`
handshake, `apply`, `answers`, `profile`, and the web app's `ProtectedRoute` —
requires a verified email. If verification email delivery is anything less than
perfect on Friday, testers register and then can't do anything.

### Fix (already in the code)

A reversible env flag, `REQUIRE_EMAIL_VERIFICATION`, defaulting to `true`
(secure). When set to `false`:

- the backend verification gate is bypassed (`backend/auth/dependencies.py`), and
- auth responses + `GET /auth/me` report `email_verified` as effectively true,
  so the **web `ProtectedRoute` and the extension are both unblocked with no
  frontend rebuild** (`backend/routers/auth.py`, `backend/routers/auth_extension.py`).

Nothing is persisted as fake-verified: flip the flag back to `true` post-beta and
real verification status returns. Tested in `backend/tests/test_verification_bypass.py`
(19 tests) with no regressions across the auth + extension suites (40 passing).

---

## MUST DO in Vercel before Friday

| Env var | Set to | Why |
|---|---|---|
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Unblocks testers without depending on email delivery. **The single most important switch for Friday.** |
| `EXTENSION_ALLOWED_IDS` | `apgogjfdpleeajnngkfkfekbddcpodkl` | The extension's handshake **fails closed in prod** without this. This is the deterministic ID from the manifest `key` (stable for unpacked + Web Store). |

Already confirmed set/working in prod (via `/health` = `{"database":true,"openai":true}`
and HSTS present):
`ENVIRONMENT=production`, `DATABASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET`.

Confirm these are also set (needed for full functionality, not just smoke):
`ENCRYPTION_KEY` (LinkedIn/credential encryption), `GOOGLE_CLIENT_ID` (only if
testers use "Sign in with Google"), `CRON_SECRET`. `CORS_ORIGINS` is **not** a
beta blocker — the web app is same-origin with the API and the extension fetches
via host permissions.

`RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `FRONTEND_URL` are **not required** with
the gate off (no verification email needed). Set them later when you re-enable
verification.

---

## 2-minute post-deploy smoke test

Run after deploying the code + setting the two env vars above:

```bash
BASE=https://www.tailrd.ca
EMAIL="smoke.$(date +%s)@example.com"; PASS='Str0ng!betaPass1'

# 1. register -> expect 200 and "email_verified": true  (gate off)
curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"

# grab the access_token from that response into $TOK, then:
# 2. extension path should now WORK (was 403 before) -> expect 200
curl -s -o /dev/null -w "sync -> HTTP %{http_code}\n" \
  $BASE/api/extension/sync -H "Authorization: Bearer $TOK"
```

- [ ] `register` returns `"email_verified": true`
- [ ] `GET /api/extension/sync` returns **200** (not 403)
- [ ] Web: sign up at www.tailrd.ca → you land in the app, **not** on `/verify-email`
- [ ] Extension: install → "Connect account" → handshake succeeds → profile syncs
- [ ] Wrong password still returns 401; 5 wrong tries still locks the account

---

## Already verified (no action needed)

- `/health` → 200, DB + OpenAI reachable.
- `/docs` & `/openapi.json` are **not** exposing Swagger (they hit the SPA catch-all).
- Security headers present (HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy).
- Account creation, login, token auth, wrong-password 401 all work against prod.
- Passwords bcrypt-hashed (12 rounds); refresh tokens rotate + can be revoked;
  per-user job ownership checks present (no IDOR).

## Notes / deferred (not Friday blockers)

- Minor: the deployed API response lacked a `Content-Security-Policy` header
  (X-Frame-Options DENY already prevents framing). A redeploy of current `main`
  includes the CSP middleware.
- "Save jobs from a page" (batch `/api/extension/jobs/save-batch`) is **not built**
  — there are spec/tests for it (`backend/tests/test_save_batch_dedup.py`, currently
  failing 404) but no endpoint and no extension call yet. Per-job save
  (`POST /jobs/{id}/save`) exists and is user-scoped. Decide before Friday whether
  bulk page-save is in scope; if so it needs to be implemented.
- A couple of throwaway `smoke.*@example.com` / `betasmoke.*@example.com` users
  were created in prod during testing — harmless, delete at leisure.
