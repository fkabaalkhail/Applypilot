# Implementation Plan: Job Dashboard & Apply Flow

## Overview

This plan implements the full Jobright.ai-style job dashboard experience across three layers: database schema extensions, backend services and API endpoints, frontend dashboard components, and Chrome extension rework. Tasks are ordered to build incrementally — database first, then services, then API, then frontend, then extension — with each step wiring into the previous.

## Tasks

- [x] 1. Database schema extensions and new tables
  - [x] 1.1 Add new columns to ScrapedJob model
    - Add `source_platform`, `saved`, `experience_score`, `skill_score`, `industry_score`, `match_label`, `applicant_count`, `github_source_id`, `last_viewed_at` columns to `ScrapedJob` in `backend/db/models.py`
    - _Requirements: 1.4, 2.2, 9.1, 9.3_

  - [x] 1.2 Create GitHubSource model
    - Add `GitHubSource` table in `backend/db/models.py` with fields: `id`, `repo_url`, `repo_owner`, `repo_name`, `file_path`, `poll_interval_minutes`, `last_polled_at`, `last_commit_sha`, `status`, `error_message`, `created_at`
    - _Requirements: 1.2, 1.5, 11.1_

  - [x] 1.3 Create TailoredResume model
    - Add `TailoredResume` table in `backend/db/models.py` with fields: `id`, `job_id`, `original_text`, `tailored_text`, `diff_summary`, `status`, `created_at`
    - _Requirements: 10.1, 10.5_

  - [x] 1.4 Create InsiderConnection model
    - Add `InsiderConnection` table in `backend/db/models.py` with fields: `id`, `company`, `name`, `title`, `linkedin_url`, `relationship_type`, `source`, `discovered_at`
    - _Requirements: 4.1, 4.2_

  - [x] 1.5 Create Alembic migration or auto-create for new tables
    - Ensure database auto-creates new tables on startup (existing pattern uses `Base.metadata.create_all`)
    - Verify all new models are imported in the database module
    - _Requirements: 1.4, 10.5, 11.1_

- [x] 2. Backend Pydantic schemas
  - [x] 2.1 Create match and AI schemas
    - Create `backend/schemas/match.py` with `MatchBreakdown`, `FitAnalysis` models
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 2.2 Create resume and cover letter schemas
    - Create `backend/schemas/ai.py` with `TailoredResumeOut`, `CoverLetterOut` models
    - _Requirements: 3.2, 3.3, 10.1_

  - [x] 2.3 Create GitHub source schemas
    - Create `backend/schemas/github_source.py` with `GitHubSourceOut`, `GitHubSourceCreate` models
    - _Requirements: 11.1, 11.2_

  - [x] 2.4 Create connections and email schemas
    - Create `backend/schemas/connections.py` with `InsiderConnectionOut`, `EmailResult` models
    - _Requirements: 4.1, 5.1, 5.3_

  - [x] 2.5 Create apply flow schemas
    - Create `backend/schemas/apply.py` with `ApplySession`, `FillProfile`, `ProgressUpdate` models
    - _Requirements: 6.1, 6.2, 8.2_

  - [x] 2.6 Update ScrapedJobOut schema
    - Add `source_platform`, `saved`, `experience_score`, `skill_score`, `industry_score`, `match_label`, `applicant_count` fields to `ScrapedJobOut` in `backend/schemas/jobs.py`
    - _Requirements: 9.1, 2.2_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Backend services — GitHub Scraper
  - [x] 4.1 Implement GitHubScraper service
    - Create `backend/services/github_scraper.py` with `GitHubScraper` class
    - Implement `fetch_jobs(source)` to call GitHub API for repo content
    - Implement `parse_markdown_table(content)` to parse pipe-delimited markdown tables into structured job records
    - Implement `extract_link_from_cell(cell)` to extract URLs from markdown link syntax
    - Implement `poll_all_sources()` to iterate all active sources and fetch new jobs
    - _Requirements: 1.2, 1.7, 11.3, 11.4, 11.6_

  - [x] 4.2 Write property test for markdown table parsing round-trip
    - **Property 3: Markdown Table Parsing Round-Trip**
    - **Validates: Requirements 1.7, 11.3, 11.6**

  - [x] 4.3 Write property test for GitHub URL validation
    - **Property 6: GitHub Repository URL Validation**
    - **Validates: Requirements 11.2**

  - [x] 4.4 Write property test for incremental poll processing
    - **Property 16: Incremental Poll Processing**
    - **Validates: Requirements 11.4**

  - [x] 4.5 Implement job deduplication logic
    - Add deduplication by URL in the job storage pipeline (check existing URLs before insert)
    - _Requirements: 1.3_

  - [x] 4.6 Write property test for job deduplication
    - **Property 1: Job Deduplication Preserves URL Uniqueness**
    - **Validates: Requirements 1.3**

  - [x] 4.7 Write property test for job storage round-trip
    - **Property 2: Job Storage Round-Trip Preserves All Fields**
    - **Validates: Requirements 1.4**

- [x] 5. Backend services — Match Engine extension
  - [x] 5.1 Implement MatchEngine service
    - Create `backend/services/match_engine.py` with `MatchEngine` class
    - Implement `compute_breakdown(resume_text, job_description)` using structured Ollama prompt returning `MatchBreakdown`
    - Implement `analyze_fit(resume_text, job_description)` returning `FitAnalysis` with narrative
    - Implement `queue_analysis(job_id)` for background match computation
    - Implement score-to-label mapping: >=80 → "STRONG MATCH", >=60 → "GOOD MATCH", <60 → "FAIR MATCH"
    - _Requirements: 2.2, 2.3, 2.4, 2.7, 3.4_

  - [x] 5.2 Write property test for match score label mapping
    - **Property 4: Match Score Label Mapping**
    - **Validates: Requirements 2.2**

- [x] 6. Backend services — Resume Tailor and Cover Letter Generator
  - [x] 6.1 Implement ResumeTailor service
    - Create `backend/services/resume_tailor.py` with `ResumeTailor` class
    - Implement `tailor_resume(resume_text, job_description)` using Ollama to generate tailored version
    - Implement `compute_diff(original, tailored)` to produce human-readable diff summary
    - Store tailored resume in `TailoredResume` table
    - _Requirements: 3.2, 10.1, 10.2, 10.3, 10.5_

  - [x] 6.2 Write property test for diff computation correctness
    - **Property 17: Diff Computation Correctness**
    - **Validates: Requirements 10.3**

  - [x] 6.3 Implement CoverLetterGenerator service
    - Create `backend/services/cover_letter.py` with `CoverLetterGenerator` class
    - Implement `generate(resume_text, job_description, company)` using Ollama
    - _Requirements: 3.3_

- [x] 7. Backend services — Connection Finder and Email Finder
  - [x] 7.1 Implement ConnectionFinder service
    - Create `backend/services/connection_finder.py` with `ConnectionFinder` class
    - Implement `find_connections(company, user_connections)` categorizing by relationship type (beyond_network, previous_company, school)
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 7.2 Implement EmailFinder service
    - Create `backend/services/email_finder.py` with `EmailFinder` class
    - Implement `validate_linkedin_url(url)` for LinkedIn URL validation
    - Implement `resolve_email(linkedin_url)` using pattern matching and verification
    - _Requirements: 5.2, 5.5_

  - [x] 7.3 Write property test for LinkedIn URL validation
    - **Property 5: LinkedIn URL Validation**
    - **Validates: Requirements 5.5**

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Backend API — AI Router
  - [x] 9.1 Create AI router endpoints
    - Create `backend/routers/ai.py` with router prefix `/ai`
    - Implement `POST /ai/match-breakdown/{job_id}` → returns `MatchBreakdown`
    - Implement `POST /ai/tailor-resume/{job_id}` → returns `TailoredResumeOut`
    - Implement `POST /ai/cover-letter/{job_id}` → returns `CoverLetterOut`
    - Implement `POST /ai/analyze-fit/{job_id}` → returns `FitAnalysis`
    - Handle Ollama unreachable with 503 response
    - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_

  - [x] 9.2 Write unit tests for AI router
    - Test each endpoint with mocked Ollama service
    - Test 503 error when Ollama is unreachable
    - _Requirements: 3.7_

- [x] 10. Backend API — Apply Router
  - [x] 10.1 Create Apply router endpoints
    - Create `backend/routers/apply.py` with router prefix `/apply`
    - Implement `POST /apply/initiate` → creates apply session, updates job status to "applying", returns `ApplySession`
    - Implement `GET /apply/{session_id}/profile` → returns `FillProfile` with resume (tailored if available) and profile data
    - Implement `POST /apply/{session_id}/progress` → accepts `ProgressUpdate`
    - Implement `POST /apply/{session_id}/complete` → updates job status to "applied", creates `ApplicationRecord`
    - Implement `POST /apply/{session_id}/question` → creates `PendingQuestion`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 10.2 Write property test for apply flow resume version selection
    - **Property 7: Apply Flow Resume Version Selection**
    - **Validates: Requirements 6.7**

- [x] 11. Backend API — Connections Router
  - [x] 11.1 Create Connections router endpoints
    - Create `backend/routers/connections.py` with router prefix `/connections`
    - Implement `GET /connections/{company}` → returns `list[InsiderConnectionOut]`
    - Implement `POST /connections/email-find` → accepts LinkedIn URL, returns `EmailResult`
    - Validate LinkedIn URL input with 422 on invalid
    - _Requirements: 4.1, 5.1, 5.2, 5.4, 5.5_

- [x] 12. Backend API — GitHub Sources Router
  - [x] 12.1 Create GitHub Sources router endpoints
    - Create `backend/routers/github_sources.py` with router prefix `/github-sources`
    - Implement `GET /github-sources` → returns `list[GitHubSourceOut]`
    - Implement `POST /github-sources` → validates GitHub URL, creates source, returns `GitHubSourceOut`
    - Implement `PUT /github-sources/{id}` → updates source config
    - Implement `DELETE /github-sources/{id}` → removes source
    - Implement `POST /github-sources/{id}/poll` → triggers immediate poll, returns result
    - _Requirements: 1.5, 11.1, 11.2, 11.5_

- [x] 13. Backend API — Jobs Router extensions
  - [x] 13.1 Extend Jobs router with new filters and endpoints
    - Add `source` query parameter to `GET /jobs` for source platform filtering
    - Add `saved` query parameter to `GET /jobs` for saved jobs filter
    - Add `location` and `experience_level` query parameters
    - Add `avg_match_score` and `saved_count` to `GET /jobs/stats` response
    - Implement `POST /jobs/{id}/save` → sets `saved=1`
    - Implement `POST /jobs/{id}/unsave` → sets `saved=0`
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.7_

  - [x] 13.2 Write property test for aggregate stats computation
    - **Property 13: Aggregate Stats Computation**
    - **Validates: Requirements 9.4**

  - [x] 13.3 Write property test for multi-filter intersection
    - **Property 14: Multi-Filter Intersection**
    - **Validates: Requirements 9.5**

  - [x] 13.4 Write property test for pagination correctness
    - **Property 15: Pagination Correctness**
    - **Validates: Requirements 9.7**

- [x] 14. Register new routers in FastAPI app
  - Add `ai`, `apply`, `connections`, `github_sources` routers to `backend/main.py`
  - _Requirements: 3.1, 6.1, 4.1, 11.1_

- [x] 15. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Frontend — Job Detail View component
  - [x] 16.1 Create JobDetailView component
    - Create `frontend/src/components/JobDetailView.tsx`
    - Display company logo, company name, posted time, job title, location/type/level tags, full description, industry tags
    - Display circular match score indicator with label (STRONG/GOOD/FAIR MATCH)
    - Display match breakdown bars for Experience, Skill Match, Industry Experience
    - Display applicant count if available
    - Link to original job posting
    - Trigger match analysis on first view if not yet analyzed
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7_

  - [x] 16.2 Write unit tests for JobDetailView
    - Test rendering with full match breakdown data
    - Test rendering without match data (loading state)
    - Test match score label display logic
    - _Requirements: 2.1, 2.2_

- [x] 17. Frontend — AI Tools Sidebar component
  - [x] 17.1 Create AIToolsSidebar component
    - Create `frontend/src/components/AIToolsSidebar.tsx`
    - Display three action buttons: "Customize Your Resume", "Build Cover Letter", "Analyze How Well You Fit"
    - Show loading indicator with estimated time while AI processes
    - Display generated content with copy, download, and edit options
    - Show error message when Ollama is unreachable
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 17.2 Create InsiderConnections section
    - Create `frontend/src/components/InsiderConnections.tsx`
    - Display connections categorized by relationship type
    - Show name, title, and relationship type for each connection
    - Show empty state message when no connections found
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 17.3 Create EmailFinder component
    - Create `frontend/src/components/EmailFinder.tsx`
    - Display input field for LinkedIn profile URL
    - Show resolved email with copy-to-clipboard button
    - Show error message when email cannot be found
    - Validate LinkedIn URL format before submission
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 18. Frontend — Apply Flow Modal
  - [x] 18.1 Create ApplyFlowModal component
    - Create `frontend/src/components/ApplyFlowModal.tsx`
    - Display pre-apply checklist: resume version, cover letter status, match summary
    - Confirm button initiates apply flow (calls `POST /apply/initiate`)
    - Open job URL in new tab on confirm
    - Show progress updates from extension via chrome.runtime messaging
    - Update job status on completion
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 18.2 Create ResumeDiffView component
    - Create `frontend/src/components/ResumeDiffView.tsx`
    - Display side-by-side or inline diff of original vs tailored resume
    - Provide accept, edit, and reject buttons
    - _Requirements: 10.3, 10.4_

- [x] 19. Frontend — Enhanced Job List page
  - [x] 19.1 Update Jobs page with tabs, filters, and saved jobs
    - Update `frontend/src/pages/Jobs.tsx` to add "Saved" tab
    - Add source platform indicator on job cards
    - Add save/unsave button on job cards
    - Add filter controls: source platform, min match score, location, experience level
    - Add average match score to sidebar stats
    - Add new jobs count indicator
    - Implement pagination or infinite scroll (default page size 50)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 19.2 Write property test for tab filter correctness (frontend)
    - **Property 12: Tab Filter Correctness and Sort Order**
    - **Validates: Requirements 9.2**

- [x] 20. Frontend — GitHub Source Settings page
  - [x] 20.1 Create GitHub source management UI
    - Create `frontend/src/components/GitHubSourceSettings.tsx`
    - Display list of configured GitHub sources with status
    - Add form to add new source (URL input with validation)
    - Edit and delete existing sources
    - Manual poll trigger button per source
    - _Requirements: 1.5, 11.1, 11.2, 11.5_

- [x] 21. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 22. Chrome Extension — Plasmo framework setup and content scripts
  - [x] 22.1 Set up Plasmo extension structure
    - Update `extension/package.json` with required Plasmo dependencies and manifest permissions (storage, tabs, activeTab, scripting)
    - Configure content script injection for LinkedIn, Lever, Greenhouse, and Workday domains
    - Set up background service worker
    - Set up Chrome storage for auth state persistence
    - _Requirements: 7.1, 7.2, 7.4, 7.7_

  - [x] 22.2 Implement FormDetector class
    - Create `extension/src/form-detector.ts`
    - Implement `detectFields()` to find all visible, enabled form fields (text, email, select, textarea, radio, checkbox)
    - Implement `detectFieldsInIframe(iframe)` for iframe context switching
    - Classify each field by type and extract label/name
    - _Requirements: 8.1, 8.5_

  - [x] 22.3 Write property test for form field detection completeness
    - **Property 8: Form Field Detection Completeness**
    - **Validates: Requirements 8.1**

  - [x] 22.4 Implement field-to-profile mapping
    - Create `extension/src/field-mapper.ts`
    - Map detected fields to profile data using label keyword matching (name, email, phone, linkedin, etc.)
    - Map unrecognized labels to "unknown"
    - _Requirements: 8.2_

  - [x] 22.5 Write property test for field-to-profile mapping
    - **Property 9: Field-to-Profile Mapping Correctness**
    - **Validates: Requirements 8.2**

- [x] 23. Chrome Extension — FormFiller and ProgressTracker
  - [x] 23.1 Implement FormFiller class
    - Create `extension/src/form-filler.ts`
    - Implement `fillField(field, value)` with type-specific fill logic
    - Implement `fillReactInput(element, value)` using native value setter + event dispatch
    - Implement `dispatchEvents(element)` for input, change, blur events
    - Handle unfillable fields by highlighting and creating PendingQuestion
    - _Requirements: 8.2, 8.4, 8.6, 8.7_

  - [x] 23.2 Write property test for React input value persistence
    - **Property 11: React Input Value Persistence**
    - **Validates: Requirements 8.6**

  - [x] 23.3 Implement ProgressTracker class
    - Create `extension/src/progress-tracker.ts`
    - Implement `update(filled, total, currentLabel)` to compute percentage
    - Implement `render()` to display progress bar overlay on page
    - Implement `reportToDashboard(state)` via chrome.runtime messaging
    - Show 100% and enable submit when all fields complete
    - _Requirements: 8.3, 8.8_

  - [x] 23.4 Write property test for progress percentage computation
    - **Property 10: Progress Percentage Computation**
    - **Validates: Requirements 8.3**

  - [x] 23.5 Implement TaskQueue class
    - Create `extension/src/task-queue.ts`
    - Implement `enqueue(task)`, `processNext()`, `getFailedTasks()`
    - Add configurable delay between fills for anti-detection
    - _Requirements: 8.2, 8.7_

- [x] 24. Chrome Extension — Overlay panel and messaging
  - [x] 24.1 Implement floating overlay panel
    - Create `extension/src/overlay/OverlayPanel.tsx`
    - Show match score and quick-action buttons when on a job listing page
    - "Apply" button triggers form autofill flow
    - _Requirements: 7.3, 7.5_

  - [x] 24.2 Implement extension ↔ dashboard messaging protocol
    - Create `extension/src/messaging.ts`
    - Define message types: FILL_FORM, FILL_PROGRESS, FILL_COMPLETE, FILL_ERROR, NEED_ANSWER, GET_MATCH_SCORE, MATCH_SCORE_RESULT
    - Implement message handlers in background service worker
    - Connect extension to backend API for match scores and AI content
    - _Requirements: 7.3, 7.5, 7.6, 6.3_

- [x] 25. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 26. Integration wiring and end-to-end flow
  - [x] 26.1 Wire apply flow end-to-end
    - Connect ApplyFlowModal → POST /apply/initiate → open tab → extension FILL_FORM message → FormFiller → ProgressTracker → POST /apply/complete
    - Ensure job status transitions: new → applying → applied
    - Handle interrupted sessions (extension disconnect)
    - _Requirements: 6.1, 6.3, 6.4, 6.5_

  - [x] 26.2 Wire AI tools to job detail view
    - Connect AIToolsSidebar buttons to `/ai` endpoints
    - Display results in sidebar with loading states
    - Wire resume tailoring result into apply flow (use tailored version if accepted)
    - _Requirements: 3.1, 3.6, 6.7, 10.4_

  - [x] 26.3 Wire GitHub source polling to job list
    - Connect GitHub source settings to `/github-sources` CRUD endpoints
    - Ensure polled jobs appear in job list with `source_platform="github"` indicator
    - Wire new job count indicator
    - _Requirements: 1.2, 1.5, 9.6, 11.1_

  - [x] 26.4 Write integration tests for apply flow
    - Test full apply flow with mocked extension messaging
    - Test resume version selection (tailored vs original)
    - Test progress updates and completion
    - _Requirements: 6.1, 6.5, 6.7_

  - [x] 26.5 Write integration tests for GitHub polling
    - Test GitHub API polling with mocked responses
    - Test markdown table parsing with real repo formats
    - Test deduplication across sources
    - _Requirements: 1.2, 1.3, 11.4_

- [x] 27. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (17 total)
- Backend uses Python with Hypothesis for property-based testing
- Frontend/Extension uses TypeScript with fast-check for property-based testing
- All AI operations use existing Ollama/Llama integration
- Browser automation runs locally (not Docker) per project constraints
- Chrome extension uses Plasmo framework with Manifest V3
