---
inclusion: always
---

# Resumate — Project Context

## What This Project Is
A job aggregation and smart-apply platform that scrapes job listings from multiple GitHub repositories, classifies them by country/work type/role category, and provides a filterable dashboard with AI-powered resume matching.

## Architecture
- **Frontend**: React + Vite + TypeScript (dashboard for job browsing, filtering, resume upload)
- **Backend**: FastAPI + SQLAlchemy + PostgreSQL/Neon (API, job storage, classification)
- **Scraper**: resumate-scraper (standalone scraper for ATS company career pages)
- **Extension**: Chrome extension (job apply assistance)
- **AI**: Google Gemini (resume matching, quality analysis, form filling)
- **Hosting**: Vercel (serverless) + Neon PostgreSQL
- **Cron**: Vercel Cron Jobs for daily polling of GitHub repos

## Key Services
- **AggregatorService** — polls 9+ GitHub repos for job listings
- **MarkdownParser** — parses job markdown tables from repos
- **CountryFilter** — classifies jobs by US/Canada
- **WorkTypeClassifier** — Remote/Hybrid/On Site detection
- **GeminiService** — AI-powered resume analysis, matching, form filling
- **MatchEngine** — computes match scores between resume and job descriptions

## Tech Stack
- **Frontend**: React, Vite, TypeScript, Recharts, TailwindCSS
- **Backend**: FastAPI, SQLAlchemy, Pydantic
- **Database**: PostgreSQL (Neon)
- **AI**: Google Gemini API
- **Hosting**: Vercel
- **Testing**: Pytest + Hypothesis (property-based), Vitest + fast-check (frontend)

## Key Files
- `backend/services/gemini_service.py` — AI service (Gemini)
- `backend/services/aggregator.py` — Job aggregation from GitHub repos
- `backend/services/markdown_parser.py` — Parse job listings from markdown
- `backend/routers/jobs.py` — Job listing API
- `backend/routers/resumes.py` — Resume upload/analysis
- `backend/routers/github_sources.py` — GitHub source management + cron
- `frontend/src/pages/JobsList.tsx` — Main job browsing page
- `resumate-scraper/` — Standalone ATS scraper

## User Info
- Name: Fahad Aba-Alkhail
- Email: fahadabraar@gmail.com
- Phone: 6133168025
- Location: Ottawa, Ontario, Canada
- LinkedIn: fahadabraar@gmail.com
