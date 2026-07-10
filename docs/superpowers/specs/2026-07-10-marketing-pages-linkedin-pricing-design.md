# Marketing pages, LinkedIn SSO & pricing UI — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Author:** Wissam Elmasry (with Claude)

## Overview

Four site-level improvements to the Tailrd web app (Vite + React SPA, FastAPI
backend, deployed on Vercel at www.tailrd.ca):

1. **Real pages behind nav/footer links** — replace dead `#` footer links and
   turn key destinations into standalone pages (About, Pricing, Terms, Cookie
   Policy). Content-rich landing *sections* (Features, Results, FAQ) stay on the
   home page as anchor-scroll targets.
2. **LinkedIn SSO** — add "Continue with LinkedIn" alongside the existing Google
   sign-in, using LinkedIn's OpenID Connect authorization-code flow.
3. **Legal pages** — add Terms of Service and Cookie Policy pages (Privacy
   already exists).
4. **Pricing UI (display only)** — Free + **Pro $9.99 CAD/mo**, Lifetime
   removed, promoted to its own `/pricing` page/tab with a teaser on home. No
   billing/checkout is wired.

## Goals

- Every primary-nav and footer link resolves to real content (page or section);
  no dead `#` links.
- Working LinkedIn sign-in/sign-up, gated behind env vars like Google is today.
- Terms + Cookie Policy pages consistent with the existing Privacy page.
- A dedicated pricing page + home teaser, single source of truth, two tiers.

## Non-goals

- **No billing/payments.** Pricing is presentational only; CTAs route to
  sign-up. Stripe/checkout is explicitly out of scope.
- **No cookie consent banner.** Tailrd uses only an essential HttpOnly
  refresh-token cookie; a Cookie *Policy* page is added, not a consent banner.
- **No Blog or Careers pages.** These footer links are removed until there is
  real content.
- **No conversion of Features/Results/FAQ into separate pages** — they remain
  home-page sections (decision below).

## Current state (as of HEAD)

- **Routing:** `frontend/src/main.tsx` — React Router v6. Public routes: `/`
  (`Landing`), `/privacy`, `/support`, `/sign-in/*`, `/sign-up/*`,
  `/verify-email`, `/extension/connect`, `/embed/*`, `/list`, `/demo-apply`,
  `/setup`; app routes under `/app`.
- **Landing (`pages/Landing.tsx`, ~1125 lines):** nav + footer are **inline**.
  - Primary nav: `#features`, `#pricing`, `#success-story`, `#faq` (anchor
    scroll) + Log in / Sign up.
  - Footer: Product (Features/Pricing/FAQ), Company (About/Blog/Careers — all
    dead `#`), Legal (Privacy → `/privacy`, Terms `#`, Cookie `#` — dead).
  - Pricing section (~lines 1004–1050): Free / **Pro** / **Lifetime** cards.
- **Legal pattern:** `pages/Privacy.tsx` uses a self-contained `legal-page` /
  `legal-doc` reading layout (`privacy.css`) with a back-to-home brand link —
  **not** the marketing nav/footer.
- **Auth:**
  - Backend `routers/auth.py` — `POST /auth/google` verifies a Google ID token
    via `oauth2.googleapis.com/tokeninfo`, checks `aud == GOOGLE_CLIENT_ID`,
    find-or-creates a `User` (`auth_provider="google"`), starts a web session,
    sets an HttpOnly refresh cookie via `_set_refresh_cookie`, returns an access
    token. Helpers: `session_service.start_session`, `create_access_token`,
    `create_refresh_token`.
  - Frontend `auth/GoogleSignInButton.tsx` uses Google Identity Services JS SDK
    (returns an ID token in-browser); gated behind `VITE_GOOGLE_CLIENT_ID`.
  - `auth/AuthProvider.tsx` bootstraps **only** from a localStorage
    `access_token` → `GET /auth/me`. It does **not** auto-refresh from the
    cookie alone when there is no stored access token.
  - `User.auth_provider` is a free-text string column → no migration needed to
    add `"linkedin"`.

## Design

### A. Shared marketing chrome

Extract the inline nav/footer from `Landing.tsx` into reusable components so
Home, About, and Pricing share one header/footer (no duplication/drift). Legal
pages keep the existing `legal-page` layout.

- **New:** `frontend/src/components/site/SiteHeader.tsx`,
  `frontend/src/components/site/SiteFooter.tsx`.
- **Primary nav** (in `SiteHeader`):
  - Features → `/#features`, **Pricing → `/pricing`** (dedicated page),
    Results → `/#success-story`, FAQ → `/#faq`.
  - Section links use React Router hash routes (`<Link to={{ pathname: "/",
    hash: "#features" }}>`). On the home page a small effect scrolls to
    `location.hash` on mount / hash change, so section links work from any page
    (e.g. clicking "Features" on `/about` navigates home, then scrolls).
  - Auth actions unchanged (Dashboard when signed in; else Log in / Sign up).
- **Footer** (in `SiteFooter`):
  - Product: Features (`/#features`), Pricing (`/pricing`), FAQ (`/#faq`).
  - Company: **About → `/about`** only (Blog & Careers **removed**).
  - Legal: Privacy (`/privacy`), **Terms (`/terms`)**, **Cookie Policy
    (`/cookies`)**.
- `Landing.tsx` refactored to render `<SiteHeader/>` … sections … `<SiteFooter/>`
  and to host the hash-scroll effect. Section ids (`features`, `pricing`,
  `success-story`, `faq`) are preserved.

### B. New pages & routes

Add to `main.tsx`:

| Route | Component | Layout |
|---|---|---|
| `/about` | `pages/About.tsx` | marketing chrome |
| `/pricing` | `pages/Pricing.tsx` | marketing chrome |
| `/terms` | `pages/Terms.tsx` | `legal-page` (like Privacy) |
| `/cookies` | `pages/Cookies.tsx` | `legal-page` (like Privacy) |
| `/linkedin/complete` | `pages/LinkedInComplete.tsx` | minimal (SSO landing) |

- **About** — marketing header/footer; mission, what Tailrd does, who it's for
  (interns / new grads). Copy drafted from existing landing + privacy content;
  editable by the user.
- **Terms / Cookies** — reuse `legal-page` layout + `privacy.css`. Terms: standard
  ToS (acceptable use, accounts, IP, disclaimers, liability, governing law,
  contact support@tailrd.ca). **Governing-law province to be confirmed by the
  owner** — the existing Privacy policy references Quebec (Law 25); Terms should
  name the province Tailrd actually operates from. Cookies: describes the essential
  HttpOnly refresh-token cookie and localStorage `access_token`; states no
  third-party/advertising cookies are used today.

### C. Pricing UI (display only)

- **New shared component** `frontend/src/components/PricingTiers.tsx` — the
  single source of truth, used by both the home teaser and `/pricing`.
- **Two tiers:**
  - **Free** — current free feature set; CTA "Get started" → `/sign-up`.
  - **Pro — $9.99 CAD / month** — featured/highlighted; CTA "Get started" →
    `/sign-up` (no checkout wired). Copy makes the currency explicit ("CAD").
  - **Lifetime removed.**
- **Home:** condensed teaser (the two cards + "See full pricing" link to
  `/pricing`), replacing the current three-card section.
- **`/pricing` page:** full `PricingTiers` + a short feature comparison and 2–3
  pricing FAQs.
- Billing is not implemented; a code comment marks the CTA as a placeholder.

### D. LinkedIn SSO

LinkedIn OIDC requires the **authorization-code flow** with a **client secret on
the server** (no in-browser ID token like Google). Chosen flow keeps the access
token out of URLs by reusing the existing refresh-cookie mechanism.

**Flow:**

1. User clicks **Continue with LinkedIn** → browser navigates to
   `GET /auth/linkedin/start?next=/app`.
2. **`/auth/linkedin/start`** generates a random `state`, stores it in a
   short-lived HttpOnly cookie (`li_oauth_state`), and 302-redirects to
   `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=…&redirect_uri=…&scope=openid%20profile%20email&state=…`.
   `next` is stored in a companion short-lived HttpOnly cookie (`li_oauth_next`,
   validated against the existing safe-path allowlist on return) for the
   post-login redirect.
3. LinkedIn redirects to **`/auth/linkedin/callback?code=…&state=…`**. The
   backend:
   - verifies `state` against the cookie (mismatch → 401), clears the cookie;
   - exchanges the code at `https://www.linkedin.com/oauth/v2/accessToken`
     (form: `grant_type=authorization_code`, `code`, `redirect_uri`,
     `client_id`, `client_secret`);
   - fetches `https://api.linkedin.com/v2/userinfo` with the access token
     (`sub`, `email`, `email_verified`, `given_name`, `family_name`, `picture`);
   - find-or-creates the `User` (mirrors `google_auth`; `auth_provider="linkedin"`;
     links an existing `local` account by email; no migration);
   - starts a web session, sets the refresh cookie via `_set_refresh_cookie`;
   - 302-redirects to `/linkedin/complete?next=/app`.
4. **`LinkedInComplete.tsx`** calls a new `completeOAuthRedirect()` on
   `AuthProvider` → `POST /auth/refresh` (uses the refresh cookie) → stores the
   returned `access_token` → `GET /auth/me` → `setUser` → navigates to `next`
   (default `/app`). Shows a spinner + error fallback to `/sign-in`.

**Frontend:**

- **New** `frontend/src/auth/LinkedInSignInButton.tsx` — mirrors
  `GoogleSignInButton`, gated behind `VITE_LINKEDIN_ENABLED`; renders a LinkedIn
  button that sets `window.location = "/auth/linkedin/start?next=" + next`.
  Added to Sign In and Sign Up next to Google.
- **New** `frontend/src/pages/LinkedInComplete.tsx` (route `/linkedin/complete`).
- **Edit** `AuthProvider.tsx` / `AuthContext.tsx` — add `completeOAuthRedirect()`.

**Backend:**

- **New focused module** `backend/routers/auth_linkedin.py` (keeps the large
  `auth.py` from growing), mounted under the `/auth` prefix, importing the shared
  helpers (`_set_refresh_cookie`, `session_service`, `create_access_token`,
  `create_refresh_token`, `User`, `get_db`). Endpoints: `GET /auth/linkedin/start`,
  `GET /auth/linkedin/callback`.
- **Vercel rewrites** (`vercel.json`) already forward `/auth/(.*)` to the API, so
  `/auth/linkedin/*` is covered — no rewrite change needed.

**Env vars (server):** `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`LINKEDIN_REDIRECT_URI` (e.g. `https://www.tailrd.ca/auth/linkedin/callback`).
**Env var (client):** `VITE_LINKEDIN_ENABLED=true` to reveal the button. When
unset, the button is hidden and behavior is unchanged (mirrors Google gating).

### E. Manual setup required from the account owner (LinkedIn)

1. Create an app at **linkedin.com/developers/apps** — requires an associated
   **LinkedIn Company Page** (create a minimal one if needed).
2. On the app's **Products** tab, add **"Sign In with LinkedIn using OpenID
   Connect"** (grants `openid` / `profile` / `email`).
3. On the **Auth** tab → **Authorized redirect URLs**, add
   `https://www.tailrd.ca/auth/linkedin/callback` (and a localhost equivalent
   for dev).
4. Copy the **Client ID** and **Client Secret**.
5. Set on **Vercel** (Production + Preview): `LINKEDIN_CLIENT_ID`,
   `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, and
   `VITE_LINKEDIN_ENABLED=true`. Mirror into local `.env`.
6. Redeploy.

### F. Testing

- **Frontend (vitest):**
  - `PricingTiers` renders exactly two tiers, no "Lifetime", Pro shows
    "$9.99" + "CAD".
  - Hash-scroll: navigating to `/#features` from another route scrolls to the
    section (or at least sets hash + fires the effect).
  - `LinkedInSignInButton` hidden when `VITE_LINKEDIN_ENABLED` is unset.
- **Backend (pytest, mocked LinkedIn HTTP, style of `test_auth_properties.py`):**
  - `/auth/linkedin/callback` with mismatched `state` → 401.
  - Successful callback: exchanges code, creates a new `linkedin` user, sets the
    refresh cookie, redirects to `/linkedin/complete`.
  - Existing-email user is linked (not duplicated).
- **Link audit:** no remaining `href="#"` dead links in nav/footer.

## Files touched

**New (frontend):** `components/site/SiteHeader.tsx`,
`components/site/SiteFooter.tsx`, `components/PricingTiers.tsx`,
`pages/About.tsx`, `pages/Pricing.tsx`, `pages/Terms.tsx`, `pages/Cookies.tsx`,
`pages/LinkedInComplete.tsx`, `auth/LinkedInSignInButton.tsx`.

**Edit (frontend):** `main.tsx` (routes), `pages/Landing.tsx` (use shared
chrome, hash-scroll, two-tier teaser), `pages/SignIn.tsx`, `pages/SignUp.tsx`
(LinkedIn button), `auth/AuthProvider.tsx` + `auth/AuthContext.tsx`
(`completeOAuthRedirect`), CSS as needed.

**New (backend):** `routers/auth_linkedin.py` + tests.
**Edit (backend):** app entry to include the new router (e.g. `api/index.py` /
FastAPI app wiring).

## Resolved decisions

- Nav scope: Features/Results/FAQ stay as home sections; About/Pricing/Terms/
  Cookie are standalone pages.
- Blog & Careers: removed for now.
- Home pricing: keep a teaser linking to `/pricing`.
- Cookies: policy page only, no consent banner.
- Pro CTA copy: "Get started" (routes to sign-up); billing not wired.
- LinkedIn: server-side auth-code flow + `/linkedin/complete` hydration
  (access token never in a URL).
