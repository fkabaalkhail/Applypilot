# Responsive audit

Renders every screen of the web app at every viewport we support and reports the
places where a user cannot see or cannot reach something.

```bash
node scripts/responsive-audit/audit.cjs                      # full matrix
node scripts/responsive-audit/audit.cjs --state app-profile  # one screen (substring match)
node scripts/responsive-audit/audit.cjs --viewport 390x844   # one viewport
node scripts/responsive-audit/audit.cjs --shots              # screenshot every cell, not just failures
node scripts/responsive-audit/audit.cjs --out mybranch       # write out/mybranch.{json,md}

node scripts/responsive-audit/probe.cjs app-profile 390x844  # dump one screen: text, HTML, console errors
```

Exits non-zero if any **high** finding survives, so it can gate CI.

It starts a Vite dev server on :5173 if one is not already up, and reuses the
Playwright + Chromium already vendored under `chrome-extension/node_modules`,
no new dependency in the app bundle.

## How it works

`states.cjs` lists every screen. A screen is a route *plus the interactions
needed to reach a view a user actually sees*, an open modal is a screen, so it
gets audited like one. `fixtures.cjs` stubs the whole API, so authenticated
pages render fully with no backend, and always with the same data.

That data is deliberately **realistic worst case**: a 70-character email, an
88-character job title, a real ATS URL with query params, seventeen skill tags.
Overflow bugs hide behind short lorem-ipsum fixtures; they surface immediately
under the strings the app actually sees in production.

## What counts as a finding

`detectors.cjs` only reports mechanical facts. There is no taste in it.

| type | meaning |
| --- | --- |
| `page-scrolls-horizontally` | the document is wider than the viewport |
| `element-off-viewport` | an element's box extends past the viewport edge, and no scrollable ancestor can reach it |
| `content-clipped-x` / `-y` | an `overflow: hidden` box is cutting real content off |
| `unreachable-control` | a control inside a `position: fixed` layer sits past the fold with nothing scrollable between it and the layer, the classic "Save button is under the bottom of the screen" |
| `overflows-parent-x` | an element spills sideways out of a container that neither clips nor scrolls |
| `small-tap-target` | (touch widths only) an interactive box under 36×36 |
| `page-blank` | the screen rendered almost no text. It crashed, redirected, or the fixture is wrong |

Deliberately **exempt**, because their `scrollWidth` does not mean what it means
on a normal box:

- form controls, an `<input>` whose value is longer than its box scrolls
  internally by design; that content is not lost;
- replaced elements, `<img>.scrollWidth` reports the image's *intrinsic* size,
  so every downscaled image would otherwise look "clipped";
- marquee tracks, content that is wide, clipped, and animated through its
  wrapper (the landing page's logo strip) is wide **on purpose**.

If you add a detector, add its exemptions in the same commit. A noisy audit gets
ignored, and an ignored audit is worse than no audit.

## Rules for fixing what it finds

Fix the cause. Putting `overflow-x: hidden` on a container to make a finding go
away hides the content, which *is* the bug, the audit will go quiet and the
user will still not be able to see the button.

The two causes behind most findings:

1. A flex/grid child defaults to `min-width: auto`: it refuses to shrink below
   its content's intrinsic width. One long job title is then enough to shove the
   whole page sideways, at *any* viewport. Give text-bearing children
   `min-width: 0`.
2. A long unbroken string (an email, a URL, a company slug) has an intrinsic
   width equal to its full length and will happily widen its container past the
   screen. Give it `overflow-wrap: anywhere`.

Modals: the overlay scrolls (`overflow-y: auto`), the content is capped at
`calc(100dvh - 32px)`, and the body scrolls inside it. Use `dvh`, not `vh`: on
mobile browsers `100vh` is measured against the viewport with the URL bar
*hidden*, so a `90vh` modal is taller than the screen you can actually see, and
that is exactly how a primary button ends up under the fold.

Breakpoint scale: **640 / 768 / 1024 / 1280**.
