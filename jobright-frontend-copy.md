# Jobright Frontend Web Experience — Feature Copy Reference

## How Jobright Works (User Flow)

### 1. Web App (jobright.ai)

**Onboarding Flow** (`/onboarding-v3/`):
- `/mode-selection` — Choose seeker type (job seeker, student, etc.)
- `/diagnostics` — Basic preferences (role, location, salary)
- `/career-goals` — Career goals input
- `/advanced-preferences` — Detailed filters
- `/resume-upload` — Upload resume (parsed by AI)
- `/matching` — Loading screen while AI processes resume

**Main App Pages**:
- `/jobs/recommend` — AI-matched job feed (personalized recommendations)
- `/jobs/applied` — Track applied jobs
- `/jobs/info/:id` — Job detail page with match score
- `/jobs/external` — External job imports

**Features on Web App**:
- Resume AI rewriter/tailor per job
- Cover letter generator
- Job match scoring
- Insider connections (shows who you know at company)
- Application tracker
- Payment/subscription management (Free → Turbo plan)

---

### 2. Chrome Extension Overlay (on job application pages)

When a user visits a supported ATS page, the extension injects a **floating side panel** with these states:

#### State Machine
```
INITIAL → FILLING → FILLED
                  → FAILED
```

#### Panel UI Sections

**A. Top Bar**
- Jobright logo + "Autofill with Jobright" button
- Credits remaining indicator (`5 free fills left`)
- Settings gear icon
- Close/minimize button

**B. Pre-Fill State (INITIAL)**
- "AI is scanning this page" loading indicator
- Resume picker dropdown (select which resume to use)
- "Autofill" primary CTA button
- "Fill manually" secondary link
- Job match banner (if job is in Jobright's database):
  - Match score percentage
  - "Similar Jobs" link
  - "Tailor Resume" link
  - "Insider Connections" count

**C. Filling State (FILLING)**
- Animated progress bar
- Real-time field status list:
  - ✅ Filled fields (green checkmarks)
  - ⏳ In-progress fields
  - ❌ Missing/failed fields
- "Filling X of Y fields..."
- Cancel button

**D. Filled State (FILLED)**
- Summary: "Filled 12/14 fields"
- List of filled vs missing fields
- "Edit with AI" button (regenerate individual answers)
- Star rating feedback prompt
- "Submit Application" button (if auto-submit enabled)
- Cover Letter section:
  - Preview
  - Download PDF
  - "Generate" / "Regenerate" button
- Tailor Resume section:
  - Preview iframe
  - Download button
  - "Tailor for this job" button

**E. Failed State (FAILED)**
- Error message
- "Try Again" button
- "Fill manually" fallback

**F. Settings Panel**
- "Autofill After Page Turn" toggle (multi-page forms)
- "Default View" selector
- "Hide on this site" option
- "Don't ask again" checkbox

**G. Info Modal (Profile Editor)**
- Personal info (name, email, phone, address)
- Work experience entries
- Education entries
- Skills list
- Links (LinkedIn, GitHub, portfolio)
- "Save" button syncs to Jobright account

---

### 3. LinkedIn Integration

**LinkedIn Job Page Banner**:
- Injected banner below job posting
- "Add this job in one click" button
- Job match score
- "Apply with Jobright" CTA
- Similar jobs carousel

---

### 4. Subscription/Credits Model

| Tier | Credits | Features |
|------|---------|----------|
| Free | 5 fills/month | Basic autofill |
| Turbo | Unlimited | AI answers, tailor resume, cover letter, priority |

- Credit balance shown in extension overlay
- "Upgrade Now" / "Get Unlimited Credits Now" CTAs
- "Turbo for Students" special pricing

---

## Technical Implementation (What to Copy)

### Extension UI Stack
- **Framework**: React (via Plasmo CSUI — Content Script UI)
- **Styling**: CSS-in-JS with Inter font family
- **Icons**: Ant Design icons (Outlined, Filled, TwoTone variants)
- **State**: React context + Chrome storage sync
- **Animations**: CSS keyframes for loading bars

### Key UI Components to Build

```
src/contents/
├── overlay/
│   ├── OverlayContainer.tsx      # Main floating panel
│   ├── AutofillButton.tsx        # Primary CTA
│   ├── ProgressTracker.tsx       # Fill progress with field list
│   ├── ResumePickerDropdown.tsx  # Select resume to use
│   ├── CreditsBadge.tsx          # Credits remaining
│   ├── JobMatchBanner.tsx        # Match score + similar jobs
│   ├── CoverLetterSection.tsx    # Generate/preview/download
│   ├── TailorResumeSection.tsx   # Preview iframe + download
│   ├── FeedbackRating.tsx        # Star rating after fill
│   ├── SettingsPanel.tsx         # Toggles and preferences
│   └── InfoModal.tsx             # Profile editor modal
├── linkedin/
│   ├── LinkedInBanner.tsx        # Banner on LinkedIn job pages
│   └── SimilarJobsCarousel.tsx   # Job recommendations
└── shared/
    ├── LoadingBar.tsx            # Animated progress bar
    ├── FieldStatusList.tsx       # Filled/missing field indicators
    └── UpgradePrompt.tsx         # Paywall/upgrade CTA
```

### Overlay Injection Pattern
```typescript
// Plasmo content script UI — injects React into page
import type { PlasmoCSConfig, PlasmoGetOverlayAnchor } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

// Anchor the overlay to the page body (floating panel)
export const getOverlayAnchor: PlasmoGetOverlayAnchor = async () =>
  document.body

export default function AutofillOverlay() {
  const [step, setStep] = useState<'INITIAL' | 'FILLING' | 'FILLED' | 'FAILED'>('INITIAL')
  // ... render based on step
}
```

### Message Flow (UI ↔ Background)
```
[Overlay UI] → sendToBackground({ name: "getAutofillInfo" }) → [Background Worker] → [API]
[Overlay UI] → sendToBackground({ name: "getGptResults", body: { fields, url } }) → [AI API]
[Overlay UI] → sendToBackground({ name: "getResumeBlob", body: { resumeId } }) → [Resume API]
[Overlay UI] → sendToBackground({ name: "getTailorResume", body: { jobId } }) → [Tailor API]
[Overlay UI] → sendToBackground({ name: "getCoverLetterBlob", body: { ... } }) → [CL API]
```

---

## What ApplyPilot Should Copy

### Must-Have (MVP)
1. **Floating overlay panel** on supported ATS pages
2. **One-click autofill button** with progress tracking
3. **Resume picker** (select from uploaded resumes)
4. **Real-time fill progress** (field-by-field status)
5. **Profile/info editor** in extension
6. **Multi-page form support** (auto-fill after page turn)

### Should-Have (v1.1)
7. **AI answer regeneration** (edit individual field answers)
8. **Cover letter generation** with preview/download
9. **Resume tailoring** per job with preview
10. **Job match scoring** on application pages
11. **LinkedIn job page banner** integration

### Nice-to-Have (v2)
12. **Insider connections** display
13. **Similar jobs** recommendations
14. **Application tracker** dashboard
15. **Star rating feedback** system
16. **Credits/subscription** model
