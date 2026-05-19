# Tailrd Extension — Onboarding Wizard Spec

## Overview

When a user installs the Tailrd Chrome extension for the first time, they are automatically redirected to a **demo Greenhouse-style job application page** hosted on `tailrd.ca/demo-apply`. The wizard guides them through the extension's features step-by-step using tooltip-style popups that point to specific UI elements.

---

## Flow

### Trigger
- On first install (`chrome.runtime.onInstalled` event in background.ts)
- Check `chrome.storage.local` for `onboarding_complete` flag
- If not set → open `https://www.tailrd.ca/demo-apply` in a new tab

### Demo Page (`/demo-apply`)
A fake Greenhouse-style job application form hosted on the Tailrd frontend. Contains:
- Company: "Tailrd" (with logo)
- Job Title: "Software Engineer — Full Stack"
- Fields: First Name, Last Name, Email, Phone, LinkedIn Profile, "Why are you a good fit for Tailrd?", Resume upload
- Submit button (disabled — just for demo)
- The page loads the Tailrd extension content script (since it matches `https://www.tailrd.ca/*`)

---

## Wizard Steps (8 steps)

### Step 1 — Welcome
**Position:** Center of screen (modal overlay)
**Content:**
> Welcome to Tailrd
>
> Let us show you how to autofill job applications in seconds.
>
> [Get Started →]

---

### Step 2 — Click Autofill
**Position:** Tooltip pointing at the extension popup's Autofill button (or a simulated version on the page)
**Content:**
> (1/8)
>
> Click **Autofill** to see the extension in action.
>
> [Next]

**Action:** Auto-triggers the autofill on the demo form, filling in sample data (Fahad Aba-Alkhail, fahadabraar@gmail.com, etc.)

---

### Step 3 — Fields Filled
**Position:** Tooltip pointing at the filled form fields
**Content:**
> (2/8)
>
> Just like that, your application has been automatically filled with information from your **Tailrd profile**.
>
> [Back] [Next]

---

### Step 4 — Custom Questions
**Position:** Tooltip pointing at the "Why are you a good fit?" textarea (which was filled with AI-generated text)
**Content:**
> (3/8)
>
> Fill in any custom application questions and Tailrd will **save** your answers.
>
> Your saved answers will then be used to autofill any future job applications with the exact same question.
>
> [Back] [Next]

---

### Step 5 — Tailor Resume
**Position:** Tooltip pointing at the "Generate Custom Resume" button in the extension popup
**Content:**
> (4/8)
>
> **Tailor** your resume for every job, directly in Tailrd.
>
> Our AI analyzes the job description and optimizes your resume to match the keywords and requirements.
>
> [Back] [Next]

---

### Step 6 — AI Generation
**Position:** Tooltip pointing at the extension popup
**Content:**
> (5/8)
>
> Use **AI** to auto-generate tailored resumes and cover letters.
>
> Our AI will analyze the job description you are applying to and generate a tailored resume and cover letter in 1-click.
>
> [Back] [Next]

---

### Step 7 — Supported Platforms
**Position:** Center tooltip (no pointer)
**Content:**
> (6/8)
>
> Tailrd works with most job boards and ATS systems such as **Workday, Lever, Greenhouse**, and more.
>
> For unsupported platforms, you can still click on the extension to access your profile information for reference.
>
> [Back] [Next]

---

### Step 8 — Profile Copy
**Position:** Tooltip pointing at the extension popup's "Your Autofill Information" section
**Content:**
> (7/8)
>
> From your profile, click on any text to **copy it directly** to your clipboard.
>
> We make it easy to copy and paste information directly into job applications.
>
> [Back] [Next]

---

### Step 9 — Submit (Final)
**Position:** Tooltip pointing at the Submit button
**Content:**
> (8/8)
>
> Click **Submit** to finish this job application.
>
> See how Tailrd helps you organize submitted applications.
>
> [Back] [Finish Setup]

**Action:** On "Finish Setup":
- Set `chrome.storage.local` → `onboarding_complete: true`
- Redirect to `https://www.tailrd.ca/app` (dashboard)
- Show a toast: "You're all set! Tailrd is ready to autofill your applications."

---

## Technical Implementation

### Files to Create

1. **`extension/onboarding.ts`** — Background script handler
   - Listen for `chrome.runtime.onInstalled`
   - Check if `onboarding_complete` is set
   - If not, open the demo page

2. **`frontend/src/pages/DemoApply.tsx`** — The fake job application page
   - Greenhouse-style form layout
   - Includes the wizard overlay component
   - Fields are pre-styled to look like a real ATS

3. **`frontend/src/components/OnboardingWizard.tsx`** — The tooltip wizard component
   - Manages step state (1-8)
   - Renders tooltip bubbles with arrows pointing at target elements
   - Has Back/Next navigation
   - Triggers autofill demo on step 2
   - Stores completion in localStorage + sends message to extension

4. **`frontend/src/main.tsx`** — Add route `/demo-apply`

### Wizard Tooltip Design
- White card with rounded corners (12px)
- Drop shadow
- Small triangle/arrow pointing at the target element
- Step counter in top-left (e.g., "(2/8)")
- Bold headline text
- Smaller description text
- Purple accent color for highlighted words
- "Back" link (purple text) + "Next" button (purple filled, rounded)
- Gray overlay behind (50% opacity) with the target element highlighted (cutout)

### Extension Changes
- `background.ts`: Add `chrome.runtime.onInstalled` listener
- `package.json` manifest: Add `https://www.tailrd.ca/*` to content script matches (already done)

### Demo Form Data (pre-filled during wizard)
```json
{
  "first_name": "Fahad",
  "last_name": "Aba-Alkhail",
  "email": "fahadabraar@gmail.com",
  "phone": "6133168025",
  "location": "Ottawa, Ontario, Canada",
  "linkedin_url": "https://linkedin.com/in/fahadabraar",
  "why_good_fit": "I'm a great fit for Tailrd because of my extensive background in full-stack development and AI integration. At the University of Ottawa, I built multiple production applications using React, Python, and cloud services. My experience with job platforms and resume parsing directly aligns with Tailrd's mission to simplify the job application process."
}
```

---

## Priority
- **Phase 1:** Build the demo page + wizard overlay (frontend only)
- **Phase 2:** Wire up the extension background script to auto-open on install
- **Phase 3:** Polish animations, add confetti on completion, track onboarding analytics

---

## Notes
- The wizard should work even if the extension isn't installed (for marketing/demo purposes)
- The demo page should be accessible at `tailrd.ca/demo-apply` for anyone to try
- Consider adding a "Skip Tutorial" link in the top-right for power users
- The wizard state should persist — if user closes tab mid-wizard, resume where they left off
