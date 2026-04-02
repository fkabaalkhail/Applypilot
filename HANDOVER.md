# ApplyPilot - Handover for Omar

## What is this?
A Chrome extension that auto-applies to LinkedIn Easy Apply jobs. It scrapes jobs from LinkedIn, queues them, and automatically fills out application forms on external ATS systems (Greenhouse, Lever, Workday).

---

## First Time Setup

### Prerequisites
- Python 3.10+ installed
- Chrome browser
- Git

### 1. Clone the Repo
```bash
git clone https://github.com/fkabaalkhail/Applypilot.git
cd Applypilot
```

### 2. Install Python Dependencies
```bash
pip install -r backend/requirements.txt
```

### 3. Create Environment File (Optional)
Copy the example and edit if needed:
```bash
cp .env.example .env
```

---

## Quick Start

### 1. Start the Backend
Open terminal in the project root:

**Windows (PowerShell):**
```powershell
py -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

**Mac/Linux:**
```bash
python -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

**IMPORTANT**: Run from project root, NOT from inside the `backend` folder.

### 2. Load the Chrome Extension
1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `extension` folder

### 3. Configure Your Profile
Click the extension icon → Settings tab:
- Name, Email, Phone
- School: University of Ottawa
- Degree: Bachelor's in Computer Science
- Location: Ottawa, Ontario, Canada

### 4. Start Applying
1. Go to LinkedIn job search
2. Click extension icon → "Start Auto Apply"
3. The bot will:
   - Scrape jobs from LinkedIn
   - Filter out US-only jobs (you're in Canada)
   - Open each job and click "Easy Apply"
   - Fill forms automatically on external ATS sites
   - Wait 30-60 seconds for you to review before moving to next job

---

## Key Features

### Form Filling
- **Text fields**: AI fills based on your resume/profile
- **Dropdowns (React-Select)**: Clicks to open, reads options, AI picks best match
- **Searchable dropdowns** (School, Country): Types to filter, then clicks result
- **Radio buttons**: AI selects appropriate option
- **EEO questions**: Defaults to "Decline to answer" (except Gender → "Male")

### Timing
- After submit: 30 seconds delay
- If no submit button found: 60 seconds delay (manual review needed)
- Between jobs: 5 seconds

### Location Filter
Jobs are filtered to exclude US-only positions since you're based in Canada.

---

## Folder Structure
```
Applypilot/
├── backend/           # FastAPI backend
│   ├── main.py        # Entry point
│   ├── bot/           # LinkedIn bot logic
│   ├── routers/       # API endpoints
│   └── services/      # AI, browser pool, etc.
├── extension/         # Chrome extension
│   ├── manifest.json
│   ├── content.js     # Main form-filling logic (5000+ lines)
│   ├── background.js  # Service worker
│   └── popup/         # Extension UI
├── data/              # SQLite database (auto-created)
└── .kiro/             # Specs and steering docs
```

---

## Troubleshooting

### "No module named 'backend'"
You're running from the wrong directory. Run from project root:
```powershell
cd C:\Users\fahad\Desktop\Applypilot
py -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Database locked / Old jobs showing
1. Stop the backend (Ctrl+C)
2. Delete the database:
```powershell
Remove-Item data\autoapply.db -Force
```
3. Restart backend

Or use the "Clear All" button in the extension popup.

### Extension not detecting forms
- Check console (F12) for `[AutoApplyBot]` logs
- Forms must be on supported ATS: Greenhouse, Lever, Workday
- LinkedIn Easy Apply forms are handled differently

### Form fields not filling
- React-Select dropdowns need click-based selection (not typing)
- Some fields may need manual input if AI can't determine answer
- Check that your profile settings are complete

---

## Development Notes

### Key Files to Know
- `extension/content.js` - All form-filling logic
- `backend/bot/smart_filter.py` - Job filtering (location, keywords)
- `backend/routers/extension.py` - API endpoints for extension
- `.kiro/steering/project-context.md` - Lessons learned (READ THIS)

### What Works
- Job scraping from LinkedIn
- Cookie-based login (li_at cookie)
- Form detection on Greenhouse/Lever/Workday
- React-Select dropdown handling
- AI-powered form filling via Ollama

### What's In Progress
- Full end-to-end Easy Apply flow
- Some edge cases in form filling
- Desktop app packaging

### Anti-Detection
The bot uses:
- selenium_stealth
- Real Chrome (not Chromium)
- Cookie persistence
- `excludeSwitches: ["enable-automation"]`

---

## Contact
If stuck, check `.kiro/steering/project-context.md` for detailed lessons learned and what NOT to do (Docker Chromium, Playwright, headless mode all fail).
