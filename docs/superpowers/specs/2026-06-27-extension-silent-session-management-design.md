# Phase 2 — Silent Session Management (Design)

**Date:** 2026-06-27
**Owner:** Wissam
**Status:** Approved — ready for implementation plan
**Predecessor:** Phase 1 Connect flow (`docs/extension-connect-status.md`) — ✅ built & live-verified

---

## Goal

The Chrome extension obtains a token pair through the Phase 1 PKCE handshake. The
refresh *transport* already exists end-to-end:

- **Extension (`chrome-extension/src/api/client.ts`)** — single-flight
  refresh-on-401, stores the rotated pair, and on refresh failure calls
  `clearAuth()` + throws `AuthRequiredError`. Access token in
  `chrome.storage.session`; refresh token in `chrome.storage.local` (survives
  restart).
- **Backend (`backend/routers/auth.py` `/refresh`)** — rotates and revokes the
  old refresh token, **preserves the `client="extension"` claim** across
  rotation, skips the HttpOnly cookie for the extension, and `tokens.py` grants
  the extension a **60-day** refresh TTL vs. 7 days for web.

Phase 2 makes that transport **proactive**, **gracefully recoverable**,
**tested**, and **user-visible/revocable**. It does not rebuild refresh.

Workstreams, in implementation priority order:

1. Proactive refresh (extension)
2. Re-auth recovery UX (extension)
3. Tests + audit (backend + extension)
4. Web-side "Connected Devices" session management (backend + frontend)

---

## 1. Proactive refresh (extension only — no backend change)

**Problem.** The access token lives 15 min and is only refreshed reactively on a
401. After the MV3 service worker sleeps and wakes, the first authed request
pays a failed round-trip + retry before succeeding.

**Design.**

- On `saveAuth(...)`, decode the access token's `exp` (base64url-decode the JWT
  payload segment — **read only, no signature verification**) and persist
  `accessTokenExp` (epoch seconds) in `chrome.storage.session` alongside the
  access token.
- Add `ensureFreshAccessToken()` to `client.ts`: if the access token is missing,
  or `accessTokenExp` is within a **120s** skew of now, await the existing
  single-flight `refreshTokens()`. If `accessTokenExp` is unknown (legacy stored
  auth), treat as "needs refresh".
- Call `ensureFreshAccessToken()`:
  - at the top of `authedRequest` and `authedRaw`, before building headers; and
  - from the `SYNC_ALARM` handler in `serviceWorker.ts` (proactive top-up while
    the panel is idle).
- The reactive 401 → `refreshTokens()` → retry path **stays** as the safety net.

**Storage shape.** `saveAuth` continues to write `{ refreshToken, email }` to
`chrome.storage.local` and the access token to `chrome.storage.session`; it
additionally writes `accessTokenExp` to session storage. `getAuth()` returns the
existing `StoredAuth`; `accessTokenExp` is read directly where needed (it is not
required to be part of `StoredAuth`).

**Out of scope.** No change to token lifetimes or to the backend.

---

## 2. Re-auth recovery UX (extension)

**Problem.** When refresh ultimately fails (60-day expiry, or the session is
revoked from the web), `client.ts` calls `clearAuth()` and the panel silently
drops to `signedOut`, indistinguishable from "never connected", and the
connect-first default risks showing an empty/sample state.

**Design.**

- **Preserve cached data on failure.** On a terminal refresh failure, stop
  clearing the snapshot. `clearAuth()` removes tokens only; the
  `ap_sync` snapshot and cached resume files are left intact.
- **Distinguish expiry from never-connected.** Set a persistent
  `sessionExpired` flag (e.g. `ap_session_expired = true` in
  `chrome.storage.local`) **only** when `refreshTokens()` fails because the
  refresh token is invalid / revoked / expired. A first-time user who never
  connected does not get this flag.
- **New status mode `sessionExpired`.** `GET_STATUS` returns mode
  `"sessionExpired"` when there is no live auth, the flag is set, and a cached
  snapshot exists. It surfaces the email/name from the cached snapshot.
  - Precedence in `GET_STATUS`: `mock` (if `useMockData`) → `connected` →
    `sessionExpired` (flag + snapshot) → `signedOut`.
- **Overlay (`content/overlay.ts`).** For `sessionExpired`, render a
  *"Session expired — reconnect"* banner with a Reconnect button (reuses the
  existing `CONNECT` path), keep rendering the cached snapshot **read-only**, and
  **never** auto-switch to sample/mock data.
- **Clear on recovery.** A successful `CONNECT` clears `ap_session_expired`.

**Type changes.** Extend the `StatusResponse` mode union with `"sessionExpired"`
and thread it through `serviceWorker.ts` and `overlay.ts`.

---

## 3. Tests + audit

**Backend** (`backend/tests/`):

- Extend `test_extension_auth.py`: a token minted via the handshake refreshes
  successfully, the refreshed pair still carries `client="extension"`, and the
  refresh token's TTL reflects the 60-day extension lifetime.
- New `test_sessions.py`:
  - Refresh rotates the `jti` and revokes the previous one (replay rejected).
  - Refresh updates the session's `last_seen_at`.
  - A revoked session (via `DELETE /auth/sessions/{sid}`) blocks the next
    refresh (401).
  - `POST /auth/sessions/revoke-all` invalidates all of the user's sessions.
  - `GET /auth/sessions` lists active sessions and omits revoked ones.
  - Legacy refresh token without a `sid` claim is migrated lazily (a session row
    is created on first refresh and reissued with a `sid`).

> Note: pytest runs against the real **dev** Neon DB via the app lifespan /
> migrations — see memory `pytest-runs-real-neon-migrations`. New tables must be
> covered by a migration so the suite can create them.

**Extension** (vitest if configured; otherwise document the harness):

- `ensureFreshAccessToken` triggers a refresh inside the 120s skew and skips it
  outside; concurrent callers share the single in-flight refresh.
- `sessionExpired` flag is set on terminal refresh failure, drives the
  `sessionExpired` status mode, and is cleared on successful `CONNECT`.

---

## 4. Web-side "Connected Devices" (backend + frontend)

A **session registry** (no user-facing labels) is the foundation for listing and
revoking devices, including "sign out everywhere".

### Data model — `Session`

New table (migration mirrors `backend/migrations/add_extension_auth_codes.py`):

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `user_id` | int FK → users.id, indexed | |
| `sid` | str(36) uuid, unique, indexed | stable session id across refresh rotation |
| `client` | str | `"web"` \| `"extension"` |
| `created_at` | datetime | |
| `last_seen_at` | datetime | bumped on each refresh |
| `revoked_at` | datetime, nullable | set on revoke; null = active |
| `last_ip` | str(45), nullable | captured raw, no parsing |
| `user_agent` | text, nullable | captured raw, no parsing/labels |

`RevokedToken` is **unchanged** — it keeps per-`jti` rotation-replay protection.
`Session` is the higher-level liveness gate layered on top: a refresh is valid
only if its `jti` is not revoked **and** its `sid` session is active.

### Token + issuance changes

- Add a `sid` claim to **refresh** tokens (`create_refresh_token` gains an
  optional `sid`; callers pass the session's `sid`). Access tokens are unchanged.
- Create a `Session` row at every refresh-token issuance point:
  - extension `/auth/extension/token`,
  - web login and OAuth sign-in in `auth.py`.
  Capture `request` IP + `User-Agent` at creation.
- `/refresh`:
  - Look up the session by `sid`. Missing or `revoked_at` set → **401**.
  - Otherwise bump `last_seen_at`, reissue access + refresh with the **same**
    `sid` (and the preserved `client`).
  - **Legacy fallback:** a refresh token with no `sid` claim (issued before this
    deploy) is accepted once — a new `Session` is created and the reissued
    refresh token carries its `sid`. No user is logged out by the deploy.

### Endpoints (under `/auth`)

- `GET /auth/sessions` → list the caller's active sessions
  (`sid, client, created_at, last_seen_at, last_ip, user_agent`, plus an
  `is_current` flag derived from the caller's own token `sid` when available).
- `DELETE /auth/sessions/{sid}` → revoke one session (sets `revoked_at`; also
  revoke its current `jti` if known).
- `POST /auth/sessions/revoke-all` → revoke all of the caller's sessions;
  optional `except_current` to keep the calling session alive.

### Frontend — `frontend/src/pages/Settings.tsx`

A new **"Connected Devices"** section:

- Lists each active session: client (Chrome extension / Web) with an icon,
  "connected {created_at}", "last active {last_seen_at}", a "This device" tag
  for the current session, and a **Revoke** button.
- A **"Sign out everywhere"** button (calls `revoke-all`, `except_current=true`).
- Uses the existing `api` client (`frontend/src/auth/api.ts`); styles via
  `settings.css`.

---

## Risks & mitigations

- **Deploy logs users out.** Mitigated by the legacy-`sid` lazy-migration path in
  `/refresh`.
- **Web login path churn.** Registering web sessions touches `auth.py`
  login/OAuth/refresh. Kept minimal: a single `Session`-creation helper called at
  each issuance point; refresh gains the `sid` lookup. Covered by `test_sessions.py`.
- **Session table growth.** Revoked/expired rows accumulate. Out of scope for
  Phase 2; a cron cleanup (like the existing auth-code cleanup) can prune
  `revoked_at`-set or long-stale rows later.

## Explicitly out of scope

- User-renamable device labels and rich UA parsing (YAGNI).
- Push/real-time revocation to a live extension (revocation takes effect at the
  next refresh, ≤ access-token lifetime + skew).
- Changes to access/refresh token lifetimes.
- Session-table cleanup cron.
