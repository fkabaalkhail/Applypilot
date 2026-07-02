# Phase 5 — iframe "agent apply" — DEFERRED (decision record)

- **Date:** 2026-07-02
- **Decision:** **Deferred** — not built during the autonomous overnight run. Needs a product decision + real-browser validation + your sign-off.
- **Author:** autonomous run (Phases 3–6). See memory `autonomous-autofill-phases-overnight`.

## What Phase 5 was going to be (the Jobright feature)

Jobright's "agent apply" (analysis §11/§14) embeds the third‑party ATS application page inside a frame **Jobright controls**, then runs its autofill agent inside that frame so the user never leaves the Jobright surface. To make a third‑party page framable, it uses `chrome.declarativeNetRequest` (DNR) rules to **strip response headers** on the framed navigation:

- `X-Frame-Options` (else the browser refuses to frame the page),
- `Content-Security-Policy` `frame-ancestors` (same),
- `Content-Disposition` (so file/PDF responses render inline instead of downloading).

Then the fill runs in that embedded frame via the same content‑script machinery.

## Why I deferred it (rather than build it unattended)

Your directive was explicit: *scope or defer the risky parts with a written rationale rather than build them recklessly unattended.* This is the risky part. Three independent reasons:

### 1. It's a security‑posture change, not just a feature
Stripping `X-Frame-Options` and CSP `frame-ancestors` **removes clickjacking protections** that ATS/employer sites deliberately set. A DNR ruleset that does this across ATS origins widens our attack surface and changes the extension's security review story. Shipping that while you're asleep — with no chance for you to weigh the trade‑off — is exactly the kind of "hard to reverse, outward‑facing" change that should wait for explicit authorization. (It also materially affects the Chrome Web Store review + permissions story: `declarativeNetRequest` + broad host access + header modification is a red‑flag combination reviewers scrutinize.)

### 2. It doesn't fit our architecture — it's a product pivot
Our extension is an **in‑page overlay** (memory `extension-ui-is-overlay`): the content‑script side panel fills the **live page the user is already on**. Jobright's agent‑apply is a **different product model** — "embed the job inside *our* dashboard and fill it there." We have no dashboard‑that‑embeds‑jobs surface, and building one is a product/UX decision (where does the frame live? how does the user pick a job to embed? what happens on submit/redirect?), not a mechanical autofill improvement. Adopting it would reorient the product, which is yours to decide.

### 3. It's not verifiable unattended
Header stripping + cross‑origin iframe embedding + fill‑inside‑frame cannot be meaningfully unit‑tested (no jsdom coverage for DNR, XFO, or real cross‑origin framing). It needs a **real browser against real ATS pages** and human observation. The rest of this rebuild (Phases 1–4, 6) is gated by an automated suite; this phase can't be, so building it blind risks shipping something that silently doesn't work — or worse, works in a way that's insecure.

## The safe alternative I also considered (and deferred)

**Cross‑frame fill coordination *without* header stripping.** Our content script already runs in all frames (`all_frames: true`, memory `autofill-scope-and-captcha-decisions`). When an ATS form is embedded as a cross‑origin iframe on a company careers page (common: Greenhouse `boards.greenhouse.io`, Lever, Workday), our script is *already inside that iframe* — the browser already allowed it to load. A `postMessage`‑based protocol could let the top‑frame overlay broadcast "autofill" to child frames, have each child scan+fill its own fields, and report results back — **no header stripping, no embedding third‑party pages in our UI**, only coordinating frames that are already present.

This is legitimately valuable and much safer than the Jobright approach. I deferred it too, because: (a) it still touches the content‑script entry + overlay (integration‑heavy) and its real behavior is only observable in a live cross‑origin browser context, so it's not safely verifiable unattended; and (b) it deserves a small design decision from you (does the top overlay aggregate child‑frame results into one panel, or does each frame keep its own?). It's the recommended **first** step if you want to move toward multi‑frame apply — it delivers most of the value with none of the security cost.

## If you want to pursue this (design sketch)

**Recommended order:**
1. **Cross‑frame coordination (safe, no DNR).** New `crossFrame` module: a small `postMessage` protocol — top frame enumerates child frames, sends a signed `AUTOFILL_FRAME` request, each child's content script scans+fills and returns `{filled, needsReview, failed}`; top frame aggregates into the overlay. Unit‑test the pure protocol (message shapes + aggregation); validate the wiring in a real browser with an embedded Greenhouse form. **No new permissions.**
2. **Only if a real product need exists — embedded agent‑apply (DNR).** Scope the DNR header‑strip rules to a **narrow, explicit allowlist** of ATS origins (not `all_urls`), gate the whole feature behind a setting, and get a security review of the ruleset. Requires `declarativeNetRequest` + host permissions for the allowlisted origins + a WAR for the embedding page. Validate end‑to‑end in a real browser.

**Do not** ship step 2 without: (a) your explicit go‑ahead, (b) a narrow origin allowlist, (c) a security review of the DNR rules, (d) real‑browser validation.

## Status
Deferred. No code written. Phases 1–4 shipped to local `main`; the autonomous run proceeds to **Phase 6 (safe hardening)**. Revisit this with the user awake.
