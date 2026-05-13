# Handover Notes — May 12, 2026

## What's Done
- Lavender theme (#7C6CFF accent, #D3D3FF borders, #F0EEFF backgrounds)
- Jobright-style dropdown filter bar with Country/City, Job Function, Experience (multi-select), Work Model, Date Posted
- Dropdown positioning fixed (each appears below its button)
- Experience level is multi-select (string[] type)
- ATS scraper running hourly on GitHub Actions (523 companies, Greenhouse/Lever/Ashby/Workday + LinkedIn)
- ~2,900+ jobs in Neon DB with descriptions and salaries
- /list page (intern-list style) with city pills
- "ASK REMI" + "APPLY WITH AUTOFILL" buttons
- Salary JSON display fix (hides broken `{"unit":"CAD"...}` entries)

## What Needs To Be Done Next

### 1. City Multi-Tag Filter
In `frontend/src/components/JobFilterBar.tsx`, the Country dropdown has a single text input for city. Change it to:
- Type a city name, press Enter → adds it as a tag (pill with × to remove)
- Can add multiple cities (Ottawa, Toronto, Vancouver)
- Store as `location: string[]` instead of `location: string`
- Filter jobs matching ANY of the selected cities (OR logic)
- Update `Jobs.tsx` to pass `location` as comma-separated to the API

### 2. Full-Page Job Detail (Replace Popup)
Currently clicking a job card opens a modal overlay (`job-detail-overlay`). Replace with:
- Navigate to a full page (route: `/app/job/:id`)
- Layout like jobright: top bar with close/back, company logo + name + time, job title, location/work model/salary tags
- Match score panel on the right (76% GOOD MATCH with breakdown bars)
- "Insider Connection @Company" section with 3 columns: Beyond Your Network, From Your Previous Company, From Your School
- "Find Any Email" input
- Job description with Responsibilities and Qualifications sections
- Skill tags (highlighted matching ones)
- "APPLY WITH AUTOFILL" button top-right

### 3. Profile Page Redesign
Current profile page needs sections like jobright:
- **Personal**: Name, address, email, phone, LinkedIn URL
- **Education**: School, degree, GPA, dates (timeline format)
- **Work Experience**: Company, title, dates, bullet points (timeline format)
- **Skills**: Tag pills (Python, Java, AWS, Docker, etc.)
- **Equal Employment**: Work authorization, disability, gender, veteran status, race, etc.
- Each section has an edit pencil icon
- Data stored in backend and used for:
  - AI match scoring
  - Insider connections matching
  - Auto-fill applications

### 4. Insider Connections
Uses profile data (school, previous companies) to show:
- "From Your School" — people at the target company who went to same school
- "From Your Previous Company" — people who worked at same companies
- "Beyond Your Network" — other connections
- This is a future feature that needs LinkedIn data or manual entry

## Key Files
- `frontend/src/components/JobFilterBar.tsx` — the dropdown filter bar
- `frontend/src/pages/Jobs.tsx` — main jobs dashboard
- `frontend/src/components/JobDetailView.tsx` — current popup detail view (to be replaced)
- `frontend/src/pages/Profile.tsx` — profile page (needs redesign)
- `frontend/src/index.css` — main styles (lavender theme)
- `resumate-scraper/` — separate scraper repo (pushed to github.com/fkabaalkhail/-resumate-jobs-scraper)

## Architecture
- Frontend: React + Vite on Vercel (resumate-smoky.vercel.app)
- Backend: FastAPI on Vercel (same deployment)
- Database: Neon PostgreSQL
- Scraper: GitHub Actions hourly cron (separate public repo)
- Auth: Clerk
- AI: Gemini (for match scoring)
