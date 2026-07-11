# App-wide responsive + overflow remediation

**Date:** 2026-07-11
**Status:** approved (user pre-approved async)

## Problem

Two complaints, one root cause:

1. Elements are not usable on small screens.
2. **Even at full screen**, elements "get cut or overflow depending on the size of the screen."

The second is the tell. This is not a "we forgot phones" problem — it is a **layout that has no shrink discipline**. The app is 11k lines of hand-written CSS with 33 media queries scattered across ten ad-hoc breakpoints (480/600/640/720/760/768/860/900/1024/1100). Boxes are sized by their content, content is sized by the data, and when the data is long (a real company name, a real job title, a real URL) the box wins and the layout loses — at *any* viewport.

Measured, not assumed: a Playwright harness renders all 34 screens at 13 viewports (320→2560) with the API stubbed, and mechanically detects overflow. Baseline: **~85 unique high-severity defects**, including a dashboard that scrolls sideways on every phone.

## Approach

**Evidence first.** `scripts/responsive-audit/` is the deliverable that outlives this task: it renders every screen (including modals, which are screens) at every viewport and reports only falsifiable defects — an element is past the viewport edge, an `overflow:hidden` box is cutting real content, a control inside a fixed layer is unreachable. No taste, no judgement. It exits non-zero when any high finding survives, so it can gate CI.

The detectors are deliberately conservative. Known non-defects are exempt: `<input>` clipping its own value, `<img>` reporting intrinsic size in `scrollWidth`, and marquee tracks that are wide-and-clipped by design.

**Then fix, in dependency order.** The shell first — most page-level overflow is downstream of one missing `min-width: 0`. Then pages in parallel, since each owns a disjoint CSS file.

## Design

### 1. Foundation (`index.css`)

- **Breakpoint scale.** Standardize on `640 / 768 / 1024 / 1280`. Existing off-scale queries (720, 760, 860, 900, 1100) get normalized to the nearest standard stop.
- **Shrink discipline.** `min-width: 0` on flex/grid children that hold text. This is the single highest-leverage fix: a flex item defaults to `min-width: auto`, meaning it *refuses to shrink below its content's minimum width* — which is why `.main-content` measures 385px inside a 390px viewport and pushes the page 59px sideways.
- **Long-content guards.** `overflow-wrap: anywhere` on the containers that hold user/employer data (job descriptions, emails, URLs, resume text). A 70-character email must wrap, not widen its parent.
- **No `overflow-x: hidden` on `body` as a cure.** It hides the symptom and guarantees the bug comes back. Overflow gets fixed where it originates.

### 2. App shell (`App.tsx` + `index.css`)

Today the sidebar is `position: fixed` at 240px, shrinking to a 64px icon rail under 768px, with `.main-content { margin-left }` tracking it. On a 390px phone the rail eats 16% of the screen and the content still overflows.

| width | nav |
| --- | --- |
| ≥1024px | 240px sidebar, collapsible to a 64px rail (unchanged) |
| 768–1023px | 64px icon rail |
| <768px | **off-canvas drawer** + sticky top bar with hamburger; content gets the full width |

The drawer closes on route change, on Escape, and on backdrop click, and locks body scroll while open.

### 3. Marketing site (`SiteHeader.tsx` + `Landing.css`)

`.landing-nav-links { display: none }` under 768px with **no replacement** — Features / Pricing / Results / FAQ are simply unreachable on a phone today. Add a hamburger + mobile menu panel so every nav destination stays reachable at every width.

### 4. Modals — one pattern, applied everywhere

Modals are where "the button is off the bottom of the screen" lives. Every modal gets:

```css
.modal-overlay  { overflow-y: auto; padding: 16px; overscroll-behavior: contain; }
.modal-content  { width: min(100%, Npx); max-height: calc(100dvh - 32px);
                  display: flex; flex-direction: column; }
.modal-body     { overflow-y: auto; }   /* body scrolls; header + actions stay put */
```

`100dvh` (not `100vh`) — on mobile browsers `vh` is measured against the *expanded* viewport, so a `90vh` modal is taller than the screen the moment the URL bar is showing, which is exactly how the primary action ends up under the fold.

### 5. Resume detail

`FittedResume` already scales the 816px US-Letter page down to its wrapper, so the page itself is fine — the wrapper is not. The two-pane edit/preview split needs to collapse to a single pane with a toggle below 1024px, and the panes need `min-width: 0` so the scaler gets a truthful width to scale into.

### 6. Tap targets

Interactive boxes below 36px on touch widths get reported at low severity. Fix the egregious ones (icon and close buttons, some at 28×28); do not inflate every chip.

## Execution

1. Foundation + shell (serial — everything else depends on it).
2. Per-page fixes in parallel across disjoint CSS files, each verified by re-running the audit scoped to that page.
3. Full matrix must return **0 high findings**; existing frontend/backend suites must stay green.

## Non-goals

- No redesign. Colors, type, spacing and component structure stay as they are; this is about boxes that fit.
- No CSS framework migration.
- No new dependencies in the app bundle (the audit rig reuses the Playwright already vendored for the extension).
