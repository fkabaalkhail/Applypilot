# Implementation Plan: Resume Upload & Analysis

## Overview

Transform the stub `/app/resume` page into a full resume management system. The implementation builds incrementally: database schema changes first, then backend CRUD API endpoints, then frontend pages (list + detail/editor), then AI analysis integration, and finally Chrome extension autofill wiring. Property-based tests validate the 12 correctness properties from the design using Hypothesis (backend) and fast-check (frontend).

## Tasks

- [x] 1. Extend database model and Pydantic schemas
  - [x] 1.1 Update `ResumeProfileDB` model in `backend/db/models.py`
    - Rename existing `name` column to `profile_name` (person's name from resume)
    - Add `name` column (String, default="Untitled Resume") for user-given resume name
    - Add `target_job_title` (String, nullable=True)
    - Add `is_primary` (Integer, default=0)
    - Add `status` (String, default="analyzed")
    - Add `github_url` (String, nullable=True)
    - Add `other_link` (String, nullable=True)
    - Add `projects` (JSON, default=list)
    - Add `technologies` (JSON, default=dict)
    - Add `analysis_report` (JSON, nullable=True)
    - Add `updated_at` (DateTime, default=utcnow, onupdate=utcnow)
    - _Requirements: 3.6, 6.1, 7.2, 9.5_

  - [x] 1.2 Extend Pydantic schemas in `backend/schemas/resume.py`
    - Update `EducationItem` with fields: school, degree, start_date, end_date, gpa, achievements (list[str]), coursework (list[str])
    - Update `ExperienceItem` with fields: company, title, location, start_date, end_date, bullets (list[str])
    - Add `ProjectItem` model with fields: name, link, organization, location, start_date, end_date, bullets (list[str])
    - Update `ResumeProfile` with: github_url, other_link, projects (list[ProjectItem]), technologies (dict[str, list[str]])
    - Add `ResumeListItem` schema: id, name, target_job_title, is_primary, status, created_at, updated_at
    - Add `ResumeDetailResponse` schema: id, name, target_job_title, is_primary, profile, analysis_report, created_at, updated_at
    - Add `ResumeUpdateRequest` schema: name, target_job_title, profile (all optional)
    - Add `AnalysisReport` schema: overall_grade, urgent_fix_count, critical_fix_count, optional_fix_count, summary, highlights
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.3, 5.4, 5.5, 5.6, 8.1_

  - [x] 1.3 Write property test: Profile schema round-trip (Hypothesis)
    - **Property 1: Profile schema round-trip**
    - Generate random valid ResumeProfile objects with arbitrary fields using Hypothesis strategies
    - Serialize to JSON via `.model_dump_json()`, deserialize back via `ResumeProfile.model_validate_json()`
    - Assert the deserialized object equals the original
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

- [x] 2. Checkpoint - Verify schema changes
  - Ensure backend starts without errors
  - Ensure database table is recreated with new columns
  - Ask the user if questions arise.

- [x] 3. Implement backend CRUD API endpoints
  - [x] 3.1 Implement `GET /resumes` list endpoint in `backend/routers/resumes.py`
    - Query all ResumeProfileDB records ordered by created_at desc
    - Return list of ResumeListItem objects
    - _Requirements: 8.1_

  - [x] 3.2 Implement `GET /resumes/{id}` detail endpoint
    - Query by id, return 404 if not found
    - Serialize full profile from JSON columns into ResumeDetailResponse
    - Include analysis_report if present
    - _Requirements: 8.2, 8.7_

  - [x] 3.3 Implement `PUT /resumes/{id}` update endpoint
    - Accept ResumeUpdateRequest body
    - Update name, target_job_title, and/or profile fields
    - Set updated_at timestamp
    - Return 404 if resume not found
    - _Requirements: 8.3, 4.9, 7.2_

  - [x] 3.4 Implement `DELETE /resumes/{id}` endpoint
    - Delete resume by id, return 404 if not found
    - Return 204 on success
    - _Requirements: 8.4, 8.7_

  - [x] 3.5 Implement `PUT /resumes/{id}/primary` endpoint
    - Set is_primary=1 on target resume, set is_primary=0 on all others
    - Return 404 if resume not found
    - _Requirements: 6.2, 8.5_

  - [x] 3.6 Update `POST /resumes/upload` to use extended schema
    - Update OllamaService call to populate extended fields (projects, technologies, github_url, etc.)
    - Store new fields in DB (projects, technologies, github_url, other_link)
    - Set status="analyzed", name="Untitled Resume"
    - Return extended ResumeUploadResponse
    - _Requirements: 3.7, 8.1_

  - [x] 3.7 Write property test: Primary resume invariant (Hypothesis)
    - **Property 6: Primary resume invariant**
    - Generate random sets of resume records, call set-primary on a random id
    - Assert exactly one resume has is_primary=1 and it's the targeted one
    - **Validates: Requirements 6.2, 8.5**

  - [x] 3.8 Write property test: API CRUD round-trip (Hypothesis)
    - **Property 8: API CRUD round-trip**
    - Generate random ResumeProfile + metadata, store via upload/update, retrieve via GET
    - Assert all fields match the stored/updated values
    - **Validates: Requirements 7.2, 8.2, 8.3**

  - [x] 3.9 Write property test: Delete removes resume (Hypothesis)
    - **Property 9: Delete removes resume**
    - Create a resume, delete it, verify GET returns 404
    - Also verify GET/PUT/DELETE/analyze on non-existent ids return 404
    - **Validates: Requirements 8.4, 8.7**

- [x] 4. Implement AI quality analysis endpoint
  - [x] 4.1 Create prompt template `prompts/analyze_resume_quality.txt`
    - Prompt instructs Ollama to grade the resume (EXCELLENT/GOOD/FAIR)
    - Return JSON with: overall_grade, urgent_fix_count, critical_fix_count, optional_fix_count, summary, highlights
    - _Requirements: 9.3_

  - [x] 4.2 Add `analyze_resume_quality` method to `OllamaService`
    - Load the quality analysis prompt template
    - Send raw_text to Ollama, parse structured JSON response
    - Return AnalysisReport schema object
    - _Requirements: 9.1, 9.2_

  - [x] 4.3 Implement `POST /resumes/{id}/analyze` endpoint
    - Load resume by id (404 if not found)
    - Call OllamaService.analyze_resume_quality with raw_text
    - Persist analysis_report JSON on the resume record
    - Return AnalysisReport
    - Handle Ollama unreachable with 502 status
    - _Requirements: 9.1, 9.2, 9.4, 9.5_

  - [x] 4.4 Write property test: Analysis report persistence (Hypothesis)
    - **Property 11: Analysis report persistence**
    - Mock Ollama to return generated AnalysisReport, call analyze endpoint
    - Verify returned report has all required fields
    - Verify subsequent GET returns same analysis_report without re-running
    - **Validates: Requirements 9.2, 9.5**

- [x] 5. Checkpoint - Verify backend API
  - Ensure all backend endpoints respond correctly
  - Run backend tests: `pytest backend/tests/ -v`
  - Ask the user if questions arise.

- [x] 6. Implement autofill integration
  - [x] 6.1 Update `GET /apply/{session}/profile` to use primary resume
    - Query resume where is_primary=1; fall back to most recent if none
    - Merge technologies dict values into flat skills list for backward compat
    - Include projects in response
    - Return extended profile data
    - _Requirements: 6.5, 6.6, 11.1, 11.2, 11.3, 11.4_

  - [x] 6.2 Write property test: Autofill returns primary resume data (Hypothesis)
    - **Property 7: Autofill returns primary resume data**
    - Generate resumes with one marked primary, verify autofill returns that resume's data
    - Update the primary resume, verify subsequent autofill reflects changes
    - **Validates: Requirements 6.5, 11.1, 11.3**

  - [x] 6.3 Write property test: Skills list merges all technology categories (Hypothesis)
    - **Property 12: Skills list merges all technology categories**
    - Generate random technologies dicts with N categories
    - Verify the flat skills list contains every skill from every category
    - **Validates: Requirements 11.4**

- [x] 7. Implement frontend Resume List page
  - [x] 7.1 Create `frontend/src/resume.css` with all resume page styles
    - Resume list table with alternating rows/hover highlights
    - PRIMARY badge styling (green pill)
    - "Analysis Complete" status badge styling
    - Upload modal styles (overlay, drop zone, progress bar, success modal)
    - Section card styles for detail page (white bg, border-radius, padding)
    - Skill tag pill styles with category coloring
    - Analysis report styles (grade badge colors: green/blue/orange)
    - Responsive breakpoints (768px grid collapse, scrollable table)
    - Action buttons: pill-shaped with `var(--radius-pill)`
    - Save button: sticky footer
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 7.2 Replace `frontend/src/pages/Resume.tsx` with Resume List page
    - Fetch `GET /resumes` on mount, display in table
    - Columns: Resume Name, Target Job Title (or "Not set"), Last Modified, Created
    - Show PRIMARY badge for is_primary resumes
    - Show "Analysis Complete" badge for status="analyzed"
    - Loading spinner state, error message state, empty state with upload prompt
    - "+ Add Resume" button opens Upload Modal
    - Row click navigates to `/app/resume/:id`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 7.3, 7.4_

  - [x] 7.3 Implement Upload Modal component within Resume.tsx
    - File drop zone accepting PDF and DOCX only
    - Client-side file type validation with error message
    - Call `POST /resumes/upload` on file selection
    - Show Analysis_Progress_Indicator (progress bar + "Analyzing Your Resume" + rotating tips)
    - On success: show Upload_Success_Modal with name + target job title inputs
    - "View My Resume" button navigates to detail page
    - "Update to Profile" button sets resume as primary
    - On failure: show API error message in modal
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 8. Implement frontend Resume Detail page
  - [x] 8.1 Create `frontend/src/pages/ResumeDetail.tsx` with structured editor
    - Add route `/app/resume/:id` in `frontend/src/main.tsx`
    - Fetch `GET /resumes/{id}` on mount
    - Header Section_Card: editable name, email, phone, location, LinkedIn URL, GitHub URL, Other Link
    - Education Section_Card: entries with school, dates, GPA, degree, achievements, coursework tags
    - Experience Section_Card: entries with company, dates, location, title, editable bullets
    - Projects Section_Card: entries with name, link, dates, location, organization, editable bullets
    - Technologies Section_Card: categorized skill tags grouped by category
    - "+ Add" buttons on each section to append empty entries
    - "+ Bullet Points" buttons on experience and project entries
    - Save button calls `PUT /resumes/{id}` with full profile state
    - Success/error toast notifications
    - Loading and error states
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

  - [x] 8.2 Implement Analysis Report section in ResumeDetail
    - "Analyze" button triggers `POST /resumes/{id}/analyze`
    - Show progress bar during analysis
    - Display grade badge (EXCELLENT=green, GOOD=blue, FAIR=orange)
    - Display fix counts: Urgent, Critical, Optional
    - Display summary paragraph and highlights list
    - "Begin Improvements Now" button scrolls to editor
    - "Set as Primary" button for non-primary resumes / "PRIMARY" badge for primary
    - Error toast if analysis fails
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.3, 6.4_

- [x] 9. Checkpoint - Verify frontend pages
  - Ensure frontend builds without errors (`npm run build` in frontend)
  - Verify Resume List page renders with correct layout
  - Verify Resume Detail page renders all section cards
  - Ask the user if questions arise.

- [x] 10. Write frontend property-based tests (fast-check + Vitest)
  - [x] 10.1 Write property test: Resume list rendering faithfulness
    - **Property 2: Resume list rendering faithfulness**
    - Generate random lists of ResumeListItem objects with fast-check
    - Mock fetch, render Resume list page, verify one row per item
    - Verify correct name, target job title (or placeholder), PRIMARY badge iff is_primary, "Analysis Complete" badge iff status="analyzed"
    - **Validates: Requirements 1.1, 1.2, 1.3, 7.3, 7.4**

  - [x] 10.2 Write property test: Editor rendering faithfulness
    - **Property 3: Editor rendering faithfulness**
    - Generate random ResumeDetail responses with fast-check
    - Mock fetch, render ResumeDetail page, verify header fields match profile
    - Verify one education entry per item, one experience entry per item, one project entry per item, one category group per technologies key
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**

  - [x] 10.3 Write property test: Add entry grows section
    - **Property 4: Add entry grows section**
    - Generate random section states (education/experience/projects of length N, bullets of length M)
    - Click "+ Add" or "+ Bullet Points", verify list length increases by exactly 1 with empty fields
    - **Validates: Requirements 4.7, 4.8**

  - [x] 10.4 Write property test: Save payload matches editor state
    - **Property 5: Save payload matches editor state**
    - Generate random editor states with modifications
    - Click Save, intercept PUT request, verify body contains complete current profile state
    - **Validates: Requirements 4.9**

  - [x] 10.5 Write property test: Analysis report rendering
    - **Property 10: Analysis report rendering**
    - Generate random AnalysisReport objects (grade in {EXCELLENT, GOOD, FAIR}, non-negative counts, non-empty summary, highlights list)
    - Render AnalysisReport component, verify grade badge color, fix counts displayed, summary text, all highlights rendered
    - **Validates: Requirements 5.3, 5.4, 5.5, 5.6, 10.5**

- [x] 11. Final checkpoint - Ensure all tests pass
  - Run backend tests: `pytest backend/tests/ -v`
  - Run frontend tests: `npm run test` in frontend directory
  - Ensure both frontend and backend build successfully
  - Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Backend uses Python (FastAPI + SQLAlchemy + Hypothesis for PBT)
- Frontend uses TypeScript/React (Vite + Vitest + fast-check for PBT)
- Since this is SQLite with no production data, the table can be recreated for schema changes
- The existing `POST /resumes/upload` endpoint is extended (not replaced) to maintain backward compat
- Property tests use minimum 100 iterations per property
- CSS uses existing variables from `index.css` — no component library introduced
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at each major phase boundary
