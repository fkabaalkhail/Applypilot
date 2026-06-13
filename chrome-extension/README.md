# ApplyPilot Chrome Extension

Autofills job applications on ATS sites (Greenhouse, Lever, Workday, Ashby,
BambooHR, SmartRecruiters and generic forms) using the profile stored in your
ApplyPilot account.

**Hard guarantees baked into the code:**

- Never submits an application — it only fills fields and highlights them for review.
- Never auto-clicks buttons, never bypasses CAPTCHAs or anti-bot systems.
- EEO / demographic fields are detected but **never filled** unless you enable
  the explicit settings toggle *and* your profile contains those answers.
- File inputs (resume upload) are detected but never scripted — browser
  security requires picking the file manually, and the popup says so.
- Low-confidence matches are shown in the review panel, not filled.

---

## Build & load in Chrome

```bash
cd chrome-extension
npm install
npm run build        # bundles to dist/
```

Then:

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `chrome-extension/dist` folder.

During development use `npm run watch` and press the reload icon on the
extension card after changes (content scripts need a page refresh too).

Other scripts: `npm run typecheck` (strict TS check), `npm run icons`
(regenerates `assets/icon-*.png`).

---

## Using it

1. Click the ApplyPilot icon on a job application page.
2. On the known ATS domains the content script is already there; on any other
   site it is injected on demand when the popup opens (that's the
   `activeTab` + `scripting` permission — no broad host access).
3. The popup scans automatically and shows every detected field with its
   category, a confidence score and the value it intends to fill:
   - **Will fill** — confident matches with profile data, pre-checked.
   - **Review** — low confidence, missing profile data, EEO fields, file
     uploads, fields that already have a value. Check any of them to include.
4. Click **Autofill N fields**. Filled controls flash a lavender outline on the
   page; failures show the reason inline (e.g. "No option matches…").
5. Review the form and submit it yourself.

First run uses **sample data** (John Doe) so everything works before the
backend is connected. The header chip always tells you which mode you're in.

---

## Architecture

```
chrome-extension/
  manifest.json               MV3 manifest (copied into dist/)
  build.mjs                   esbuild bundling + static copy
  src/
    background/serviceWorker.ts   API calls, auth, opens dashboard
    content/
      contentScript.ts        message router, frame coordination
      formScanner.ts          finds controls, radio grouping, MutationObserver
      fieldMatcher.ts         classification patterns + confidence + values
      autofill.ts             fill engine (native setters + real input events)
      domUtils.ts             labels, nearby text, visibility, event helpers
    popup/                    popup.html / popup.css / popup.ts (vanilla TS)
    api/
      client.ts               backend client (login, refresh, profile, fallbacks)
      types.ts                backend wire types
      mockProfile.ts          sample profile for mock mode
    shared/
      types.ts                profile, field & message types
      constants.ts            thresholds, endpoints, ATS list
      storage.ts              chrome.storage.local wrappers (config/auth/cache)
  test/sample-form.html       local form covering every field category
```

### How the pieces talk

```
popup.ts ──chrome.runtime messages──▶ serviceWorker.ts ──fetch──▶ FastAPI backend
   │            (GET_STATUS / LOGIN / GET_PROFILE / OPEN_DASHBOARD)
   │
   └──chrome.tabs.sendMessage──▶ contentScript.ts (every frame)
                (PING / SCAN_PAGE / FILL_FIELDS)
```

- The **popup** fetches the profile from the **background**, passes it to the
  **content script** with `SCAN_PAGE`, and gets back serializable
  `DetectedField`s (id, category, confidence, proposed value, notes).
- Autofill sends `FILL_FIELDS` with only the user-approved field ids; the
  content script maps ids back to live DOM nodes and fills them.
- Field ids are prefixed with a per-frame token, so forms living inside
  iframes (embedded Greenhouse) work: the frame that owns the fields answers,
  empty frames deliberately answer late.
- A debounced `MutationObserver` rescans dynamic pages (Workday steps, SPA
  re-renders) and notifies the popup with `FIELDS_UPDATED`.
- Values are written through the native prototype setters and dispatched as
  real `input`/`change` events so React/Vue/Angular forms accept them, then
  read back to verify they stuck.

---

## Connecting your real backend

The extension already speaks your FastAPI's dialect:

- **Login**: `POST /auth/login` `{email, password}` → stores the
  `access_token`/`refresh_token` pair in `chrome.storage.local`, refreshes via
  `POST /auth/refresh` (rotation-aware) and validates with `GET /auth/me`.
- **Profile**: tries `GET /api/user/application-profile` first. Until that
  endpoint exists it automatically falls back to your existing
  `GET /settings` and maps `first_name`, `last_name`, `email`, `phone`,
  `city`, `linkedin_url`, `website`, `job_title` and any
  work-authorization/sponsorship answers found in `prefilled_answers`.

Steps:

1. Open the popup → ⚙ Settings → set **API base URL** and **Dashboard URL**
   to your deployment (defaults to `https://resumate-smoky.vercel.app`),
   untick **Use sample data**, Save. Chrome will ask to grant the extension
   access to that origin (declared as `optional_host_permissions`, so it's
   requested at runtime, never broadly).
2. Sign in with your ApplyPilot email/password.
3. (Recommended) Implement the dedicated endpoint so education, experience,
   GitHub, cover letter etc. flow through:

```python
# backend/routers/profile.py — mount with prefix="/api" like fill.py
@router.get("/user/application-profile")
def application_profile(user_id: int = Depends(get_verified_user_id),
                        db: Session = Depends(get_db)):
    s = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    return {
        "firstName": s.first_name, "lastName": s.last_name,
        "email": s.email, "phone": s.phone, "location": s.city,
        "linkedin": s.linkedin_url, "github": "", "portfolio": s.website,
        "currentCompany": "", "currentTitle": s.job_title,
        "workAuthorization": "", "requiresSponsorship": "",
        "education": [],    # [{school, degree, graduationYear}]
        "experience": [],   # [{company, title, startDate, endDate, description}]
        "coverLetter": "",
        "salaryExpectation": None,
        # "eeo": {gender, race, hispanicLatino, veteranStatus, disabilityStatus}
    }
```

The full expected shape is `UserApplicationProfile` in `src/shared/types.ts`.
No CORS changes are needed — extension requests with granted host permissions
bypass CORS.

---

## Testing on a basic form

1. Serve the bundled test page (content scripts don't run on `file://` by
   default):
   ```bash
   cd chrome-extension/test
   python -m http.server 8080
   ```
2. Open `http://localhost:8080/sample-form.html`.
3. Click the extension icon → it scans automatically (or hit **Rescan page**).
4. You should see first/last name, email, phone, city, country, LinkedIn,
   GitHub, website, cover letter, work authorization, sponsorship, company,
   title, school, degree, graduation year and salary ready to fill; the
   resume upload flagged "choose manually"; and the four EEO selects detected
   but excluded.
5. Click **Autofill** — fields flash lavender; the country select resolves
   "Ottawa, ON, Canada" → "Canada"; the sponsorship radio picks "No".
6. Verify the submit button was *not* pressed, then test on a real posting
   (e.g. any `boards.greenhouse.io` or `jobs.lever.co` listing).

## Permissions rationale

| Permission | Why |
| --- | --- |
| `activeTab` | scan/fill the tab the user invoked the popup on |
| `scripting` | inject the content script on demand on non-ATS pages |
| `storage` | config, auth tokens, profile cache |
| ATS `content_scripts` matches | auto-detection on known job sites |
| `optional_host_permissions` | runtime-granted access to *your* backend origin only |

Auth tokens live in `chrome.storage.local`; sign out from ⚙ Settings revokes
the refresh token server-side and clears them locally.
