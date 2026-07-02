# Autofill v2: Multi-page flows, form scoping, option-aware dropdowns

**Date:** 2026-07-02
**Status:** Approved (pending user review of this document)
**Areas:** `chrome-extension/src/content/*`, no backend changes

## Problem

Three field-reported gaps in the current autofill:

1. **Multi-page applications need one click per page.** One Autofill click fills only
   the current step. The MutationObserver already rescans after SPA step changes
   (`formScanner.ts` `observePage`), but nothing re-triggers the fill, nothing clicks
   Next, and a real navigation resets all content-script state. Account-creation
   walls (Workday) block the flow entirely because password inputs are skipped by
   design (`SKIPPED_INPUT_TYPES` in `formScanner.ts`).
2. **Out-of-form controls are detected.** `scanPage` sweeps the whole document with
   no "is this inside the application form?" scoping, and the overlay lists any
   fillable control even with category `unknown` (`overlay.ts` ~line 1332). A page
   language switcher (EN/FR) in the header is a real select/combobox, so it shows up
   in the panel — and an empty one becomes an AI-fill candidate (`isAiCandidate`
   returns true for every select/combobox).
3. **AI answers don't match custom-dropdown options.** Native `<select>`s send their
   options to the backend, which snaps answers to option text (`_match_option` in
   `backend/routers/fill.py`). But custom dropdowns that mount their listbox lazily
   (react-select, Workday) return nothing from `readComboboxOptions`, so the AI
   answers unconstrained ("Canada") and fill-time `matchOption` cannot map that to
   the real option ("Canadian") — every tier (exact/prefix/substring/token) misses.

## Decisions (made with user)

- **Auto-advance, stop at Submit.** One click fills a step, clicks Next itself,
  repeats. Pauses for human-only work. Never clicks the final Submit.
- **Signup walls: generate & save locally.** Generate a strong password, fill it,
  store credentials in `chrome.storage.local` on the device. Never synced, never
  sent to the Tailrd backend.
- Out-of-scope controls are **excluded** from the panel and from AI candidates (not
  merely deselected).
- Dropdown options are learned **at fill time** (no scan-time pre-opening), with at
  most one extra batched AI call per fill pass.

## Feature 1 — Multi-page flow controller

New module `content/flowController.ts`, a state machine run by the frame that owns
the form (iframe-hosted forms use the existing FORM_OP / RELAY_TO_TOP machinery; a
new relayed `FLOW_PROGRESS` message keeps the top-frame panel updated).

States: `filling → advancing → filling → … → done | paused | stopped`.

**One button, no modes.** The panel's existing Autofill button starts a flow. A
single-page form is a flow that finishes in one step; behavior there is unchanged.

### Per-step loop

1. Run the existing fill passes exactly as today (local fast-path → backend →
   fallback, through `fillItems`; reconciler settle included). Step 1 uses the
   panel's selected ids; later steps use `defaultSelectedIds(fields)` plus the
   AI-candidate pass, recomputed after each rescan.
2. **Pause checks, in order:**
   - Captcha visible (existing `isCaptchaField` detection) → pause.
   - AI drafts pending review → pause. Auto-advancing past unreviewed AI answers
     would break the review-first contract. The flow auto-resumes when the draft
     queue empties (accept, edit, and skip all count as resolution).
   - Required résumé/file field still empty → auto-attach the résumé chosen in
     the panel's résumé picker (falling back to the account's most recent résumé)
     via the existing `injectResumeFile` path; pause only when the user has no
     résumé at all.
   - Visible validation errors (`[aria-invalid="true"]`, populated `role="alert"`
     inside the form scope) → pause.
3. **Find the advance button**, searched only inside the form scope (Feature 3):
   a visible, enabled `button` / `input[type=submit]` / `[role=button]` whose
   accessible text matches the advance list. A new optional
   `SiteAdapter.advanceButton?(scope: HTMLElement): HTMLElement | null` lets
   adapters supply exact selectors (Workday:
   `[data-automation-id="bottom-navigation-next-button"]`).
   - **Advance patterns (EN + FR):** next, continue, save and continue,
     save & continue, proceed, review, next step; suivant, continuer, poursuivre,
     réviser. When the account sub-flow (Feature 2) detects a wall, the list
     extends with wall verbs: create account, sign up, register, sign in, log in;
     créer un compte, s'inscrire, se connecter.
   - **Terminal patterns (never clicked):** submit, send application, apply now,
     finish, complete application; soumettre, envoyer, postuler, terminer.
     Finding a terminal button ends the flow as `done` — "Filled N steps — review
     and submit."
   - No advance button and no terminal button: `done` (assume last/only page).
4. **Click and settle.**
   - SPA step change: the existing observer rescan produces a new field set; the
     loop continues.
   - Real navigation: the content script dies. Flow state persists (below) and the
     fresh script resumes.

### Flow state & resume

- State `{ active, step, startedAt, lastSignature }` lives in
  `chrome.storage.session`, keyed by tab id, owned by the **background** service
  worker via two new messages `FLOW_STATE_GET` / `FLOW_STATE_SET` (background reads
  the tab id from `sender`, so content scripts never need session-storage access
  levels). Background clears state on `chrome.tabs.onRemoved`.
- On content-script init, an active flow resumes once the profile is resolved and
  at least one recognized field is scanned (the late-mount watcher already covers
  slow pages), bounded by the TTL.

### Guards

- Max 12 steps; 10-minute TTL from `startedAt`.
- Loop detector: `lastSignature` is a hash of the scanned field set (sorted
  category+label+controlType). If the signature is unchanged after an advance
  click: pause when new validation errors are visible (the click was rejected —
  the user can fix and resume); otherwise stop: "couldn't advance past this page."
- Advance is only ever clicked when the current step scanned ≥1 recognized field.
- A **Stop** button is always visible in the panel during a flow and clears state.

### Panel UX

Progress line in the existing results area: "Step 2 · filling…", "Paused — 3
answers to review", "Paused — attach your résumé", "Done — 4 steps filled, ready
to submit", with the per-step ok/fail tallies folded into the existing banner.

## Feature 2 — Account-creation sub-flow

New module `content/accountFlow.ts`.

- **Detection.** Signup wall: ≥1 password input plus an email/username field, with
  create-account/sign-up (or FR: créer un compte, s'inscrire) text nearby. Login
  wall: password + sign-in (se connecter) variant.
- **Scanner change.** `password` leaves `SKIPPED_INPUT_TYPES`; password inputs get
  controlType `password`, category `accountPassword`: never AI-eligible, never sent
  to the backend, never listed in the general panel field list. Only the
  account-flow module writes them.
- **Signup:** generate a 20-char password via `crypto.getRandomValues` with
  upper/lower/digit/symbol guaranteed; fill password + confirm (all password inputs
  in the wall container); store `{ [origin]: { email, password, createdAt } }` in
  `chrome.storage.local` (device-only; last write wins). Chrome's own password
  manager will typically also offer to save on submit. Then continue the flow.
- **Login wall with stored creds for the origin:** fill email + password, advance.
- **No stored creds, email-verification codes, or 2FA:** pause — human-only.
- **Panel:** a "Saved sign-ins" section (origin, email, password with reveal/copy,
  delete). No new manifest permissions (storage is already granted).

Security posture: credentials never leave the device, are never synced, and are
never transmitted to the Tailrd backend.

## Feature 3 — Form scoping

Two layers in `scanPage`, plus new `content/formScope.ts`.

1. **Chrome exclusion (candidate filter).** Drop any candidate with a composed-tree
   ancestor of tag `header/nav/footer/aside` or role
   `navigation/banner/contentinfo/search/complementary`. Requires a new
   composed-ancestor helper in `domUtils.ts` that crosses shadow-root boundaries
   upward (existing walks use plain `parentElement`). This alone removes header
   language switchers.
2. **Container scoping (post-classification).** Scope candidates: every `<form>`
   containing ≥1 recognized field, `main` / `[role=main]`, and the lowest common
   ancestor of all recognized fields. Choose the **deepest candidate containing
   ≥80% of recognized fields**; drop all fields outside it (any category — a
   footer newsletter email is noise even though `email` is a known category).
   **Safe fallback:** if no candidate qualifies, keep the unscoped result — a
   failed scope never makes detection worse than today.

The chosen scope container is exposed on `ScanResult` and bounds the
advance-button search (Feature 1), so the flow can never click a nav link.
`MIN_FIELDS_FOR_OVERLAY` and all downstream consumers see only scoped fields.

## Feature 4 — Option-aware dropdowns

- **Harvest on miss.** `fillAriaCombobox` already opens the real listbox. When
  `findOption` misses, harvest the visible option labels (existing `optionText`
  path, cap 60) and return them: `{ filled: false, reason, options?: string[] }`.
- **One batched re-ask per fill pass.** `fillItems`/`onAutofill` collect all choice
  -control failures that produced harvested options and make **one** extra
  `AI_FILL` call with the real options attached (`AiFillField.type: "select"`).
  The backend already snaps answers to provided options — no backend change. The
  snapped answers are driven in a merge pass; outcomes join the existing tally.
  Exactly one re-ask round per autofill pass — no retry loops.
- **Panel + cache consistency.** Harvested options are written back to the field's
  `options` (panel shows real choices), and the re-asked answer overwrites the
  session answer cache under the same normalized-question key, so later steps and
  clicks reuse the corrected answer.
- **Native `<select>`s.** A select whose reconciler fill failed to match re-reads
  its options fresh (`selectOptions`) — covering dependent dropdowns (Country →
  State repopulation) — and joins the same batch.
- **Driver-backed fields** (react-select/Workday MAIN-world): on driver failure,
  fall back to the ARIA harvest path, best-effort.
- **Local matcher hardening.** `matchOption` (`writeEngine.ts`) and the backend
  twin (`_match_option`) get one extra tier: tokens sharing a ≥5-char prefix count
  as overlap ("canad|a" ↔ "canad|ian"), improving the offline path. Sensitive/EEO
  fields are unaffected (never AI-eligible, never re-asked).

## Error handling summary

- Every pause sets a visible reason and preserves flow state; Resume is implicit
  (condition clears) or explicit (Stop always available).
- Backend unreachable during a re-ask: the affected dropdowns keep today's
  "select it manually" outcome; the flow treats them as fill failures (they do not
  block advancing unless the page raises validation errors).
- Scope resolution failure falls back to unscoped scanning.
- Flow resume after navigation waits for profile + recognized fields; TTL expiry
  quietly clears the flow rather than acting on a stale page.

## Testing

Vitest (invoke via node per the repo's npm stdio quirk), jsdom fixtures:

- `flowController`: multi-step advance, pause-on-drafts then auto-resume,
  navigation resume from persisted state, loop detector, step/TTL guards,
  terminal-button stop.
- `advance` detection: EN/FR advance vs terminal fixtures per ATS snippet;
  adapter override wins; out-of-scope buttons ignored.
- `formScope`: header language-switcher exclusion, ≥80% container pick,
  footer-newsletter exclusion, no-container fallback, shadow-root chrome.
- `accountFlow`: signup/login wall detection, password generation policy, both
  password fields filled, storage shape, never-AI-eligible invariant.
- `comboboxEngine`: harvest-on-miss returns options; re-ask batch assembly;
  cache overwrite under same question key.
- No backend changes → no pytest impact.

Manual verification: one Workday multi-step flow including its signup wall; one
embedded Greenhouse form; one FR-Canadian posting for localized buttons.

## Build order (each phase shippable alone)

1. **Form scoping** (Feature 3 — groundwork for everything else).
2. **Option-aware dropdowns.**
3. **Flow controller** (auto-advance, persistence, guards, panel UX).
4. **Account sub-flow** (password handling, saved sign-ins UI).

## Out of scope

- Clicking the final Submit (explicitly rejected).
- Cross-origin iframe advance-clicking beyond the existing relay architecture.
- Syncing saved credentials to the backend or across devices.
- 2FA / email-verification automation.
- Scan-time dropdown pre-opening.
