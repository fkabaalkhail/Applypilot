# Extension panel: Autofill button restyle + "Autofilling" waves

**Date:** 2026-08-11
**Surface:** `chrome-extension/src/content/overlay.ts` (shadow-DOM side panel)

## Goal

Two changes to the side panel's primary action:

1. Rename the primary button to **Autofill** and give it a rectangular corner
   matching the "Continue To The Next Page" gate.
2. While a fill runs, slide open an **Autofilling** block above "Your Autofill
   Information", pushing that section and everything below it down, showing two
   gradient waves moving up and down. It slides shut when the fill finishes.

## Decisions

| Question | Decision |
|---|---|
| Wave style | Filled "liquid" waves, not stroked lines |
| Button restyle scope | Shape only: `border-radius` 9999px → 8px. Fill, padding and type unchanged so it still outranks the Continue gate |
| Busy label | Keeps today's `Working…` swap, in addition to the waves |
| Label alignment | Centered over the wave stage (reads as a status, not a section row) |

## Design

### Button

`.ap-btn-autofill` keeps its solid `--stripe-primary` fill, `16px` padding and
15px/700 type; only the corner changes to `8px`, shared with `.ap-flow-next`.
The label is `Autofill` in the markup and in `refreshMainView()`.

### Wave block

Inserted immediately above the `Your Autofill Information` section, so that
section and the ones under it (Saved sign-ins, Upload Resume, Upload Cover
Letter) are what move.

- **Slide:** `height: 0; overflow: hidden`, and `.is-active` transitions to
  `116px` over `0.32s cubic-bezier(.22,1,.36,1)`, opacity following at `0.24s`.
  The inner block is a fixed `116px`, so it wipes into view rather than
  squashing its own contents.
- **Contents:** the word `Autofilling` (12.5px/600, centered) over a `60px`
  rounded stage tinted `--stripe-canvas-soft`, holding the two waves.
- **Motion:** each wave is an outer layer that bobs vertically wrapping an
  `<svg>` that drifts horizontally, because two animations cannot share one
  element's `transform`.

  | | back | front |
  |---|---|---|
  | bob | `4px → -5px`, 3.2s | same, 2.4s, `-0.8s` delay |
  | drift | 7s linear | 5s linear, `reverse` |
  | opacity | 0.5 | 0.92 |

- **Gradient:** the landing hero mesh from `frontend/src/pages/Landing.css`
  `.hero-bg` — cream `#f5e9d4`, sherbet `#ffd9a8`, lavender `#c3b9fd`, indigo
  `#533afd` / `#665efd`, ruby `#f96bee`.
- `prefers-reduced-motion: reduce` drops the slide and both animations; the
  waves render as static gradient bands under the label.

### Two invariants worth protecting

**Inline `<svg>`, never a data-URI background.** Pages with a strict `img-src`
CSP (Greenhouse, Workday, many banks) block data-URI images outright — the same
trap `wireBrandLogo()` already works around for the brand marks.

**The loop must not pop.** Three numbers have to agree:

- the path holds **four 60-unit periods** across a `0 0 240 40` viewBox,
- the `<svg>` is **200%** of the stage width,
- drift shifts it by **-50%**, i.e. exactly two periods.

The gradient repeats over that same 120-unit distance
(`gradientUnits="userSpaceOnUse" x2="120" spreadMethod="repeat"`) with matching
first and last stops, so the colour tiles with the shape and doesn't jump at the
loop point either.

Four periods rather than two because `preserveAspectRatio="none"` stretches the
240 units across twice the panel width; a longer wave flattens into a
barely-visible swell. At 60 units roughly two crests are in view.

### State

A dedicated `PanelState.autofilling`, **not** the existing `busy`: `busy` is
also set by `doUploadResume()` and the tailor path, and neither should raise the
waves. Set at the top of `doAutofill()`, cleared in its `finally`, and also
cleared by `reInit()` and `showReloadRequired()` (which is terminal — waves left
up there would claim work is still running).

`renderFillWave(active)` toggles the class and `aria-hidden`; the label carries
`role="status"` so it is announced only while a fill is really running.

## Verification

- `test/fillWave.test.ts` — 13 cases: markup, placement above Your Autofill
  Information, raise/lower, the no-data-URI guard, the loop invariants above,
  gradient tiling, reduced motion, and the button's corner and label.
- `npm run preview` (`test/browser/panel-preview.mjs`) renders the real panel in
  Chromium and now also captures the Autofilling state: mid-slide, three settled
  frames, and closed. It asserts four animations are running, that the frames
  differ (waves actually move), and that closing restores the idle layout
  pixel-for-pixel. jsdom cannot run CSS animations, so this is the only place
  the motion is really exercised.
- Full extension suite: 105 files / 1024 tests green; `tsc --noEmit` clean;
  `node build.mjs` clean.

## Also removed: the "N questions need your answer" card

The panel card that opened the unanswered-questions modal is gone: its markup,
its four CSS rules, the question icon, the `gapsCard` / `gapsText` refs and its
click handler.

Nothing else went with it. `answerGaps.ts`, the modal and its styles, the
`onAnswerGaps` / `onHarvestGapOptions` handlers, the cross-frame ops and all
three test files are untouched and still green; the modal simply has no entry
point in the panel today. `refreshGaps()` still recomputes `overlayState.gaps`
on every render, so re-exposing an entry point is a markup change rather than a
rebuild.

## Also removed: the flow status strip

`.ap-flow` carried exactly two strings: `Autofilling…` while a fill ran, and
`Paused: <reason>` when the flow was stuck. The waves now say the first, and
the bottom gate says what to do on a parked page, so the strip is gone with its
markup, CSS, the `flow` / `flowText` refs, and the text-setting branch of
`updateFlowProgress`.

`PAUSE_TEXT` and `formatFlowProgress` stay: every beat, pause reasons included,
is still logged via `console.info("[Tailrd] …")`, and `formatFlowProgress` keeps
its unit tests.

**Known consequence.** Captcha, verification and resume-upload pauses show no
advance gate (a press cannot clear them, see `showsAdvanceGate`) and now no text
either, so those three are silent on screen. The reason is in the console only.
The original code called an unexplained strip "a dead end"; that trade was made
deliberately here in favour of a quieter panel.

## Follow-on

The old label appeared in two places that were updated to match:
`contentScript.ts`'s mount comment and step 5 of `docs/store-submission.md`
(reviewer instructions, which would otherwise send a Chrome Web Store reviewer
looking for a button that no longer exists). Historical specs under
`docs/superpowers/specs/` keep the old name deliberately — they record what was
decided at the time.
