# Extension: mount gate, saved sign-ins modal, logo edge tab

Date: 2026-08-08
Scope: `chrome-extension/` only. No backend, no frontend, no manifest changes.

Three independent fixes to the in-page side panel (`src/content/overlay.ts`,
`src/content/contentScript.ts`, `src/content/jobFormEvidence.ts`).

---

## 1. Panel mounts on non-application pages

### Problem

`looksLikeJobApplication()` mounts the panel whenever **two distinct**
"job-flavored" field categories are detected. Two real-world pairs fire on pages
that are not job applications:

- `currentCompany` + `currentTitle` — "Company" and "Job title" appear on nearly
  every B2B demo-request, contact-sales, newsletter and event-registration form.
- `linkedin` + `github` (or `portfolio`) — developer profile / account settings
  pages.

Separately, `contentScript.ts` mounts on `Boolean(lastAdapter)`. Adapter matching
is host-only (`/(^|\.)greenhouse\.io$/`, `LEVER_HOST`, `WD_HOST`), so the
vendors' own marketing sites (`www.greenhouse.io`, `www.lever.co`) mount the
panel on every page.

### Design

Replace the flat two-of-any rule with tiers, and let page context corroborate
weak evidence.

**Tiers** (`jobFormEvidence.ts`):

| Tier | Categories | Rule |
| --- | --- | --- |
| `APPLICATION_ONLY` | resumeUpload, coverLetter, workAuthorization, sponsorship, eeo* | any one → mount |
| `STRONG` | school, degree, graduationYear, experienceStartDate, experienceEndDate, experienceDescription, experienceCurrent | one strong + one other distinct job field → mount |
| `WEAK` | linkedin, github, portfolio, education, experience, currentCompany, currentTitle, salary, skills | three distinct → mount; two distinct → mount only with a job-page hint |

A single strong category alone does **not** mount (a university contact form has
"School"; a loan form has "Highest level of education").

**Job-page hint.** A page-context signal derived from the URL path and the
document title:

```
/(?:^|[^a-z])(careers?|jobs?|apply|application|requisition|vacanc\w*|job-?post\w*)(?:[^a-z]|$)/i
```

Passed in as an optional second argument so the predicate stays pure (no
`location`, no `document`) and unit-testable:

```ts
export interface PageContext { url?: string; title?: string }
export function looksLikeJobApplication(
  fields: readonly { category: FieldCategory }[],
  context?: PageContext,
): boolean
```

The hint only *upgrades* two weak categories to a mount. It never mounts on its
own — a careers *landing* page with no recognized fields still does not mount.

**ATS-host arm** (`contentScript.ts:maybeShowOrUpdateOverlay`). Replace the bare
`Boolean(lastAdapter)` with:

```ts
const atsPage =
  Boolean(detectSite(location.hostname, location.href, { inIframe: self !== top })) ||
  (Boolean(lastAdapter) && recognizedCount(lastFields) > 0);
```

`detectSite()` is already path-gated per registry entry (Greenhouse only on
`/{co}/jobs/{id}` or `/embed/job_app`; Lever only on `/{co}/{id}`; Workday on the
whole `myworkdayjobs.com` family, which is entirely application surface). The
`lastAdapter && recognizedCount > 0` fallback preserves mounting for adapter
hosts absent from the registry, while keeping field-less marketing pages out.

The child-frame arm (`contentScript.ts:1486`) gets the same predicate and the
same page context.

The toolbar icon (`TOGGLE_PANEL`) remains the universal escape hatch: the panel
opens on demand on any page regardless of evidence. No change there.

### Tests

Extend the existing `jobFormEvidence` vitest suite:

- Company + Title alone → no mount.
- Company + Title on `https://acme.com/careers/apply/123` → mount.
- LinkedIn + GitHub alone → no mount; + portfolio → mount.
- resumeUpload alone → mount.
- school alone → no mount; school + graduationYear → mount.
- Empty field list with a job-page URL → no mount.

---

## 2. Saved sign-ins UI

### Problem

Saved sign-ins is a bare `<details>` accordion whose rows cram five elements
(site, email, masked password, Show, Copy, Delete) into one 12px flex line. It
reads as unstyled debug output next to the rest of the panel.

### Design

Mirror the "Your Autofill Information" pattern: a section row in the panel that
opens a modal.

**Panel row** — same markup shape as `#ap-section-info`: leading key icon, title
"Saved sign-ins", a count badge when there is at least one credential, trailing
chevron. Replaces the `<details>` element entirely.

**Modal** — a second `.ap-modal-backdrop` (`#ap-signins-modal`) reusing the
existing `.ap-modal`, `.ap-modal-header`, `.ap-modal-notice`, `.ap-modal-body`
styles. No sidebar (single list), no footer Update button.

- Notice: these credentials are stored on this device only and never sync.
- Body: one card per credential — origin (bold), email below it, then a
  password row with a masked `<code>`, Show/Hide, Copy, and a Delete action.
- Empty state: centered icon + "No saved sign-ins yet" + one line explaining
  that signup walls passed by autofill land here.

Behavior carries over from `renderSavedSignins()` unchanged: passwords are
masked until revealed, a revealed password is only ever written to
`textContent`, and delete re-renders the list. The list renders on modal open
(and the count badge refreshes whenever the panel re-renders).

New phosphor path constant `P_KEY` → `I_KEY`.

---

## 3. Edge tab shows the Tailrd logo

### Problem

The collapsed-state edge tab is a purple gradient pill with a white chevron —
no brand identity.

### Design

Jobright's treatment: a white tab carrying the circular brand badge. The Tailrd
mark (`frontend/public/logo-icon.png`, 301×301, purple line-art paper plane in a
ring) is already circular, so it drops in directly.

- **Asset.** `brandLogo.ts` is a single auto-generated module, so its generator
  stays single too: extend `scripts/gen-brand-logo.mjs` to emit **both**
  constants — the existing `BRAND_LOGO_DATA_URI` (header lockup, cropped from
  `docs/Logo.jpeg`) and a new `BRAND_MARK_DATA_URI` (64×64 PNG from
  `frontend/public/logo-icon.png`). No second script.
- **Markup.** The edge tab holds an `<img class="ap-edge-mark">` plus the
  existing chevron SVG, with the chevron hidden by default.
- **CSS.** White background, `border-radius: 14px 0 0 14px`, ~44×64, 1px
  `--stripe-hairline` border, `-2px 0 12px rgba(...,0.18)` shadow. Mark at 28px.
  Hover widens to 48px as today's tab widens.
- **CSP fallback.** Strict `img-src` pages block data URIs. On the `<img>`
  `error` event the tab gets an `is-fallback` class: mark hidden, chevron shown,
  background reverts to today's purple gradient. Wiring lives in
  `wireBrandLogo()` alongside the header lockup's identical fallback (listener
  attached before `src` is set, per the existing comment).

---

## Verification

- `npx vitest run` in `chrome-extension/` — new evidence cases plus the existing
  suite green.
- `node build.mjs` clean.
- Manual: load unpacked, confirm (a) no panel on a B2B contact form with
  Company + Job title, (b) panel still mounts on a Greenhouse/Lever job
  application, (c) toolbar icon still opens the panel anywhere, (d) sign-ins
  modal opens and reveal/copy/delete work, (e) edge tab shows the logo.
