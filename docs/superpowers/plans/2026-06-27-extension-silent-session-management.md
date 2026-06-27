# Extension Silent Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Chrome extension's already-built token refresh proactive, gracefully recoverable, fully tested, and user-revocable from the web dashboard.

**Architecture:** Three surfaces. (1) The extension (`chrome-extension/`, TypeScript, esbuild, vitest) gains proactive access-token refresh and a `sessionExpired` recovery state. (2) The FastAPI backend (`backend/`) gains a `Session` registry table, a `sid` claim on refresh tokens, a session-aware `/refresh`, and session list/revoke endpoints. (3) The React dashboard (`frontend/`) gains a "Connected Devices" section in Settings.

**Tech Stack:** TypeScript + esbuild + vitest + jsdom (extension); FastAPI + SQLAlchemy + PyJWT + pytest + Starlette TestClient (backend); React + Vite + axios (frontend); Postgres/Neon (prod & dev), SQLite (tests).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-27-extension-silent-session-management-design.md` — the source of truth.
- **No token-lifetime changes.** Access 15 min; web refresh 7 days; extension refresh 60 days. Do not edit `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS`, `EXTENSION_REFRESH_TOKEN_EXPIRE_DAYS`.
- **`client` claim ("web" | "extension") MUST be preserved across every rotation** — it already is in `/refresh`; do not regress it.
- **Migrations run on app startup** via `backend/main.py` lifespan and must be **idempotent + additive** (guard on the SQLAlchemy inspector, never `DROP`). Raw Postgres DDL (`SERIAL`, `NOW()`) must never reach SQLite — gate `CREATE TABLE` behind the inspector so `create_all()` covers the test path. Mirror `backend/migrations/add_extension_auth_codes.py` exactly.
- **pytest hits the real dev Neon DB** via the app lifespan (memory `pytest-runs-real-neon-migrations`). New tables must be created by `create_all()` from the model in tests; the raw-DDL migration only runs against Postgres.
- **`RevokedToken` is unchanged** — it keeps per-`jti` rotation-replay protection. `Session` is a higher-level liveness gate layered on top.
- **Extension never handles credentials.** All session changes flow through the existing token plumbing in `chrome-extension/src/api/client.ts` and `shared/storage.ts`.
- Run extension tests with `npm test` (vitest) from `chrome-extension/`. Run backend tests with `pytest` from the repo root.

---

## File Structure

**Extension**
- Modify `chrome-extension/src/shared/storage.ts` — persist `accessTokenExp`; add `sessionExpired` flag helpers.
- Modify `chrome-extension/src/api/client.ts` — `ensureFreshAccessToken()`; distinguish terminal (401) vs transient refresh failure; set/clear the `sessionExpired` flag.
- Modify `chrome-extension/src/background/serviceWorker.ts` — proactive refresh on the sync alarm; `sessionExpired` status mode; clear flag on `CONNECT`.
- Modify `chrome-extension/src/shared/types.ts` — add `"sessionExpired"` to `StatusResponse.mode`.
- Modify `chrome-extension/src/content/overlay.ts` — render the "Session expired — reconnect" state.
- Create `chrome-extension/test/session.test.ts` — vitest unit tests.

**Backend**
- Modify `backend/db/models.py` — add `Session` model.
- Create `backend/migrations/add_sessions.py` — `sessions` table migration.
- Modify `backend/main.py` — import + call the new migration in lifespan.
- Modify `backend/auth/tokens.py` — `create_refresh_token` accepts an optional `sid`.
- Create `backend/services/sessions.py` — session create/lookup/touch/revoke helpers.
- Modify `backend/routers/auth.py` — register sessions at login/OAuth/refresh; session-aware `/refresh`; new `/auth/sessions` endpoints.
- Modify `backend/routers/auth_extension.py` — register a session at `/auth/extension/token`.
- Create `backend/tests/test_sessions.py` — session registry + endpoint tests.
- Modify `backend/tests/test_extension_auth.py` — extension refresh preserves `client` + carries a `sid`.

**Frontend**
- Modify `frontend/src/pages/Settings.tsx` — "Connected Devices" section.
- Modify `frontend/src/settings.css` — styles for the section (follow existing patterns).

---

## Task 1: Proactive access-token refresh (extension)

**Files:**
- Modify: `chrome-extension/src/shared/storage.ts`
- Modify: `chrome-extension/src/api/client.ts`
- Modify: `chrome-extension/src/background/serviceWorker.ts:47-49` (alarm handler)
- Test: `chrome-extension/test/session.test.ts`

**Interfaces:**
- Consumes: existing `getAuth()`, `saveAuth()`, `refreshTokens()` (private, single-flight).
- Produces:
  - `getAccessTokenExp(): Promise<number | null>` (storage) — epoch seconds or null.
  - `ensureFreshAccessToken(): Promise<void>` (client) — refreshes if missing/within skew.
  - `ACCESS_TOKEN_SKEW_SECONDS = 120` (client, exported).

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal chrome.storage stub (local + session) backed by plain objects.
function makeStorageArea() {
  const data: Record<string, unknown> = {};
  return {
    _data: data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(data, obj); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
}

beforeEach(() => {
  (globalThis as any).chrome = {
    storage: { local: makeStorageArea(), session: makeStorageArea() },
  };
});

describe("getAccessTokenExp", () => {
  it("returns the persisted expiry epoch", async () => {
    const { saveAuth, getAccessTokenExp } = await import("../src/shared/storage");
    // exp = now + 600s, encoded as a JWT-shaped token (header.payload.sig).
    const exp = Math.floor(Date.now() / 1000) + 600;
    const payload = btoa(JSON.stringify({ sub: "1", exp })).replace(/=+$/, "");
    const token = `h.${payload}.s`;
    await saveAuth({ accessToken: token, refreshToken: "r", email: "u@e.com" });
    expect(await getAccessTokenExp()).toBe(exp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chrome-extension && npm test -- session`
Expected: FAIL — `getAccessTokenExp` is not exported.

- [ ] **Step 3: Implement `accessTokenExp` persistence in storage.ts**

In `chrome-extension/src/shared/storage.ts`, add to `KEYS`:

```ts
  // In-memory only (chrome.storage.session): epoch-seconds expiry of the access token.
  authAccessExp: "ap_auth_access_exp",
```

Add a JWT-exp reader and persist it in `saveAuth`:

```ts
/** Read a JWT's `exp` (epoch seconds) without verifying the signature. Returns null on any parse failure. */
function readJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

export async function getAccessTokenExp(): Promise<number | null> {
  try {
    const sess = await chrome.storage.session.get(KEYS.authAccessExp);
    const v = sess[KEYS.authAccessExp];
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
```

In `saveAuth`, after writing the access token to session storage, also write its expiry:

```ts
  try {
    await chrome.storage.session.set({ [KEYS.authAccess]: auth.accessToken });
    await chrome.storage.session.set({ [KEYS.authAccessExp]: readJwtExp(auth.accessToken) });
  } catch {
    // session storage unavailable — the access token just won't persist
  }
```

In `clearAuth`, also remove the expiry key:

```ts
  try {
    await chrome.storage.session.remove(KEYS.authAccess);
    await chrome.storage.session.remove(KEYS.authAccessExp);
  } catch {
    // ignore
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chrome-extension && npm test -- session`
Expected: PASS.

- [ ] **Step 5: Add `ensureFreshAccessToken` test**

Append to `chrome-extension/test/session.test.ts`:

```ts
describe("ensureFreshAccessToken", () => {
  it("refreshes when the access token expires within the skew window", async () => {
    const storage = await import("../src/shared/storage");
    const nearExp = Math.floor(Date.now() / 1000) + 30; // < 120s skew
    const payload = btoa(JSON.stringify({ sub: "1", exp: nearExp })).replace(/=+$/, "");
    await storage.saveAuth({ accessToken: `h.${payload}.s`, refreshToken: "r-old", email: "u@e.com" });

    const fresh = Math.floor(Date.now() / 1000) + 900;
    const freshPayload = btoa(JSON.stringify({ sub: "1", exp: fresh })).replace(/=+$/, "");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: `h.${freshPayload}.s`, refresh_token: "r-new" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const client = await import("../src/api/client");
    await client.ensureFreshAccessToken();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await storage.getAccessTokenExp()).toBe(fresh);
  });

  it("does not refresh when the access token is comfortably valid", async () => {
    const storage = await import("../src/shared/storage");
    const farExp = Math.floor(Date.now() / 1000) + 900; // > 120s skew
    const payload = btoa(JSON.stringify({ sub: "1", exp: farExp })).replace(/=+$/, "");
    await storage.saveAuth({ accessToken: `h.${payload}.s`, refreshToken: "r", email: "u@e.com" });

    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const client = await import("../src/api/client");
    await client.ensureFreshAccessToken();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

> Note: `getConfig()` returns `DEFAULT_CONFIG` from the storage stub, so `apiUrl()` resolves against the default base — fine for asserting fetch was called.

- [ ] **Step 6: Run to verify the new tests fail**

Run: `cd chrome-extension && npm test -- session`
Expected: FAIL — `ensureFreshAccessToken` is not exported.

- [ ] **Step 7: Implement `ensureFreshAccessToken` in client.ts**

In `chrome-extension/src/api/client.ts`, import `getAccessTokenExp`:

```ts
import {
  clearAuth,
  clearSnapshot,
  getAccessTokenExp,
  getAuth,
  getConfig,
  saveAuth,
} from "../shared/storage";
```

Add the skew constant and the function (place it right after `refreshTokens`):

```ts
/** Refresh proactively when the access token is missing or near expiry. */
export const ACCESS_TOKEN_SKEW_SECONDS = 120;

export async function ensureFreshAccessToken(): Promise<void> {
  const auth = await getAuth();
  if (!auth?.refreshToken) return; // not connected — nothing to refresh
  const exp = await getAccessTokenExp();
  const needs = !auth.accessToken || exp === null || exp - Math.floor(Date.now() / 1000) <= ACCESS_TOKEN_SKEW_SECONDS;
  if (needs) await refreshTokens();
}
```

Call it at the top of `authedRequest` and `authedRaw`, replacing their first two lines:

```ts
export async function authedRequest<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  await ensureFreshAccessToken();
  const auth = await getAuth();
  if (!auth) throw new AuthRequiredError();
  // …unchanged…
}
```

```ts
export async function authedRaw(path: string, init?: RequestInit, retry = true): Promise<Response> {
  await ensureFreshAccessToken();
  const auth = await getAuth();
  if (!auth) throw new AuthRequiredError();
  // …unchanged…
}
```

> `ensureFreshAccessToken` reuses the single-flight `refreshTokens()` guard, so concurrent callers share one refresh.

- [ ] **Step 8: Run to verify all Task 1 tests pass**

Run: `cd chrome-extension && npm test -- session`
Expected: PASS (3 tests).

- [ ] **Step 9: Wire proactive refresh into the sync alarm**

In `chrome-extension/src/background/serviceWorker.ts`, import it and call it before the stale sync:

```ts
import { AuthRequiredError, checkAuthStatus, ensureFreshAccessToken, logout } from "../api/client";
```

```ts
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void ensureFreshAccessToken()
      .catch(() => {})
      .finally(() => void syncIfStale().catch(() => {}));
  }
});
```

- [ ] **Step 10: Typecheck**

Run: `cd chrome-extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add chrome-extension/src/shared/storage.ts chrome-extension/src/api/client.ts chrome-extension/src/background/serviceWorker.ts chrome-extension/test/session.test.ts
git commit -m "feat(extension): proactive access-token refresh before expiry"
```

---

## Task 2: Distinguish terminal vs transient refresh failure (extension)

**Files:**
- Modify: `chrome-extension/src/shared/storage.ts`
- Modify: `chrome-extension/src/api/client.ts:72-98` (`refreshTokens`)
- Test: `chrome-extension/test/session.test.ts`

**Interfaces:**
- Consumes: `ApiError` (already exported from client), `clearAuth`.
- Produces (storage):
  - `setSessionExpired(): Promise<void>`
  - `getSessionExpired(): Promise<boolean>`
  - `clearSessionExpired(): Promise<void>`
- Behavior change: a **401** refresh failure is terminal (clear tokens, set flag, keep snapshot); a **non-401** (network/5xx) failure is transient (keep tokens + snapshot, rethrow).

- [ ] **Step 1: Write the failing test**

Append to `chrome-extension/test/session.test.ts`:

```ts
describe("refresh failure classification", () => {
  it("on a 401 refresh: clears tokens, sets sessionExpired, keeps the snapshot", async () => {
    const storage = await import("../src/shared/storage");
    await storage.saveAuth({ accessToken: "", refreshToken: "r-dead", email: "u@e.com" });
    await storage.saveSnapshot({ version: 1 } as any);

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "Token has been revoked" }), { status: 401 })
    ) as unknown as typeof fetch;

    const client = await import("../src/api/client");
    await expect(client.authedRequest("/auth/me")).rejects.toThrow();

    expect(await storage.getAuth()).toBeNull();           // tokens cleared
    expect(await storage.getSessionExpired()).toBe(true); // flag set
    expect(await storage.getSnapshot()).not.toBeNull();   // snapshot preserved
  });

  it("on a network error during refresh: keeps tokens and does not set the flag", async () => {
    const storage = await import("../src/shared/storage");
    await storage.saveAuth({ accessToken: "", refreshToken: "r-live", email: "u@e.com" });

    globalThis.fetch = vi.fn(async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;

    const client = await import("../src/api/client");
    await expect(client.authedRequest("/auth/me")).rejects.toThrow();

    expect(await storage.getAuth()).not.toBeNull();        // tokens kept
    expect(await storage.getSessionExpired()).toBe(false); // flag NOT set
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npm test -- session`
Expected: FAIL — `getSessionExpired` not exported / behavior not implemented.

- [ ] **Step 3: Add the flag helpers to storage.ts**

In `chrome-extension/src/shared/storage.ts`, add to `KEYS`:

```ts
  // Persistent: set when a refresh fails on an invalid/revoked/expired refresh
  // token, so the UI can show "session expired" instead of "never connected".
  sessionExpired: "ap_session_expired",
```

Add the helpers (after `clearAuth`):

```ts
export async function setSessionExpired(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.sessionExpired]: true });
}

export async function getSessionExpired(): Promise<boolean> {
  const data = await chrome.storage.local.get(KEYS.sessionExpired);
  return data[KEYS.sessionExpired] === true;
}

export async function clearSessionExpired(): Promise<void> {
  await chrome.storage.local.remove(KEYS.sessionExpired);
}
```

- [ ] **Step 4: Update `refreshTokens` to classify failures**

In `chrome-extension/src/api/client.ts`, import the new helpers (and keep `clearSnapshot` out of this path):

```ts
import {
  clearAuth,
  clearSnapshot,
  getAccessTokenExp,
  getAuth,
  getConfig,
  saveAuth,
  setSessionExpired,
} from "../shared/storage";
```

Replace the `try/catch` body inside `refreshTokens`:

```ts
      try {
        const tokens = await publicRequest<TokenResponse>("/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: auth.refreshToken }),
        });
        // The backend revokes the old refresh token — always store the new pair.
        await saveAuth({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          email: auth.email,
        });
      } catch (err) {
        // Terminal only on an auth rejection (invalid/revoked/expired refresh
        // token). Clear tokens + mark the session expired, but KEEP the cached
        // snapshot so the UI can show data + a reconnect prompt.
        if (err instanceof ApiError && err.status === 401) {
          await clearAuth();
          await setSessionExpired();
          throw new AuthRequiredError();
        }
        // Transient (network / 5xx): keep tokens + snapshot; let the caller retry later.
        throw err;
      }
```

> The previous code called `clearAuth()` on every failure and dropped the user even on a network blip. This change preserves the session through transient failures and never wipes the snapshot.

- [ ] **Step 5: Run to verify Task 2 tests pass**

Run: `cd chrome-extension && npm test -- session`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
cd chrome-extension && npm run typecheck && cd ..
git add chrome-extension/src/shared/storage.ts chrome-extension/src/api/client.ts chrome-extension/test/session.test.ts
git commit -m "feat(extension): treat only 401 refresh failures as terminal; preserve snapshot"
```

---

## Task 3: `sessionExpired` status mode (extension background)

**Files:**
- Modify: `chrome-extension/src/shared/types.ts:269-281` (`StatusResponse`)
- Modify: `chrome-extension/src/background/serviceWorker.ts:141-177` (`GET_STATUS`, `CONNECT`)
- Test: `chrome-extension/test/session.test.ts`

**Interfaces:**
- Consumes: `getSessionExpired`, `clearSessionExpired`, `getSnapshot`, `checkAuthStatus`.
- Produces: `StatusResponse.mode` includes `"sessionExpired"`; `GET_STATUS` returns it when not connected, the flag is set, and a snapshot exists; `CONNECT` clears the flag on success.

- [ ] **Step 1: Add the mode to the type**

In `chrome-extension/src/shared/types.ts`, update `StatusResponse`:

```ts
export interface StatusResponse {
  ok: boolean;
  /** mock = sample data, connected = signed in, sessionExpired = was connected but refresh failed, signedOut = needs to connect */
  mode: "mock" | "connected" | "sessionExpired" | "signedOut";
  email?: string;
  firstName?: string;
  lastName?: string;
  apiBaseUrl: string;
  subscription?: Subscription;
  usage?: Usage;
}
```

- [ ] **Step 2: Write the failing test**

Append to `chrome-extension/test/session.test.ts`:

```ts
describe("GET_STATUS sessionExpired mode", () => {
  it("reports sessionExpired when the flag is set and a snapshot exists", async () => {
    const storage = await import("../src/shared/storage");
    await storage.setSessionExpired();
    await storage.saveSnapshot({
      version: 1,
      profile: { firstName: "Ada", lastName: "Lovelace", email: "ada@e.com" },
    } as any);

    // No auth → checkAuthStatus returns not-connected without any fetch.
    const sw = await import("../src/background/serviceWorker");
    const status = await (sw as any).handle({ type: "GET_STATUS" });
    expect(status.mode).toBe("sessionExpired");
    expect(status.email).toBe("ada@e.com");
    expect(status.firstName).toBe("Ada");
  });
});
```

> If `handle` is not currently exported from `serviceWorker.ts`, export it: change `async function handle(` to `export async function handle(`. This is a test-only export of existing logic.

- [ ] **Step 3: Run to verify it fails**

Run: `cd chrome-extension && npm test -- session`
Expected: FAIL — mode is `signedOut`, not `sessionExpired`.

- [ ] **Step 4: Implement the mode in `GET_STATUS`**

In `chrome-extension/src/background/serviceWorker.ts`, import the helpers:

```ts
import { clearSessionExpired, getConfig, getSessionExpired, getSnapshot, saveConfig } from "../shared/storage";
```

Replace the `signedOut` branch of `GET_STATUS`:

```ts
      const status = await checkAuthStatus();
      if (!status.connected) {
        const cached = await getSnapshot();
        if ((await getSessionExpired()) && cached) {
          const p = cached.snapshot.profile;
          return {
            ok: true,
            mode: "sessionExpired",
            email: p.email || undefined,
            firstName: p.firstName || undefined,
            lastName: p.lastName || undefined,
            apiBaseUrl: config.apiBaseUrl,
            subscription: cached.snapshot.subscription,
            usage: cached.snapshot.usage,
          };
        }
        return { ok: true, mode: "signedOut", apiBaseUrl: config.apiBaseUrl };
      }
```

- [ ] **Step 5: Clear the flag on successful CONNECT**

In the `CONNECT` case, after `await connectAccount();`:

```ts
    case "CONNECT": {
      try {
        await connectAccount();
        await clearSessionExpired();
        // Connecting always means leaving sample-data mode.
        await saveConfig({ useMockData: false });
        await syncIfStale().catch(() => {});
        return { ok: true };
      } catch (err) {
        // …unchanged…
      }
    }
```

- [ ] **Step 6: Run to verify Task 3 tests pass**

Run: `cd chrome-extension && npm test -- session`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
cd chrome-extension && npm run typecheck && cd ..
git add chrome-extension/src/shared/types.ts chrome-extension/src/background/serviceWorker.ts chrome-extension/test/session.test.ts
git commit -m "feat(extension): GET_STATUS sessionExpired mode; clear flag on reconnect"
```

---

## Task 4: "Session expired — reconnect" overlay state (extension UI)

**Files:**
- Modify: `chrome-extension/src/content/overlay.ts:827-848` (`initPanel`), `:889-897` (`showLoginView`)
- Test: manual (DOM-heavy view; covered by typecheck + the live verify below).

**Interfaces:**
- Consumes: `StatusResponse.mode === "sessionExpired"`, existing `showLoginView()`/`#ap-btn-connect`/`doConnect()`.
- Produces: a reconnect prompt with expired copy; the scanned-page view (`refreshMainView`) keeps working behind it; never falls back to mock.

- [ ] **Step 1: Make `showLoginView` accept an expired variant**

In `chrome-extension/src/content/overlay.ts`, locate the login view's heading/subtext element. (Search for where `refs.loginView` is built; it has a title and a connect button `#ap-btn-connect`.) Give the view an optional expired message. Replace `showLoginView`:

```ts
function showLoginView(expired = false): void {
  if (!refs) return;
  refs.loginView.classList.add("visible");
  refs.loginView.classList.toggle("ap-expired", expired);
  const heading = refs.loginView.querySelector<HTMLElement>(".ap-login-title");
  const sub = refs.loginView.querySelector<HTMLElement>(".ap-login-sub");
  if (heading) heading.textContent = expired ? "Session expired" : "Connect your Tailrd account";
  if (sub) {
    sub.textContent = expired
      ? "Reconnect to keep syncing your profile and résumés. Your data is still here."
      : "Sign in on the web to sync your profile into the extension.";
  }
}
```

> If the login view's title/subtitle elements don't already carry the classes `.ap-login-title` / `.ap-login-sub`, add those classes to the existing elements where the view is constructed (search the same file for the connect-button markup and label the sibling title/subtitle). Do not restructure the view.

- [ ] **Step 2: Handle the mode in `initPanel`**

Replace the status branch in `initPanel`:

```ts
  const status = await bg<StatusResponse>({ type: "GET_STATUS" }).catch(() => null);
  overlayState.status = status;

  if (status && status.mode === "signedOut") {
    showLoginView(false);
    return;
  }
  if (status && status.mode === "sessionExpired") {
    // Keep the scanned-page view usable; prompt a reconnect. Never show mock.
    showLoginView(true);
    return;
  }

  hideLoginView();
  await loadProfile();
```

- [ ] **Step 3: Typecheck**

Run: `cd chrome-extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Build the extension**

Run: `cd chrome-extension && npm run build`
Expected: builds into `dist/` with no errors.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/overlay.ts
git commit -m "feat(extension): show session-expired reconnect prompt in the overlay"
```

---

## Task 5: `Session` model + migration (backend)

**Files:**
- Modify: `backend/db/models.py` (after `ExtensionAuthCode`, ~line 493)
- Create: `backend/migrations/add_sessions.py`
- Modify: `backend/main.py:19` (import) and `:33` (call)
- Test: `backend/tests/test_sessions.py`

**Interfaces:**
- Produces: `Session` ORM model with columns `id, user_id, sid, client, created_at, last_seen_at, revoked_at, last_ip, user_agent`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sessions.py`:

```python
"""Tests for the session registry (Connected Devices) and session-aware refresh."""

import datetime

import pytest

from backend.auth.dependencies import get_verified_user
from backend.auth.tokens import create_refresh_token, decode_token
from backend.db.models import Session as DBSession, User
from backend.main import app

TEST_USER_ID = 1


@pytest.fixture
def user(db_session):
    u = User(id=TEST_USER_ID, email="u@example.com", email_verified=True, auth_provider="local")
    db_session.add(u)
    db_session.commit()

    async def _override():
        return u

    app.dependency_overrides[get_verified_user] = _override
    yield u
    app.dependency_overrides.pop(get_verified_user, None)


def test_session_model_persists(db_session, user):
    s = DBSession(
        sid="sid-1", user_id=TEST_USER_ID, client="extension",
        last_seen_at=datetime.datetime.utcnow(),
    )
    db_session.add(s)
    db_session.commit()
    found = db_session.query(DBSession).filter(DBSession.sid == "sid-1").first()
    assert found is not None
    assert found.client == "extension"
    assert found.revoked_at is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest backend/tests/test_sessions.py::test_session_model_persists -v`
Expected: FAIL — cannot import `Session` from models.

- [ ] **Step 3: Add the model**

In `backend/db/models.py`, after `ExtensionAuthCode`:

```python
# ─── Sessions (Connected Devices registry) ──────────────────────────────────

class Session(Base):
    """A long-lived auth session (one per connect / login), keyed by a stable
    ``sid`` that survives refresh-token rotation. Backs the "Connected Devices"
    dashboard and per-device revocation. ``revoked_at`` set => the session's next
    refresh is rejected. Labels/UA-parsing are intentionally omitted (YAGNI)."""
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    sid = Column(String(36), unique=True, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    client = Column(String(20), nullable=False, default="web")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.datetime.utcnow)
    revoked_at = Column(DateTime, nullable=True)
    last_ip = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
```

> `Column, Integer, String, DateTime, Text, ForeignKey` and `datetime` are already imported at the top of `models.py` (used by neighbouring models). Confirm and reuse; add nothing new.

- [ ] **Step 4: Run to verify the model test passes**

Run: `pytest backend/tests/test_sessions.py::test_session_model_persists -v`
Expected: PASS (tests use SQLite `create_all()`).

- [ ] **Step 5: Create the Postgres migration**

Create `backend/migrations/add_sessions.py`:

```python
"""
Migration: Sessions registry (Connected Devices).

Creates the ``sessions`` table backing per-device session tracking + revocation:

  - id (PK)
  - sid (unique, indexed)   — stable session id across refresh rotation
  - user_id (FK users.id)   — owner
  - client                  — "web" | "extension"
  - created_at / last_seen_at (TIMESTAMP)
  - revoked_at (TIMESTAMP, nullable)  — set on revoke; null = active
  - last_ip / user_agent    — captured raw at creation, no parsing

Idempotent + additive: guard on the inspector so raw Postgres DDL never reaches
SQLite (tests build the table from the model via create_all()).
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Create the sessions table if it does not exist."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    if "sessions" not in tables:
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE sessions (
                    id SERIAL PRIMARY KEY,
                    sid VARCHAR(36) NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL,
                    client VARCHAR(20) NOT NULL DEFAULT 'web',
                    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    revoked_at TIMESTAMP,
                    last_ip VARCHAR(45),
                    user_agent TEXT
                )
            """))
            logger.info("Created table: sessions")

    with engine.begin() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_sessions_sid ON sessions (sid)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions (user_id)"
        ))

    logger.info("Sessions migration completed successfully.")
```

- [ ] **Step 6: Register the migration in lifespan**

In `backend/main.py`, add the import next to the other migration imports (~line 19):

```python
from backend.migrations.add_sessions import run_migration as run_sessions_migration
```

Call it in `lifespan` after `run_company_domain_migration()`:

```python
    run_company_domain_migration()
    run_sessions_migration()
    yield
```

- [ ] **Step 7: Run the full session test file**

Run: `pytest backend/tests/test_sessions.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/db/models.py backend/migrations/add_sessions.py backend/main.py backend/tests/test_sessions.py
git commit -m "feat(backend): add Session registry model + migration"
```

---

## Task 6: `sid` claim + session-creation helper (backend)

**Files:**
- Modify: `backend/auth/tokens.py:41-55` (`create_refresh_token`)
- Create: `backend/services/sessions.py`
- Test: `backend/tests/test_sessions.py`

**Interfaces:**
- Consumes: `Session` model, `create_refresh_token`.
- Produces:
  - `create_refresh_token(user_id, client="web", sid: str | None = None)` — embeds `sid` claim when provided.
  - `sessions.start_session(db, user_id, client, request) -> Session` — creates a row with a fresh uuid `sid`, capturing IP + UA.
  - `sessions.get_active(db, sid) -> Session | None` — active (not revoked) session by sid.
  - `sessions.touch(db, session)` — bump `last_seen_at`.
  - `sessions.revoke(db, session)` — set `revoked_at`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_sessions.py`:

```python
def test_refresh_token_carries_sid():
    tok = create_refresh_token(TEST_USER_ID, client="extension", sid="sid-xyz")
    payload = decode_token(tok)
    assert payload["sid"] == "sid-xyz"
    assert payload["client"] == "extension"


def test_start_session_captures_client(db_session, user):
    from backend.services import sessions

    class _Req:
        client = type("C", (), {"host": "1.2.3.4"})()
        headers = {"user-agent": "TestAgent/1.0"}

    s = sessions.start_session(db_session, TEST_USER_ID, "extension", _Req())
    assert s.sid and len(s.sid) >= 32
    assert s.client == "extension"
    assert s.last_ip == "1.2.3.4"
    assert s.user_agent == "TestAgent/1.0"
    assert sessions.get_active(db_session, s.sid) is not None
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest backend/tests/test_sessions.py::test_refresh_token_carries_sid backend/tests/test_sessions.py::test_start_session_captures_client -v`
Expected: FAIL — `sid` kwarg unsupported / `services.sessions` missing.

- [ ] **Step 3: Add the `sid` claim to `create_refresh_token`**

In `backend/auth/tokens.py`, update the signature and payload:

```python
def create_refresh_token(user_id: int, client: str = "web", sid: str | None = None) -> str:
    """Create a long-lived refresh token with a unique JTI for revocation.

    The TTL depends on ``client``: extension tokens last
    ``EXTENSION_REFRESH_TOKEN_EXPIRE_DAYS``, web tokens ``REFRESH_TOKEN_EXPIRE_DAYS``.
    ``sid`` ties the token to a row in the session registry so it can be listed
    and revoked from "Connected Devices"; it survives rotation.
    """
    expire = datetime.now(timezone.utc) + timedelta(days=_refresh_ttl_days(client))
    payload = {
        "sub": str(user_id),
        "exp": expire,
        "type": "refresh",
        "client": client,
        "jti": str(uuid.uuid4()),
    }
    if sid:
        payload["sid"] = sid
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
```

- [ ] **Step 4: Create the session service**

Create `backend/services/sessions.py`:

```python
"""Session registry helpers — create / look up / touch / revoke sessions.

A session is a long-lived auth grant keyed by a stable ``sid`` that survives
refresh-token rotation. Backs the "Connected Devices" dashboard.
"""

import uuid
from datetime import datetime
from typing import Optional

from fastapi import Request
from sqlalchemy.orm import Session as DbSession

from backend.db.models import Session as SessionModel


def _client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    client = getattr(request, "client", None)
    return getattr(client, "host", None) if client else None


def _user_agent(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    ua = request.headers.get("user-agent")
    return ua[:1024] if ua else None  # store raw, just bound the length


def start_session(db: DbSession, user_id: int, client: str, request: Optional[Request]) -> SessionModel:
    """Create and persist a new active session; returns it with its ``sid`` set."""
    now = datetime.utcnow()
    session = SessionModel(
        sid=uuid.uuid4().hex,
        user_id=user_id,
        client=client,
        created_at=now,
        last_seen_at=now,
        last_ip=_client_ip(request),
        user_agent=_user_agent(request),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def get_active(db: DbSession, sid: str) -> Optional[SessionModel]:
    """Return the session for ``sid`` only if it exists and is not revoked."""
    return (
        db.query(SessionModel)
        .filter(SessionModel.sid == sid, SessionModel.revoked_at.is_(None))
        .first()
    )


def touch(db: DbSession, session: SessionModel) -> None:
    """Record activity on a session (called on each successful refresh)."""
    session.last_seen_at = datetime.utcnow()
    db.commit()


def revoke(db: DbSession, session: SessionModel) -> None:
    """Mark a session revoked; its next refresh will be rejected."""
    session.revoked_at = datetime.utcnow()
    db.commit()
```

- [ ] **Step 5: Run to verify Task 6 tests pass**

Run: `pytest backend/tests/test_sessions.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auth/tokens.py backend/services/sessions.py backend/tests/test_sessions.py
git commit -m "feat(backend): sid claim on refresh tokens + session service helpers"
```

---

## Task 7: Register sessions at issuance + session-aware `/refresh` (backend)

**Files:**
- Modify: `backend/routers/auth_extension.py:176-238` (`/token`)
- Modify: `backend/routers/auth.py:329-404` (`/refresh`) and the login/OAuth token-issuance points (~`:164`, `:240`, `:319`)
- Test: `backend/tests/test_sessions.py`, `backend/tests/test_extension_auth.py`

**Interfaces:**
- Consumes: `services.sessions` (`start_session`, `get_active`, `touch`), `create_refresh_token(..., sid=...)`.
- Produces: every issued refresh token carries a `sid` of a `Session` row; `/refresh` rejects revoked/unknown sessions (401), bumps `last_seen_at`, and lazily migrates legacy (no-`sid`) tokens.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_sessions.py`:

```python
def _connect_extension(client):
    """Run the PKCE handshake and return the extension's refresh token + sid."""
    import base64, hashlib, secrets
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    redirect = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"
    code = client.post("/auth/extension/authorize",
                       json={"code_challenge": challenge, "redirect_uri": redirect}).json()["code"]
    body = client.post("/auth/extension/token",
                       json={"code": code, "code_verifier": verifier}).json()
    return body["refresh_token"]


def test_extension_token_registers_session(client, db_session, user):
    refresh = _connect_extension(client)
    sid = decode_token(refresh)["sid"]
    assert sid
    assert db_session.query(DBSession).filter(DBSession.sid == sid).first() is not None


def test_refresh_rotates_and_touches_session(client, db_session, user):
    refresh = _connect_extension(client)
    sid = decode_token(refresh)["sid"]

    res = client.post("/auth/refresh", json={"refresh_token": refresh})
    assert res.status_code == 200, res.text
    new_refresh = res.json()["refresh_token"]
    # sid is preserved across rotation; client stays "extension".
    assert decode_token(new_refresh)["sid"] == sid
    assert decode_token(new_refresh)["client"] == "extension"


def test_refresh_rejected_after_session_revoked(client, db_session, user):
    from backend.services import sessions
    refresh = _connect_extension(client)
    sid = decode_token(refresh)["sid"]
    sessions.revoke(db_session, sessions.get_active(db_session, sid))

    res = client.post("/auth/refresh", json={"refresh_token": refresh})
    assert res.status_code == 401


def test_legacy_refresh_without_sid_is_migrated(client, db_session, user):
    # A refresh token minted the old way (no sid) must still work once and gain a sid.
    legacy = create_refresh_token(TEST_USER_ID, client="extension")  # no sid
    assert "sid" not in decode_token(legacy)
    res = client.post("/auth/refresh", json={"refresh_token": legacy})
    assert res.status_code == 200, res.text
    assert decode_token(res.json()["refresh_token"])["sid"]
```

Append to `backend/tests/test_extension_auth.py` (`test_authorize_then_token_happy_path`), after the existing `client` assertions:

```python
    # The refresh token is tied to a session (Connected Devices).
    assert decode_token(body["refresh_token"]).get("sid")
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest backend/tests/test_sessions.py backend/tests/test_extension_auth.py -v`
Expected: FAIL — no `sid` on issued tokens; revoked/legacy paths not handled.

- [ ] **Step 3: Register a session in the extension `/token` endpoint**

In `backend/routers/auth_extension.py`, import the service:

```python
from backend.services import sessions as session_service
```

Replace the success return of `token(...)`:

```python
    session = session_service.start_session(db, user.id, "extension", request)

    security_logger.log_event(
        db, SecurityLogger.EXTENSION_TOKEN, request,
        user_id=user.id, success=True,
    )

    return ExtensionTokenResponse(
        access_token=create_access_token(user.id, client="extension"),
        refresh_token=create_refresh_token(user.id, client="extension", sid=session.sid),
        email=user.email,
        email_verified=user.email_verified,
    )
```

- [ ] **Step 4: Make `/refresh` session-aware (with legacy migration)**

In `backend/routers/auth.py`, import the service near the other imports:

```python
from backend.services import sessions as session_service
```

In `refresh(...)`, after `client = payload.get("client", "web")` and before issuing new tokens, resolve/validate the session:

```python
    client = payload.get("client", "web")

    # Session registry gate (Connected Devices). A token with a sid must map to a
    # live session; revoked/unknown => 401. Legacy tokens (no sid) are migrated:
    # a fresh session is created so existing users aren't logged out by deploy.
    sid = payload.get("sid")
    if sid:
        session = session_service.get_active(db, sid)
        if session is None:
            security_logger.log_event(
                db, SecurityLogger.TOKEN_REFRESH, request,
                user_id=user_id, success=False,
                details={"reason": "session_revoked_or_unknown"},
            )
            raise HTTPException(status_code=401, detail="Session has been revoked")
        session_service.touch(db, session)
    else:
        session = session_service.start_session(db, user_id, client, request)
        sid = session.sid
```

Then update the issuance lines to pass `sid`:

```python
    refresh_tok = create_refresh_token(user_id, client=client, sid=sid)
    if client != "extension":
        _set_refresh_cookie(response, refresh_tok)

    return TokenResponseWithVerification(
        access_token=create_access_token(user_id, client=client),
        refresh_token=refresh_tok,
        email_verified=user.email_verified,
    )
```

- [ ] **Step 5: Register web sessions at login + OAuth issuance**

In `backend/routers/auth.py`, at each web refresh-token issuance point — the password login (~`:164`), the verify/login path (~`:240`), and the OAuth/Google sign-in (~`:319`) — replace the bare `refresh_tok = create_refresh_token(user.id)` with a session-backed one. Each of these handlers already has `request: Request` and `db` in scope (the router uses them for `security_logger`); if a given handler is missing `request`, add `request: Request` to its signature.

```python
    _web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, sid=_web_session.sid)
    _set_refresh_cookie(response, refresh_tok)
```

> Apply this verbatim at all three sites. Keep the existing `_set_refresh_cookie(response, refresh_tok)` (shown above) — do not duplicate it.

- [ ] **Step 6: Run the affected suites**

Run: `pytest backend/tests/test_sessions.py backend/tests/test_extension_auth.py -v`
Expected: PASS.

- [ ] **Step 7: Run the broader auth suite to catch regressions**

Run: `pytest backend/tests/ -k "auth" -v`
Expected: PASS (existing login/refresh/logout tests still green).

- [ ] **Step 8: Commit**

```bash
git add backend/routers/auth.py backend/routers/auth_extension.py backend/tests/test_sessions.py backend/tests/test_extension_auth.py
git commit -m "feat(backend): register sessions at issuance; session-aware refresh with legacy migration"
```

---

## Task 8: Session list / revoke endpoints (backend)

**Files:**
- Modify: `backend/routers/auth.py` (new endpoints under the `auth` router; mounted at `/auth`)
- Test: `backend/tests/test_sessions.py`

**Interfaces:**
- Consumes: `get_verified_user` (or the existing access-token dependency used elsewhere in `auth.py`), `Session` model, `services.sessions.revoke`.
- Produces:
  - `GET /auth/sessions` → `{ sessions: [{ sid, client, created_at, last_seen_at, last_ip, user_agent, is_current }] }`
  - `DELETE /auth/sessions/{sid}` → `{ status: "revoked" }` (404 if not the caller's)
  - `POST /auth/sessions/revoke-all` → `{ revoked: <count> }` (body: `{ except_current?: bool }`)

> `is_current` is derived from the caller's own token `sid` when available. If `auth.py` has no dependency that exposes the raw token/claims, set `is_current` to `False` for now (the frontend tolerates it) and note it; do not invent a new auth scheme.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_sessions.py`:

```python
def test_list_sessions_excludes_revoked(client, db_session, user):
    from backend.services import sessions
    s1 = sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    s2 = sessions.start_session(db_session, TEST_USER_ID, "web", None)
    sessions.revoke(db_session, s2)

    res = client.get("/auth/sessions")
    assert res.status_code == 200, res.text
    sids = [s["sid"] for s in res.json()["sessions"]]
    assert s1.sid in sids
    assert s2.sid not in sids


def test_revoke_one_session(client, db_session, user):
    from backend.services import sessions
    s = sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    res = client.delete(f"/auth/sessions/{s.sid}")
    assert res.status_code == 200, res.text
    assert sessions.get_active(db_session, s.sid) is None


def test_revoke_all_sessions(client, db_session, user):
    from backend.services import sessions
    sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    sessions.start_session(db_session, TEST_USER_ID, "web", None)
    res = client.post("/auth/sessions/revoke-all", json={})
    assert res.status_code == 200, res.text
    assert res.json()["revoked"] >= 2
    assert client.get("/auth/sessions").json()["sessions"] == []
```

> These rely on the `user` fixture overriding `get_verified_user`. If `auth.py`'s endpoints authenticate via a different dependency (e.g. `get_current_user`), override that one in the fixture instead — check which dependency the new endpoints use and match it.

- [ ] **Step 2: Run to verify they fail**

Run: `pytest backend/tests/test_sessions.py -k "list_sessions or revoke" -v`
Expected: FAIL — endpoints do not exist (404).

- [ ] **Step 3: Implement the endpoints**

In `backend/routers/auth.py`, add Pydantic models near the other schemas:

```python
class SessionInfo(BaseModel):
    sid: str
    client: str
    created_at: datetime
    last_seen_at: datetime
    last_ip: Optional[str] = None
    user_agent: Optional[str] = None
    is_current: bool = False


class SessionListResponse(BaseModel):
    sessions: list[SessionInfo]


class RevokeAllRequest(BaseModel):
    except_current: bool = False
```

Add the endpoints (use the same authenticated-user dependency the rest of `auth.py`'s protected routes use — shown here as `get_verified_user`):

```python
@router.get("/sessions", response_model=SessionListResponse)
def list_sessions(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """List the caller's active (non-revoked) sessions for Connected Devices."""
    rows = (
        db.query(DBSession)
        .filter(DBSession.user_id == user.id, DBSession.revoked_at.is_(None))
        .order_by(DBSession.last_seen_at.desc())
        .all()
    )
    return SessionListResponse(sessions=[
        SessionInfo(
            sid=r.sid, client=r.client, created_at=r.created_at,
            last_seen_at=r.last_seen_at, last_ip=r.last_ip, user_agent=r.user_agent,
            is_current=False,
        )
        for r in rows
    ])


@router.delete("/sessions/{sid}")
def revoke_session(
    sid: str,
    request: Request,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Revoke one of the caller's sessions."""
    row = (
        db.query(DBSession)
        .filter(DBSession.sid == sid, DBSession.user_id == user.id, DBSession.revoked_at.is_(None))
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    session_service.revoke(db, row)
    security_logger.log_event(db, SecurityLogger.LOGOUT, request, user_id=user.id, success=True)
    return {"status": "revoked"}


@router.post("/sessions/revoke-all")
def revoke_all_sessions(
    request: Request,
    body: Optional[RevokeAllRequest] = None,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Revoke all of the caller's sessions ('sign out everywhere')."""
    rows = (
        db.query(DBSession)
        .filter(DBSession.user_id == user.id, DBSession.revoked_at.is_(None))
        .all()
    )
    count = 0
    for r in rows:
        session_service.revoke(db, r)
        count += 1
    security_logger.log_event(db, SecurityLogger.LOGOUT, request, user_id=user.id, success=True)
    return {"revoked": count}
```

Add imports at the top of `auth.py` if not present:

```python
from backend.db.models import Session as DBSession
from backend.auth.dependencies import get_verified_user
```

> If `Session` (SQLAlchemy ORM `sessionmaker` type) is already imported under the name `Session` for `db: Session`, the model alias `DBSession` avoids the clash — keep the model imported as `DBSession`.

- [ ] **Step 4: Run to verify Task 8 tests pass**

Run: `pytest backend/tests/test_sessions.py -v`
Expected: PASS (all session tests).

- [ ] **Step 5: Run the full backend auth + extension suites**

Run: `pytest backend/tests/test_sessions.py backend/tests/test_extension_auth.py backend/tests/ -k "auth" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/auth.py backend/tests/test_sessions.py
git commit -m "feat(backend): GET/DELETE /auth/sessions + revoke-all endpoints"
```

---

## Task 9: "Connected Devices" dashboard section (frontend)

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/settings.css`
- Test: manual (verify against the running dashboard).

**Interfaces:**
- Consumes: `GET /auth/sessions`, `DELETE /auth/sessions/{sid}`, `POST /auth/sessions/revoke-all` via the shared `api` axios client.
- Produces: a Connected Devices section listing sessions with per-row Revoke + a "Sign out everywhere" button.

- [ ] **Step 1: Add the session type + fetch state**

In `frontend/src/pages/Settings.tsx`, add an interface near the other interfaces:

```ts
interface DeviceSession {
  sid: string;
  client: string;
  created_at: string;
  last_seen_at: string;
  last_ip: string | null;
  user_agent: string | null;
  is_current: boolean;
}
```

Inside the `Settings` component, add state + a loader:

```ts
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      const { data } = await api.get<{ sessions: DeviceSession[] }>("/auth/sessions");
      setSessions(data.sessions);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => { void loadSessions(); }, []);
```

> Reuse the existing `useState`/`useEffect` imports already at the top of the file.

- [ ] **Step 2: Add revoke handlers**

```ts
  const revokeSession = async (sid: string) => {
    try {
      await api.delete(`/auth/sessions/${sid}`);
      setSessions((prev) => prev.filter((s) => s.sid !== sid));
    } catch {
      // surface via the existing toast mechanism if present; otherwise no-op
    }
  };

  const signOutEverywhere = async () => {
    try {
      await api.post("/auth/sessions/revoke-all", { except_current: true });
      await loadSessions();
    } catch {
      // no-op
    }
  };
```

- [ ] **Step 3: Render the section**

Add a Connected Devices block within the settings layout (place it alongside the existing settings sections, following their markup/class conventions):

```tsx
      <section className="settings-section">
        <h2>Connected Devices</h2>
        <p className="settings-section-sub">
          Browsers and the Tailrd extension currently signed in to your account.
        </p>

        {sessionsLoading ? (
          <p>Loading…</p>
        ) : sessions.length === 0 ? (
          <p>No active sessions.</p>
        ) : (
          <ul className="device-list">
            {sessions.map((s) => (
              <li key={s.sid} className="device-row">
                <div className="device-meta">
                  <span className="device-client">
                    {s.client === "extension" ? "Chrome extension" : "Web"}
                    {s.is_current && <span className="device-current"> · This device</span>}
                  </span>
                  <span className="device-times">
                    Connected {new Date(s.created_at).toLocaleDateString()} · last active{" "}
                    {new Date(s.last_seen_at).toLocaleString()}
                  </span>
                </div>
                <button
                  className="device-revoke"
                  onClick={() => void revokeSession(s.sid)}
                  disabled={s.is_current}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        <button className="device-revoke-all" onClick={() => void signOutEverywhere()}>
          Sign out everywhere
        </button>
      </section>
```

- [ ] **Step 4: Add styles**

In `frontend/src/settings.css`, append (match the file's existing visual language — spacing, colors, radius):

```css
.device-list { list-style: none; padding: 0; margin: 0.5rem 0; }
.device-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.75rem 0; border-bottom: 1px solid var(--border, #e5e7eb);
}
.device-meta { display: flex; flex-direction: column; gap: 0.15rem; }
.device-client { font-weight: 600; }
.device-current { color: var(--accent, #2563eb); font-weight: 500; }
.device-times { font-size: 0.85rem; color: var(--muted, #6b7280); }
.device-revoke, .device-revoke-all {
  cursor: pointer; border-radius: 8px; padding: 0.4rem 0.8rem;
  border: 1px solid var(--border, #e5e7eb); background: transparent;
}
.device-revoke:disabled { opacity: 0.4; cursor: default; }
.device-revoke-all { margin-top: 0.75rem; }
```

- [ ] **Step 5: Typecheck the frontend**

Run: `cd frontend && npm run build` (or `npx tsc --noEmit` if a faster typecheck script exists)
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/settings.css
git commit -m "feat(web): Connected Devices section in Settings"
```

---

## Task 10: Full verification + status-doc update

**Files:**
- Modify: `docs/extension-connect-status.md` (mark Phase 2 progress)
- Test: full suites + manual live check.

- [ ] **Step 1: Run the full backend test suite**

Run: `pytest backend/tests/ -v`
Expected: PASS (note: runs against the real dev Neon DB via lifespan; the `sessions` migration creates the table on first run).

- [ ] **Step 2: Run the full extension test suite + build**

Run: `cd chrome-extension && npm test && npm run typecheck && npm run build`
Expected: all tests pass; build emits `dist/`.

- [ ] **Step 3: Manual live check (human)**

- Load `chrome-extension/dist/` unpacked; confirm the ID is `apgogjfdpleeajnngkfkfekbddcpodkl`.
- Connect the account; in the web dashboard → Settings → Connected Devices, confirm a "Chrome extension" row appears with a recent "last active".
- Click **Revoke** on the extension row. Within ~the access-token lifetime, the extension's next refresh should 401 → the panel shows **"Session expired — reconnect"** (not sample data), with the cached data still visible behind it.
- Reconnect; confirm the banner clears and the device reappears in the list.
- Click **Sign out everywhere** from a second browser session and confirm the others drop on their next refresh.

- [ ] **Step 4: Update the status doc**

In `docs/extension-connect-status.md`, update the roadmap so **Phase 2 — Silent session management** is marked built + verified, and link the spec/plan.

- [ ] **Step 5: Commit**

```bash
git add docs/extension-connect-status.md
git commit -m "docs: mark Phase 2 silent session management complete"
```

---

## Self-Review Notes

- **Spec coverage:** Proactive refresh → Task 1. Re-auth recovery UX (preserve snapshot, distinct state, never mock) → Tasks 2–4. Tests + audit → Tasks 1–9 (TDD per task; backend `test_sessions.py` + extended `test_extension_auth.py`). Connected Devices (session registry, `sid`, list/revoke, frontend) → Tasks 5–9. Legacy-token migration → Task 7. Web + extension sessions both registered → Task 7.
- **Type consistency:** `Session` ORM model imported as `DBSession` everywhere to avoid clashing with `sqlalchemy.orm.Session`; `services.sessions` functions `start_session/get_active/touch/revoke` used identically across Tasks 6–8; `sid` claim threaded through `create_refresh_token` (Task 6) and all issuance points (Task 7); `StatusResponse.mode` union extended once (Task 3) and consumed in Task 4.
- **Open verification point:** `is_current` depends on whether `auth.py` exposes the caller's token claims; Task 8 specifies a safe `False` default if not, with no new auth scheme — confirm during implementation.
