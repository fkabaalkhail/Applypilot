# Implementation Plan: ATS Job Scraper

## Overview

Build a standalone Python scraping pipeline in a `scraper/` directory at the repo root. The pipeline scrapes job listings from Greenhouse, Lever, Ashby, and Workday ATS platforms, filters for entry-level positions in US/Canada, classifies by role category, deduplicates by URL, and stores results in the existing Neon PostgreSQL `scraped_jobs` table. Runs on GitHub Actions every 6 hours.

## Tasks

- [x] 1. Set up project structure and dependencies
  - Create the separate repo structure at `resumate-scraper/` with `scraper/` package, `requirements.txt`, `.github/workflows/scrape.yml`, `.gitignore`, and `README.md`
  - README should describe: "A job aggregation pipeline that scrapes entry-level tech positions from major ATS platforms (Greenhouse, Lever, Ashby, Workday) across 200+ companies in the US and Canada."
  - Add dependencies to root `requirements.txt`: httpx, sqlalchemy, pg8000, hypothesis, pytest, pytest-asyncio
  - Create `scraper/__init__.py`, `scraper/clients/__init__.py`, `scraper/services/__init__.py`, `scraper/tests/__init__.py`
  - _Requirements: 11.1, 11.6, 11.9_

- [ ] 2. Implement database layer and data models
  - [x] 2.1 Create `scraper/db.py` with SQLAlchemy model, session factory, `store_job()`, and `normalize_url()`
    - Define `ScrapedJob` ORM model mirroring the existing table schema (id, platform, title, company, location, url, posted_date, salary_range, company_logo, ats_type, source_platform, work_type, role_category, country, experience_level, scraped_at)
    - Implement `get_session(database_url)` to create engine and session
    - Implement `store_job(session, job_data)` using INSERT ON CONFLICT (url) DO NOTHING
    - Implement `normalize_url(url)` to strip trailing slashes and sort query params
    - _Requirements: 9.1, 9.2, 9.3, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ]* 2.2 Write property test for URL normalization idempotence
    - **Property 18: URL normalization is idempotent**
    - **Validates: Requirements 9.3**

- [ ] 3. Implement company registry loader
  - [x] 3.1 Create `scraper/companies.json` with initial company entries (200+ companies across Greenhouse, Lever, Ashby, Workday)
    - Include required fields: company_name, ats_platform, board_slug
    - Include optional fields: company_logo_url, enabled, workday_url_template
    - Target ~100 Greenhouse, ~50 Lever, ~30 Ashby, ~20 Workday companies
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 3.2 Implement registry loading and validation in `scraper/registry.py`
    - Load JSON file, validate required fields per entry
    - Filter to enabled-only entries (default enabled=true if absent)
    - Log warnings for invalid entries, skip without halting
    - _Requirements: 1.4, 1.5, 1.6_

  - [ ]* 3.3 Write property tests for registry loading
    - **Property 1: Registry field extraction preserves all data**
    - **Property 2: Enabled flag filtering**
    - **Property 3: Registry validation rejects entries missing required fields**
    - **Validates: Requirements 1.2, 1.4, 1.5, 1.6**

- [ ] 4. Implement entry-level filter service
  - [x] 4.1 Create `scraper/services/entry_level_filter.py`
    - Implement `EntryLevelFilter` class with `filter(title) -> FilterResult`
    - Define INTERN_PATTERNS, NEW_GRAD_PATTERNS, SENIOR_EXCLUSIONS regex lists
    - Return experience_level="internship" for intern patterns, "new_grad" for new-grad patterns
    - Exclude titles with senior-level indicators (senior, staff, principal, lead, manager, director, vp, head of)
    - Handle Roman numeral "I" as standalone suffix only (not part of words)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 4.2 Write property tests for entry-level filter
    - **Property 10: Entry-level filter assigns correct experience_level**
    - **Property 11: Non-entry-level titles are excluded**
    - **Property 12: Roman numeral "I" only matches as standalone suffix**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6**

- [ ] 5. Implement category classifier service
  - [x] 5.1 Create `scraper/services/category_classifier.py`
    - Implement `CategoryClassifier` class with `classify(title, department) -> str`
    - Define CATEGORIES dict with keyword lists for all 17 categories
    - Implement title-first priority: match title keywords, fallback to department, default to "Other"
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ]* 5.2 Write property tests for category classifier
    - **Property 13: Category classifier keyword matching**
    - **Property 14: Category classifier title priority over department fallback**
    - **Property 15: Category classifier defaults to "Other"**
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.6**

- [ ] 6. Implement location filter service
  - [x] 6.1 Create `scraper/services/location_filter.py`
    - Implement `LocationFilter` class with `filter(location) -> LocationResult`
    - Classify country as "US" or "CA" based on state/province abbreviations, full names, country names
    - Default "Remote" without country indicator to "US"
    - Classify work_type as "remote", "hybrid", or "onsite"
    - Return is_included=False for non-US/CA locations
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [ ]* 6.2 Write property tests for location filter
    - **Property 16: Location filter country classification**
    - **Property 17: Location filter work_type extraction**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement platform client base class
  - [x] 8.1 Create `scraper/clients/base.py`
    - Define `RawJob` dataclass (title, company, location, url, posted_date, department, salary_range, company_logo, employment_type)
    - Implement `BaseClient` with httpx.AsyncClient, retry logic for 429 responses, configurable delays
    - Implement `_request_with_retry(method, url, **kwargs)` with platform-specific retry counts and wait times
    - _Requirements: 2.6, 3.6, 4.5, 5.6, 12.3_

- [ ] 9. Implement Greenhouse client
  - [x] 9.1 Create `scraper/clients/greenhouse.py`
    - Implement `GreenhouseClient` extending `BaseClient`
    - Fetch from `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
    - Parse job objects: extract title, location.name, absolute_url, updated_at, departments
    - Construct apply URL: `https://boards.greenhouse.io/{slug}/jobs/{job_id}`
    - Extract salary from metadata if available
    - Extract company logo from board metadata if available
    - Handle 404 (log warning, skip) and 429 (wait 60s, retry 3x)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 13.2, 14.1_

  - [ ]* 9.2 Write property tests for Greenhouse parser
    - **Property 4: Greenhouse job parsing extracts all required fields**
    - **Property 5: Greenhouse URL construction**
    - **Validates: Requirements 2.2, 2.4**

- [ ] 10. Implement Lever client
  - [x] 10.1 Create `scraper/clients/lever.py`
    - Implement `LeverClient` extending `BaseClient`
    - Fetch from `https://api.lever.co/v0/postings/{slug}?mode=json`
    - Parse posting objects: extract text (title), categories.location, hostedUrl, createdAt, categories.team, categories.department, categories.commitment
    - Use hostedUrl as direct apply URL
    - Handle 404 and 429 responses
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 14.2_

  - [ ]* 10.2 Write property test for Lever parser
    - **Property 6: Lever job parsing extracts all required fields**
    - **Validates: Requirements 3.2, 3.3**

- [ ] 11. Implement Ashby client
  - [x] 11.1 Create `scraper/clients/ashby.py`
    - Implement `AshbyClient` extending `BaseClient`
    - Fetch from `https://api.ashbyhq.com/posting-api/job-board/{slug}`
    - Parse job objects: extract title, location, department, employmentType, applyUrl, publishedAt
    - Use applyUrl as direct apply URL
    - Handle 404 and 429 responses
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 14.3_

  - [ ]* 11.2 Write property test for Ashby parser
    - **Property 7: Ashby job parsing extracts all required fields**
    - **Validates: Requirements 4.2, 4.3**

- [ ] 12. Implement Workday client
  - [x] 12.1 Create `scraper/clients/workday.py`
    - Implement `WorkdayClient` extending `BaseClient`
    - Send POST request to Workday search API with entry-level keyword filters
    - Parse results: extract title, location, postedOn, external URL path
    - Construct apply URL from workday_url_template + job path
    - Use 2s delay between requests, 120s wait on 429, max 2 retries
    - Handle error responses (log warning, skip)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 12.2 Write property tests for Workday parser
    - **Property 8: Workday job parsing extracts all required fields**
    - **Property 9: Workday URL construction from template**
    - **Validates: Requirements 5.2, 5.3, 5.4**

- [ ] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Implement main orchestrator
  - [x] 14.1 Create `scraper/main.py` with `ATSScraper` class and CLI entry point
    - Implement `load_registry()` to load and validate companies.json
    - Implement `run(platform_filter, company_filter)` to orchestrate full pipeline
    - Implement `_scrape_platform(platform, companies)` to process all companies for a platform
    - Wire together: fetch jobs → entry-level filter → category classifier → location filter → staleness check (30-day cutoff) → store_job
    - Group companies by platform, process sequentially with delays
    - Track and return `ScrapeStats` (total_companies, succeeded, failed, jobs_found, after_filter, new_stored, duplicates_skipped)
    - Add CLI argument parsing: `--platform` and `--company` flags
    - Log summary stats on completion
    - Exit code 0 on success, 1 on fatal error (DB connection failure)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 13.1, 13.3, 14.4_

  - [ ]* 14.2 Write property test for stale job exclusion
    - **Property 19: Stale job exclusion by posted date**
    - **Validates: Requirements 10.6**

- [ ] 15. Create GitHub Actions workflow
  - [ ] 15.1 Create `.github/workflows/scrape.yml`
    - Configure cron schedule: `0 * * * *` (every hour — unlimited on public repos)
    - Add workflow_dispatch for manual trigger
    - Set up Python 3.11 with pip cache
    - Install dependencies from root `requirements.txt`
    - Run `python -m scraper.main` with DATABASE_URL from secrets
    - Set timeout-minutes: 45
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8_

- [ ]* 16. Write integration tests
  - [ ]* 16.1 Create `scraper/tests/test_pipeline_integration.py`
    - Test full pipeline with mocked HTTP responses
    - Test database write with ON CONFLICT deduplication
    - Test registry loading from actual companies.json
    - Test end-to-end flow: fetch → filter → classify → store
    - _Requirements: 9.1, 9.2, 10.1, 12.1, 12.2_

- [ ] 17. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using Hypothesis (min 100 examples)
- The scraper is a standalone Python package in `scraper/` — no coupling to the FastAPI backend
- All platform clients share the same base class for consistent retry/rate-limit behavior
- The company registry JSON should be populated with real company slugs for the target 200+ companies
