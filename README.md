# Tailrd

A job aggregation and smart-apply platform that scrapes job listings from 9 jobright-ai GitHub repositories, classifies them by country/work type/role category, and provides a filterable dashboard with AI-powered resume matching.

## Features

- Aggregates jobs from 9 jobright-ai GitHub repos (8 New Grad + 1 Internship)
- Classifies jobs by country (US/Canada), work type (Remote/Hybrid/On Site), role category (17 categories)
- Daily automated polling via Vercel Cron Jobs
- Rich filtering UI (country, work type, category, experience level)
- AI-powered match scoring (Gemini/Ollama)
- Resume upload and analysis
- Job detail view with match breakdown

## Tech Stack

- **Frontend**: React + Vite + TypeScript
- **Backend**: FastAPI + SQLAlchemy
- **Database**: PostgreSQL (Neon)
- **Hosting**: Vercel (serverless)
- **AI**: Google Gemini / Ollama (local)

## Architecture

- Backend services: CountryFilter, WorkTypeClassifier, MarkdownParser, AggregatorService
- 9 GitHub repos polled daily for new job listings
- Property-based testing with Hypothesis (Python) and fast-check (TypeScript)

## Getting Started

1. Clone the repo
2. Set up environment variables (see `.env.example`)
3. Install dependencies:
   ```bash
   pip install -r backend/requirements.txt
   cd frontend && npm install
   ```
4. Run locally:
   ```bash
   uvicorn backend.main:app --reload
   cd frontend && npm run dev
   ```
5. Seed sources:
   ```
   POST /github-sources/seed
   ```
6. Poll jobs:
   ```
   GET /github-sources/cron-poll
   ```

## Deployment (Vercel)

- Push to main or run `vercel --prod`
- Set `DATABASE_URL` env var to your Neon PostgreSQL URL
- Optionally set `GITHUB_TOKEN` for higher API rate limits
- Daily cron job at `/github-sources/cron-poll` keeps jobs updated
