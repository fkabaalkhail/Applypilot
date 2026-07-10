# Marketing Pages, LinkedIn SSO & Pricing UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn dead nav/footer links into real pages (About, Pricing, Terms, Cookie Policy), add LinkedIn OIDC sign-in beside Google, and present a two-tier (Free / Pro $9.99 CAD) pricing UI — no billing.

**Architecture:** Extract the inline nav/footer from `Landing.tsx` into shared `SiteHeader`/`SiteFooter` components reused by the marketing pages; legal pages reuse the existing `legal-page` reading layout (`privacy.css`). LinkedIn uses the server-side authorization-code flow: `/auth/linkedin/start` → LinkedIn → `/auth/linkedin/callback` (sets the existing HttpOnly refresh cookie) → SPA `/linkedin/complete` hydrates the session via `/auth/refresh`, so the access token never appears in a URL.

**Tech Stack:** Vite + React 18 + TypeScript, react-router-dom v6, Phosphor icons, framer-motion (frontend); FastAPI + SQLAlchemy + httpx (backend); Vitest (frontend tests), pytest (backend tests).

## Global Constraints

- **Framework/versions:** React 18, react-router-dom v6, TypeScript strict — the build is `tsc && vite build`; type errors fail the build.
- **Pro price copy:** exactly `$9.99` with the string `CAD` visible. **No "Lifetime" tier anywhere.**
- **Pricing is display-only:** no checkout/Stripe. CTAs route to `/sign-up`. Mark the CTA with a code comment that billing is not wired.
- **LinkedIn button gating:** rendered only when `import.meta.env.VITE_LINKEDIN_ENABLED === "true"` (mirrors Google's `VITE_GOOGLE_CLIENT_ID` gating). Vite reads env from the **repo-root** `.env` (`envDir: ".."`).
- **SPA landing path:** the LinkedIn completion page MUST be `/linkedin/complete` — NOT under `/auth/*`, because `vercel.json` rewrites `/auth/(.*)` to the backend API.
- **Cookies:** refresh cookie keeps `path="/auth"`, `samesite="strict"` (unchanged). LinkedIn state/next cookies use `samesite="lax"` so they survive LinkedIn's top-level cross-site GET redirect back to `/callback`.
- **Frontend tests:** files named `*.test.tsx`/`*.test.ts` next to source; run with `npx vitest --run`. Components using `useAuth()` must be wrapped in `AuthProvider` (no localStorage token ⇒ no network call on mount). Components using `Link`/`useSearchParams` must be wrapped in `MemoryRouter`.
- **Backend tests:** `backend/tests/`, use the `client` and `db_session` fixtures from `conftest.py`; run with `python -m pytest`. Mock LinkedIn HTTP by monkeypatching the module functions `_exchange_code` / `_fetch_userinfo`.
- **Commit** after every task's tests pass.
- **Governing-law province** in Terms is owner-confirmed (Privacy references Quebec / Law 25) — use the placeholder text specified in Task 4 and flag it.

---

### Task 1: Shared `SiteHeader` + `SiteFooter`, refactor `Landing`, hash-scroll

**Files:**
- Create: `frontend/src/components/site/SiteHeader.tsx`
- Create: `frontend/src/components/site/SiteFooter.tsx`
- Create: `frontend/src/components/site/SiteFooter.test.tsx`
- Create: `frontend/src/components/site/SiteHeader.test.tsx`
- Modify: `frontend/src/pages/Landing.tsx` (replace inline nav @316-338 and footer @1095-1125; add imports + hash-scroll effect)
- Modify: `frontend/src/pages/Landing.css` (append `.marketing-page` offset class)

**Interfaces:**
- Produces: `SiteHeader` (default export, no props), `SiteFooter` (default export, no props). Both render the existing `.landing-nav` / `.landing-footer` markup and depend on `Landing.css` classes. Section links use hash routes (`/#features`, `/#success-story`, `/#faq`); Pricing → `/pricing`. Footer Company column has **only** About (`/about`); Legal has Privacy/Terms/Cookies.

- [ ] **Step 1: Write the failing footer test**

Create `frontend/src/components/site/SiteFooter.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SiteFooter from "./SiteFooter";

test("footer links resolve to real routes; no dead/removed links", () => {
  render(<MemoryRouter><SiteFooter /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
  expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  expect(screen.getByRole("link", { name: "Cookie Policy" })).toHaveAttribute("href", "/cookies");
  expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
  expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  expect(screen.queryByRole("link", { name: "Blog" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
  document.querySelectorAll("a").forEach((a) =>
    expect(a.getAttribute("href")).not.toBe("#"));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest --run src/components/site/SiteFooter.test.tsx`
Expected: FAIL — cannot resolve `./SiteFooter`.

- [ ] **Step 3: Create `SiteFooter.tsx`**

```tsx
import { Link } from "react-router-dom";

/** Shared marketing footer. Section links use hash routes to the home page so
 *  they work from any marketing page (Landing hosts the scroll-to-hash effect). */
export default function SiteFooter() {
  return (
    <footer className="landing-footer">
      <div className="footer-inner">
        <div className="footer-col">
          <div className="footer-brand">
            <img src="/logo-full.png" alt="Tailrd" className="landing-logo-full" />
          </div>
          <p className="footer-tagline">AI-powered job applications.<br />Apply smarter, not harder.</p>
        </div>
        <div className="footer-col">
          <h4>Product</h4>
          <Link to={{ pathname: "/", hash: "#features" }}>Features</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to={{ pathname: "/", hash: "#faq" }}>FAQ</Link>
        </div>
        <div className="footer-col">
          <h4>Company</h4>
          <Link to="/about">About</Link>
        </div>
        <div className="footer-col">
          <h4>Legal</h4>
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms of Service</Link>
          <Link to="/cookies">Cookie Policy</Link>
        </div>
      </div>
      <div className="footer-bottom">
        <p>© 2026 Tailrd. All rights reserved.</p>
      </div>
    </footer>
  );
}
```

- [ ] **Step 4: Run the footer test — expect PASS**

Run: `cd frontend && npx vitest --run src/components/site/SiteFooter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing header test**

Create `frontend/src/components/site/SiteHeader.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthProvider";
import SiteHeader from "./SiteHeader";

test("nav: Pricing is a page link, sections are hash links", () => {
  render(
    <AuthProvider>
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>
    </AuthProvider>
  );
  expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
  expect(screen.getByRole("link", { name: "Features" })).toHaveAttribute("href", "/#features");
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd frontend && npx vitest --run src/components/site/SiteHeader.test.tsx`
Expected: FAIL — cannot resolve `./SiteHeader`.

- [ ] **Step 7: Create `SiteHeader.tsx`**

```tsx
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";

/** Shared marketing top nav. Section links use hash routes so they work from
 *  any page; the Landing page scrolls to the hash on mount / hash change. */
export default function SiteHeader() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  return (
    <nav className="landing-nav">
      <div className="landing-nav-inner">
        <div className="landing-brand">
          <Link to="/" aria-label="Tailrd home">
            <img src="/logo-full.png" alt="Tailrd" className="landing-logo-full" />
          </Link>
        </div>
        <div className="landing-nav-links">
          <Link to={{ pathname: "/", hash: "#features" }} className="nav-link-item">Features</Link>
          <Link to="/pricing" className="nav-link-item">Pricing</Link>
          <Link to={{ pathname: "/", hash: "#success-story" }} className="nav-link-item">Results</Link>
          <Link to={{ pathname: "/", hash: "#faq" }} className="nav-link-item">FAQ</Link>
        </div>
        <div className="landing-nav-actions">
          {isAuthenticated ? (
            <button className="btn-cta nav-cta" onClick={() => navigate("/app")}>Dashboard</button>
          ) : (
            <>
              <button className="btn-ghost nav-login" onClick={() => navigate("/sign-in")}>Log in</button>
              <button className="btn-cta nav-cta" onClick={() => navigate("/sign-up")}>Sign up</button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 8: Run the header test — expect PASS**

Run: `cd frontend && npx vitest --run src/components/site/SiteHeader.test.tsx`
Expected: PASS.

- [ ] **Step 9: Refactor `Landing.tsx` to use the shared components + hash-scroll**

In `frontend/src/pages/Landing.tsx`:

(a) Update imports at the top — add `useEffect` to the existing React import and add `useLocation`, `SiteHeader`, `SiteFooter`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import SiteHeader from "../components/site/SiteHeader";
import SiteFooter from "../components/site/SiteFooter";
```

(b) Inside `export default function Landing()`, after the existing `const navigate = useNavigate();`, add the hash-scroll effect:

```tsx
  const location = useLocation();
  useEffect(() => {
    if (!location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [location.hash]);
```

(c) Replace the entire `{/* Nav */}` `<nav className="landing-nav"> … </nav>` block (currently lines ~315-338) with:

```tsx
      {/* Nav */}
      <SiteHeader />
```

(d) Replace the entire `{/* Footer */}` `<footer className="landing-footer"> … </footer>` block (currently lines ~1094-1125) with:

```tsx
      {/* Footer */}
      <SiteFooter />
```

- [ ] **Step 10: Append the marketing sub-page offset class to `Landing.css`**

Append to `frontend/src/pages/Landing.css`:

```css
/* Standalone marketing sub-pages (About, Pricing) render the fixed .landing-nav,
   so their body needs top offset to clear it. */
.marketing-page {
  padding-top: 100px;
  padding-bottom: 64px;
  min-height: 100vh;
}
```

- [ ] **Step 11: Typecheck + full frontend test run**

Run: `cd frontend && npx tsc --noEmit && npx vitest --run src/components/site`
Expected: no type errors; both site tests PASS. (Nav/footer links to `/about`, `/pricing`, `/terms`, `/cookies` 404 until Tasks 2-4 add the routes — expected mid-plan.)

- [ ] **Step 12: Commit**

```bash
git add frontend/src/components/site frontend/src/pages/Landing.tsx frontend/src/pages/Landing.css
git commit -m "refactor(site): extract SiteHeader/SiteFooter, add hash-scroll, wire real footer links"
```

---

### Task 2: `PricingTiers` component + Landing teaser + `/pricing` page

**Files:**
- Create: `frontend/src/components/PricingTiers.tsx`
- Create: `frontend/src/components/PricingTiers.test.tsx`
- Create: `frontend/src/pages/Pricing.tsx`
- Modify: `frontend/src/pages/Landing.tsx` (replace inline pricing section @~1004-1055 with the teaser)
- Modify: `frontend/src/main.tsx` (add `/pricing` route)

**Interfaces:**
- Consumes: `SiteHeader`, `SiteFooter` (Task 1).
- Produces: `PricingTiers` — `export default function PricingTiers({ variant }: { variant?: "teaser" | "full" })`. Renders exactly two `.pricing-card`s (Free, Pro featured). `Pricing` page default export at route `/pricing`.

- [ ] **Step 1: Write the failing `PricingTiers` test**

Create `frontend/src/components/PricingTiers.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PricingTiers from "./PricingTiers";

test("renders Free and Pro only, Pro at $9.99 CAD, no Lifetime", () => {
  render(<MemoryRouter><PricingTiers /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Free" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Lifetime" })).toBeNull();
  expect(screen.getByText("$9.99")).toBeInTheDocument();
  expect(screen.getByText(/CAD/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest --run src/components/PricingTiers.test.tsx`
Expected: FAIL — cannot resolve `./PricingTiers`.

- [ ] **Step 3: Create `PricingTiers.tsx`**

```tsx
import { useNavigate } from "react-router-dom";

interface Tier {
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  featured: boolean;
  badge?: string;
}

const TIERS: Tier[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "/month",
    features: ["10 auto-applies per day", "Basic job matching", "Application tracker", "1 resume profile"],
    cta: "Get started",
    featured: false,
  },
  {
    name: "Pro",
    price: "$9.99",
    cadence: "CAD / month",
    features: [
      "Unlimited auto-applies",
      "AI screening answers",
      "Resume tailoring per job",
      "Cover letter generation",
      "Priority AI processing",
      "Advanced match scoring",
    ],
    cta: "Get started",
    featured: true,
    badge: "Most Popular",
  },
];

/** Free + Pro pricing cards. Single source of truth for the home teaser and the
 *  /pricing page. Display-only — CTAs route to sign-up (billing is not wired). */
export default function PricingTiers({ variant = "full" }: { variant?: "teaser" | "full" }) {
  const navigate = useNavigate();
  return (
    <div className={`pricing-grid pricing-grid-${variant}`}>
      {TIERS.map((tier) => (
        <div key={tier.name} className={`pricing-card${tier.featured ? " pricing-featured" : ""}`}>
          {tier.badge && <div className="pricing-badge">{tier.badge}</div>}
          <h3>{tier.name}</h3>
          <div className="pricing-price">{tier.price}<span>{tier.cadence}</span></div>
          <ul className="pricing-features">
            {tier.features.map((f) => <li key={f}>✓ {f}</li>)}
          </ul>
          {/* Billing is not wired yet — CTA routes to sign-up (display-only pricing). */}
          <button
            className={`${tier.featured ? "btn-cta btn-lg" : "btn-outline-lg"} w-full`}
            onClick={() => navigate("/sign-up")}
          >
            {tier.cta}
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd frontend && npx vitest --run src/components/PricingTiers.test.tsx`
Expected: PASS.

- [ ] **Step 5: Swap the Landing pricing section to the teaser**

In `frontend/src/pages/Landing.tsx`, add to imports:

```tsx
import PricingTiers from "../components/PricingTiers";
```

Replace the whole Pricing `<AnimatedSection …>` block (currently lines ~1004-1055, the `{/* Pricing */}` section containing the three `StaggerItem` cards) with:

```tsx
      {/* Pricing */}
      <AnimatedSection animation="fadeUp">
        <section className="section" id="pricing">
          <h2 className="section-title">Simple Pricing</h2>
          <p className="section-sub">Start free, upgrade when you're ready. Prices in CAD.</p>
          <PricingTiers variant="teaser" />
          <div style={{ textAlign: "center", marginTop: 24 }}>
            <button className="btn-ghost" onClick={() => navigate("/pricing")}>See full pricing →</button>
          </div>
        </section>
      </AnimatedSection>
```

(Leaves the `id="pricing"` anchor intact for any lingering references; the nav points to `/pricing`.)

- [ ] **Step 6: Create the `/pricing` page**

Create `frontend/src/pages/Pricing.tsx`:

```tsx
import SiteHeader from "../components/site/SiteHeader";
import SiteFooter from "../components/site/SiteFooter";
import PricingTiers from "../components/PricingTiers";
import "./Landing.css";

export default function Pricing() {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="marketing-page">
        <section className="section">
          <h1 className="section-title">Simple Pricing</h1>
          <p className="section-sub">Start free, upgrade when you're ready. Prices in CAD.</p>
          <PricingTiers variant="full" />
          <div className="pricing-faq" style={{ maxWidth: 640, margin: "48px auto 0" }}>
            <h2 className="section-title" style={{ fontSize: "1.5rem" }}>Pricing FAQ</h2>
            <p><strong>Is there a free plan?</strong> Yes — Free includes 10 auto-applies per day, basic job matching, the application tracker, and one resume profile.</p>
            <p><strong>What does Pro cost?</strong> Pro is $9.99 CAD per month and unlocks unlimited auto-applies, AI screening answers, per-job resume tailoring, cover letters, and priority AI processing.</p>
            <p><strong>Can I cancel anytime?</strong> Yes — Pro is month-to-month with no long-term commitment.</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 7: Add the `/pricing` route**

In `frontend/src/main.tsx`, add the import next to the other page imports:

```tsx
import Pricing from "./pages/Pricing";
```

Add the route inside `<Routes>` next to the other public routes (e.g. after the `/support` route):

```tsx
          <Route path="/pricing" element={<Pricing />} />
```

- [ ] **Step 8: Typecheck, build, test**

Run: `cd frontend && npx tsc --noEmit && npx vitest --run src/components/PricingTiers.test.tsx`
Expected: no type errors; PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/PricingTiers.tsx frontend/src/components/PricingTiers.test.tsx frontend/src/pages/Pricing.tsx frontend/src/pages/Landing.tsx frontend/src/main.tsx
git commit -m "feat(pricing): two-tier Free/Pro (\$9.99 CAD) PricingTiers, home teaser + /pricing page"
```

---

### Task 3: About page + route

**Files:**
- Create: `frontend/src/pages/About.tsx`
- Modify: `frontend/src/main.tsx` (add `/about` route)

**Interfaces:**
- Consumes: `SiteHeader`, `SiteFooter` (Task 1).
- Produces: `About` default export at route `/about`.

- [ ] **Step 1: Create `About.tsx`**

```tsx
import SiteHeader from "../components/site/SiteHeader";
import SiteFooter from "../components/site/SiteFooter";
import "./Landing.css";

export default function About() {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="marketing-page">
        <section className="section" style={{ maxWidth: 760, margin: "0 auto" }}>
          <h1 className="section-title">About Tailrd</h1>
          <p className="section-sub">Apply smarter, not harder.</p>
          <p>
            Tailrd is an AI-powered job-search assistant built for interns and new
            grads. It tailors your résumé to each role, generates cover letters,
            matches you with jobs that fit your real skills, and auto-fills
            applications across the web — so you spend your time preparing for
            interviews instead of retyping the same fields.
          </p>
          <h2 style={{ marginTop: 32 }}>Why we built it</h2>
          <p>
            Early-career job seekers send hundreds of applications, each demanding
            the same tedious data entry and subtle résumé tweaks. We built Tailrd to
            automate the busywork while keeping you in control of every submission.
          </p>
          <h2 style={{ marginTop: 32 }}>Privacy first</h2>
          <p>
            Your résumé and profile are used only to help you apply. We never sell
            your personal information. Read our <a href="/privacy">Privacy Policy</a> and{" "}
            <a href="/cookies">Cookie Policy</a> for details.
          </p>
          <h2 style={{ marginTop: 32 }}>Get in touch</h2>
          <p>
            Questions or feedback? Email us at{" "}
            <a href="mailto:support@tailrd.ca">support@tailrd.ca</a>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 2: Add the `/about` route**

In `frontend/src/main.tsx`, add:

```tsx
import About from "./pages/About";
```

and inside `<Routes>`:

```tsx
          <Route path="/about" element={<About />} />
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/About.tsx frontend/src/main.tsx
git commit -m "feat(site): add /about page"
```

---

### Task 4: Terms of Service + Cookie Policy pages + routes

**Files:**
- Create: `frontend/src/pages/Terms.tsx`
- Create: `frontend/src/pages/Cookies.tsx`
- Modify: `frontend/src/main.tsx` (add `/terms` and `/cookies` routes)

**Interfaces:**
- Consumes: existing `legal-page` / `legal-doc` / `legal-title` / `legal-updated` / `legal-brand` classes from `src/privacy.css` (same pattern as `pages/Privacy.tsx`).
- Produces: `Terms` and `Cookies` default exports at `/terms` and `/cookies`.

- [ ] **Step 1: Create `Terms.tsx`**

```tsx
import { Link } from "react-router-dom";
import "../privacy.css";

/** Public Terms of Service (route: /terms). Reuses the legal reading layout. */
export default function Terms() {
  return (
    <div className="legal-page">
      <div className="legal-doc">
        <Link to="/" className="legal-brand" aria-label="Back to home">
          <img src="/logo-icon.png" alt="" className="legal-brand-img" />
          <span>Tailrd</span>
        </Link>
        <h1 className="legal-title">Terms of Service</h1>
        <p className="legal-updated">Last updated July 10, 2026</p>

        <p>
          These Terms of Service (“Terms”) govern your access to and use of
          Tailrd (“we,” “us,” or “our”), including our website at{" "}
          <a href="https://www.tailrd.ca">www.tailrd.ca</a> and our browser
          extension (collectively, the “Services”). By creating an account or
          using the Services, you agree to these Terms. If you do not agree, do
          not use the Services.
        </p>

        <h2>1. Eligibility &amp; accounts</h2>
        <p>
          You must be at least 16 years old to use the Services. You are
          responsible for the accuracy of the information you provide and for
          safeguarding your account credentials. You are responsible for all
          activity that occurs under your account.
        </p>

        <h2>2. Acceptable use</h2>
        <p>
          You agree to use the Services only for lawful purposes and in
          accordance with these Terms. You will not misuse the Services,
          interfere with their operation, attempt to access them using a method
          other than the interfaces we provide, or use them to submit false,
          misleading, or unauthorized job applications.
        </p>

        <h2>3. Your content</h2>
        <p>
          You retain ownership of the résumés, profile data, and other content
          you provide (“Your Content”). You grant us a limited license to
          process Your Content solely to operate and provide the Services to you,
          as described in our <a href="/privacy">Privacy Policy</a>.
        </p>

        <h2>4. AI-generated output</h2>
        <p>
          The Services use AI to tailor résumés, draft cover letters, and answer
          application questions. AI output may contain errors. You are
          responsible for reviewing all output before submitting any application,
          and you remain solely responsible for the applications you submit.
        </p>

        <h2>5. Subscriptions &amp; pricing</h2>
        <p>
          Paid plans, where offered, are billed on the cadence shown at checkout
          and prices are stated in Canadian dollars (CAD). Pricing displayed on
          the site is subject to change. Where required by law, you may have
          rights to cancel or obtain a refund.
        </p>

        <h2>6. Third-party services</h2>
        <p>
          The Services interact with third-party job boards and applicant
          tracking systems that we do not control. We are not responsible for the
          availability, accuracy, or policies of those third parties, and your
          use of them may be subject to their own terms.
        </p>

        <h2>7. Disclaimers</h2>
        <p>
          The Services are provided “as is” and “as available” without warranties
          of any kind, whether express or implied, including fitness for a
          particular purpose. We do not warrant that the Services will be
          uninterrupted, error-free, or that they will result in any job offer or
          interview.
        </p>

        <h2>8. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, Tailrd will not be liable for
          any indirect, incidental, special, consequential, or punitive damages,
          or any loss of data, opportunities, or profits, arising out of or
          related to your use of the Services.
        </p>

        <h2>9. Termination</h2>
        <p>
          You may stop using the Services at any time. We may suspend or terminate
          your access if you violate these Terms or use the Services in a way that
          could cause harm to us or others.
        </p>

        <h2>10. Governing law</h2>
        <p>
          {/* OWNER TO CONFIRM province — Privacy references Quebec (Law 25). */}
          These Terms are governed by the laws of the Province of Quebec and the
          federal laws of Canada applicable therein, without regard to conflict
          of laws principles.
        </p>

        <h2>11. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. When we do, we will revise
          the “Last updated” date above. Your continued use of the Services after
          changes take effect constitutes acceptance of the revised Terms.
        </p>

        <h2>12. Contact</h2>
        <p>
          Questions about these Terms? Contact us at{" "}
          <a href="mailto:support@tailrd.ca">support@tailrd.ca</a>.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `Cookies.tsx`**

```tsx
import { Link } from "react-router-dom";
import "../privacy.css";

/** Public Cookie Policy (route: /cookies). Reuses the legal reading layout. */
export default function Cookies() {
  return (
    <div className="legal-page">
      <div className="legal-doc">
        <Link to="/" className="legal-brand" aria-label="Back to home">
          <img src="/logo-icon.png" alt="" className="legal-brand-img" />
          <span>Tailrd</span>
        </Link>
        <h1 className="legal-title">Cookie Policy</h1>
        <p className="legal-updated">Last updated July 10, 2026</p>

        <p>
          This Cookie Policy explains how Tailrd (“we,” “us,” or “our”) uses
          cookies and similar technologies when you visit{" "}
          <a href="https://www.tailrd.ca">www.tailrd.ca</a> or use our browser
          extension. It should be read together with our{" "}
          <a href="/privacy">Privacy Policy</a>.
        </p>

        <h2>What are cookies?</h2>
        <p>
          Cookies are small text files stored on your device by your browser.
          Similar technologies such as browser local storage can also store small
          amounts of data on your device.
        </p>

        <h2>How we use them</h2>
        <p>
          We use only what is necessary to sign you in and keep you signed in. We
          do <strong>not</strong> use advertising or third-party tracking cookies.
        </p>
        <ul>
          <li>
            <strong>Essential authentication cookie</strong> — a secure, HttpOnly
            cookie named <code>refresh_token</code> that keeps your session active
            so you don't have to sign in on every visit. It is scoped to our
            authentication endpoints and cannot be read by JavaScript.
          </li>
          <li>
            <strong>Local storage</strong> — we store a short-lived access token
            in your browser's local storage to authorize requests while you use
            the app. It is cleared when you sign out.
          </li>
        </ul>

        <h2>Managing cookies</h2>
        <p>
          Because these technologies are strictly necessary to provide the
          Services, disabling them will prevent you from signing in. You can clear
          cookies and local storage at any time through your browser settings;
          doing so will sign you out.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          If we introduce analytics or other non-essential cookies in the future,
          we will update this policy and, where required by law, ask for your
          consent first.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this Cookie Policy? Contact us at{" "}
          <a href="mailto:support@tailrd.ca">support@tailrd.ca</a>.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the `/terms` and `/cookies` routes**

In `frontend/src/main.tsx`, add:

```tsx
import Terms from "./pages/Terms";
import Cookies from "./pages/Cookies";
```

and inside `<Routes>`:

```tsx
          <Route path="/terms" element={<Terms />} />
          <Route path="/cookies" element={<Cookies />} />
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Terms.tsx frontend/src/pages/Cookies.tsx frontend/src/main.tsx
git commit -m "feat(legal): add Terms of Service and Cookie Policy pages"
```

---

### Task 5: Backend — LinkedIn OIDC router (`/auth/linkedin/*`)

**Files:**
- Create: `backend/routers/auth_linkedin.py`
- Create: `backend/tests/test_linkedin_auth.py`
- Modify: `backend/main.py` (import + `include_router` @~30 and ~139)

**Interfaces:**
- Consumes: `_set_refresh_cookie`, `IS_PRODUCTION` from `backend/routers/auth.py`; `create_refresh_token` from `backend/auth/tokens.py`; `session_service.start_session`; `User`; `get_db`.
- Produces: `router` mounted at prefix `/auth/linkedin` → routes `GET /auth/linkedin/start`, `GET /auth/linkedin/callback`. Module-level `_exchange_code(code) -> dict` and `_fetch_userinfo(access_token) -> dict` (monkeypatch seams for tests). Callback redirects to `"/linkedin/complete?next=<safe path>"`.

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_linkedin_auth.py`:

```python
"""Tests for the LinkedIn OIDC auth flow (/auth/linkedin/*)."""
import backend.routers.auth_linkedin as li
from backend.db.models import User


def _prime_env(monkeypatch):
    monkeypatch.setattr(li, "LINKEDIN_CLIENT_ID", "test-client")
    monkeypatch.setattr(li, "LINKEDIN_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(li, "LINKEDIN_REDIRECT_URI", "https://www.tailrd.ca/auth/linkedin/callback")


def test_start_redirects_and_sets_state_cookie(client, monkeypatch):
    _prime_env(monkeypatch)
    resp = client.get("/auth/linkedin/start", params={"next": "/app"}, follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("https://www.linkedin.com/oauth/v2/authorization")
    assert "li_oauth_state" in resp.cookies


def test_start_500_when_unconfigured(client, monkeypatch):
    monkeypatch.setattr(li, "LINKEDIN_CLIENT_ID", "")
    resp = client.get("/auth/linkedin/start", follow_redirects=False)
    assert resp.status_code == 500


def test_callback_rejects_state_mismatch(client, monkeypatch):
    _prime_env(monkeypatch)
    resp = client.get(
        "/auth/linkedin/callback",
        params={"code": "abc", "state": "attacker"},
        cookies={"li_oauth_state": "real", "li_oauth_next": "/app"},
        follow_redirects=False,
    )
    assert resp.status_code == 401


def test_callback_creates_user_sets_cookie_and_redirects(client, db_session, monkeypatch):
    _prime_env(monkeypatch)
    monkeypatch.setattr(li, "_exchange_code", lambda code: {"access_token": "tok"})
    monkeypatch.setattr(li, "_fetch_userinfo", lambda tok: {
        "email": "grad@example.com", "given_name": "Grad", "family_name": "Student",
        "picture": "https://img.example/p.jpg", "email_verified": True,
    })
    resp = client.get(
        "/auth/linkedin/callback",
        params={"code": "abc", "state": "match"},
        cookies={"li_oauth_state": "match", "li_oauth_next": "/app"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/linkedin/complete")
    assert "refresh_token" in resp.cookies
    user = db_session.query(User).filter(User.email == "grad@example.com").first()
    assert user is not None
    assert user.auth_provider == "linkedin"
    assert user.email_verified is True
```

- [ ] **Step 2: Run and confirm failure**

Run: `python -m pytest backend/tests/test_linkedin_auth.py -q`
Expected: FAIL / ERROR — `backend.routers.auth_linkedin` does not exist.

- [ ] **Step 3: Create `auth_linkedin.py`**

```python
"""
LinkedIn "Sign In with LinkedIn using OpenID Connect" — authorization-code flow.

Unlike Google (which returns an ID token to the browser via the GIS SDK),
LinkedIn requires a server-side code exchange with a client secret:

  GET /auth/linkedin/start     -> 302 to LinkedIn authorize (sets state cookie)
  GET /auth/linkedin/callback  -> verify state, exchange code, upsert user,
                                  set the refresh cookie, 302 to the SPA
                                  /linkedin/complete

The SPA landing (/linkedin/complete) hydrates the session from the refresh
cookie via POST /auth/refresh, so the access token never appears in a URL.
NOTE: the SPA landing path must NOT be under /auth/* — vercel.json rewrites
/auth/(.*) to this API.
"""

import logging
import os
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.tokens import create_refresh_token
from backend.services import sessions as session_service
from backend.routers.auth import _set_refresh_cookie, IS_PRODUCTION

logger = logging.getLogger(__name__)
router = APIRouter()

LINKEDIN_CLIENT_ID = os.getenv("LINKEDIN_CLIENT_ID", "")
LINKEDIN_CLIENT_SECRET = os.getenv("LINKEDIN_CLIENT_SECRET", "")
LINKEDIN_REDIRECT_URI = os.getenv("LINKEDIN_REDIRECT_URI", "")

LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization"
LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"

STATE_COOKIE = "li_oauth_state"
NEXT_COOKIE = "li_oauth_next"
# SPA landing that hydrates the session — deliberately NOT under /auth/*.
COMPLETE_PATH = "/linkedin/complete"


def _safe_next(next_path):
    """Only honor same-origin absolute paths (mirrors the frontend safeNextPath)."""
    if next_path and next_path.startswith("/") and not next_path.startswith("//"):
        return next_path
    return "/app"


def _exchange_code(code: str) -> dict:
    """Exchange an authorization code for LinkedIn tokens (returns token JSON)."""
    with httpx.Client(timeout=10.0) as client:
        resp = client.post(
            LINKEDIN_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": LINKEDIN_REDIRECT_URI,
                "client_id": LINKEDIN_CLIENT_ID,
                "client_secret": LINKEDIN_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    resp.raise_for_status()
    return resp.json()


def _fetch_userinfo(access_token: str) -> dict:
    """Fetch OIDC userinfo claims for the signed-in LinkedIn member."""
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(
            LINKEDIN_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    return resp.json()


@router.get("/start")
def linkedin_start(next: str = "/app"):
    """Begin OAuth: set a CSRF state cookie and redirect to LinkedIn."""
    if not (LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET and LINKEDIN_REDIRECT_URI):
        logger.error("LinkedIn OAuth env vars are not set")
        raise HTTPException(status_code=500, detail="LinkedIn OAuth not configured on server")

    state = secrets.token_urlsafe(32)
    params = {
        "response_type": "code",
        "client_id": LINKEDIN_CLIENT_ID,
        "redirect_uri": LINKEDIN_REDIRECT_URI,
        "scope": "openid profile email",
        "state": state,
    }
    redirect = RedirectResponse(url=f"{LINKEDIN_AUTHORIZE_URL}?{urlencode(params)}", status_code=302)
    # samesite="lax" so the cookie is returned on LinkedIn's top-level GET
    # redirect back to /callback (a strict cookie would be dropped there).
    redirect.set_cookie(STATE_COOKIE, state, httponly=True, secure=IS_PRODUCTION,
                        samesite="lax", max_age=600, path="/auth")
    redirect.set_cookie(NEXT_COOKIE, _safe_next(next), httponly=True, secure=IS_PRODUCTION,
                        samesite="lax", max_age=600, path="/auth")
    return redirect


@router.get("/callback")
def linkedin_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    li_oauth_state: str = Cookie(default=None),
    li_oauth_next: str = Cookie(default=None),
    db: Session = Depends(get_db),
):
    """Verify state, exchange the code, upsert the user, set the session, redirect."""
    if error:
        logger.warning("LinkedIn returned an error: %s", error)
        raise HTTPException(status_code=401, detail="LinkedIn sign-in was cancelled")
    if not code or not state or not li_oauth_state or state != li_oauth_state:
        logger.warning("LinkedIn state mismatch or missing code")
        raise HTTPException(status_code=401, detail="Invalid or expired LinkedIn sign-in state")

    try:
        token_json = _exchange_code(code)
    except httpx.HTTPError as e:
        logger.error("LinkedIn token exchange failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not complete LinkedIn sign-in")

    access = token_json.get("access_token")
    if not access:
        raise HTTPException(status_code=502, detail="LinkedIn did not return an access token")

    try:
        info = _fetch_userinfo(access)
    except httpx.HTTPError as e:
        logger.error("LinkedIn userinfo fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not read LinkedIn profile")

    email = info.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="LinkedIn account has no email")

    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            email=email,
            hashed_password=None,
            auth_provider="linkedin",
            first_name=info.get("given_name", ""),
            last_name=info.get("family_name", ""),
            profile_image_url=info.get("picture", ""),
            email_verified=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        logger.info("New LinkedIn user registered: %s", user.email)
    else:
        if not user.profile_image_url and info.get("picture"):
            user.profile_image_url = info["picture"]
        if not user.first_name and info.get("given_name"):
            user.first_name = info["given_name"]
        if not user.last_name and info.get("family_name"):
            user.last_name = info["family_name"]
        if user.auth_provider == "local":
            user.auth_provider = "linkedin"
        if not user.email_verified:
            user.email_verified = True
        db.commit()
        db.refresh(user)

    web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, client="web", sid=web_session.sid)

    next_path = _safe_next(li_oauth_next)
    redirect = RedirectResponse(url=f"{COMPLETE_PATH}?next={next_path}", status_code=302)
    _set_refresh_cookie(redirect, refresh_tok)
    redirect.delete_cookie(STATE_COOKIE, path="/auth")
    redirect.delete_cookie(NEXT_COOKIE, path="/auth")
    return redirect
```

- [ ] **Step 4: Register the router in `backend/main.py`**

Change the import on line ~30 from:

```python
from backend.routers import auth, auth_extension, extension, tailor, cover_letter
```

to:

```python
from backend.routers import auth, auth_extension, extension, tailor, cover_letter, auth_linkedin
```

Add the include after the `auth_extension` include (line ~139):

```python
app.include_router(auth_linkedin.router, prefix="/auth/linkedin", tags=["auth-linkedin"])
```

- [ ] **Step 5: Run the tests — expect PASS**

Run: `python -m pytest backend/tests/test_linkedin_auth.py -q`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/auth_linkedin.py backend/tests/test_linkedin_auth.py backend/main.py
git commit -m "feat(auth): LinkedIn OIDC sign-in (server-side auth-code flow)"
```

---

### Task 6: Frontend — LinkedIn button, completion page, session hydration

**Files:**
- Modify: `frontend/src/auth/AuthContext.tsx` (add `completeOAuthRedirect` to the interface)
- Modify: `frontend/src/auth/AuthProvider.tsx` (implement it + add to value)
- Create: `frontend/src/auth/LinkedInSignInButton.tsx`
- Create: `frontend/src/auth/LinkedInSignInButton.test.tsx`
- Create: `frontend/src/pages/LinkedInComplete.tsx`
- Modify: `frontend/src/pages/SignIn.tsx` (render the button)
- Modify: `frontend/src/pages/SignUp.tsx` (render the button)
- Modify: `frontend/src/main.tsx` (add `/linkedin/complete` route)
- Modify: `frontend/src/index.css` (append `.linkedin-signin-button` styles)

**Interfaces:**
- Consumes: `useAuth()`, `safeNextPath`, backend `/auth/linkedin/start`, `/auth/refresh`, `/auth/me`.
- Produces: `AuthContextValue.completeOAuthRedirect: () => Promise<void>`; named export `LinkedInSignInButton`; `LinkedInComplete` default export at route `/linkedin/complete`.

- [ ] **Step 1: Add `completeOAuthRedirect` to the context type**

In `frontend/src/auth/AuthContext.tsx`, inside `interface AuthContextValue`, after `loginWithGoogle`, add:

```tsx
  completeOAuthRedirect: () => Promise<void>;
```

- [ ] **Step 2: Implement it in `AuthProvider.tsx`**

In `frontend/src/auth/AuthProvider.tsx`, after the `loginWithGoogle` `useCallback` block, add:

```tsx
  const completeOAuthRedirect = useCallback(async () => {
    // The backend OAuth callback already set the HttpOnly refresh cookie. Trade
    // it for an access token, store it, and load the profile — same end state as
    // loginWithGoogle, but the token was never exposed in a URL.
    const { data } = await api.post("/auth/refresh", {});
    localStorage.setItem("access_token", data.access_token);
    const { data: profile } = await api.get("/auth/me");
    setUser(profile);
  }, []);
```

Then add `completeOAuthRedirect` to the `value` object (next to `loginWithGoogle`):

```tsx
    loginWithGoogle,
    completeOAuthRedirect,
```

- [ ] **Step 3: Write the failing button test**

Create `frontend/src/auth/LinkedInSignInButton.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LinkedInSignInButton } from "./LinkedInSignInButton";

afterEach(() => vi.unstubAllEnvs());

test("hidden when VITE_LINKEDIN_ENABLED is not 'true'", () => {
  vi.stubEnv("VITE_LINKEDIN_ENABLED", "");
  const { container } = render(<MemoryRouter><LinkedInSignInButton /></MemoryRouter>);
  expect(container).toBeEmptyDOMElement();
});

test("renders a link to the backend start endpoint when enabled", () => {
  vi.stubEnv("VITE_LINKEDIN_ENABLED", "true");
  render(
    <MemoryRouter initialEntries={["/sign-in?next=%2Fapp"]}>
      <LinkedInSignInButton />
    </MemoryRouter>
  );
  const link = screen.getByRole("link", { name: /continue with linkedin/i });
  expect(link.getAttribute("href")).toContain("/auth/linkedin/start");
});
```

- [ ] **Step 4: Run it and confirm failure**

Run: `cd frontend && npx vitest --run src/auth/LinkedInSignInButton.test.tsx`
Expected: FAIL — cannot resolve `./LinkedInSignInButton`.

- [ ] **Step 5: Create `LinkedInSignInButton.tsx`**

```tsx
import { useSearchParams } from "react-router-dom";
import { LinkedinLogo } from "@phosphor-icons/react";

/**
 * "Continue with LinkedIn" — a full-page navigation to the backend OAuth start
 * endpoint (it leaves the SPA, so a plain <a> is correct). Hidden unless
 * VITE_LINKEDIN_ENABLED === "true", mirroring the Google button's gating.
 * The "or" divider is provided by <GoogleSignInButton /> above it.
 */
export function LinkedInSignInButton() {
  const [searchParams] = useSearchParams();
  const enabled = import.meta.env.VITE_LINKEDIN_ENABLED === "true";
  if (!enabled) return null;
  const next = searchParams.get("next") || "/app";
  const href = `/auth/linkedin/start?next=${encodeURIComponent(next)}`;
  return (
    <a className="linkedin-signin-button" href={href} aria-label="Continue with LinkedIn">
      <LinkedinLogo size={18} weight="fill" />
      <span>Continue with LinkedIn</span>
    </a>
  );
}
```

- [ ] **Step 6: Run the button test — expect PASS**

Run: `cd frontend && npx vitest --run src/auth/LinkedInSignInButton.test.tsx`
Expected: 2 passed.

- [ ] **Step 7: Create the completion page**

Create `frontend/src/pages/LinkedInComplete.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { safeNextPath } from "../auth/nextRedirect";

/** Landing page after the LinkedIn OAuth callback (route: /linkedin/complete).
 *  Hydrates the session from the refresh cookie, then redirects into the app. */
export default function LinkedInComplete() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { completeOAuthRedirect } = useAuth();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    completeOAuthRedirect()
      .then(() => { if (!cancelled) navigate(safeNextPath(searchParams.get("next")), { replace: true }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [completeOAuthRedirect, navigate, searchParams]);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/logo-icon.png" alt="Tailrd" className="auth-brand-logo" />
        </div>
        {failed ? (
          <div className="auth-head">
            <h1 className="auth-title">Sign-in failed</h1>
            <p className="auth-subtitle">We couldn't complete your LinkedIn sign-in.</p>
            <Link to="/sign-in" className="auth-link">Back to sign in</Link>
          </div>
        ) : (
          <div className="auth-head">
            <h1 className="auth-title">Signing you in…</h1>
            <p className="auth-subtitle">One moment while we finish connecting your LinkedIn account.</p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Render the button on Sign In and Sign Up**

In `frontend/src/pages/SignIn.tsx`: add the import after the Google one:

```tsx
import { LinkedInSignInButton } from "../auth/LinkedInSignInButton";
```

and directly after `<GoogleSignInButton />` add:

```tsx
        <LinkedInSignInButton />
```

Repeat the same two edits in `frontend/src/pages/SignUp.tsx`.

- [ ] **Step 9: Add the `/linkedin/complete` route**

In `frontend/src/main.tsx`, add:

```tsx
import LinkedInComplete from "./pages/LinkedInComplete";
```

and inside `<Routes>`:

```tsx
          <Route path="/linkedin/complete" element={<LinkedInComplete />} />
```

- [ ] **Step 10: Append LinkedIn button styles to `index.css`**

Append to `frontend/src/index.css`:

```css
/* LinkedIn SSO button (auth pages) */
.linkedin-signin-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 320px;
  max-width: 100%;
  margin: 12px auto 0;
  padding: 10px 16px;
  border-radius: 9999px;
  background: #0a66c2;
  color: #fff;
  font-weight: 600;
  font-size: 0.95rem;
  text-decoration: none;
  cursor: pointer;
}
.linkedin-signin-button:hover { background: #004182; }
```

- [ ] **Step 11: Typecheck + run the auth tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest --run src/auth/LinkedInSignInButton.test.tsx`
Expected: no type errors; 2 passed.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/auth/AuthContext.tsx frontend/src/auth/AuthProvider.tsx frontend/src/auth/LinkedInSignInButton.tsx frontend/src/auth/LinkedInSignInButton.test.tsx frontend/src/pages/LinkedInComplete.tsx frontend/src/pages/SignIn.tsx frontend/src/pages/SignUp.tsx frontend/src/main.tsx frontend/src/index.css
git commit -m "feat(auth): LinkedIn sign-in button + completion page + session hydration"
```

---

### Task 7: Full verification — tests, build, dead-link audit, env docs

**Files:**
- Modify: `.env` (repo root) — **local, untracked** (`.env`, `.env.*` are gitignored). Add local LinkedIn dev vars here for testing. **Never commit this file** — it holds real secrets. Canonical env documentation lives in the spec's Section E.

**Interfaces:** none (verification task — no code commits unless a fix is required).

- [ ] **Step 1: Full frontend test + typecheck + production build**

Run: `cd frontend && npx tsc --noEmit && npx vitest --run && npm run build`
Expected: all tests pass; `tsc && vite build` completes with no errors and emits `frontend/dist`.

- [ ] **Step 2: Full backend test run**

Run: `python -m pytest backend/tests/test_linkedin_auth.py backend/tests/test_auth_properties.py -q`
Expected: all pass. (Full suite: `python -m pytest -q` — note the known pre-existing flaky/baseline failures documented in memory are unrelated to this change.)

- [ ] **Step 3: Dead-link audit**

Run: `cd frontend && grep -rn 'href="#"' src/components/site src/pages/Landing.tsx || echo "no dead links"`
Expected: `no dead links`.

- [ ] **Step 4: Add env vars to the local (untracked) root `.env`**

Append these keys to the repo-root `.env` for local dev. This file is **gitignored and must never be committed** (it already contains real secrets). The button stays hidden until `VITE_LINKEDIN_ENABLED=true`:

```bash
# LinkedIn OIDC (see docs/superpowers/specs/2026-07-10-marketing-pages-linkedin-pricing-design.md §E for setup)
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=http://localhost:5173/auth/linkedin/callback
VITE_LINKEDIN_ENABLED=false
```

Confirm it is NOT staged: `git status --porcelain .env` must print nothing (gitignored).

- [ ] **Step 5: Manual smoke checklist (record results)**

With `cd frontend && npm run dev` and the backend running on :8000:
- Visit `/` → nav renders via `SiteHeader`; footer via `SiteFooter`; no Blog/Careers; About/Terms/Cookies/Pricing links work.
- From `/about`, click nav "Features" → lands on `/` and scrolls to the Features section.
- `/pricing` shows Free + Pro ($9.99 CAD), no Lifetime; home teaser matches and "See full pricing →" navigates to `/pricing`.
- `/terms` and `/cookies` render in the legal layout with a working "Back to home".
- Sign-in/up: LinkedIn button hidden with `VITE_LINKEDIN_ENABLED=false`; shown when `true`. (Full LinkedIn round-trip requires the owner's real app credentials — see the spec's Section E.)

- [ ] **Step 6: No commit for env**

The root `.env` is gitignored and must not be committed. Env setup is documented in the spec's Section E. Task 7 produces a commit **only** if verification surfaced a code fix — in that case, `git add` the specific source files changed (never `.env`) and commit with a descriptive message.

---

## Self-Review

**Spec coverage:**
- Nav/footer → real pages: Tasks 1-4 (SiteHeader/SiteFooter link changes + About/Pricing/Terms/Cookies pages). Features/Results/FAQ kept as home sections with hash-scroll (Task 1). ✓
- Blog/Careers removed: Task 1 (SiteFooter omits them; footer test asserts their absence). ✓
- LinkedIn SSO (server flow, button gated, `/linkedin/complete`): Tasks 5-6. ✓
- Terms + Cookie Policy pages (legal layout): Task 4. ✓
- Pricing UI (Free + Pro $9.99 CAD, no Lifetime, teaser + `/pricing` tab, no billing): Task 2. ✓
- Home pricing teaser links to `/pricing`: Task 2 Step 5. ✓
- Owner LinkedIn setup + env gating: Task 7 Step 4 + spec §E. ✓

**Placeholder scan:** Legal copy is real (not lorem); the single owner-confirm item (governing-law province) is an explicit, marked decision, not a plan gap. No "TBD"/"handle errors"/"similar to Task N" left. ✓

**Type/name consistency:** `completeOAuthRedirect` defined in AuthContext (Task 6 Step 1), implemented in AuthProvider (Step 2), consumed in LinkedInComplete (Step 7). Backend `_exchange_code`/`_fetch_userinfo` defined in Task 5 Step 3 and monkeypatched by the same names in the Task 5 tests. `COMPLETE_PATH = "/linkedin/complete"` matches the frontend route added in Task 6 Step 9 and the constraint that it is not under `/auth/*`. `PricingTiers` prop `variant` used consistently. ✓
