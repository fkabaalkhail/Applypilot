# User Story: Settings & Profile Page

## Summary
Build the Settings page in the React frontend so users can save their personal info, job preferences, and pre-filled answers. This data powers the `/api/fill` endpoint — without it, the extension has nothing to fill forms with.

## Why This Matters
The Chrome extension calls `POST /api/fill` with form fields. That endpoint looks up `UserSettings` from the DB to answer questions like "What's your name?", "Are you authorized to work?", etc. If settings are empty, every answer comes back blank.

---

## What Already Exists (Backend — DONE)
- `GET /settings` — returns all saved settings
- `PUT /settings` — updates only the fields you send
- `POST /settings/resume` — uploads a resume file
- DB model: `UserSettings` in Neon (already deployed)
- Schemas: `SettingsOut` (response), `SettingsUpdate` (request)

You do NOT need to touch the backend. Just build the frontend.

---

## What You're Building

### Page: `/settings` (replace the stub in `frontend/src/pages/Settings.tsx`)

### Sections

#### 1. Personal Info
| Field | Type | Maps to |
|-------|------|---------|
| First Name | text input | `first_name` |
| Last Name | text input | `last_name` |
| Email | email input | `email` |
| Phone | tel input | `phone` |
| City | text input | `city` |
| LinkedIn URL | url input | `linkedin_url` |
| Website | url input | `website` |

#### 2. Job Preferences
| Field | Type | Maps to |
|-------|------|---------|
| Target Job Title | text input | `job_title` |
| Target Location | text input | `location` |
| Remote Only | toggle/checkbox | `remote_only` |

#### 3. Pre-filled Answers (Common Screening Questions)
A key-value editor where users can add answers to common questions:
- "Are you authorized to work in Canada?" → "Yes"
- "Do you require visa sponsorship?" → "No"
- "Years of experience with Python?" → "4"

Maps to: `prefilled_answers` (JSON dict)

#### 4. Resume Upload
- File input (PDF/DOCX)
- Shows current file name if uploaded
- Calls `POST /settings/resume`

---

## Acceptance Criteria

- [ ] Page loads and fetches current settings from `GET /settings`
- [ ] All fields in Section 1-3 are pre-populated with saved values
- [ ] Editing any field and clicking Save calls `PUT /settings` with changed fields
- [ ] Success toast/message on save
- [ ] Resume upload works and shows filename after upload
- [ ] Pre-filled answers section lets you add/remove key-value pairs
- [ ] Page is styled consistently with the existing Jobs page (use same CSS variables)
- [ ] Works on the deployed Vercel URL (relative API calls, no hardcoded localhost)

---

## Technical Notes

- API calls use relative URLs (e.g. `fetch("/settings")`) — Vite proxy handles dev, Vercel rewrites handle prod
- The `PUT /settings` endpoint is PATCH-like: only send fields that changed
- `prefilled_answers` is a flat `{question: answer}` dict
- Resume upload is multipart form data to `POST /settings/resume`
- No auth yet — single-user for now

---

## File to Edit
`frontend/src/pages/Settings.tsx` (currently a stub)

---

## How to Test Locally
```bash
# Terminal 1: backend
cd backend && uvicorn backend.main:app --reload --port 8000

# Terminal 2: frontend
cd frontend && npm run dev
```

Go to http://localhost:5173/settings, fill in your info, save, refresh — data should persist.

---

## Definition of Done
- Settings page is functional and deployed
- Your profile data is saved in Neon
- `GET /settings` returns your saved data
- Extension's `/api/fill` endpoint can use this data to answer form questions
