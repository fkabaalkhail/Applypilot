# Chrome Web Store Submission — Tailrd v0.4.0

Everything below is ready to paste into the CWS developer dashboard
(https://chrome.google.com/webstore/devconsole).

## The package

- Zip: `chrome-extension/tailrd-extension-0.4.0.zip` (manifest at zip root, built from `dist/`).
- Version `0.4.0`, MV3, no remote code (everything is bundled by esbuild; no eval, no CDN scripts).
- `manifest.json` **keeps the `key` field on purpose**: the Web Store derives the
  extension ID from it, so the published ID stays
  `apgogjfdpleeajnngkfkfekbddcpodkl` — the same ID already pinned in the
  backend's `EXTENSION_ALLOWED_IDS` and used by the PKCE
  `https://<id>.chromiumapp.org/` redirect. **Do not strip the key.**
  - Fallback: if the dashboard ever rejects the `key` field, upload without it,
    read the new ID the store assigns, and append it to `EXTENSION_ALLOWED_IDS`
    in Vercel (comma-separated — both IDs can stay allowed).

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
  `Autofill job applications on Greenhouse, Workday, Lever and 60+ ATSs from your Tailrd profile. Reviews with you — never auto-submits.`
- **Category:** Productivity → Workflow & Planning
- **Language:** English
- **Privacy policy URL:** `https://www.tailrd.ca/privacy` (live, returns 200)
- **Screenshots:** `store-previews/tailrd-1-autofill.png … tailrd-4-dashboard.png`
  (4 × 1280×800 — already the right size)

- **Description (long):**

```
Tailrd fills job applications for you — accurately, and always under your control.

WHAT IT DOES
• Detects application forms on Greenhouse, Lever, Workday, Ashby, BambooHR, SmartRecruiters, iCIMS, Jobvite, Taleo, SuccessFactors and 60+ other applicant tracking systems.
• Fills every field it can ground in your Tailrd profile: contact details, work history, education, links, work authorization, and screening questions.
• Handles multi-page applications end to end: one click fills each page, creates the account step when a site requires one, and waits for you to turn each page.
• Answers dropdowns and multiple-choice questions only with options that actually exist on the form — if it can't answer truthfully from your profile, it leaves the field for you.
• Attaches your résumé and generates tailored résumés and cover letters from your Tailrd account.

WHAT IT NEVER DOES
• It never submits an application by itself. The final Submit is always yours.
• It never guesses. Answers come from your profile or are left blank.
• Demographic (EEO) answers never leave your device — they are stored locally and filled locally.

You need a free Tailrd account (www.tailrd.ca) to sync your profile.
```

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
- [ ] Vercel: `REQUIRE_EMAIL_VERIFICATION=false` (USER ACTION)
- [ ] Vercel: `EXTENSION_ALLOWED_IDS=apgogjfdpleeajnngkfkfekbddcpodkl` (USER ACTION)
- [ ] Upload zip, paste listing + justifications, submit for review

## After review approval

1. Install from the store, sign in, run one real application end to end.
2. Flip `REQUIRE_EMAIL_VERIFICATION` back to `true` once email delivery
   (Resend) is configured post-beta.
