# User Story: Frontend Design Transition

**Assignee:** Wassim  
**Priority:** High  
**Sprint:** Current  

---

## Story

As a user, I want ApplyPilot to have a modern job board interface (inspired by Jobright.ai) so that I can browse AI-matched jobs, see match scores, and apply with one click — instead of the old bot-runner dashboard.

---

## What Changed

We replaced the old bot-runner UI (Dashboard → Bot Runner → Review → Settings) with a Jobright-inspired job board layout:

| Before | After |
|--------|-------|
| Top nav bar with 4 links | Left sidebar with 6 nav items |
| Dashboard with stats cards | Job feed with match score cards |
| Bot runner with log stream | "Apply Now" / "Ask AI" buttons per job |
| Review table | Filter pills + tabs (Recommended/Liked/Applied/External) |

---

## New Design System

- **Accent color:** `#10b981` (emerald green)
- **Font:** Inter
- **Layout:** Fixed left sidebar + scrollable main content + right info panel
- **Cards:** White with 12px radius, 1px border, hover shadow
- **Buttons:** Pill-shaped (999px radius), green primary, outline secondary
- **Match scores:** Circular SVG progress on dark cards (STRONG/GOOD/FAIR MATCH)
- **Responsive:** Sidebar collapses to icons on mobile, right panel hides on tablet

---

## Files to Review

```
frontend/src/App.tsx          ← Sidebar layout
frontend/src/main.tsx         ← Simplified routing
frontend/src/index.css        ← Full design system (438 lines)
frontend/src/pages/Jobs.tsx   ← Main job board page
```

---

## Acceptance Criteria

- [ ] Sidebar renders with all nav items (Jobs, Resume, Profile, Agent, Applied, Settings)
- [ ] Active nav item is highlighted green with left border
- [ ] Job cards display: title, company, location, salary, work mode, level
- [ ] Each job card has a match score circle (SVG) with percentage and label
- [ ] Filter pills are visible and styled (active = green background)
- [ ] Tabs show (Recommended, Liked, Applied, External) with counts
- [ ] "Apply Now" button is green pill, "Ask AI" is outline pill
- [ ] Right sidebar shows user avatar + plan badge + saved filters
- [ ] Layout is responsive (sidebar collapses on mobile)
- [ ] No references to old bot-runner UI remain in active routes

---

## How to Test

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` — should see the new job board layout.

---

## Screenshots Reference

The design is inspired by Jobright.ai's job recommendation page:
- Left sidebar navigation
- Filter pills row at top
- Job cards with match score badges on the right side
- Clean white cards with green accent color

---

## Notes

- Old pages (Dashboard.tsx, Running.tsx, ReviewPage.tsx, Settings.tsx) still exist in `src/pages/` but are **not routed** — safe to delete after verification
- Mock data is used for now — will wire to real API next sprint
- This is ApplyPilot's own brand (emerald green, ⚡ logo) — not a 1:1 Jobright copy
