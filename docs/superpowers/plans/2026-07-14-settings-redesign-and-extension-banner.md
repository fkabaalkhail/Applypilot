# Settings Redesign + Extension Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the settings modal from five tabs to three (Account / Extension / Security) in a Clerk-style row layout, delete the unlinked duplicate settings page, and add a themed Chrome-extension install banner to every `/app` page.

**Architecture:** The banner's install detection reuses `TAILRD_PING`, an `onMessageExternal` handler that **already ships in the extension's service worker** (`chrome-extension/src/background/serviceWorker.ts:188`) and replies `{ ok, connected }`. So detection is a new function in the existing `frontend/src/lib/extensionBridge.ts` — no backend endpoint, no extension change, no migration. The settings redesign is a rewrite of `SettingsModal.tsx`'s body around one new `SettingRow` primitive (muted label · value · right-aligned action, hairline divider); the removed tabs were duplicates of `/app/profile`, which already owns those fields.

**Tech Stack:** React 18 + TypeScript + Vite, react-router-dom, `@phosphor-icons/react`, plain CSS with custom properties, Vitest + @testing-library/react (jsdom), FastAPI + SQLAlchemy + pytest.

**Spec:** `docs/superpowers/specs/2026-07-14-settings-redesign-and-extension-banner-design.md`

## Global Constraints

- **No database migration.** `auth_provider` already exists (`backend/db/models.py:32`, values `local` / `google` / `linkedin`). No `user_settings` column is added or dropped.
- **No data loss.** `first_name`, `last_name`, `email`, `phone`, `linkedin_url`, `website`, `job_title`, `location`, `remote_only`, `prefilled_answers` stay on the model, stay readable by the extension (`backend/routers/extension.py:174-175`), and stay writable from `/app/profile` (`backend/routers/profile.py:392,421-430`). `PUT /settings` keeps accepting all of them — **only the modal stops sending them.**
- **No extension change.** Do not edit anything under `chrome-extension/`.
- **Theme tokens only.** Use the custom properties already in `frontend/src/index.css` (`--accent`, `--stripe-primary`, `--radius-pill`, `--border`, `--text`, `--text-secondary`, `--text-muted`, `--bg-white`, `--bg-page`, `--stripe-ruby`). The sole exception is the banner's gradient stops (`#665efd → #533afd → #4434d4`), which mirror the existing `--stripe-cta-gradient` family.
- **Icons:** `@phosphor-icons/react`, e.g. `<X size={16} weight="bold" />`.
- **Frontend tests:** run from `frontend/`. `npm test` → `vitest --run` (jsdom, `globals: true`). Component tests are **siblings** of the component (`components/Foo.tsx` → `components/Foo.test.tsx`); there is no `components/__tests__/`.
- **Backend tests:** run from the repo root: `python -m pytest backend/tests/<file> -v`. Entering the app lifespan migrates the real dev Neon DB — expected, not an error.
- **Shared working tree.** Other sessions may share this checkout. `git add` **by explicit path**, never `git add -A`. Run `git reflog -3` before any commit.
- **Copy is exact.** Use the literal strings given in each task — the tests assert on them.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/src/lib/extensionStore.ts` | **Create.** The one constant holding the Web Store URL. |
| `frontend/src/lib/extensionBridge.ts` | **Modify.** Add `pingExtension()` / `ExtensionState` beside the existing `notifyApplyIntent`. |
| `frontend/src/lib/extensionBridge.test.ts` | **Create.** Covers the four ping outcomes. |
| `frontend/src/components/ExtensionBanner.tsx` | **Create.** The banner. Owns its own ping, snooze, and copy. |
| `frontend/src/components/extension-banner.css` | **Create.** Gradient, pill CTA, ring art. |
| `frontend/src/components/ExtensionBanner.test.tsx` | **Create.** All three states + snooze. |
| `frontend/src/App.tsx` | **Modify.** Mount `<ExtensionBanner />` above `<Outlet />`. |
| `backend/routers/auth.py` | **Modify.** Add `auth_provider` to `GET /auth/me`. |
| `backend/tests/test_auth_me.py` | **Create.** Asserts `/auth/me` exposes `auth_provider`. |
| `frontend/src/auth/AuthContext.tsx` | **Modify.** Add `auth_provider?: string` to `UserProfile`. |
| `frontend/src/components/SettingsModal.tsx` | **Rewrite body.** 5 tabs → 3, built on a `SettingRow` primitive. |
| `frontend/src/settings-modal.css` | **Rewrite.** Row/hairline layout. |
| `frontend/src/components/SettingsModal.test.tsx` | **Create.** Locks the three tabs and the absence of the removed fields. |
| `frontend/src/pages/Settings.tsx` | **Delete.** Unlinked 697-line duplicate. |
| `frontend/src/main.tsx` | **Modify.** Drop the `/app/settings` route + import. |
| `scripts/responsive-audit/states.cjs` | **Modify.** Drop `app-settings-page`, add `app-extension-banner`. |

`frontend/src/settings.css` is **not** touched — the modal still imports it for `.toggle-switch`, `.settings-save-btn`, `.device-*`, and `.toast-*`.

**Task order:** 1 → 2 (banner needs the ping), 3 → 4 (Account tab needs `auth_provider`), 1 → 4 (Extension tab needs the ping), 4 → 5 (delete the page only once the modal replaces it).

---

## Task 1: Extension detection bridge

**Files:**
- Create: `frontend/src/lib/extensionStore.ts`
- Modify: `frontend/src/lib/extensionBridge.ts` (append; do not touch `notifyApplyIntent`)
- Test: `frontend/src/lib/extensionBridge.test.ts`

**Interfaces:**
- Consumes: the module-private `EXTENSION_IDS` and `runtime()` already in `extensionBridge.ts`.
- Produces:
  - `export type ExtensionState = "unknown" | "not-installed" | "installed" | "connected"`
  - `export function pingExtension(timeoutMs?: number): Promise<ExtensionState>` — never rejects
  - `export const CHROME_STORE_URL: string` (from `extensionStore.ts`)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/extensionBridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pingExtension } from "./extensionBridge";

const KNOWN_ID = "apgogjfdpleeajnngkfkfekbddcpodkl";

type SendMessage = (id: string, msg: unknown, cb: (r: unknown) => void) => void;

/** Install a fake chrome.runtime. `lastError` mimics "no receiving end". */
function setChrome(sendMessage: SendMessage, lastError?: { message: string }) {
  (window as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError },
  };
}

describe("pingExtension", () => {
  beforeEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
  });
  afterEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
  });

  it("resolves not-installed when chrome.runtime is absent (non-Chromium)", async () => {
    await expect(pingExtension()).resolves.toBe("not-installed");
  });

  it("sends TAILRD_PING to the known extension id", async () => {
    const send = vi.fn<SendMessage>((_id, _msg, cb) => cb({ ok: true, connected: true }));
    setChrome(send);
    await pingExtension();
    expect(send).toHaveBeenCalledWith(
      KNOWN_ID,
      { type: "TAILRD_PING" },
      expect.any(Function)
    );
  });

  it("resolves connected when the extension replies ok + connected", async () => {
    setChrome((_id, _msg, cb) => cb({ ok: true, connected: true }));
    await expect(pingExtension()).resolves.toBe("connected");
  });

  it("resolves installed when the extension replies ok but not connected", async () => {
    setChrome((_id, _msg, cb) => cb({ ok: true, connected: false }));
    await expect(pingExtension()).resolves.toBe("installed");
  });

  it("resolves not-installed when chrome reports lastError", async () => {
    setChrome((_id, _msg, cb) => cb(undefined), { message: "Receiving end does not exist." });
    await expect(pingExtension()).resolves.toBe("not-installed");
  });

  it("resolves not-installed on timeout rather than hanging or rejecting", async () => {
    setChrome(() => {
      /* never invokes the callback */
    });
    await expect(pingExtension(30)).resolves.toBe("not-installed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend/`): `npm test -- extensionBridge`
Expected: FAIL — `"pingExtension" is not exported by "src/lib/extensionBridge.ts"`.

- [ ] **Step 3: Create the store-URL constant**

Create `frontend/src/lib/extensionStore.ts`:

```ts
/**
 * The Tailrd extension's Chrome Web Store listing.
 *
 * The extension is still in review, so the fallback below is a placeholder. Once
 * the listing is live, set VITE_CHROME_STORE_URL in Vercel — no code change and
 * no redeploy of source needed. Replacing the literal works too.
 */
export const CHROME_STORE_URL =
  (import.meta.env.VITE_CHROME_STORE_URL as string | undefined) ??
  "https://chromewebstore.google.com/detail/tailrd/PLACEHOLDER_STORE_ID";
```

- [ ] **Step 4: Add `pingExtension` to the bridge**

Append to `frontend/src/lib/extensionBridge.ts` (leave everything above untouched):

```ts
/** Installed-and-signed-in state of the extension, as reported by TAILRD_PING. */
export type ExtensionState = "unknown" | "not-installed" | "installed" | "connected";

interface PingResponse {
  ok?: boolean;
  connected?: boolean;
}

/**
 * Ask the extension whether it is installed and signed in.
 *
 * The service worker's onMessageExternal handler answers TAILRD_PING with
 * {ok, connected}. We ask every known id and take the first real answer.
 * Resolves "not-installed" when chrome.runtime is absent (non-Chromium), every
 * send errors, or nothing answers within `timeoutMs`.
 *
 * Never rejects: the only caller is UI, and a messaging failure must not break a
 * page render.
 *
 * The extension's externally_connectable.matches covers only
 * https://(www.)tailrd.ca, so on localhost this always resolves "not-installed".
 * ExtensionBanner has a dev-only ?extState= override for that reason.
 */
export function pingExtension(timeoutMs = 400): Promise<ExtensionState> {
  const rt = runtime();
  if (!rt?.sendMessage || EXTENSION_IDS.length === 0) {
    return Promise.resolve("not-installed");
  }

  return new Promise<ExtensionState>((resolve) => {
    let settled = false;
    let outstanding = EXTENSION_IDS.length;

    const finish = (state: ExtensionState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };

    const timer = setTimeout(() => finish("not-installed"), timeoutMs);

    const miss = () => {
      outstanding -= 1;
      if (outstanding <= 0) finish("not-installed");
    };

    for (const extensionId of EXTENSION_IDS) {
      try {
        rt.sendMessage(extensionId, { type: "TAILRD_PING" }, (response: unknown) => {
          // Reading lastError suppresses Chrome's "Unchecked runtime.lastError"
          // console warning when no extension answered.
          const errored = Boolean(rt.lastError);
          const res = response as PingResponse | undefined;
          if (!errored && res?.ok) {
            finish(res.connected ? "connected" : "installed");
            return;
          }
          miss();
        });
      } catch {
        // chrome.runtime present but messaging blocked.
        miss();
      }
    }
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `frontend/`): `npm test -- extensionBridge`
Expected: PASS — 6 passed.

- [ ] **Step 6: Commit**

```bash
git reflog -3
git add frontend/src/lib/extensionBridge.ts frontend/src/lib/extensionStore.ts frontend/src/lib/extensionBridge.test.ts
git commit -m "feat(extension): detect install state from the web app via TAILRD_PING"
```

---

## Task 2: Extension install banner

**Files:**
- Create: `frontend/src/components/ExtensionBanner.tsx`
- Create: `frontend/src/components/extension-banner.css`
- Test: `frontend/src/components/ExtensionBanner.test.tsx`
- Modify: `frontend/src/App.tsx:197-199`

**Interfaces:**
- Consumes: `pingExtension()`, `ExtensionState` (Task 1); `CHROME_STORE_URL` (Task 1).
- Produces: `export default function ExtensionBanner(): JSX.Element | null` — takes no props.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ExtensionBanner.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const ping = vi.fn();
vi.mock("../lib/extensionBridge", () => ({ pingExtension: () => ping() }));

import ExtensionBanner from "./ExtensionBanner";
import { CHROME_STORE_URL } from "../lib/extensionStore";

const SNOOZE_KEY = "tailrd.extBanner.snoozedUntil";
const DAY = 24 * 60 * 60 * 1000;

const renderBanner = () =>
  render(
    <MemoryRouter>
      <ExtensionBanner />
    </MemoryRouter>
  );

describe("ExtensionBanner", () => {
  beforeEach(() => {
    ping.mockReset();
    localStorage.clear();
  });

  it("links to the Chrome Web Store when the extension is not installed", async () => {
    ping.mockResolvedValue("not-installed");
    renderBanner();
    const cta = await screen.findByRole("link", { name: /add to chrome/i });
    expect(cta).toHaveAttribute("href", CHROME_STORE_URL);
    expect(cta).toHaveAttribute("target", "_blank");
    expect(cta).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("points at the connect flow when installed but not signed in", async () => {
    ping.mockResolvedValue("installed");
    renderBanner();
    const cta = await screen.findByRole("link", { name: /finish setup/i });
    expect(cta).toHaveAttribute("href", "/extension/connect");
    expect(screen.queryByRole("link", { name: /add to chrome/i })).toBeNull();
  });

  it("renders nothing once the extension is connected", async () => {
    ping.mockResolvedValue("connected");
    const { container } = renderBanner();
    await waitFor(() => expect(ping).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the ping is still pending, so it cannot flash", () => {
    ping.mockReturnValue(new Promise(() => {}));
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("dismissing hides it and snoozes for 7 days", async () => {
    ping.mockResolvedValue("not-installed");
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("link", { name: /add to chrome/i })).toBeNull();
    expect(Number(localStorage.getItem(SNOOZE_KEY))).toBeGreaterThan(Date.now() + 6 * DAY);
  });

  it("stays hidden while a snooze is still live", async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * DAY));
    ping.mockResolvedValue("not-installed");
    const { container } = renderBanner();
    await waitFor(() => expect(ping).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("clears a stale snooze once connected, so a later uninstall re-prompts", async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * DAY));
    ping.mockResolvedValue("connected");
    renderBanner();
    await waitFor(() => expect(localStorage.getItem(SNOOZE_KEY)).toBeNull());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend/`): `npm test -- ExtensionBanner`
Expected: FAIL — cannot resolve `./ExtensionBanner`.

- [ ] **Step 3: Write the component**

Create `frontend/src/components/ExtensionBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X, PuzzlePiece } from "@phosphor-icons/react";
import { pingExtension, type ExtensionState } from "../lib/extensionBridge";
import { CHROME_STORE_URL } from "../lib/extensionStore";
import "./extension-banner.css";

const SNOOZE_KEY = "tailrd.extBanner.snoozedUntil";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function isSnoozed(): boolean {
  const until = Number(localStorage.getItem(SNOOZE_KEY));
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Dev-only override. The extension's externally_connectable.matches covers only
 * tailrd.ca, so on localhost the real ping always reports "not-installed" and
 * the other two states are undrivable. Vite statically replaces
 * import.meta.env.DEV with false in production, so this whole branch is
 * dead-code-eliminated from the prod bundle.
 */
function devStateOverride(): ExtensionState | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(window.location.search).get("extState");
  return v === "connected" || v === "installed" || v === "not-installed" ? v : null;
}

export default function ExtensionBanner() {
  const [state, setState] = useState<ExtensionState>("unknown");
  const [dismissed, setDismissed] = useState(isSnoozed);

  useEffect(() => {
    const override = devStateOverride();
    if (override) {
      setState(override);
      return;
    }
    let alive = true;
    void pingExtension().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Installing is the outcome we wanted, so retire the snooze. A snooze that
  // outlived an uninstall would silently suppress the prompt for a week.
  useEffect(() => {
    if (state === "connected") localStorage.removeItem(SNOOZE_KEY);
  }, [state]);

  // "unknown" is the pre-ping state: render nothing rather than flash a banner
  // at users who already have the extension.
  if (state === "unknown" || state === "connected" || dismissed) return null;

  const snooze = () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    setDismissed(true);
  };

  const installed = state === "installed";

  return (
    <aside className="ext-banner" role="region" aria-label="Tailrd Chrome extension">
      <div className="ext-banner-copy">
        <span className="ext-banner-eyebrow">
          {installed ? "Almost there" : "New · Chrome extension"}
        </span>
        <p className="ext-banner-headline">
          {installed
            ? "Sign in to the extension to start autofilling"
            : "Autofill any job application in one click"}
        </p>
        {installed ? (
          <Link className="ext-banner-cta" to="/extension/connect">
            Finish setup
          </Link>
        ) : (
          <a
            className="ext-banner-cta"
            href={CHROME_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add to Chrome — it's free
          </a>
        )}
      </div>

      <div className="ext-banner-art" aria-hidden="true">
        <span className="ext-banner-ring ext-banner-ring-lg" />
        <span className="ext-banner-ring ext-banner-ring-md" />
        <span className="ext-banner-mark">
          <PuzzlePiece size={28} weight="fill" />
        </span>
      </div>

      <button type="button" className="ext-banner-close" onClick={snooze} aria-label="Dismiss">
        <X size={16} weight="bold" />
      </button>
    </aside>
  );
}
```

- [ ] **Step 4: Write the stylesheet**

Create `frontend/src/components/extension-banner.css`:

```css
/* ─── Extension install banner ───────────────────────────────────────────────
   Sits inside .main-content, which has NO padding of its own — every page
   supplies its own inset (2rem is the house convention: .profile-page,
   .interview-page, .resume-page-new). The banner therefore carries its own
   margin so it lines up with the page content below it rather than going
   edge-to-edge. */
.ext-banner {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  overflow: hidden;
  margin: 1.5rem 2rem 0;
  padding: 1.15rem 1.4rem;
  border-radius: 14px;
  background: linear-gradient(110deg, #665efd 0%, #533afd 55%, #4434d4 100%);
  box-shadow: 0 8px 24px rgba(83, 58, 253, 0.22);
  color: #fff;
}

.ext-banner-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  min-width: 0;
}

.ext-banner-eyebrow {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.72);
}

.ext-banner-headline {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.3;
  color: #fff;
}

.ext-banner-cta {
  display: inline-flex;
  align-items: center;
  margin-top: 0.35rem;
  padding: 0.5rem 1.1rem;
  border-radius: var(--radius-pill);
  background: #fff;
  color: var(--stripe-primary);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.ext-banner-cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}

/* Concentric rings + mark, bleeding toward the right edge. Decorative only. */
.ext-banner-art {
  position: relative;
  flex-shrink: 0;
  width: 132px;
  height: 88px;
  margin-right: -0.4rem;
  pointer-events: none;
}

.ext-banner-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.22);
  transform: translate(-50%, -50%);
}

.ext-banner-ring-lg {
  width: 126px;
  height: 126px;
}

.ext-banner-ring-md {
  width: 90px;
  height: 90px;
  background: rgba(255, 255, 255, 0.08);
}

.ext-banner-mark {
  position: absolute;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  color: var(--stripe-primary);
  transform: translate(-50%, -50%);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
}

.ext-banner-close {
  position: absolute;
  top: 0.6rem;
  right: 0.7rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.ext-banner-close:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

/* Phone: drop the art, let the CTA span the width, tighten the inset. */
@media (max-width: 640px) {
  .ext-banner {
    margin: 1rem 1rem 0;
    padding: 1rem 1.1rem;
  }
  .ext-banner-art {
    display: none;
  }
  .ext-banner-headline {
    font-size: 1rem;
  }
  .ext-banner-cta {
    width: 100%;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ext-banner-cta {
    transition: none;
  }
  .ext-banner-cta:hover {
    transform: none;
  }
}
```

- [ ] **Step 5: Mount it in the app shell**

In `frontend/src/App.tsx`, add the import beside the other component imports (after line 25, `import SettingsModal from "./components/SettingsModal";`):

```tsx
import ExtensionBanner from "./components/ExtensionBanner";
```

Then change the `<main>` block (lines 197-199) from:

```tsx
      <main className="main-content">
        <Outlet />
      </main>
```

to:

```tsx
      <main className="main-content">
        <ExtensionBanner />
        <Outlet />
      </main>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `frontend/`): `npm test -- ExtensionBanner`
Expected: PASS — 7 passed.

- [ ] **Step 7: Typecheck**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git reflog -3
git add frontend/src/components/ExtensionBanner.tsx frontend/src/components/extension-banner.css frontend/src/components/ExtensionBanner.test.tsx frontend/src/App.tsx
git commit -m "feat(app): prompt signed-in users to install the Chrome extension"
```

---

## Task 3: Expose `auth_provider` on `/auth/me`

**Files:**
- Modify: `backend/routers/auth.py:526-536` (the `get_me` return dict)
- Test: `backend/tests/test_auth_me.py` (create)
- Modify: `frontend/src/auth/AuthContext.tsx:3-13` (the `UserProfile` interface)

**Interfaces:**
- Produces: `GET /auth/me` gains `auth_provider: "local" | "google" | "linkedin"`; `UserProfile.auth_provider?: string`. Task 4's Account tab consumes it.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_auth_me.py`. It follows the fixture pattern of `backend/tests/test_setup_api.py` (`client` and `db_session` come from `backend/tests/conftest.py`, which also stubs auth as `TEST_USER_ID`):

```python
"""GET /auth/me must expose auth_provider — the Settings Account tab renders it."""
import pytest

from backend.db.models import User
from backend.tests.conftest import TEST_USER_ID


def _make_user(db, provider: str) -> User:
    user = User(id=TEST_USER_ID, email="me@test.com", auth_provider=provider)
    db.add(user)
    db.commit()
    return user


@pytest.mark.parametrize("provider", ["local", "google", "linkedin"])
def test_me_exposes_auth_provider(client, db_session, provider):
    _make_user(db_session, provider)
    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["auth_provider"] == provider
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from the repo root): `python -m pytest backend/tests/test_auth_me.py -v`
Expected: FAIL — 3 failures, `KeyError: 'auth_provider'`.
(The app lifespan runs migrations against the dev Neon DB on startup. That is expected.)

- [ ] **Step 3: Add the field to the endpoint**

In `backend/routers/auth.py`, in `get_me`, add one line to the returned dict (after `"profile_image_url": user.profile_image_url,`):

```python
        "auth_provider": user.auth_provider or "local",
```

The full dict becomes:

```python
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "profile_image_url": user.profile_image_url,
        "auth_provider": user.auth_provider or "local",
        "email_verified": effective_email_verified(user),
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "has_completed_onboarding": bool(user.has_completed_onboarding),
        "has_completed_setup": bool(user.has_completed_setup),
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from the repo root): `python -m pytest backend/tests/test_auth_me.py -v`
Expected: PASS — 3 passed.

- [ ] **Step 5: Widen the frontend type**

In `frontend/src/auth/AuthContext.tsx`, add one field to `UserProfile`:

```ts
export interface UserProfile {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  profile_image_url?: string;
  auth_provider?: string;
  created_at?: string;
  email_verified: boolean;
  has_completed_onboarding?: boolean;
  has_completed_setup?: boolean;
}
```

- [ ] **Step 6: Typecheck**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git reflog -3
git add backend/routers/auth.py backend/tests/test_auth_me.py frontend/src/auth/AuthContext.tsx
git commit -m "feat(auth): expose auth_provider on /auth/me"
```

---

## Task 4: Rewrite the settings modal

**Files:**
- Rewrite: `frontend/src/components/SettingsModal.tsx`
- Rewrite: `frontend/src/settings-modal.css`
- Test: `frontend/src/components/SettingsModal.test.tsx` (create)
- Modify: `frontend/src/test-setup.ts` (add a `crypto.randomUUID` stub — see Step 0)

**Landmine, read first.** `showToast()` calls `crypto.randomUUID()`. Today that code is only
reached from `SettingsModal.tsx` and `pages/Settings.tsx`, **neither of which has ever had a
test** — so it has never run under jsdom. jsdom installs its own `window.crypto` (with only
`getRandomValues`), which shadows Node's webcrypto, so `crypto.randomUUID` is very likely
`undefined` in the test environment and the save test will die with
`crypto.randomUUID is not a function`. Step 0 stubs it, in the same house style as the
`scrollIntoView` and `ResizeObserver` stubs already in `test-setup.ts`.

**Interfaces:**
- Consumes: `pingExtension()` / `ExtensionState` and `CHROME_STORE_URL` (Task 1); `UserProfile.auth_provider` (Task 3); existing `api`, `useAuth`, `useOnboarding`.
- Produces: `export default function SettingsModal({ onClose }: { onClose: () => void })` — the prop signature is **unchanged**, so `App.tsx` needs no edit.

- [ ] **Step 0: Stub `crypto.randomUUID` for jsdom**

Append to `frontend/src/test-setup.ts`:

```ts
// jsdom's window.crypto shadows Node's webcrypto and omits randomUUID, which
// SettingsModal uses to key toasts.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
  });
}
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/SettingsModal.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const get = vi.fn();
const put = vi.fn();
vi.mock("../auth/api", () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    delete: vi.fn(),
    post: vi.fn(),
  },
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));

vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "you@school.edu",
      first_name: "Wissam",
      last_name: "Elmasry",
      email_verified: true,
      auth_provider: "google",
    },
    logout: vi.fn(),
  }),
}));

vi.mock("../onboarding", () => ({ useOnboarding: () => ({ restart: vi.fn() }) }));
vi.mock("../lib/extensionBridge", () => ({ pingExtension: () => Promise.resolve("connected") }));

import SettingsModal from "./SettingsModal";

const SETTINGS = {
  pause_before_submit: true,
  smooth_scrolling: false,
  follow_companies: false,
};

const renderModal = () =>
  render(
    <MemoryRouter>
      <SettingsModal onClose={() => {}} />
    </MemoryRouter>
  );

describe("SettingsModal", () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    navigate.mockReset();
    get.mockImplementation((url: string) =>
      url === "/settings"
        ? Promise.resolve({ data: SETTINGS })
        : Promise.resolve({ data: { sessions: [] } })
    );
  });

  it("has exactly three tabs: Account, Extension, Security", async () => {
    renderModal();
    await screen.findByRole("button", { name: "Account" });
    expect(screen.getByRole("button", { name: "Extension" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Security" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /job preferences/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /autofill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /profile & contact/i })).toBeNull();
  });

  it("no longer edits profile, job-preference or autofill fields", async () => {
    const { container } = renderModal();
    await screen.findByRole("button", { name: "Account" });
    for (const id of ["first_name", "last_name", "phone", "linkedin_url", "website", "job_title", "location"]) {
      expect(container.querySelector(`#${id}`)).toBeNull();
    }
    expect(screen.queryByPlaceholderText("Question")).toBeNull();
    expect(screen.queryByPlaceholderText("Answer")).toBeNull();
    expect(screen.queryByText(/pre-filled answers/i)).toBeNull();
  });

  it("shows the signed-in identity and OAuth provider on the Account tab", async () => {
    renderModal();
    expect(await screen.findByText("you@school.edu")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("sends the Profile link to /app/profile", async () => {
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: /update profile/i }));
    expect(navigate).toHaveBeenCalledWith("/app/profile");
  });

  it("saves ONLY the extension toggles — never the removed profile fields", async () => {
    put.mockResolvedValue({ data: { ...SETTINGS, smooth_scrolling: true } });
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Extension" }));

    const toggle = await screen.findByRole("checkbox", { name: "Smooth scrolling" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings", { smooth_scrolling: true }));
  });

  it("lists connected devices on the Security tab", async () => {
    get.mockImplementation((url: string) =>
      url === "/settings"
        ? Promise.resolve({ data: SETTINGS })
        : Promise.resolve({
            data: {
              sessions: [
                {
                  sid: "s1",
                  client: "extension",
                  created_at: "2026-07-01T00:00:00Z",
                  last_seen_at: "2026-07-13T00:00:00Z",
                  last_ip: null,
                  user_agent: null,
                  is_current: false,
                },
              ],
            },
          })
    );
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Security" }));
    expect(await screen.findByText(/chrome extension/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend/`): `npm test -- SettingsModal`
Expected: FAIL — the old modal still renders five tabs; the "exactly three tabs" and "saves ONLY the extension toggles" cases fail.

- [ ] **Step 3: Rewrite the component**

Replace the **entire contents** of `frontend/src/components/SettingsModal.tsx`:

```tsx
import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  UserCircle,
  PuzzlePiece,
  ShieldCheck,
  ShieldStar,
  SignOut,
  GoogleLogo,
  LinkedinLogo,
  Envelope,
  ArrowRight,
} from "@phosphor-icons/react";
import api from "../auth/api";
import { useAuth } from "../auth/useAuth";
import { useOnboarding } from "../onboarding";
import { pingExtension, type ExtensionState } from "../lib/extensionBridge";
import { CHROME_STORE_URL } from "../lib/extensionStore";
import "../settings.css";
import "../settings-modal.css";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The extension toggles are the only thing this modal edits now.
 *
 * Contact details, job preferences and screening answers moved to /app/profile,
 * which is their single source of truth. The columns still exist and the
 * extension still reads them (backend/routers/extension.py) — we simply stopped
 * offering a second, competing editor for them.
 */
interface ExtensionSettings {
  pause_before_submit: boolean;
  smooth_scrolling: boolean;
  follow_companies: boolean;
}

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

interface DeviceSession {
  sid: string;
  client: string;
  created_at: string;
  last_seen_at: string;
  last_ip: string | null;
  user_agent: string | null;
  is_current: boolean;
}

type TabKey = "account" | "extension" | "security";

const SETTINGS_KEYS: (keyof ExtensionSettings)[] = [
  "pause_before_submit",
  "smooth_scrolling",
  "follow_companies",
];

function normalize(data: Partial<ExtensionSettings>): ExtensionSettings {
  return {
    pause_before_submit: data.pause_before_submit ?? false,
    smooth_scrolling: data.smooth_scrolling ?? false,
    follow_companies: data.follow_companies ?? false,
  };
}

function computeDiff(
  original: ExtensionSettings,
  current: ExtensionSettings
): Partial<ExtensionSettings> | null {
  const diff: Partial<ExtensionSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (current[key] !== original[key]) diff[key] = current[key];
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

const PROVIDERS: Record<string, { label: string; icon: ReactNode }> = {
  google: { label: "Google", icon: <GoogleLogo size={18} weight="bold" /> },
  linkedin: { label: "LinkedIn", icon: <LinkedinLogo size={18} weight="fill" /> },
  local: { label: "Email & password", icon: <Envelope size={18} weight="duotone" /> },
};

const EXT_STATUS: Record<Exclude<ExtensionState, "unknown">, string> = {
  "not-installed": "Not installed",
  installed: "Installed — not signed in",
  connected: "Installed and connected",
};

const TABS: { key: TabKey; label: string; title: string; icon: ReactNode }[] = [
  { key: "account", label: "Account", title: "Account details", icon: <UserCircle size={18} weight="duotone" /> },
  { key: "extension", label: "Extension", title: "Extension", icon: <PuzzlePiece size={18} weight="duotone" /> },
  { key: "security", label: "Security", title: "Login & security", icon: <ShieldCheck size={18} weight="duotone" /> },
];

// ─── Row primitive ───────────────────────────────────────────────────────────

/**
 * Every row in every tab is one of these: muted label | value | right-aligned
 * action, closed by a hairline. That single repeated rhythm is the redesign —
 * resist adding bespoke layouts inside a tab.
 */
function SettingRow({
  label,
  children,
  action,
}: {
  label: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="sm-row">
      <span className="sm-row-label">{label}</span>
      <div className="sm-row-value">{children}</div>
      {action ? <div className="sm-row-action">{action}</div> : null}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
    </label>
  );
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Close notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Main modal ──────────────────────────────────────────────────────────────

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<TabKey>("account");
  const [formData, setFormData] = useState<ExtensionSettings | null>(null);
  const [originalData, setOriginalData] = useState<ExtensionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [extState, setExtState] = useState<ExtensionState>("unknown");

  const { user, logout } = useAuth();
  const { restart: restartTour } = useOnboarding();
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function showToast(type: "success" | "error", message: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }
  const dismissToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  // ─── Data ──────────────────────────────────────────────────────────────
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

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.get("/settings");
        const settings = normalize(res.data);
        setFormData(settings);
        setOriginalData(settings);
      } catch (err: any) {
        setError(
          err.response?.data?.detail || err.message || "Could not load settings. Please check your connection."
        );
      } finally {
        setLoading(false);
      }
    })();
    void loadSessions();
    void pingExtension().then(setExtState);
  }, []);

  const revokeSession = async (sid: string) => {
    try {
      await api.delete(`/auth/sessions/${sid}`);
      setSessions((prev) => prev.filter((s) => s.sid !== sid));
    } catch {
      showToast("error", "Failed to revoke session.");
    }
  };

  const signOutEverywhere = async () => {
    try {
      await api.post("/auth/sessions/revoke-all", { except_current: true });
      await loadSessions();
    } catch {
      /* no-op */
    }
  };

  async function saveSettings() {
    if (!formData || !originalData) return;
    const diff = computeDiff(originalData, formData);
    if (!diff) {
      showToast("success", "No changes to save.");
      return;
    }
    try {
      setSaving(true);
      const res = await api.put("/settings", diff);
      const updated = normalize(res.data);
      setFormData(updated);
      setOriginalData(updated);
      showToast("success", "Settings saved successfully.");
    } catch (err: any) {
      showToast("error", err.response?.data?.detail || err.message || "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  const isDirty = useMemo(
    () => Boolean(originalData && formData && computeDiff(originalData, formData)),
    [originalData, formData]
  );

  function updateField(field: keyof ExtensionSettings, value: boolean) {
    setFormData((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  const goTo = (path: string) => {
    navigate(path);
    onClose();
  };

  // ─── Tabs ──────────────────────────────────────────────────────────────

  function renderAccount() {
    const provider = PROVIDERS[user?.auth_provider ?? "local"] ?? PROVIDERS.local;
    const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
    const initials = (user?.first_name?.[0] || user?.email?.[0] || "U").toUpperCase();

    return (
      <div className="sm-rows">
        <SettingRow
          label="Profile"
          action={
            <button type="button" className="sm-link" onClick={() => goTo("/app/profile")}>
              Update profile <ArrowRight size={13} weight="bold" />
            </button>
          }
        >
          <span className="sm-identity">
            <span className="sm-avatar">
              {user?.profile_image_url ? (
                <img src={user.profile_image_url} alt="" />
              ) : (
                initials
              )}
            </span>
            <span className="sm-identity-name">{fullName || "Your name"}</span>
          </span>
        </SettingRow>

        <SettingRow
          label="Email address"
          action={
            <span className={`sm-pill ${user?.email_verified ? "sm-pill-ok" : "sm-pill-warn"}`}>
              {user?.email_verified ? "Verified" : "Unverified"}
            </span>
          }
        >
          {user?.email ?? "—"}
        </SettingRow>

        {/* Read-only: there is no account-linking flow. auth_provider is set once,
            at signup, and cannot be changed from the app. */}
        <SettingRow label="Connected account">
          <span className="sm-provider">
            {provider.icon}
            {provider.label}
          </span>
        </SettingRow>

        <SettingRow
          label="Profile & résumé"
          action={
            <button type="button" className="sm-link" onClick={() => goTo("/app/profile")}>
              Edit on Profile <ArrowRight size={13} weight="bold" />
            </button>
          }
        >
          <span className="sm-muted">
            Name, contact details, address, EEO answers and saved screening answers.
          </span>
        </SettingRow>
      </div>
    );
  }

  function renderExtension() {
    if (!formData) return null;
    return (
      <div className="sm-rows" data-tour="extension-settings">
        <SettingRow
          label="Status"
          action={
            extState === "not-installed" ? (
              <a className="sm-cta" href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer">
                Add to Chrome
              </a>
            ) : extState === "installed" ? (
              <button type="button" className="sm-link" onClick={() => goTo("/extension/connect")}>
                Finish setup <ArrowRight size={13} weight="bold" />
              </button>
            ) : null
          }
        >
          {extState === "unknown" ? "Checking…" : EXT_STATUS[extState]}
        </SettingRow>

        <SettingRow
          label="Pause before submit"
          action={
            <ToggleSwitch
              label="Pause before submit"
              checked={formData.pause_before_submit}
              onChange={(v) => updateField("pause_before_submit", v)}
            />
          }
        >
          <span className="sm-muted">Review each application before it is submitted.</span>
        </SettingRow>

        <SettingRow
          label="Smooth scrolling"
          action={
            <ToggleSwitch
              label="Smooth scrolling"
              checked={formData.smooth_scrolling}
              onChange={(v) => updateField("smooth_scrolling", v)}
            />
          }
        >
          <span className="sm-muted">Scroll smoothly while moving through a form.</span>
        </SettingRow>

        <SettingRow
          label="Follow companies"
          action={
            <ToggleSwitch
              label="Follow companies"
              checked={formData.follow_companies}
              onChange={(v) => updateField("follow_companies", v)}
            />
          }
        >
          <span className="sm-muted">Follow a company automatically when you apply.</span>
        </SettingRow>

        <SettingRow
          label="Product tour"
          action={
            <button
              type="button"
              className="sm-link"
              onClick={() => {
                void restartTour();
                goTo("/app");
              }}
            >
              Restart tour <ArrowRight size={13} weight="bold" />
            </button>
          }
        >
          <span className="sm-muted">Replay the guided walkthrough from the beginning.</span>
        </SettingRow>
      </div>
    );
  }

  function renderSecurity() {
    return (
      <div className="sm-rows">
        <SettingRow label="Devices">
          <span className="sm-muted">
            Browsers and the Tailrd extension currently signed in to your account.
          </span>
        </SettingRow>

        {sessionsLoading ? (
          <SettingRow label="">
            <span className="sm-muted">Loading…</span>
          </SettingRow>
        ) : sessions.length === 0 ? (
          <SettingRow label="">
            <span className="sm-muted">No active sessions.</span>
          </SettingRow>
        ) : (
          sessions.map((s) => (
            <SettingRow
              key={s.sid}
              label={s.client === "extension" ? "Chrome extension" : "Web"}
              action={
                <button
                  type="button"
                  className="device-revoke"
                  onClick={() => void revokeSession(s.sid)}
                  disabled={s.is_current}
                >
                  Revoke
                </button>
              }
            >
              <span className="sm-muted">
                Connected {new Date(s.created_at).toLocaleDateString()} · Last seen{" "}
                {new Date(s.last_seen_at).toLocaleString()}
                {s.last_ip ? ` · ${s.last_ip}` : ""}
                {s.is_current ? " · This device" : ""}
              </span>
            </SettingRow>
          ))
        )}

        <div className="sm-rows-footer">
          <button type="button" className="device-revoke-all" onClick={() => void signOutEverywhere()}>
            Sign out of all devices (except this one)
          </button>
        </div>
      </div>
    );
  }

  function renderTab() {
    if (loading) return <div className="settings-loading">Loading settings…</div>;
    if (error) return <div className="settings-error">{error}</div>;
    switch (activeTab) {
      case "account":
        return renderAccount();
      case "extension":
        return renderExtension();
      case "security":
        return renderSecurity();
    }
  }

  const activeMeta = TABS.find((t) => t.key === activeTab);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <aside className="sm-nav">
          <div className="sm-nav-top">
            <div className="sm-nav-header">
              <h2 className="sm-nav-title">Account</h2>
              <p className="sm-nav-sub">Manage your account info.</p>
            </div>
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`sm-nav-item${activeTab === tab.key ? " active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="sm-nav-icon">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div className="sm-nav-bottom">
            <button type="button" className="sm-nav-item" onClick={() => goTo("/privacy")}>
              <span className="sm-nav-icon">
                <ShieldStar size={18} weight="duotone" />
              </span>
              <span>Privacy Policy</span>
            </button>
            <button type="button" className="sm-nav-item sm-nav-danger" onClick={logout}>
              <span className="sm-nav-icon">
                <SignOut size={18} weight="duotone" />
              </span>
              <span>Log Out</span>
            </button>
          </div>
        </aside>

        <div className="sm-panel">
          <header className="sm-panel-header">
            <h2>{activeMeta?.title ?? "Settings"}</h2>
            <button type="button" className="sm-close" onClick={onClose} aria-label="Close settings">
              <X size={20} weight="bold" />
            </button>
          </header>

          <div className="sm-panel-body">{renderTab()}</div>

          {activeTab === "extension" && !loading && !error && (
            <div className="sm-save-bar">
              <button
                type="button"
                className="settings-save-btn"
                disabled={saving || !isDirty}
                onClick={saveSettings}
              >
                {saving ? "Saving…" : "Save Changes"}
                {isDirty && !saving && <span className="dirty-dot" />}
              </button>
            </div>
          )}
        </div>

        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite the stylesheet**

Replace the **entire contents** of `frontend/src/settings-modal.css`:

```css
/* ─── Settings Modal ─────────────────────────────────────────────────────────
   Left nav + right panel of label/value/action rows separated by hairlines.
   Every row is a .sm-row; there are no bespoke per-tab layouts. */

/* .modal-overlay (index.css) centres this with no padding and does not scroll,
   so the modal has to fit the viewport itself — hence the calc() caps rather
   than 94vw/90vh. dvh, not vh: on mobile `100vh` is measured against the
   *expanded* viewport, so a 90vh modal is taller than the screen while the URL
   bar is showing, which is exactly how the Save button ends up under the fold.
   The body (.sm-panel-body) scrolls; the header and save bar stay put. */
.settings-modal {
  position: relative;
  display: flex;
  width: min(960px, calc(100vw - 32px));
  height: min(660px, calc(100vh - 32px));
  height: min(660px, calc(100dvh - 32px));
  background: var(--bg-white);
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  animation: slideUp 0.2s ease;
}

/* ── Left navigation column ── */
.sm-nav {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 244px;
  flex-shrink: 0;
  background: var(--bg-page);
  border-right: 1px solid var(--border);
  padding: 1.5rem 0.75rem 1.25rem;
}

.sm-nav-top,
.sm-nav-bottom {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.sm-nav-header {
  padding: 0 0.75rem;
  margin-bottom: 1.1rem;
}

.sm-nav-title {
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
}

.sm-nav-sub {
  margin-top: 0.15rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.sm-nav-bottom {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}

.sm-nav-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.55rem 0.75rem;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.sm-nav-item:hover {
  background: rgba(13, 37, 61, 0.05);
  color: var(--text);
}

/* The reference uses a neutral pill for the selected item, not a brand fill. */
.sm-nav-item.active {
  background: rgba(13, 37, 61, 0.07);
  color: var(--text);
  font-weight: 600;
}

.sm-nav-icon {
  display: inline-flex;
  align-items: center;
  color: currentColor;
}

.sm-nav-danger {
  color: var(--stripe-ruby);
}

.sm-nav-danger:hover {
  background: rgba(234, 34, 97, 0.08);
  color: var(--stripe-ruby);
}

/* ── Right panel ──
   min-height: 0 is load-bearing. Below 768px .settings-modal is a *column* flex
   container, so .sm-panel is a column flex item with the default
   min-height: auto — it refuses to shrink below its content, grows taller than
   the modal, and pushes .sm-save-bar out through the modal's overflow:hidden.
   That is how "Save Changes" ends up under the fold on a phone. */
.sm-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.sm-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.35rem 1.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.sm-panel-header h2 {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
  min-width: 0;
  overflow-wrap: anywhere;
}

.sm-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.sm-close:hover {
  background: var(--bg-page);
  color: var(--text);
}

.sm-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 1.75rem 1.5rem;
}

/* ── The row primitive ── */
.sm-rows {
  display: flex;
  flex-direction: column;
}

.sm-row {
  display: grid;
  grid-template-columns: 168px 1fr auto;
  align-items: center;
  gap: 1rem;
  padding: 1.05rem 0;
  border-bottom: 1px solid var(--border-light);
}

.sm-row:last-child {
  border-bottom: none;
}

.sm-row-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-muted);
}

.sm-row-value {
  min-width: 0;
  font-size: 0.875rem;
  color: var(--text);
  overflow-wrap: anywhere;
}

.sm-row-action {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
}

.sm-muted {
  color: var(--text-muted);
}

/* ── Row value ornaments ── */
.sm-identity {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
}

.sm-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--accent-light);
  color: var(--accent);
  font-size: 0.8125rem;
  font-weight: 700;
}

.sm-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sm-identity-name {
  font-weight: 600;
}

.sm-provider {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.sm-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.6rem;
  border-radius: var(--radius-pill);
  font-size: 0.75rem;
  font-weight: 600;
}

.sm-pill-ok {
  background: rgba(16, 133, 85, 0.1);
  color: #0f7a4d;
}

.sm-pill-warn {
  background: rgba(234, 34, 97, 0.1);
  color: var(--stripe-ruby);
}

/* ── Row actions ── */
.sm-link {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.15rem;
  border: none;
  background: transparent;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s;
}

.sm-link:hover {
  color: var(--accent);
}

.sm-cta {
  display: inline-flex;
  align-items: center;
  padding: 0.4rem 0.85rem;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: #fff;
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  transition: background 0.15s;
}

.sm-cta:hover {
  background: var(--accent-hover);
}

.sm-rows-footer {
  padding-top: 1.25rem;
}

/* ── Sticky save bar ── */
.sm-save-bar {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  padding: 0.9rem 1.75rem;
  border-top: 1px solid var(--border);
  background: var(--bg-white);
}

/* ── Responsive: collapse to stacked layout (768 is the house breakpoint) ── */
@media (max-width: 768px) {
  .settings-modal {
    flex-direction: column;
    width: calc(100vw - 24px);
    height: calc(100vh - 24px);
    height: calc(100dvh - 24px);
  }
  .sm-nav {
    width: 100%;
    flex-direction: row;
    justify-content: space-between;
    flex-shrink: 0;
    overflow-x: auto;
    padding: 0.6rem;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  /* The title block only makes sense beside a vertical nav. */
  .sm-nav-header {
    display: none;
  }
  .sm-nav-top,
  .sm-nav-bottom {
    flex-direction: row;
  }
  .sm-nav-bottom {
    border-top: none;
    padding-top: 0;
  }
  .sm-nav-item span:not(.sm-nav-icon) {
    display: none;
  }
  .sm-nav-item {
    padding: 0.55rem;
  }
  .sm-panel-header {
    padding: 1rem 1rem 0.75rem;
  }
  .sm-panel-body {
    padding: 0.25rem 1rem 1.1rem;
  }
  .sm-save-bar {
    padding: 0.75rem 1rem;
  }
  .sm-save-bar .settings-save-btn {
    width: 100%;
  }
}

/* Phone: the 3-column row cannot hold. Stack label over value, action right. */
@media (max-width: 640px) {
  .sm-row {
    grid-template-columns: 1fr auto;
    align-items: start;
    gap: 0.5rem 1rem;
    padding: 0.9rem 0;
  }
  .sm-row-label {
    grid-column: 1;
    grid-row: 1;
  }
  .sm-row-value {
    grid-column: 1;
    grid-row: 2;
  }
  .sm-row-action {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-items: center;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `frontend/`): `npm test -- SettingsModal`
Expected: PASS — 6 passed.

- [ ] **Step 6: Typecheck**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git reflog -3
git add frontend/src/components/SettingsModal.tsx frontend/src/settings-modal.css frontend/src/components/SettingsModal.test.tsx frontend/src/test-setup.ts
git commit -m "feat(settings): 3-tab account panel; drop profile/job-prefs/autofill duplicates"
```

---

## Task 5: Delete the duplicate settings page and re-run the audits

**Files:**
- Delete: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/main.tsx:21` (import) and `:69` (route)
- Modify: `scripts/responsive-audit/states.cjs:233` (drop `app-settings-page`) and `:153` (add a banner state)

**Interfaces:**
- Consumes: the working modal from Task 4 and the banner from Task 2.
- Produces: nothing importable. This task removes a route and proves the whole change renders.

- [ ] **Step 1: Delete the page**

```bash
git rm frontend/src/pages/Settings.tsx
```

It is a 697-line duplicate of the same form, routed at `/app/settings`, that nothing in the UI links to — the sidebar's Settings button opens `SettingsModal`. Leaving it would mean the three tabs we just removed are still reachable by URL.

`frontend/src/settings.css` stays: `SettingsModal.tsx` still imports it for `.toggle-switch`, `.settings-save-btn`, `.dirty-dot`, `.device-*` and `.toast-*`.

- [ ] **Step 2: Drop the route**

In `frontend/src/main.tsx`, remove line 21:

```tsx
import Settings from "./pages/Settings";
```

and remove line 69 from the `/app` route block:

```tsx
            <Route path="settings" element={<Settings />} />
```

- [ ] **Step 3: Verify nothing else referenced it**

Run (from the repo root): `grep -rn "pages/Settings\|/app/settings" frontend/src scripts --include=*.tsx --include=*.ts --include=*.cjs`
Expected: exactly one remaining hit — `scripts/responsive-audit/states.cjs:233` — which the next step removes. If anything else appears, fix it before continuing.

- [ ] **Step 4: Update the responsive-audit states**

In `scripts/responsive-audit/states.cjs`, delete this line (currently 233):

```js
  { id: "app-settings-page", url: "/app/settings", ...AUTHED, wait: "main" },
```

Then add a banner state directly after the `app-settings-modal` entry (which ends at line 153). The `?extState=not-installed` param is the dev-only override from Task 2 — the audit runs against a dev build, where the real ping cannot reach the extension:

```js
  {
    id: "app-extension-banner",
    url: "/app?extState=not-installed",
    ...AUTHED,
    wait: ".ext-banner",
  },
```

- [ ] **Step 5: Run the full frontend suite**

Run (from `frontend/`): `npm test`

Expected: no **new** failures. Three suites already fail on clean `main` and are unrelated to this
work — `JobDetailView`, `job-detail-inline-panel`, and `resume.property`. Confirm they are the only
red ones by stashing and re-running if unsure. **Do not "fix" them here** — that is a separate
change, and folding it in would make this diff impossible to review.

- [ ] **Step 6: Build**

Run (from `frontend/`): `npm run build`
Expected: `tsc && vite build` completes with no errors. This is the real proof the deleted import is gone.

- [ ] **Step 7: Run the responsive audit on the changed screens**

Run (from the repo root):

```bash
node scripts/responsive-audit/audit.cjs --state app-settings-modal
node scripts/responsive-audit/audit.cjs --state app-extension-banner
```

Expected: 0 high, 0 medium for both. If the audit reports overflow or clipping, fix the CSS — do not lower the bar.

- [ ] **Step 8: Drive it in a browser**

Start the dev server (`npm run dev` from `frontend/`), sign in, and confirm by eye:
1. `/app` shows the purple banner; "Add to Chrome" opens `CHROME_STORE_URL` in a new tab.
2. `/app?extState=connected` shows **no** banner.
3. `/app?extState=installed` shows the "Finish setup" variant.
4. The banner's `×` hides it, and it stays hidden after a reload.
5. Settings (sidebar) opens a three-tab modal; Account shows your email + provider; Extension toggles save; Security lists devices.
6. `/app/settings` no longer resolves to the old form.

- [ ] **Step 9: Commit**

```bash
git reflog -3
git add frontend/src/main.tsx scripts/responsive-audit/states.cjs
git add -u frontend/src/pages/Settings.tsx
git commit -m "refactor(settings): delete the unlinked duplicate settings page and its route"
```

---

## Self-Review Notes

**Spec coverage.** Every spec section maps to a task: detection + store URL → Task 1; banner, art, snooze, dev override, App mount → Task 2; `auth_provider` → Task 3; the three tabs, the `SettingRow` primitive, read-only Connected account, save-bar scoping → Task 4; page deletion, route, audit states, verification → Task 5.

**Type consistency.** `ExtensionState` is defined once in Task 1 and consumed by name in Tasks 2 and 4. `pingExtension(timeoutMs?)` has one signature everywhere. `ExtensionSettings` and `SETTINGS_KEYS` (Task 4) are the only shape `PUT /settings` is given, which is exactly what the "saves ONLY the extension toggles" test pins. `SettingsModal`'s props are unchanged, so `App.tsx` needs no edit in Task 4.

**Known risk, called out rather than hidden.** The `sm-pill-ok` green (`#0f7a4d`) is not an existing theme token — `index.css` has no success colour. It is introduced here deliberately for the Verified pill; if a success token is added later, swap it.
