# Chrome Web Store Submission — Tailrd v0.4.0

Everything below is ready to paste into the CWS developer dashboard
(https://chrome.google.com/webstore/devconsole).

## The package

- Zip: `chrome-extension/tailrd-extension-0.4.0.zip` — built by
  `node build.mjs && python scripts/make-store-zip.py` (run from
  `chrome-extension/`). The script strips the dev-only `key` field (the
  dashboard rejects manifests that carry it) and enforces the 132-char
  description limit, so a bad zip fails locally instead of at upload.
- Version `0.4.0`, MV3, no remote code (everything is bundled by esbuild; no
  eval, no CDN scripts). `dist/` keeps the `key`, so the locally-loaded
  unpacked extension keeps its pinned dev ID.

### Extension IDs — REQUIRED follow-up right after the first upload

The store assigns a NEW extension ID at first upload (it ignores dev keys),
and that ID is permanent for the item from then on. Two things depend on it:

1. **`EXTENSION_ALLOWED_IDS` (Vercel)** — as soon as the upload succeeds, copy
   the item ID from the dashboard (it's in the item's URL and details page) and
   set the var to BOTH ids, comma-separated:
   `apgogjfdpleeajnngkfkfekbddcpodkl,<store-id>` → redeploy. Until then the
   store build's "Connect account" fails closed (the dev/unpacked build keeps
   working via the first id).
2. **Web-app → extension bridge** (`frontend/src/lib/extensionBridge.ts`) —
   sends apply-intent to every id in its list. Add the store id to the default
   list (or set `VITE_EXTENSION_IDS=<dev-id>,<store-id>`) and redeploy so
   dashboard-initiated applies are tracked by the store build too.

You can do both immediately after upload — no need to wait for review.

## Before testers can use it (Vercel env — 2 minutes, REQUIRED)

Verified live on prod (2026-07-09): a fresh registration still gets
`email_verified: false` and `GET /api/extension/sync` → **403**. Until these two
vars are set, every beta tester is dead on arrival:

| Env var | Value | Effect |
|---|---|---|
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Unblocks unverified testers everywhere (web + extension). Reversible post-beta. |
| `EXTENSION_ALLOWED_IDS` | `apgogjfdpleeajnngkfkfekbddcpodkl` | Extension PKCE handshake fails closed in prod without it. |

Set both for **Production**, then redeploy (env changes need a redeploy to apply).

## Listing — basic fields

- **Name:** Tailrd — Job Application Autofill
- **Summary (132 chars max):**
  `Fills job application forms from the profile in your Tailrd account. You always review every answer and submit the form yourself.`
  (Must match `manifest.json`'s `description`. Keep it free of applicant-tracking-system
  brand names — a brand list here reads as keyword stuffing to review.)
- **Category:** Productivity → Workflow & Planning
- **Language:** English
- **Privacy policy URL:** `https://www.tailrd.ca/privacy` (live, returns 200)
- **Screenshots:** `store-previews/tailrd-1-autofill.png … tailrd-4-dashboard.png`
  (4 × 1280×800 — already the right size)
- **Small promo tile (440×280):** `store-previews/tailrd-promo-small-440x280.png`
- **Marquee promo tile (1400×560):** `store-previews/tailrd-promo-marquee-1400x560.png`
  (both 24-bit PNG, no alpha; regenerate with `node scripts/gen-promo-tiles.mjs`)

- **Description (long):**

```
Tailrd fills job application forms for you — accurately, and always under your control.

Applying online means retyping the same details into a new form for every role. Tailrd keeps that information in one profile and puts it into the form in front of you, so you can spend your time on the parts of the application that actually need you.

WHAT IT DOES
• Recognizes an application form when you open one, on company career sites and on the hiring platforms they run on, and offers to fill it.
• Fills the fields it can answer from your Tailrd profile: contact details, work history, education, links, work authorization, and screening questions.
• Works through applications that span several pages. You click once per page; if the site asks you to create an account first, Tailrd fills that step too.
• Answers dropdowns and multiple-choice questions only with options the form actually offers. If your profile does not answer a question, Tailrd leaves it blank for you to complete.
• Attaches the résumé from your account, and can generate a résumé or cover letter tailored to the job you are applying for.

WHAT IT NEVER DOES
• It never submits an application by itself. The final Submit is always yours.
• It never invents an answer. Every answer comes from your profile, or the field is left empty.
• Demographic (EEO) answers never leave your device — they are stored locally and filled locally.

You need a free Tailrd account (www.tailrd.ca) to sync your profile.
```

> **Do not reintroduce a list of applicant-tracking-system names here.** The v0.4.0
> draft was rejected under "Spam and Placement in the Store" (ref: Yellow Argon,
> 2026-07-11) for exactly that: the line naming ten ATS vendors was judged
> "excessive keywords in the item's description." Describe what the extension does;
> let the screenshots show where it runs.

## Privacy tab — permission justifications (paste per field)

- **Single purpose:** Tailrd autofills job-application forms from the user's own
  Tailrd profile and tracks the applications they choose to submit.
- **Host permissions (`http://*/*`, `https://*/*`, content script `<all_urls>` / all frames):**
  Job applications are hosted on tens of thousands of company-specific ATS
  domains (`boards.greenhouse.io`, `*.myworkdayjobs.com`, `jobs.lever.co`,
  company career sites, and embedded cross-origin iframes inside them). A fixed
  domain list cannot cover them; the content script must run where the
  application form actually renders, including inside iframes. The script only
  activates its UI when it recognizes an application form; captcha provider
  frames are explicitly excluded in the manifest.
- **storage:** Caches the user's profile for offline fills; stores device-local
  answers (including optional demographic answers that deliberately never leave
  the device) and per-site account-creation credentials the user saves.
- **scripting / activeTab:** Injects a small page-context helper
  (`mainWorld.js`) needed to drive framework-controlled widgets (React selects,
  Workday dropdowns) that ignore synthetic DOM events.
- **identity:** Signs the user into their Tailrd account with an OAuth-style
  PKCE handshake via `chrome.identity.launchWebAuthFlow` (no Google account
  data is accessed).
- **alarms:** Periodic profile re-sync and auth-token refresh while the browser
  is open.
- **Remote code:** None. All code ships in the package.

## Data-use disclosures (check these boxes)

Collected and transmitted to the developer's service (www.tailrd.ca), tied to
the user's account:
- Personally identifiable information (name, email, phone, address — the
  profile the user asks us to fill forms with)
- Professional information: work history, education, skills, résumé content
- Authentication information (account email; tokens)
- User activity: which fields/sites autofill succeeded or failed on
  (field labels and outcomes only — **never field values**)

NOT collected: browsing history, financial info, health info, location,
personal communications, keystrokes.

Certify: data is not sold; not used for unrelated purposes; not used for
creditworthiness.

## Pre-flight checklist (all verified 2026-07-09)

- [x] 679+ unit tests green; typecheck clean
- [x] e2e multi-page flow probe green (entry click → account creation →
      user-gated page turns → terminal Submit never clicked)
- [x] dist contains no `localhost` / dev URLs; API base is `https://www.tailrd.ca`
- [x] `externally_connectable` limited to tailrd.ca (localhost removed)
- [x] Icons 16/32/48/128 present; screenshots 1280×800
- [x] Privacy policy live at `/privacy`
- [x] Vercel: `REQUIRE_EMAIL_VERIFICATION=false` (verified live 2026-07-09: register → email_verified true)
- [x] Vercel: `EXTENSION_ALLOWED_IDS=apgogjfdpleeajnngkfkfekbddcpodkl` (verified live: authorize → 200)
- [x] Upload zip, paste listing + justifications, submit for review
- [x] **APPROVED + LIVE 2026-07-14.** Store-assigned id: `dadbhjlflnljgailcpgehdainjdmjeej`
      (the Store strips the manifest `key`, so this is NOT the dev id
      `apgogjfdpleeajnngkfkfekbddcpodkl` — both must be trusted everywhere).
      Listing: https://chromewebstore.google.com/detail/tailrd-%E2%80%94-job-application/dadbhjlflnljgailcpgehdainjdmjeej
- [x] Frontend: both ids baked into `extensionBridge.ts` `EXTENSION_IDS`, and the real
      listing URL into `extensionStore.ts` `CHROME_STORE_URL`. No env var needed.
- [ ] **BLOCKING — Vercel: `EXTENSION_ALLOWED_IDS` must become**
      `apgogjfdpleeajnngkfkfekbddcpodkl,dadbhjlflnljgailcpgehdainjdmjeej`
      → redeploy. `auth_extension.py:104` fails **closed** in production: until this is
      set, every user who installs from the Web Store and clicks Connect is rejected,
      because their redirect_uri is `https://dadbhj….chromiumapp.org/` and that id is
      not on the allowlist. The extension is DOA for store users until this lands.

## Test instructions (paste into the dashboard's "Test instructions" form)

A dedicated reviewer account exists on prod, pre-loaded with a full profile
and a résumé file (created 2026-07-10; password also below):

```
TEST ACCOUNT
Email: cws.reviewer@tailrd.ca
Password: Tailrd!Review2026
(Pre-loaded with a complete profile and resume. No email verification needed.)

SETUP (once)
1. Install the extension.
2. Click the Tailrd icon in the Chrome toolbar to open the side panel.
3. Click "Connect your Tailrd account" — a tailrd.ca sign-in window opens.
   Sign in with the credentials above. The panel syncs the profile automatically.

CORE FUNCTIONALITY (no real application is submitted)
4. Go to https://www.tailrd.ca/demo-apply — a demo job-application form.
5. Open the panel (toolbar icon) and click "Account Creation & Autofill".
6. Expected: the form fills from the signed-in profile within a few seconds
   (name, email, phone, address, work authorization…), and the resume file
   attaches where an upload field exists. Questions the profile cannot answer
   truthfully are left blank BY DESIGN — the extension never guesses.
7. The extension never submits an application by itself; the final Submit is
   always left to the user.

OPTIONAL — real ATS detection
Open any public Greenhouse or Lever job posting; the panel detects the
application form the same way. Please avoid pressing a real employer's final
Submit button — running Autofill itself is safe.

NOTES
- AI answers are grounded in the account profile; ungroundable fields stay empty.
- Demographic (EEO) answers are stored on-device only and never transmitted.
```

**Prerequisite:** the store-assigned extension ID must already be in
`EXTENSION_ALLOWED_IDS` (see "Extension IDs" above) or the reviewer's Connect
step fails closed.

## After review approval

1. Install from the store, sign in, run one real application end to end.
2. Flip `REQUIRE_EMAIL_VERIFICATION` back to `true` once email delivery
   (Resend) is configured post-beta.
