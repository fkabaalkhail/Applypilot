# Requirements Document

## Introduction

This feature creates a full automated application pipeline that orchestrates the existing AutoApply subsystems into a single end-to-end flow. The pipeline fetches jobs via the existing LinkedIn guest API scraper, tailors the user's resume per job (summary rewrite + skill reordering only — no fabrication), opens each job page using the existing Selenium + selenium_stealth browser session, fills and submits the application form, answers open-ended questions via Ollama (Qwen2.5:14b at http://localhost:11434), captures confirmation screenshots, and logs every outcome to a CSV file. The pipeline must use Selenium (not Playwright) because LinkedIn detects Playwright's `--enable-automation` flag and blocks the SPA from rendering.

## Glossary

- **Pipeline**: The top-level orchestrator that sequences job fetching, resume tailoring, browser-based application, screenshot capture, and CSV logging for a batch of jobs.
- **Guest_API_Scraper**: The existing `_scrape_linkedin()` function in `backend/bot/linkedin_bot.py` that fetches job listings from LinkedIn's public guest API without requiring a browser session.
- **Browser_Session**: The existing `BrowserSession` singleton in `backend/services/browser_pool.py` that manages a persistent Selenium + selenium_stealth Chrome instance with anti-detection options.
- **Form_Filler**: The existing `FormFillerSelenium` class in `backend/bot/form_filler_selenium.py` that fills form fields using profile data, prefilled answers, and AI fallback.
- **Resume_Tailor**: The component that calls Ollama to rewrite the resume summary and reorder skills to match a specific job description, without fabricating any new experience or skills.
- **Ollama_Client**: The existing `OllamaService` class in `backend/services/ollama_service.py`, configured to use model `qwen2.5:14b` at `http://localhost:11434`.
- **Smart_Filter**: The existing `SmartFilter` class in `backend/bot/smart_filter.py` that evaluates jobs against user-defined filter rules (blacklists, salary, experience, duplicates).
- **Application_Log**: A CSV file at `applications/applications_log.csv` that records the outcome of every pipeline run attempt.
- **Confirmation_Screenshot**: A PNG screenshot saved to the `applications/` folder after a successful form submission.

## Requirements

### Requirement 1: Pipeline Orchestration

**User Story:** As a job seeker, I want a single command that fetches jobs, tailors my resume, applies to each one, and logs results, so that I can automate my entire application workflow.

#### Acceptance Criteria

1. WHEN the Pipeline is started, THE Pipeline SHALL call the Guest_API_Scraper to fetch new job listings using the user's configured job title, regions, and filters.
2. WHEN job listings are fetched, THE Pipeline SHALL evaluate each job through the Smart_Filter and skip jobs that fail filter checks.
3. WHEN a job passes the Smart_Filter, THE Pipeline SHALL execute the following steps in order: tailor resume, open job page in Browser_Session, fill and submit the application form, capture a Confirmation_Screenshot, and append a row to the Application_Log.
4. THE Pipeline SHALL process jobs sequentially with a randomized delay between 30 and 120 seconds between each application to mimic human behavior.
5. THE Pipeline SHALL respect the user's configured `daily_apply_limit` and `weekly_apply_limit` and stop processing when either limit is reached.
6. IF the Pipeline encounters an unhandled exception during a single job application, THEN THE Pipeline SHALL log the failure to the Application_Log, capture a failure screenshot, and continue to the next job.

### Requirement 2: Resume Tailoring

**User Story:** As a job seeker, I want my resume summary and skill order adjusted for each job, so that my application highlights the most relevant qualifications without fabricating anything.

#### Acceptance Criteria

1. WHEN a job passes the Smart_Filter, THE Resume_Tailor SHALL send the user's resume text and the job description to the Ollama_Client using the `qwen2.5:14b` model.
2. THE Resume_Tailor SHALL rewrite only the professional summary section and reorder the skills list to prioritize skills mentioned in the job description.
3. THE Resume_Tailor SHALL preserve all factual content from the original resume and not add any experience, skills, certifications, or education that do not exist in the original resume.
4. THE Resume_Tailor SHALL save the tailored resume to `data/tailored_resumes/resume_{job_id}_{timestamp}.txt`.
5. IF the Ollama_Client is unreachable or returns an error, THEN THE Resume_Tailor SHALL fall back to the original resume and log a warning.

### Requirement 3: Browser-Based Application Submission

**User Story:** As a job seeker, I want the bot to open each job page and fill out the application form automatically, so that I do not have to manually apply to each job.

#### Acceptance Criteria

1. THE Pipeline SHALL use the existing Browser_Session (Selenium + selenium_stealth with `excludeSwitches: ["enable-automation"]` and `useAutomationExtension: False`) for all browser interactions.
2. THE Pipeline SHALL NOT use Playwright for any browser automation because LinkedIn detects Playwright and blocks the SPA from rendering.
3. WHEN a job page is loaded, THE Pipeline SHALL detect whether the job uses Easy Apply or an external ATS and route to the appropriate handler.
4. WHEN an Easy Apply form is detected, THE Form_Filler SHALL fill all visible fields using the priority order: profile data, prefilled answers, AI-generated answers via Ollama_Client.
5. WHEN the form contains a file upload field, THE Form_Filler SHALL upload the tailored resume file for the current job.
6. WHEN the form contains multi-step navigation (Next, Review, Submit), THE Form_Filler SHALL click through each step, filling fields on each page, until the Submit button is reached.
7. WHEN the Submit button is found, THE Pipeline SHALL click it and wait for the confirmation page to load.

### Requirement 4: Open-Ended Question Answering

**User Story:** As a job seeker, I want the bot to answer open-ended application questions using my resume context, so that I do not have to manually answer repetitive questions.

#### Acceptance Criteria

1. WHEN the Form_Filler encounters a text input or textarea that cannot be matched to profile data or prefilled answers, THE Ollama_Client SHALL generate an answer using the `qwen2.5:14b` model with the user's resume as context.
2. WHEN the Form_Filler encounters a select dropdown or radio group that cannot be matched to prefilled answers, THE Ollama_Client SHALL select the most appropriate option based on the user's resume context.
3. THE Ollama_Client SHALL use the existing `answer_question.txt` prompt template, which instructs the model to answer in first person, draw from resume context, and never fabricate information.
4. THE Ollama_Client SHALL NOT use any paid AI APIs — all AI inference runs locally via Ollama at `http://localhost:11434`.
5. IF the Ollama_Client fails to generate an answer within 30 seconds, THEN THE Form_Filler SHALL skip the field and log it as unanswered in the Application_Log.

### Requirement 5: Confirmation Screenshot Capture

**User Story:** As a job seeker, I want a screenshot of each successful application confirmation, so that I have proof of submission.

#### Acceptance Criteria

1. WHEN a form submission succeeds and a confirmation page or message is detected, THE Pipeline SHALL capture a full-page screenshot using the Browser_Session.
2. THE Pipeline SHALL save the screenshot to `applications/screenshots/{company}_{job_title}_{timestamp}.png` with filesystem-safe characters.
3. WHEN a form submission fails, THE Pipeline SHALL capture a failure screenshot and save it to `applications/screenshots/failed_{company}_{job_title}_{timestamp}.png`.
4. THE Pipeline SHALL create the `applications/screenshots/` directory if it does not exist.

### Requirement 6: CSV Application Logging

**User Story:** As a job seeker, I want every application attempt logged to a CSV file, so that I can track my progress and debug failures.

#### Acceptance Criteria

1. THE Pipeline SHALL append a row to `applications/applications_log.csv` after each job application attempt.
2. THE Application_Log SHALL contain the following columns: `timestamp`, `company`, `job_title`, `job_url`, `status`, `resume_version`, `screenshot_path`, `questions_answered`, `failure_reason`, `ats_type`.
3. THE Application_Log `status` column SHALL use one of these values: `success`, `failed`, `captcha`, `skipped`, `already_applied`.
4. WHEN the CSV file does not exist, THE Pipeline SHALL create it with a header row before appending the first data row.
5. THE Pipeline SHALL write to the CSV using append mode to preserve previous run data.

### Requirement 7: Error Handling and Skip Logic

**User Story:** As a job seeker, I want the bot to handle errors gracefully and skip problematic jobs, so that one failure does not stop the entire pipeline.

#### Acceptance Criteria

1. WHEN the Pipeline detects a CAPTCHA challenge on a job page, THE Pipeline SHALL skip the job, log the status as `captcha` in the Application_Log, and continue to the next job.
2. WHEN the Pipeline detects that the user has already applied to a job (via page badge text or ApplicationRecord lookup), THE Pipeline SHALL skip the job, log the status as `already_applied`, and continue to the next job.
3. WHEN the Browser_Session loses its login state during a pipeline run, THE Pipeline SHALL attempt to re-authenticate using the stored li_at cookie or saved cookies before continuing.
4. IF re-authentication fails, THEN THE Pipeline SHALL stop the pipeline run and log the reason.
5. WHEN a single job application throws an exception, THE Pipeline SHALL catch the exception, log the failure with the exception message, capture a failure screenshot, and proceed to the next job.
6. THE Pipeline SHALL call `BrowserSession.keep_alive()` at least once every 5 minutes during long pipeline runs to prevent LinkedIn session timeout.
7. WHEN the Pipeline finishes processing all jobs or reaches a limit, THE Pipeline SHALL log a summary line to the Application_Log with total counts for each status category.

### Requirement 8: Ollama Configuration

**User Story:** As a job seeker, I want all AI steps to use my local Ollama instance with the Qwen2.5:14b model, so that I do not incur any API costs.

#### Acceptance Criteria

1. THE Ollama_Client SHALL be configured to use `http://localhost:11434` as the base URL and `qwen2.5:14b` as the model for all pipeline AI operations.
2. WHEN the Pipeline starts, THE Ollama_Client SHALL verify that Ollama is reachable by calling the `/api/tags` endpoint.
3. IF Ollama is not reachable at startup, THEN THE Pipeline SHALL exit with a clear error message instructing the user to start Ollama.
4. THE Pipeline SHALL NOT call any external paid AI API (OpenAI, Anthropic, Google, etc.) for any step in the pipeline.
