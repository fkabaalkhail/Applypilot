# Implementation Plan: Auto-Apply Pipeline

## Overview

Implement the end-to-end auto-apply pipeline that orchestrates job scraping, resume tailoring, browser-based form filling, screenshot capture, and CSV logging into a single Celery-driven batch flow. New components: `CSVLogger`, `ScreenshotCapture`, `ResumeTailor`, `PipelineRunner`. All code is Python, tests use Hypothesis + pytest.

## Tasks

- [ ] 1. Implement CSVLogger
  - [ ] 1.1 Create `backend/bot/csv_logger.py` with `CSVLogger` class
    - Implement `__init__` that creates `applications/` directory and writes CSV header if file doesn't exist
    - Implement `log(row: dict)` that appends a single row in append mode, sanitizing commas/newlines
    - Implement `log_summary(counts: dict)` that appends a summary row with status totals
    - Define `CSV_PATH = "applications/applications_log.csv"` and `COLUMNS` list (10 columns)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 1.2 Write property test: CSV append preserves existing data (Property 10)
    - **Property 10: CSV append preserves existing data**
    - For any sequence of N `log()` calls, the CSV must contain exactly N data rows plus one header row, and previous rows must be unmodified
    - **Validates: Requirements 6.1, 6.5**

  - [ ]* 1.3 Write property test: CSV rows have valid schema and status (Property 11)
    - **Property 11: CSV rows have valid schema and status**
    - For any row written, it must contain exactly 10 required columns and `status` must be one of: `success`, `failed`, `captcha`, `skipped`, `already_applied`
    - **Validates: Requirements 6.2, 6.3**

  - [ ]* 1.4 Write property test: Summary row matches actual run totals (Property 13)
    - **Property 13: Summary row matches actual run totals**
    - For any list of status outcomes, the summary row counts must exactly match the number of rows logged with each status
    - **Validates: Requirements 7.7**

- [ ] 2. Implement ScreenshotCapture
  - [ ] 2.1 Create `backend/bot/screenshot_capture.py` with `ScreenshotCapture` class
    - Implement `__init__(driver)` that stores the Selenium driver reference
    - Implement `capture_success(company, job_title)` returning the screenshot file path
    - Implement `capture_failure(company, job_title)` returning the screenshot file path with `failed_` prefix
    - Implement `_safe_filename(text)` static method: replace non-alphanumeric chars with underscores, truncate to 200 chars
    - Create `applications/screenshots/` directory if missing
    - Filename pattern: `{safe_company}_{safe_title}_{timestamp}.png` (success) / `failed_{safe_company}_{safe_title}_{timestamp}.png` (failure)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 2.2 Write property test: Screenshot filenames are filesystem-safe (Property 9)
    - **Property 9: Screenshot filenames are filesystem-safe**
    - For any company name and job title (including Unicode, special chars, empty strings), the filename must contain only alphanumeric, underscores, hyphens, dots, and not exceed 200 chars
    - **Validates: Requirements 5.2, 5.3**

- [ ] 3. Implement ResumeTailor
  - [ ] 3.1 Create `backend/bot/resume_tailor.py` with `ResumeTailor` class
    - Implement `__init__(ollama: OllamaService)` storing the Ollama client
    - Implement `tailor(resume_text, job_description, job_id)` that calls `OllamaService.tailor_resume()`, saves output to `data/tailored_resumes/resume_{job_id}_{timestamp}.txt`, returns `(file_path, resume_version)`
    - On Ollama failure: log warning, return `("", "original")` as fallback
    - Create `data/tailored_resumes/` directory if missing
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [ ]* 3.2 Write property test: Tailored resume file path follows naming convention (Property 6)
    - **Property 6: Tailored resume file path follows naming convention**
    - For any positive integer job_id and timestamp, the file must be saved at `data/tailored_resumes/resume_{job_id}_{timestamp}.txt` and exist on disk
    - **Validates: Requirements 2.4**

- [ ] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement PipelineRunner core orchestration
  - [ ] 5.1 Create `backend/bot/pipeline_runner.py` with `run_pipeline(task_id)` function
    - Verify Ollama is reachable via `/api/tags` at startup; exit with clear error if unreachable
    - Load user settings from DB (reuse `_load_settings()` pattern from `linkedin_bot.py`)
    - Call `scrape_jobs(task_id)` to fetch new job listings
    - Initialize `SmartFilter`, `CSVLogger`, `ScreenshotCapture`, `ResumeTailor`
    - Query `ScrapedJob` records with `status=NEW` ordered by `match_score` desc
    - _Requirements: 1.1, 1.2, 8.1, 8.2, 8.3_

  - [ ] 5.2 Implement per-job processing loop in `run_pipeline`
    - For each job: evaluate through `SmartFilter`, skip if fails (log as `skipped` or `already_applied`)
    - If `resume_tailoring_enabled`: call `ResumeTailor.tailor()`, else use original resume
    - Open job page in `BrowserSession`, detect Easy Apply vs external ATS
    - Call `FormFillerSelenium.fill_with_ai_fallback()` to fill form fields
    - Click Submit, capture success/failure screenshot via `ScreenshotCapture`
    - Append row to CSV via `CSVLogger.log()`
    - Insert randomized delay between `apply_delay_min` and `apply_delay_max` (default 30–120s)
    - _Requirements: 1.3, 1.4, 2.1, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1_

  - [ ] 5.3 Implement limit enforcement and keep-alive
    - Query `ApplicationRecord` counts for daily and weekly limits before each job
    - Stop pipeline when `daily_apply_limit` or `weekly_apply_limit` is reached
    - Enforce `max_applications_per_run` setting
    - Call `BrowserSession.keep_alive()` every 5 minutes using `maybe_keep_alive()` pattern from `linkedin_bot.py`
    - _Requirements: 1.5, 7.6_

  - [ ] 5.4 Implement error handling and recovery in `run_pipeline`
    - Wrap each job in try/except: on exception, capture failure screenshot, log `failed` row to CSV, continue to next job
    - CAPTCHA detection: check URL for `checkpoint`/`challenge`, check page body for security verification text; skip job with `captcha` status
    - Session loss recovery: after each apply, call `BrowserSession.is_session_valid()`; if invalid, attempt `ensure_logged_in()`; if re-login fails, log summary and exit
    - Ollama failure during tailoring: fall back to original resume
    - Ollama timeout during question answering: skip field, log as unanswered
    - File system errors (CSV write, screenshot, resume save): log warning, continue pipeline
    - At pipeline end: call `CSVLogger.log_summary()` with status counts
    - _Requirements: 1.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.7_

- [ ] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Register Celery task and API endpoint
  - [ ] 7.1 Add `run_pipeline` Celery task to `backend/worker.py`
    - Register as `backend.worker.run_pipeline` with `bind=True`
    - Import and call `run_pipeline(self.request.id)` from `backend.bot.pipeline_runner`
    - Follow existing pattern from `run_autopilot` task (load settings, init SmartFilter)
    - _Requirements: 1.1_

  - [ ] 7.2 Add `/pipeline/start` POST endpoint to a new or existing router
    - Create endpoint that dispatches the `run_pipeline` Celery task
    - Return the task ID for status tracking
    - Follow existing patterns from jobs/applications routers
    - _Requirements: 1.1_

- [ ] 8. Property-based tests for pipeline behavior
  - [ ]* 8.1 Write property test: SmartFilter gates all jobs (Property 1)
    - **Property 1: SmartFilter gates all jobs**
    - For any list of scraped jobs and filter config, every job reaching apply must have passed `SmartFilter.evaluate()`, and every failing job must be skipped with correct reason
    - **Validates: Requirements 1.2, 7.2**

  - [ ]* 8.2 Write property test: Inter-application delay is bounded (Property 2)
    - **Property 2: Inter-application delay is bounded**
    - For any pipeline run with multiple jobs, the delay between consecutive applications must be in `[apply_delay_min, apply_delay_max]`
    - **Validates: Requirements 1.4**

  - [ ]* 8.3 Write property test: Daily and weekly limits are never exceeded (Property 3)
    - **Property 3: Daily and weekly limits are never exceeded**
    - For any combination of limits and existing ApplicationRecord counts, the pipeline must stop before exceeding limits
    - **Validates: Requirements 1.5**

  - [ ]* 8.4 Write property test: Fail-forward on per-job exceptions (Property 4)
    - **Property 4: Fail-forward on per-job exceptions**
    - For any ordered list of jobs where some throw exceptions, the pipeline must process all non-failing jobs and produce exactly one failure row + screenshot per failing job
    - **Validates: Requirements 1.6, 7.5**

  - [ ]* 8.5 Write property test: Resume tailoring preserves original content (Property 5)
    - **Property 5: Resume tailoring preserves original content**
    - For any original resume text and job description, the tailored output must not contain skills/experience/certs/education not in the original
    - **Validates: Requirements 2.2, 2.3**

  - [ ]* 8.6 Write property test: ATS type detection is consistent (Property 7)
    - **Property 7: ATS type detection is consistent with page signals**
    - For any HTML with Easy Apply indicators, detection must return `easy_apply`; for known ATS domains, must return correct type
    - **Validates: Requirements 3.3**

  - [ ]* 8.7 Write property test: Form fill priority order (Property 8)
    - **Property 8: Form fill priority order**
    - For any field matching both profile data and prefilled answer, profile data must be used; prefilled before AI; AI only as last resort
    - **Validates: Requirements 3.4**

  - [ ]* 8.8 Write property test: Keep-alive called within 5-minute intervals (Property 12)
    - **Property 12: Keep-alive is called within 5-minute intervals**
    - For any pipeline run lasting >5 minutes, `keep_alive()` must be called at least once every 300 seconds
    - **Validates: Requirements 7.6**

- [ ] 9. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–13)
- All property tests use Hypothesis with `max_examples=100` and `deadline=None`
- Test file location: `backend/tests/test_pipeline_properties.py`
