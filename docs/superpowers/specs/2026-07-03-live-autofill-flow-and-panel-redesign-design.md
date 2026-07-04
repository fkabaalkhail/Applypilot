# Live multi-page autofill + panel redesign — design

- **Date:** 2026-07-03
- **Status:** Workstream B (UI) COMPLETE. Workstream A: FIXED + verified the
  "doesn't click Apply" root cause (deepQueryAll skips the panel's own shadow
  root) and the #1 live fill failure "Field no longer found" (settle-before-fill
  in fillOnce). 527 unit tests + flow-probe + workday-account-probe +
  workday-churn-probe all green. Remaining: Workday phone-code/device dropdowns.
- **Target:** `chrome-extension/` (active build; overlay side-panel is the real UI)
- **Reference behaviour:** Jobright `1.15.0_0` (parity of behaviour, NOT a port of its minified bundle)

## Problem

The multi-page flow machinery is complete and unit-tested (`FlowController`,
`applyEntry`, `accountFlow`, `advance`, Workday/Greenhouse adapters), but on live
sites it "does almost nothing" — it doesn't click Apply, doesn't click Create
Account. Root causes found in the code:

1. **Panel won't mount on a bare job posting.** `contentScript.ts` mounts only
   when `recognizedCount >= 1 || entry?.fromAdapter`. A Workday posting has zero
   form fields, so the panel appears only if the adapter recognises Apply.
2. **Primary button disabled on postings.** `overlay.ts`: `disabled = busy ||
   (count === 0 && !entryStart)` — dead on a fields-less posting.
3. Therefore `FlowController.run()` (whose apply-entry path clicks Apply → Apply
   Manually) never starts.
4. Live detection (`findApplyEntry`, `detectWall`) and click delivery
   (`clickAdvance → activateElement`) need empirical verification on real
   Workday shadow-DOM/iframes, not just fixtures.

The fix and the requested UI redesign converge: the photo's big
**"Account Creation & Autofill"** button becomes the always-on primary action
that always runs the full flow.

## Decisions (confirmed)

- **Primary button:** always-on "Account Creation & Autofill" that always runs
  the full multi-page flow; panel also mounts on known ATS hosts with no fields.
- **Header:** company logo + company name + job title (all page-scrapable).
- **Logo source:** on-device — og:image / apple-touch-icon / favicon → colored
  monogram fallback. No external calls.
- **Credits row:** dropped (no metering backend).

## Workstream A — live flow reliability (Workday-first)

- **A1. Always-on primary + mount on postings.** Rename primary button; enable
  whenever a profile is loaded. Mount when `recognized>=1 || anyApplyEntry
  (generic) || knownAtsHost`. `onAutofill` → `fillOnce` (no-op on a posting) →
  `FlowController.run()` which clicks the apply-entry.
- **A2. Real-markup detection.** Verify/extend `findApplyEntry` + Workday adapter
  `entryButton` (Apply → Apply Manually) and `detectWall` (create-account:
  fill creds, tick `createAccountCheckbox`, click Create Account) against the
  live DOM.
- **A3. Click delivery + frames.** Confirm `activateElement` triggers Workday's
  React; confirm the controller runs in the frame that owns the form/wall
  (`all_frames` already on).
- **A4. Verify end-to-end live.** Drive a real Workday application
  posting→account→pages with the browser harness (`live-probe.mjs`,
  `workday-account-probe.mjs`, `test:flow`), screenshot each step; cross-check
  `autofill_reports` in Neon for per-field results.

## Workstream B — panel redesign (matches the photo)

```
┌───────────────────────────────────────┐
│ ⚡ Tailrd                      ⚙  ✕     │  header (unchanged)
├───────────────────────────────────────┤
│ ┌───┐  Salesforce                      │  NEW job card:
│ │ S │  Corporate Counsel, Global Trade │  logo(og/favicon→monogram)
│ └───┘                                  │  + company + title
│ ┌───────────────────────────────────┐ │
│ │   Account Creation & Autofill     │ │  primary (always-on, full flow)
│ └───────────────────────────────────┘ │
│   ⟳ flow status … / Stop  (when live)  │
│ 📁 Your Autofill Information         › │
│ 📄 Upload Resume                       │  COMPACT (no expander):
│    Wissam_Elmasry_CV   [ Attach ]      │  name + small attach button
│    ✨ Generate Custom Resume           │  remake, directly below
│ ✉️ Upload Cover Letter                 │  COMPACT:
│    ✨ Generate Cover Letter            │
├───────────────────────────────────────┤
│            Open Dashboard              │  footer (unchanged)
└───────────────────────────────────────┘
```

- **B1. Job-card header** — new block below the header: logo (resolver) +
  company + title, fed from `extractJobContext`. Plumb company/title into the
  overlay state.
- **B2. Compact resume section** — remove the accordion; show current resume
  name inline with a small **Attach** button and **Generate Custom Resume**
  directly below.
- **B3. Compact cover-letter section** — direct **Generate Cover Letter**
  (keep tone select), no accordion.
- **B4. Primary button + order** — "Account Creation & Autofill" directly under
  the job card. Keep "Your Autofill Information" modal, flow status, saved
  sign-ins, connect/login view, footer. Drop credits.

## Sequencing

Do **B first** (it is also the A1 fix + a fast visible win), then A2–A4 live
hardening.

## Testing / verification

- Keep vitest green; run via `node` directly (npm-stdio quirk).
- Add unit tests: mount-on-ATS gate, always-on button, logo resolver.
- Live-verify the flow with the browser harness (real Workday posting).

## Out of scope

- Credits/metering backend, insider connections, match-% ring, and any port of
  the Jobright minified bundle.
