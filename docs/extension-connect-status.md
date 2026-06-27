# Extension Connect Flow — Status & Pick-Up Doc

**Last updated:** 2026-06-27
**Owner:** Wissam
**Purpose:** Single source of truth for the Chrome-extension "Connect" (web-authenticated handshake) work. Point the next session here to resume exactly where we left off.

---

## TL;DR

**The connect flow is already fully implemented and wired end-to-end.** Backend, extension client, and web page all exist, are registered/routed, and have test coverage. This is a **PKCE S256 authorization-code** handshake — stronger than the simple `connectToken` sketch in the architecture spec.

There was **one genuine go-live blocker**: in production the backend rejects every connect attempt unless the `EXTENSION_ALLOWED_IDS` env var is set (it fails *closed*).

**Progress 2026-06-27:** the extension ID is now pinned to **`apgogjfdpleeajnngkfkfekbddcpodkl`** via a `key` added to `chrome-extension/manifest.json`. The Vercel prod env var `EXTENSION_ALLOWED_IDS` was set to that ID (it had been added empty ~20h earlier, which never closed the gap) and production was redeployed (`resumate-ggnwf069z`, aliased to www.tailrd.ca). API-level verification passed: `/health` 200, `/auth/extension/authorize` 401 (route live, auth-gated), `/auth/extension/token` 400 on a bad code. **The only thing left is the browser-driven end-to-end check** (load the unpacked build, click Connect) — that needs a human + Chrome.

Nothing here needs to be *built*. The remaining work is a one-time **live verify**.

---

## How the flow works (as built)

```
[Extension overlay]  "Connect your Tailrd account" button
      │  overlay.ts → doConnect() → CONNECT message
      ▼
[Service worker]  connectAccount()  (handshake.ts)
      │  generates PKCE verifier+challenge + state nonce
      │  chrome.identity.launchWebAuthFlow → opens web page:
      ▼
[Web app]  /extension/connect  (ExtensionConnect.tsx)
      │  reuses live web session (bounces to /sign-in?next if signed out)
      │  POST /auth/extension/authorize  (web access token)
      │     → mints single-use 60s code bound to user + challenge + redirect_uri
      │  redirects to  <id>.chromiumapp.org/#code=…&state=…
      ▼
[Service worker]  exchanges code (handshake.ts)
      │  POST /auth/extension/token  { code, code_verifier }   (PUBLIC, no auth)
      │     → verifies PKCE S256, single-use, not expired
      │     → returns access + refresh token pair tagged client="extension"
      ▼
[Extension]  saveAuth(tokens) → leaves mock mode → syncIfStale()
```

No CAPTCHA touches any extension route — confirmed (the only `reCAPTCHA` references in the codebase are page-injection comments in `serviceWorker.ts`, unrelated to auth).

---

## Component status

| Layer | File | Status |
|---|---|---|
| Backend: authorize + token endpoints | `backend/routers/auth_extension.py` | ✅ Built (PKCE S256, single-use 60s codes, redirect_uri allowlist, rate-limited, security logging) |
| Backend: router registration | `backend/main.py:76` (`/auth/extension`) | ✅ Registered |
| Backend: DB model | `backend/db/models.py:478` (`ExtensionAuthCode`) | ✅ Present |
| Backend: migration | `backend/migrations/add_extension_auth_codes.py` | ✅ Present |
| Backend: tests | `backend/tests/test_extension_auth.py` | ✅ Covers authorize, token, PKCE mismatch, replay, expiry, redirect_uri rejection — **not run this session** (pytest migrates the real dev Neon DB) |
| Extension: handshake client | `chrome-extension/src/api/handshake.ts:58` (`connectAccount`) | ✅ Built (PKCE + launchWebAuthFlow + state nonce) |
| Extension: CONNECT handler | `chrome-extension/src/background/serviceWorker.ts:164` | ✅ Built |
| Extension: UI button | `chrome-extension/src/content/overlay.ts:673` → `doConnect()` (`:1170`) | ✅ Wired |
| Extension: manifest | `chrome-extension/manifest.json` | ✅ `identity` permission declared; host perms for localhost + www.tailrd.ca; **`key` added** → ID pinned to `apgogjfdpleeajnngkfkfekbddcpodkl` |
| Web: connect page | `frontend/src/pages/ExtensionConnect.tsx` | ✅ Built (handles signed-out, unverified-email, error/retry) |
| Web: route | `frontend/src/main.tsx:33` (`/extension/connect`) | ✅ Routed |

---

## ⚠️ Open gap (the one real blocker)

**`EXTENSION_ALLOWED_IDS` is required in production and is not set.**

In `backend/routers/auth_extension.py`, `_redirect_uri_allowed()` (line ~100) ends with:

```python
if _ALLOWED_IDS:
    return ext_id in _ALLOWED_IDS
# No allowlist configured: permissive in dev, deny in prod (fail closed).
return not IS_PRODUCTION
```

So when `ENVIRONMENT=production` and `EXTENSION_ALLOWED_IDS` is empty, **every** `/auth/extension/authorize` call returns `400 redirect_uri is not an allowed extension URL`, and the connect button silently fails for all users.

**Status of the fix:**
1. ✅ **Extension ID pinned.** A `key` was added to `chrome-extension/manifest.json`, fixing the unpacked ID to `apgogjfdpleeajnngkfkfekbddcpodkl`. Round-trip verified (the key derives exactly that ID) and the production build (`npm run build`) carries the key into `dist/`. The public `key` in the manifest is what pins the ID, so it's fully reproducible from the manifest; the RSA private key was generated in an ephemeral scratchpad and intentionally not kept (it isn't needed for unpacked dev loading or Web Store publishing).
2. ✅ **Vercel env var set** on the `resumate` project (Production): `EXTENSION_ALLOWED_IDS=apgogjfdpleeajnngkfkfekbddcpodkl`. `ENVIRONMENT=production` confirmed present (Preview + Production). Set via the Vercel REST API upsert using the CLI's stored token — note the CLI's `vercel env add` silently stored an empty value on this Windows machine (stdin not captured), so use the REST API (or the dashboard) to write env values here, not `env add`.
3. ✅ **Redeployed** (`resumate-ggnwf069z`, aliased to www.tailrd.ca). Env change has no effect until redeploy; done. No env change needed for a localhost backend (non-prod accepts any `*.chromiumapp.org`).
4. ⬜ **When publishing to the Web Store:** upload with this same `key` so the published ID stays `apgogjfdpleeajnngkfkfekbddcpodkl`; if the store assigns a different ID, add that ID to `EXTENSION_ALLOWED_IDS` too.

---

## Not yet verified / out of scope for "connect"

- **Live end-to-end run** — the flow has unit tests but I have not driven it live (load unpacked extension → click Connect → confirm token pair lands). This is the highest-value next check.
- **Silent token refresh** — the refresh token is issued (`client="extension"`), but the refresh/re-auth path belongs to the *Session Management* phase, not connect. Not audited here.
- **Manifest `key`** — without a pinned `key`, the dev unpacked ID and the published ID differ, which complicates `EXTENSION_ALLOWED_IDS`. Consider adding one.

---

## ▶️ Pick up here next session

Recommended order:

1. ✅ **Extension ID pinned** — done (`apgogjfdpleeajnngkfkfekbddcpodkl`, manifest `key`).
2. ✅ **`EXTENSION_ALLOWED_IDS` set + prod redeployed** — done & API-verified (www.tailrd.ca).
3. ⬜ **Live-verify** (only the human can do this — this is the one remaining step):
   - `chrome://extensions` → Developer mode → **Load unpacked** → select `chrome-extension/dist/`. Confirm the ID reads `apgogjfdpleeajnngkfkfekbddcpodkl`.
   - Make sure the extension's API base points at the backend you set the env var on (prod `www.tailrd.ca`, or localhost for a non-prod check).
   - Open a supported job page, open the Tailrd panel, click **"Connect your Tailrd account"**.
   - Expect: web tab opens → "Connecting…" → "You're connected!"; the panel flips to the connected/profile view and leaves sample-data mode. (If signed out, it bounces through `/sign-in?next=…` first.)
   - On failure, check the Network tab for `POST /auth/extension/authorize` (should be 200) and `POST /auth/extension/token` (should be 200). A 400 on `authorize` = the env var/ID mismatch.
4. ⬜ **Run** `backend/tests/test_extension_auth.py` to confirm green (note: hits the real dev Neon DB).
5. Then move to the next phase of the Jobright-style refactor → **Silent session management** (token refresh) or the **Autofill engine** (see project architecture doc).

### Where connect sits in the bigger roadmap
- **Phase 1 — Connect flow (web-authenticated handshake): ✅ built, ⚠️ needs prod env + live verify** ← *we are here*
- Phase 2 — Silent session management (refresh/recovery, no re-login UI)
- Phase 3 — Jobright-level autofill engine (frame + shadow-DOM traversal, semantic detection, mutation-observer retries)
