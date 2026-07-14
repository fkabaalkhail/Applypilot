# Settings redesign + extension install banner

**Date:** 2026-07-14
**Status:** Approved, ready for implementation plan

## Problem

Two unrelated-but-adjacent gaps:

1. **The settings modal duplicates the Profile page.** `SettingsModal.tsx` has five tabs —
   Profile & Contact, Job Preferences, Autofill & Answers, Extension, Login & Security. The
   first three edit the same rows that `/app/profile` already owns, so the same field has two
   editors and users don't know which one wins. Visually it's also a stack of form grids, which
   is dated next to the rest of the app.

2. **Nothing tells a signed-in user the extension exists.** The Chrome Web Store listing is
   pending approval. There is no install prompt anywhere in the web app, and no Web Store URL
   in the frontend at all.

## Goals

- Remove the Profile / Job Preferences / Autofill Answers tabs from the settings modal without
  losing any data or breaking the extension's reads.
- Restyle settings to the Clerk-style account panel in the reference: left nav with a titled
  header, right panel of `label · value · action` rows separated by hairlines.
- Show a themed banner to signed-in users prompting them to install the extension, linking to a
  placeholder Web Store URL that can be swapped for the real one with no code change.

## Non-goals

- Account linking ("+ Connect account" in the reference). No such flow exists — `auth_provider`
  is a single string set at signup. The Connected-account row is **read-only**.
- A Billing tab. There is no billing backend (`PricingTiers.tsx` is a marketing page).
- Any change to the extension itself. Everything needed already ships in it.
- Any database migration.

---

## Key discovery: the extension is already detectable

`chrome-extension/src/background/serviceWorker.ts:184` registers
`chrome.runtime.onMessageExternal`, and it already handles a `TAILRD_PING` message whose own
comment reads *"Lets the web app detect the extension is installed + its auth state."* It replies
`{ ok: true, connected: boolean }`.

`chrome-extension/manifest.json:46` declares `externally_connectable.matches` for
`https://www.tailrd.ca/*` and `https://tailrd.ca/*`, and `frontend/src/lib/extensionBridge.ts`
already resolves the extension IDs and calls `chrome.runtime.sendMessage`.

So install detection needs **no backend endpoint and no extension change** — only a new function
in the existing bridge. It yields three states, which is strictly better than the session-list
signal (`GET /auth/sessions` where `client === "extension"`), because a session row survives an
uninstall and would falsely suppress the banner.

| Ping outcome | State | Banner |
| --- | --- | --- |
| no `chrome.runtime`, `lastError`, or timeout | `not-installed` | "Add to Chrome" → Web Store |
| `{ ok: true, connected: false }` | `installed` | "Finish setup" → `/extension/connect` |
| `{ ok: true, connected: true }` | `connected` | not rendered |

---

## Part A — Settings modal

### Component structure

`SettingsModal.tsx` keeps its shell (overlay, left nav, right panel, Escape-to-close, toast
container) and replaces its body.

**Nav** — header "Account" / "Manage your account info.", then three items: Account, Extension,
Security. The existing bottom group (Privacy Policy, Log Out) stays.

**The row primitive** is the whole redesign. One new sub-component replaces the mix of
`.settings-form-grid` and bare `.toggle-row`:

```tsx
<SettingRow label="Email address" action={<VerifiedPill verified={...} />}>
  you@school.edu
</SettingRow>
```

It renders a three-column grid — muted label (fixed width), value (flex), right-aligned action —
with a `border-bottom` hairline. Every row in every tab is one of these, which is what produces
the reference's calm, uniform rhythm. `ToggleSwitch` becomes a *value* passed to a `SettingRow`
rather than its own layout.

### Tabs

**Account** (read-only; it is a directory, not an editor)

| Row | Value | Action |
| --- | --- | --- |
| Profile | avatar + full name | `Update profile →` (→ `/app/profile`, closes modal) |
| Email address | `user.email` | Verified / Unverified pill |
| Connected account | Google / LinkedIn mark + label, or "Email & password" when `auth_provider === "local"` | — |
| Profile & résumé | "Name, contact, address, EEO and screening answers" | `Edit on Profile →` |

The last row exists so nobody hunts for the fields that moved.

**Extension**

| Row | Value | Action |
| --- | --- | --- |
| Status | `pingExtension()` → "Installed and connected" / "Installed — not signed in" / "Not installed" | `Add to Chrome` (not installed), `Finish setup` (installed), none (connected) |
| Pause before submit | toggle | — |
| Smooth scrolling | toggle | — |
| Follow companies | toggle | — |
| Product tour | "Replay the guided walkthrough." | `Restart tour` |

This is the only tab with editable state, so it is the only tab that renders the save bar.

**Security** — the existing device list and "sign out of all devices", restyled into `SettingRow`s.

### Data: nothing is lost

The removed editors wrote `first_name`, `last_name`, `email`, `phone`, `linkedin_url`, `website`,
`job_title`, `location`, `remote_only`, and `prefilled_answers`. All of these:

- remain columns on `user_settings` (`backend/db/models.py:350-379`),
- remain readable by the extension (`backend/routers/extension.py:174-175`),
- remain writable from `/app/profile`, which already maps `currentTitle → job_title`
  (`backend/routers/profile.py:392`) and writes screening answers into `prefilled_answers`
  (`backend/routers/profile.py:421-430`).

`PUT /settings` keeps accepting all of them. Only the modal stops sending them: `SETTINGS_KEYS`
shrinks to the three extension toggles, and `computeDiff` / `entriesToDict` / `dictToEntries` /
`KeyValueEditor` / the résumé upload are deleted from the modal.

The résumé upload in the old "Autofill & Answers" tab is redundant with `/app/resume`; the
Account tab's pointer row covers the discovery gap.

### Files

| File | Change |
| --- | --- |
| `frontend/src/components/SettingsModal.tsx` | Rewrite body: 5 tabs → 3, `SettingRow` primitive |
| `frontend/src/settings-modal.css` | Restyle to the row/hairline aesthetic |
| `frontend/src/pages/Settings.tsx` | **Delete** — 697-line unlinked duplicate of the same form |
| `frontend/src/main.tsx` | Remove the `/app/settings` route + import |
| `backend/routers/auth.py` | Add `"auth_provider": user.auth_provider` to `get_me` (line ~526) |
| `frontend/src/auth/AuthContext.tsx` | Add `auth_provider?: string` to `UserProfile` (line 3) |
| `scripts/responsive-audit/states.cjs` | Remove the `app-settings-page` state (page is gone) |

**Existing tests are unaffected by the deletion.** `frontend/src/__tests__/settings.property.test.tsx`
is a stub (`expect(1).toBe(1)`) that imports nothing, and
`frontend/src/__tests__/settings-profile.test.ts` covers `computeProfileDiff` from
`lib/profileExtras` — the *Profile page's* helper, not the modal's. Neither touches
`pages/Settings.tsx` or `SettingsModal.tsx`.

`GET /auth/me` currently omits `auth_provider` even though the column exists
(`backend/db/models.py:32`, values `local` / `google` / `linkedin`). Adding it is one line and
needs no migration.

---

## Part B — Extension banner

### Detection

New in `frontend/src/lib/extensionBridge.ts`:

```ts
export type ExtensionState = "unknown" | "not-installed" | "installed" | "connected";
export function pingExtension(timeoutMs = 400): Promise<ExtensionState>;
```

It sends `{ type: "TAILRD_PING" }` to every id in the existing `EXTENSION_IDS` list, resolves on
the first `{ ok: true }` reply (`connected` → `"connected"`, else `"installed"`), and resolves
`"not-installed"` when every send errors, no reply arrives, or `chrome.runtime` is absent
(non-Chromium browsers). It reads `runtime.lastError` in each callback to suppress Chrome's
"Unchecked runtime.lastError" console noise — the same trick `notifyApplyIntent` already uses.

The promise never rejects. A hung ping resolves `"not-installed"` at `timeoutMs`.

### Store URL

New `frontend/src/lib/extensionStore.ts`:

```ts
/** TODO: replace with the real listing URL once the extension clears review. */
export const CHROME_STORE_URL =
  (import.meta.env.VITE_CHROME_STORE_URL as string | undefined) ??
  "https://chromewebstore.google.com/detail/tailrd/PLACEHOLDER_STORE_ID";
```

Env-overridable so the real URL can be set in Vercel without a code change; the literal is there
as the one line to edit if that is preferred.

### Component

New `frontend/src/components/ExtensionBanner.tsx` + `extension-banner.css`, rendered in
`App.tsx` inside `<main className="main-content">`, above `<Outlet />` — so it appears on every
`/app` page and scrolls with content rather than pinning over it.

Renders `null` when state is `unknown` (first paint, avoids a flash), `connected`, or snoozed.

```
╔═══════════════════════════════════════════════════════════════════╗
║  NEW · CHROME EXTENSION                                        ×  ║
║  Autofill any job application in one click              ◜  ▣  ◝   ║
║  ( Add to Chrome — it's free )                            ◟  ◞    ║
╚═══════════════════════════════════════════════════════════════════╝
```

- Container: `border-radius: 14px`, `linear-gradient(110deg, #665efd 0%, #533afd 55%, #4434d4 100%)`
  (the `--stripe-cta-gradient` family already in `index.css`).
- Eyebrow: 11px / 600 / `letter-spacing: .08em` / uppercase, white at 72%.
- Headline: 18px / 700, white.
- CTA: white pill, `--stripe-primary` text, `border-radius: var(--radius-pill)`.
  `target="_blank" rel="noopener noreferrer"`.
- Art: concentric translucent rings + the Tailrd logo mark, CSS/SVG only, bleeding off the right
  edge, `pointer-events: none`, `aria-hidden`, hidden below 640px.
- Close: `×` top-right, white at 60%, `aria-label="Dismiss"`.
- Honours `prefers-reduced-motion` (no entrance transition when set).

The `installed` variant swaps copy to "Finish setting up Tailrd" / "Sign in to the extension" and
points the CTA at `/extension/connect` instead of the store. Same shell.

### Dismissal

`localStorage["tailrd.extBanner.snoozedUntil"]` = epoch ms. `×` sets `now + 7 days`. State
`connected` removes the key entirely, so a user who installs and later uninstalls gets a clean
prompt rather than a stale snooze.

### The localhost caveat, and how it is handled

`externally_connectable.matches` covers only `https://(www.)tailrd.ca/*`. On `localhost` the ping
therefore always fails and the banner always renders `not-installed`. Widening the manifest to
include localhost would expand the extension's real attack surface for a dev convenience, so we
do not.

Instead, `ExtensionBanner` accepts a `?extState=not-installed|installed|connected` query-param
override, read **only** under `import.meta.env.DEV`. Vite statically replaces `import.meta.env.DEV`
with `false` in production, so the branch is dead-code-eliminated from the prod bundle. This makes
all three states drivable locally without touching the extension or shipping a debug hook.

---

## Testing

Component tests in this repo sit **beside** the component (`components/PricingTiers.test.tsx`,
`components/CustomResumeModal.test.tsx`); there is no `components/__tests__/`. New tests follow
that convention.

**New — `frontend/src/components/ExtensionBanner.test.tsx`**
- `not-installed` → renders, CTA `href === CHROME_STORE_URL`, opens in a new tab.
- `installed` → renders the finish-setup variant, CTA points at `/extension/connect`.
- `connected` → renders nothing.
- `unknown` (ping pending) → renders nothing (no flash).
- `×` → hides it and writes `snoozedUntil`; a future `snoozedUntil` suppresses it on mount.
- `connected` clears an existing `snoozedUntil`.

**New — `frontend/src/lib/extensionBridge.test.ts`**
- `pingExtension` → `not-installed` when `chrome.runtime` is absent.
- → `not-installed` on `lastError`.
- → `not-installed` on timeout (fake timers; assert it never rejects).
- → `connected` / `installed` on the respective replies.

**New — `frontend/src/components/SettingsModal.test.tsx`**
- Exactly three nav items: Account, Extension, Security.
- No "Job Preferences" / "Autofill" / "Pre-filled Answers" text; no `#first_name` / `#job_title`
  / `#linkedin_url` inputs anywhere in the modal.
- Toggling an extension switch enables Save; saving `PUT /settings` sends **only** the three
  toggle keys (guards against re-introducing the profile-field writes).
- The Account tab's "Update profile" navigates to `/app/profile`.

**Backend** — there is no dedicated `/auth/me` test file today (the auth suites are
`test_auth_properties.py`, `test_extension_auth.py`, `test_linkedin_auth.py`). Add a case to
`backend/tests/test_auth_properties.py` asserting `GET /auth/me` returns `auth_provider`, so the
field the Account tab renders cannot silently disappear.

**Responsive** — `scripts/responsive-audit`. Keep `app-settings-modal` green, delete
`app-settings-page`, add a state that captures the banner on `/app`. Per project practice the
audit must run clean (0 high / 0 medium) before this is called done.

## Risks

| Risk | Mitigation |
| --- | --- |
| Deleting `pages/Settings.tsx` breaks a link | Confirmed unlinked: nothing in the UI routes to `/app/settings`; the sidebar opens the modal. `states.cjs` is the only other referent and is updated in the same change. |
| A user's muscle memory looks for contact fields in Settings | The Account tab's "Profile & résumé" pointer row links straight to `/app/profile`. |
| The real Web Store URL is unknown | `CHROME_STORE_URL` is a single env-overridable constant. |
| The banner cannot be verified against a real extension locally | `?extState=` dev-only override drives all three states; the real ping is verified in prod after deploy. |
| Concurrent sessions share this working tree | Commit by explicit path; check `git reflog` before any commit or push. |
