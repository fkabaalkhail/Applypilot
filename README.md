# 🤖 Auto Apply Bot

An AI-powered job application automation platform. It parses your resume with a local LLM (Ollama), auto-fills LinkedIn Easy Apply forms, answers open-ended questions with AI, and gives you a real-time dashboard to track everything.

---

## How It Works

1. **Upload your resume** (PDF or DOCX) → the app extracts text and uses Ollama (local LLM) to parse it into structured data (name, skills, experience, education, etc.)
2. **Configure your job search** → set target job titles, location, remote preference in `.env`
3. **Start the bot** → it logs into LinkedIn, searches for Easy Apply jobs, and fills out applications automatically
4. **Track everything** → a React dashboard shows stats, charts, and every application with status tracking

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Backend API | Python, FastAPI, SQLAlchemy, SQLite |
| AI / LLM | Ollama (runs locally, no API keys needed) |
| Task Queue | Celery + Redis |
| Browser Automation | Playwright (headless Chromium) |
| Frontend | React 18, TypeScript, Vite, React Query, Recharts |
| Infrastructure | Docker Compose, nginx |

---

## Project Structure

```
auto-apply-bot/
├── backend/
│   ├── main.py                 # FastAPI app entry + startup health checks
│   ├── worker.py               # Celery worker + bot task definition
│   ├── db/
│   │   ├── database.py         # SQLAlchemy engine + session
│   │   └── models.py           # ORM models: ResumeProfile, ApplicationRecord, BotRun, UserPreferences
│   ├── schemas/
│   │   ├── resume.py           # Pydantic models for resume data
│   │   └── application.py      # Pydantic models for applications + JobPosting
│   ├── routers/
│   │   ├── health.py           # GET /health — dependency status check
│   │   ├── resumes.py          # POST /resumes/upload — parse resume via Ollama
│   │   ├── applications.py     # GET/PATCH /applications, GET /applications/stats
│   │   └── jobs.py             # POST /jobs/start, /jobs/stop, GET /jobs/logs (SSE)
│   ├── services/
│   │   ├── ollama_service.py   # All LLM calls: resume analysis, cover letters, Q&A, title suggestions
│   │   ├── resume_parser.py    # PDF (pdfplumber) and DOCX (python-docx) text extraction
│   │   └── task_runner.py      # Celery task dispatch + Redis pub/sub for SSE logs
│   ├── bot/
│   │   ├── base_bot.py         # Abstract base: Playwright lifecycle, delays, logging
│   │   ├── linkedin_bot.py     # LinkedIn login, search, Easy Apply loop
│   │   └── form_filler.py      # Maps form fields to resume data, delegates open questions to Ollama
│   └── tests/                  # pytest suite for parser, API endpoints, Ollama service
├── frontend/src/
│   ├── App.tsx                 # Layout + nav
│   ├── api.ts                  # Axios client for all backend calls
│   ├── hooks/useApplications.ts # React Query hooks with 30s auto-refresh
│   └── pages/
│       ├── Dashboard.tsx       # Stats cards, bar chart (last 30 days), filterable application table
│       └── Running.tsx         # Start/Stop bot, live SSE log stream, progress bar
├── prompts/                    # Ollama prompt templates (each has a comment header explaining format)
│   ├── analyze_resume.txt
│   ├── cover_letter.txt
│   ├── answer_question.txt
│   └── suggest_titles.txt
├── docker-compose.yml          # Backend + Worker + Frontend + Redis
├── Dockerfile.backend
├── Dockerfile.frontend
├── nginx.conf                  # Reverse proxy: /api → backend, / → React SPA
├── Makefile
├── .env.example
└── .gitignore
```

---

## Setup (Step by Step)

### Prerequisites
- Docker & Docker Compose
- [Ollama](https://ollama.com) installed on your machine (not in Docker)

### 1. Install and start Ollama

```bash
# Download from https://ollama.com, then:
ollama pull llama3
ollama serve
```

Leave `ollama serve` running in a separate terminal.

### 2. Clone the repo

```bash
git clone https://github.com/<your-username>/auto-apply-bot.git
cd auto-apply-bot
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` — your LinkedIn credentials
- `BOT_JOB_TITLE` — what you're searching for (e.g. "Backend Engineer")
- `BOT_LOCATION` — target location
- `USER_FIRST_NAME`, `USER_LAST_NAME`, etc. — used to auto-fill application forms
- `RESUME_FILE_PATH` — path to your resume file inside the container (put it in `./data/`)

### 4. Start everything

```bash
make dev
```

This builds and starts:
- **Backend API** → http://localhost:8000 (Swagger docs at `/docs`)
- **Frontend** → http://localhost:5173
- **Redis** → localhost:6379
- **Celery worker** → processes bot tasks in background

### 5. Upload your resume

```bash
curl -X POST http://localhost:8000/resumes/upload \
  -F "file=@./path/to/your/resume.pdf"
```

Or use the Swagger UI at http://localhost:8000/docs.

### 6. Run the bot

Go to http://localhost:5173/run and click **Start Bot**. Watch the live logs stream in.

---

## Commands

```bash
make dev        # Start all services (docker compose up --build)
make stop       # Stop all services
make test       # Run backend pytest suite
make lint       # Lint backend + frontend
make reset-db   # Delete the SQLite database (recreated on next start)
make logs       # Tail all Docker container logs
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Dependency health check (Ollama, Redis, DB) |
| POST | `/resumes/upload` | Upload PDF/DOCX, get parsed ResumeProfile |
| GET | `/applications` | List applications (filter by status, platform, date) |
| PATCH | `/applications/{id}` | Update status or notes |
| GET | `/applications/stats` | Dashboard stats (total, this week, by platform/status) |
| POST | `/jobs/start` | Start the bot (returns task_id) |
| POST | `/jobs/stop/{task_id}` | Stop a running bot |
| GET | `/jobs/logs/{task_id}` | SSE stream of real-time bot logs |

---

## Important Notes

- **Ollama runs on your host**, not in Docker. The backend reaches it via `host.docker.internal:11434`. On Linux, change `OLLAMA_BASE_URL` in `.env` to `http://172.17.0.1:11434`.
- **Never commit `.env`** — it contains your LinkedIn credentials.
- **2FA handling**: if LinkedIn shows a security challenge, the bot waits 60 seconds for you to complete it manually.
- **Rate limiting**: random delays between `BOT_MIN_DELAY` and `BOT_MAX_DELAY` seconds between actions to avoid detection.
- All bot actions are logged at INFO level with page, action, and result.
- All credentials come from environment variables — nothing is hardcoded.

---

## Running Tests

```bash
make test
```

Tests use an in-memory SQLite database and mock Ollama responses. No external services needed.
