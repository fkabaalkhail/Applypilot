# Requirements Document

## Introduction

Auto Apply Bot is a premium desktop application that automates job applications on LinkedIn (Easy Apply) and external ATS platforms. The system comprises a React+Vite dashboard frontend, a FastAPI+SQLAlchemy+SQLite backend, a Celery+Redis background worker, Selenium+selenium_stealth browser automation running on the user's local machine, and Ollama/Llama AI integration for intelligent form filling, resume matching, and cover letter generation.

This document covers the full feature scope: reliable LinkedIn authentication, end-to-end Easy Apply form completion, external ATS support (Greenhouse, Lever, Workday), application tracking and review, autopilot mode, smart filtering, AI-powered assistance, HR outreach, browser UX enhancements, and desktop app packaging.

## Glossary

- **Bot**: The background automation process that controls the browser to scrape jobs and submit applications
- **Dashboard**: The React frontend where the user views jobs, stats, and manages applications
- **BrowserSession**: The Selenium-based singleton that manages a persistent Chrome instance with anti-detection stealth options
- **FormFiller**: The component that detects form fields (text, select, radio, file upload, textarea) and fills them using profile data, prefilled answers, or AI
- **Easy_Apply**: LinkedIn's in-platform application flow that opens a multi-step modal form without leaving LinkedIn
- **ATS**: Applicant Tracking System — external platforms (Greenhouse, Lever, Workday) that host job application forms outside LinkedIn
- **Autopilot**: A continuous mode where the Bot automatically applies to all matching jobs without manual user intervention
- **PendingQuestion**: A form question the Bot could not answer automatically, stored in the database for the user to resolve
- **Prefilled_Answers**: A user-configured dictionary of common application question/answer pairs stored in UserSettings
- **OllamaService**: The async AI client that communicates with a local Ollama/Llama model for resume analysis, question answering, cover letter generation, and job matching
- **Task_Runner**: The Celery-based service that dispatches background tasks (scrape, apply, analyze) and streams logs via Redis pub/sub
- **ApplicationRecord**: A database row tracking each submitted application with status, timestamps, and metadata
- **ScrapedJob**: A database row representing a job listing found by the scraper, including match score and ATS type
- **Cookie_Persistence**: The mechanism that saves and loads browser cookies via pickle files to maintain LinkedIn sessions across restarts
- **Smart_Filter**: The rule engine that evaluates jobs against user-defined blacklists, salary ranges, experience requirements, and duplicate detection before applying

## Requirements

### Requirement 1: LinkedIn Authentication and Session Management

**User Story:** As a user, I want the Bot to reliably authenticate with LinkedIn and persist sessions, so that I do not have to re-login for every application run.

#### Acceptance Criteria

1. WHEN the user pastes a valid li_at cookie value in the Settings page, THE BrowserSession SHALL inject the cookie into the Chrome instance and verify login by navigating to the LinkedIn feed page.
2. WHEN saved cookies exist on disk for the configured LinkedIn email, THE BrowserSession SHALL load the cookies and attempt session restoration before trying other login methods.
3. WHEN cookie-based login fails and LinkedIn credentials are configured, THE BrowserSession SHALL navigate to the LinkedIn login page, enter the email and password, and submit the form.
4. IF LinkedIn presents a 2FA or security challenge during login, THEN THE Dashboard SHALL display a verification code modal prompting the user to enter the code received via email or SMS.
5. WHEN the user submits a verification code through the Dashboard modal, THE Bot SHALL relay the code to the browser and complete the authentication flow.
6. WHEN login succeeds by any method, THE BrowserSession SHALL save all current cookies to a pickle file keyed by the user's email hash.
7. THE BrowserSession SHALL attempt login methods in this order: saved cookies, li_at cookie injection, credential-based login.
8. IF all login methods fail, THEN THE BrowserSession SHALL save a debug screenshot and return a descriptive error message to the user.
9. WHILE the Bot is running an apply or scrape task, THE BrowserSession SHALL validate that the session is still active before each operation by checking the current URL contains "/feed".

### Requirement 2: Easy Apply End-to-End Form Completion

**User Story:** As a user, I want the Bot to complete LinkedIn Easy Apply forms from start to finish, so that I can apply to jobs without manual intervention.

#### Acceptance Criteria

1. WHEN the user clicks "Auto Apply" on a job card, THE Bot SHALL navigate to the LinkedIn job page and locate the Easy Apply button using aria-label selectors and JavaScript text-content fallback.
2. WHEN the Easy Apply button is found, THE Bot SHALL click the button and wait for the application modal to appear.
3. WHEN the Easy Apply modal opens, THE FormFiller SHALL detect all visible form fields (text inputs, email, phone, select dropdowns, textareas, radio buttons, checkboxes, file uploads) within the modal.
4. THE FormFiller SHALL fill detected fields using this priority order: profile data mapping, prefilled answers dictionary, AI-generated answers via OllamaService.
5. WHEN a resume upload field is detected, THE FormFiller SHALL upload the resume file configured in UserSettings.
6. WHEN LinkedIn prompts the user to select from previously uploaded resumes, THE Bot SHALL select the first available resume.
7. WHEN all visible fields on the current step are filled, THE Bot SHALL locate and click the "Continue to next step" button to advance to the next form page.
8. WHEN the "Review your application" button appears, THE Bot SHALL click the review button and proceed to the final submission step.
9. WHEN the "Submit application" button appears, THE Bot SHALL click the submit button and record the application as successful.
10. WHEN the FormFiller encounters a field that cannot be filled by profile data, prefilled answers, or AI, THE Bot SHALL save the question as a PendingQuestion in the database and pause the application with status "waiting_answer".
11. WHEN the user provides answers to PendingQuestions through the Dashboard modal, THE Bot SHALL resume the application from where it paused and fill the answered fields.
12. IF the Bot cannot find a Next, Review, or Submit button after filling fields, THEN THE Bot SHALL mark the application as failed and close the modal.
13. THE Bot SHALL handle up to 10 sequential form steps in a single Easy Apply flow.
14. WHEN filling text inputs inside React-based forms, THE FormFiller SHALL use send_keys() to simulate real typing and dispatch input, change, and blur events to ensure values persist.

### Requirement 3: Already-Applied and Duplicate Detection

**User Story:** As a user, I want the Bot to skip jobs I have already applied to, so that I do not waste time on duplicate applications.

#### Acceptance Criteria

1. WHEN the Bot navigates to a job page, THE Bot SHALL check if the page displays an "Applied" badge or "Already applied" text and skip the job if detected.
2. BEFORE starting an application, THE Bot SHALL query the ApplicationRecord table to check if a record with the same job URL already exists and skip the job if found.
3. WHEN a job is skipped due to duplicate detection, THE Bot SHALL update the ScrapedJob status to "skipped" and log the reason.
4. THE Bot SHALL track applied jobs by both LinkedIn job ID and job URL to catch reposted listings.

### Requirement 4: Modal Discard and Failure Recovery

**User Story:** As a user, I want the Bot to cleanly close application modals on failure, so that the browser session remains usable for subsequent applications.

#### Acceptance Criteria

1. IF an Easy Apply form submission fails or times out, THEN THE Bot SHALL attempt to close the modal by clicking the dismiss button or sending the Escape key.
2. IF LinkedIn displays a "Discard application?" confirmation dialog, THEN THE Bot SHALL click the "Discard" button to confirm closure.
3. WHEN a modal is dismissed after failure, THE Bot SHALL update the ScrapedJob status to "failed" and log the failure reason.
4. AFTER closing a failed modal, THE Bot SHALL switch the driver back to the default content to ensure subsequent operations are not trapped in a stale iframe context.

### Requirement 5: Application Tracking and Review

**User Story:** As a user, I want to review all my applications with detailed history, so that I can track my job search progress.

#### Acceptance Criteria

1. THE Dashboard SHALL display an application review page listing all ApplicationRecords with columns for company, role, platform, status, and applied date.
2. WHEN the Bot submits an application, THE Bot SHALL capture a screenshot of the filled form before clicking Submit and store the screenshot path in the ApplicationRecord.
3. THE application review page SHALL allow the user to view the pre-submit screenshot for each application.
4. THE application review page SHALL display the resume version and cover letter used for each application.
5. THE application review page SHALL provide search functionality to filter applications by company name, role title, or status.
6. THE application review page SHALL provide filter controls to show only applied, failed, skipped, interviewing, rejected, or offer status records.
7. WHEN the user clicks "Export CSV", THE Dashboard SHALL generate and download a CSV file containing all application records with fields: job ID, title, company, location, work style, description excerpt, experience required, skills, HR contact name, HR contact link, resume used, date posted, date applied, job link, questions found, and status.
8. THE ApplicationRecord model SHALL store additional metadata: screenshot path, cover letter text, questions answered, and ATS type.

### Requirement 6: Autopilot Mode

**User Story:** As a user, I want the Bot to automatically apply to all matching jobs continuously, so that I can maximize my application volume without manual clicks.

#### Acceptance Criteria

1. THE Dashboard SHALL provide an Autopilot toggle that enables or disables continuous auto-apply mode.
2. WHILE Autopilot is enabled, THE Bot SHALL repeatedly scrape new jobs, evaluate them against Smart_Filter rules, and apply to all qualifying Easy Apply jobs.
3. WHILE Autopilot is enabled, THE Dashboard SHALL display real-time stats: jobs applied today, jobs applied this week, and total interview requests.
4. THE Dashboard SHALL display a "recently applied" carousel showing the last 10 applications with company logo, title, and timestamp.
5. THE Settings page SHALL provide configurable daily and weekly application limits for Autopilot mode.
6. WHEN the daily or weekly application limit is reached, THE Bot SHALL pause Autopilot and notify the user through the Dashboard.
7. WHILE Autopilot is enabled, THE Bot SHALL continue running until the user disables the toggle or a limit is reached.
8. WHEN Autopilot encounters a PendingQuestion it cannot answer, THE Bot SHALL skip that job, log the reason, and continue to the next matching job.
9. THE Bot SHALL introduce randomized delays between applications (configurable range) to mimic human behavior during Autopilot runs.

### Requirement 7: Smart Filtering

**User Story:** As a user, I want to define filtering rules that automatically skip undesirable jobs, so that the Bot only applies to jobs that match my preferences.

#### Acceptance Criteria

1. THE Settings page SHALL provide a company blacklist input where the user can add company names to exclude from applications.
2. THE Settings page SHALL provide a keyword blacklist input where the user can add terms that, if found in a job description, cause the job to be skipped.
3. THE Settings page SHALL provide minimum and maximum salary range inputs for filtering jobs by compensation.
4. WHEN a ScrapedJob has a salary range that falls entirely below the user's minimum salary setting, THE Smart_Filter SHALL mark the job as skipped.
5. WHEN a ScrapedJob description contains a keyword from the keyword blacklist, THE Smart_Filter SHALL mark the job as skipped and log the matched keyword.
6. WHEN a ScrapedJob company name matches an entry in the company blacklist (case-insensitive), THE Smart_Filter SHALL mark the job as skipped.
7. THE OllamaService SHALL extract years-of-experience requirements from job descriptions and store the value in the ScrapedJob record.
8. THE Settings page SHALL provide minimum and maximum years-of-experience inputs for the user's qualification range.
9. WHEN a job requires more years of experience than the user's maximum setting, THE Smart_Filter SHALL mark the job as skipped with reason "overqualified requirement".
10. WHEN a job requires fewer years of experience than the user's minimum setting, THE Smart_Filter SHALL mark the job as skipped with reason "underqualified for role".
11. BEFORE applying to any job, THE Bot SHALL run the full Smart_Filter evaluation and skip jobs that fail any filter rule.

### Requirement 8: AI-Powered Cover Letters

**User Story:** As a user, I want the Bot to generate tailored cover letters for each job, so that my applications are personalized and competitive.

#### Acceptance Criteria

1. WHEN the Bot begins an application that includes a cover letter field, THE OllamaService SHALL generate a cover letter tailored to the job title, company, and description using the user's resume profile.
2. THE OllamaService SHALL use the cover_letter.txt prompt template with the user's ResumeProfile JSON, job title, company name, and job description as inputs.
3. WHEN a generated cover letter is produced, THE FormFiller SHALL paste the cover letter text into the cover letter textarea field.
4. THE ApplicationRecord SHALL store the generated cover letter text for later review.
5. IF the OllamaService is unreachable or times out, THEN THE Bot SHALL continue the application without a cover letter and log a warning.

### Requirement 9: AI-Powered Question Answering

**User Story:** As a user, I want the Bot to use AI to answer custom application questions, so that fewer applications pause for manual input.

#### Acceptance Criteria

1. WHEN the FormFiller encounters a text or textarea field that has no profile mapping and no prefilled answer, THE OllamaService SHALL generate an answer using the user's resume text and the question text.
2. WHEN the FormFiller encounters a select or radio field with no prefilled answer, THE OllamaService SHALL evaluate the options against the user's resume context and select the most appropriate option.
3. THE OllamaService SHALL use the answer_question.txt prompt template with the question text and resume context as inputs.
4. WHEN the AI generates an answer, THE FormFiller SHALL fill the field and log the AI-generated response.
5. IF the OllamaService fails to generate an answer, THEN THE Bot SHALL save the question as a PendingQuestion for manual user input.

### Requirement 10: AI Resume Tailoring

**User Story:** As a user, I want the Bot to tailor my resume for each job, so that my applications highlight the most relevant experience.

#### Acceptance Criteria

1. WHEN the user enables resume tailoring in Settings, THE OllamaService SHALL generate a tailored resume summary for each job based on the job description and the user's full resume text.
2. THE OllamaService SHALL identify the top skills and experiences from the user's resume that match the job requirements.
3. WHEN a tailored resume is generated, THE Bot SHALL save the tailored version as a separate file and use the tailored version for that specific application.
4. THE ApplicationRecord SHALL reference which resume version (original or tailored) was used for each application.

### Requirement 11: AI Match Scoring

**User Story:** As a user, I want each job to have an AI-generated match score, so that I can prioritize the best-fit opportunities.

#### Acceptance Criteria

1. WHEN a new ScrapedJob has a description, THE OllamaService SHALL analyze the job against the user's resume and produce a match score from 0 to 100.
2. THE OllamaService SHALL identify individual job requirements and mark each as met or unmet based on the user's resume.
3. THE ScrapedJob record SHALL store the match score, requirements met count, requirements total count, requirements detail list, match summary, salary range, company size, and company description.
4. THE Dashboard SHALL display the match score as a color-coded bar on each job card with labels: "Great fit" for 90 or above, "Good fit" for 75 to 89, "Fair" for 50 to 74, and "Low match" below 50.
5. THE Dashboard SHALL allow sorting jobs by match score (best match first) or by scrape date (newest first).

### Requirement 12: External ATS — Greenhouse Support

**User Story:** As a user, I want the Bot to fill and submit Greenhouse application forms, so that I can apply to jobs hosted on Greenhouse without manual effort.

#### Acceptance Criteria

1. WHEN a ScrapedJob has ats_type "greenhouse", THE Bot SHALL navigate to the Greenhouse application URL using the Selenium browser.
2. THE Bot SHALL detect Greenhouse forms by checking if the URL contains "greenhouse.io", "boards.greenhouse", or "grnh.se".
3. THE FormFiller SHALL fill standard Greenhouse fields: first name, last name, email, phone, LinkedIn URL, and website using UserSettings data.
4. WHEN a resume file upload input is detected on the Greenhouse form, THE FormFiller SHALL upload the configured resume file.
5. THE FormFiller SHALL handle Greenhouse custom questions (select dropdowns, text inputs, textareas, radio buttons, checkboxes) using prefilled answers and AI fallback.
6. WHEN all required fields are filled, THE Bot SHALL click the Submit button and verify success by checking for "thank you" or "success" text on the resulting page.
7. IF the Greenhouse form has validation errors after submission, THEN THE Bot SHALL log the error count and mark the application as failed.
8. THE Greenhouse ATS handler SHALL use Selenium WebDriver instead of Playwright Page objects for all browser interactions.

### Requirement 13: External ATS — Lever Support

**User Story:** As a user, I want the Bot to fill and submit Lever application forms, so that I can apply to jobs hosted on Lever without manual effort.

#### Acceptance Criteria

1. WHEN a ScrapedJob has ats_type "lever", THE Bot SHALL navigate to the Lever application URL using the Selenium browser.
2. THE Bot SHALL detect Lever forms by checking if the URL contains "lever.co" or "jobs.lever".
3. THE FormFiller SHALL fill standard Lever fields: full name (combined first and last), email, phone, LinkedIn URL, and GitHub/portfolio URL using UserSettings data.
4. WHEN a resume file upload input is detected on the Lever form, THE FormFiller SHALL upload the configured resume file.
5. THE FormFiller SHALL handle Lever custom questions (select dropdowns, text inputs, textareas, radio buttons) using prefilled answers and AI fallback.
6. WHEN all required fields are filled, THE Bot SHALL click the "Submit application" button and verify success by checking for confirmation text.
7. THE Lever ATS handler SHALL use Selenium WebDriver instead of Playwright Page objects for all browser interactions.

### Requirement 14: External ATS — Workday Support

**User Story:** As a user, I want the Bot to fill and submit Workday application forms, so that I can apply to jobs hosted on Workday without manual effort.

#### Acceptance Criteria

1. WHEN a ScrapedJob has ats_type "workday", THE Bot SHALL navigate to the Workday application URL using the Selenium browser.
2. THE Bot SHALL detect Workday forms by checking if the URL contains "myworkdayjobs" or "workday.com".
3. THE FormFiller SHALL handle Workday's multi-page application flow by detecting and clicking "Next" and "Submit" buttons across pages.
4. THE FormFiller SHALL fill standard Workday fields (name, email, phone, address, work experience, education) using UserSettings and ResumeProfile data.
5. WHEN Workday presents file upload fields, THE FormFiller SHALL upload the configured resume file.
6. IF the Workday form requires creating an account, THEN THE Bot SHALL log a warning and mark the application as skipped.

### Requirement 15: Generic External Form Detection

**User Story:** As a user, I want the Bot to attempt filling any external application form, so that jobs on lesser-known ATS platforms are not automatically skipped.

#### Acceptance Criteria

1. WHEN a ScrapedJob has ats_type "external" or an unrecognized ATS type, THE Bot SHALL navigate to the external URL and attempt generic form detection.
2. THE FormFiller SHALL scan the page for standard form elements (text inputs, email inputs, file uploads, select dropdowns, textareas) and fill them using profile data and prefilled answers.
3. WHEN a file upload input is detected, THE FormFiller SHALL upload the configured resume file.
4. WHEN a submit button is detected (by type="submit", text content "Submit" or "Apply"), THE Bot SHALL click the button.
5. IF the generic form filler cannot identify any fillable fields, THEN THE Bot SHALL mark the application as skipped with reason "unrecognized form".

### Requirement 16: HR Outreach — Auto-Connect with Hiring Managers

**User Story:** As a user, I want the Bot to send connection requests to hiring managers after applying, so that I can increase my visibility with recruiters.

#### Acceptance Criteria

1. WHEN the user enables HR outreach in Settings, THE Bot SHALL search for hiring managers or recruiters at the company after submitting an application.
2. THE Bot SHALL identify potential hiring contacts by searching LinkedIn for people with titles containing "recruiter", "hiring manager", "talent acquisition", or "HR" at the target company.
3. WHEN a hiring contact is found, THE Bot SHALL send a personalized connection request using a message template that references the applied role.
4. THE OllamaService SHALL generate personalized connection request messages using the user's profile, the job title, and the company name.
5. THE Bot SHALL store each connection request sent in a tracking table with the contact name, company, role applied for, message sent, and timestamp.
6. THE Bot SHALL limit connection requests to a configurable maximum per day to avoid LinkedIn restrictions.
7. THE Dashboard SHALL display a list of sent connection requests with status tracking.

### Requirement 17: Browser UX — Human-Like Behavior

**User Story:** As a user, I want the Bot to behave like a human when interacting with LinkedIn, so that the account is not flagged for automation.

#### Acceptance Criteria

1. THE BrowserSession SHALL use selenium_stealth with configured language, vendor, platform, WebGL vendor, and renderer values to mask automation fingerprints.
2. THE BrowserSession SHALL set Chrome options: excludeSwitches with "enable-automation" and useAutomationExtension set to False.
3. WHEN navigating between pages, THE Bot SHALL introduce randomized delays between 2 and 8 seconds.
4. WHERE the user enables smooth scrolling in Settings, THE Bot SHALL scroll pages incrementally using JavaScript with randomized scroll distances and pauses instead of instant jumps.
5. THE Bot SHALL randomize the order of form field filling to avoid predictable automation patterns.
6. WHEN the Bot is running for extended periods, THE BrowserSession SHALL execute a keep-alive action (mouse movement or minor scroll) every 5 minutes to prevent session timeout.

### Requirement 18: Screenshot on Failure

**User Story:** As a user, I want the Bot to capture screenshots when errors occur, so that I can debug issues with specific job applications.

#### Acceptance Criteria

1. WHEN an application fails at any step (button not found, form error, timeout, modal stuck), THE Bot SHALL capture a full-page screenshot and save the file to the data directory with a timestamp and job ID in the filename.
2. THE ApplicationRecord SHALL store the failure screenshot path for failed applications.
3. THE application review page SHALL display failure screenshots inline for failed application records.
4. WHEN a login attempt fails, THE BrowserSession SHALL capture a screenshot showing the current page state.

### Requirement 19: Pause Before Submit

**User Story:** As a user, I want the option to review applications before the Bot submits them, so that I can verify the filled form is correct.

#### Acceptance Criteria

1. WHERE the user enables "pause before submit" in Settings, THE Bot SHALL pause execution after filling all form fields and before clicking the Submit button.
2. WHEN paused before submit, THE Bot SHALL capture a screenshot of the filled form and send a notification to the Dashboard.
3. THE Dashboard SHALL display a "Review & Submit" prompt with the pre-submit screenshot and buttons to approve submission or cancel the application.
4. WHEN the user approves submission, THE Bot SHALL click the Submit button and complete the application.
5. WHEN the user cancels, THE Bot SHALL discard the application modal and mark the job as skipped.

### Requirement 20: Follow Companies After Applying

**User Story:** As a user, I want the Bot to optionally follow companies on LinkedIn after applying, so that I stay updated on their activity.

#### Acceptance Criteria

1. WHERE the user enables "follow companies" in Settings, THE Bot SHALL click the Follow button on the company's LinkedIn page after submitting an application.
2. IF the Follow button is not found on the job page, THEN THE Bot SHALL skip the follow action and log a warning.
3. THE Bot SHALL not attempt to follow a company that the user already follows.

### Requirement 21: Job Scraping and ATS Detection

**User Story:** As a user, I want the Bot to scrape LinkedIn job listings and detect which ATS each job uses, so that the correct application handler is selected.

#### Acceptance Criteria

1. WHEN the user clicks "Find Jobs", THE Bot SHALL query LinkedIn's guest API with the configured job title, regions, experience levels, and work type filters.
2. THE Bot SHALL parse the guest API HTML response to extract job title, company, location, URL, and company logo for each listing.
3. THE Bot SHALL store each new job as a ScrapedJob record, skipping jobs whose URL already exists in the database.
4. AFTER scraping job listings, THE Bot SHALL fetch the full job description for each new job by requesting the individual job page.
5. THE Bot SHALL detect the ATS type for each job by analyzing the job page HTML for Easy Apply indicators, external apply URLs, and known ATS domain patterns (greenhouse.io, lever.co, myworkdayjobs, icims, smartrecruiters, ashbyhq, bamboohr, jobvite, taleo, successfactors).
6. THE ScrapedJob record SHALL store the detected ats_type value.
7. WHEN rate-limited by LinkedIn (HTTP 429), THE Bot SHALL implement exponential backoff with a maximum of 2 retries per job.

### Requirement 22: Settings Management

**User Story:** As a user, I want a comprehensive settings page to configure all Bot parameters, so that I can customize the automation to my needs.

#### Acceptance Criteria

1. THE Settings page SHALL provide input fields for: LinkedIn email, LinkedIn password, li_at cookie, first name, last name, email, phone, city, LinkedIn profile URL, website, job title, default location, and max applications per run.
2. THE Settings page SHALL provide a resume upload control that accepts PDF and DOCX files.
3. THE Settings page SHALL provide multi-select controls for experience levels (intern, entry, mid, senior, director, executive) and target regions.
4. THE Settings page SHALL provide a work type selector (any, remote, on-site, hybrid).
5. THE Settings page SHALL provide a prefilled answers section with common application questions and the ability to add custom question/answer pairs.
6. WHEN the user clicks "Save Settings", THE Dashboard SHALL persist all settings to the UserSettings database record via the backend API.
7. THE Settings page SHALL encrypt LinkedIn passwords and cookies before storing them in the database using the crypto service.

### Requirement 23: Real-Time Log Streaming

**User Story:** As a user, I want to see live logs of what the Bot is doing, so that I can monitor progress and troubleshoot issues.

#### Acceptance Criteria

1. WHEN a background task is running, THE Task_Runner SHALL publish log messages to a Redis pub/sub channel keyed by task ID.
2. THE backend SHALL expose an SSE (Server-Sent Events) endpoint that streams log messages for a given task ID.
3. THE Running page SHALL connect to the SSE endpoint and display log messages in real-time with auto-scrolling.
4. WHEN a task completes, THE Task_Runner SHALL publish a "__DONE__" sentinel message to signal the SSE stream to close.
5. WHEN a task fails, THE Task_Runner SHALL publish an "__ERROR__" sentinel message.
6. WHEN a task is waiting for user input, THE Task_Runner SHALL publish a "__WAITING__" sentinel message.

### Requirement 24: Desktop Application Packaging

**User Story:** As a user, I want to install the Auto Apply Bot as a standalone desktop application, so that I can run the tool without manual setup of Python, Node.js, or Docker.

#### Acceptance Criteria

1. THE application SHALL be packaged as a desktop installer for Windows and macOS using Electron or a similar framework.
2. THE desktop package SHALL bundle the React frontend, FastAPI backend, Redis server, and Celery worker into a single installable application.
3. WHEN the desktop application starts, THE application SHALL launch all backend services automatically and open the Dashboard in an embedded browser window.
4. THE desktop application SHALL manage the local Chrome browser session for Selenium automation without requiring the user to install Chrome separately.
5. THE desktop application SHALL provide a system tray icon with options to open the Dashboard, view status, and quit the application.
6. THE desktop application SHALL support auto-update functionality to deliver new versions to users.

### Requirement 25: Selenium Migration for ATS Modules

**User Story:** As a developer, I want all ATS modules to use Selenium WebDriver, so that the codebase has a single browser automation dependency.

#### Acceptance Criteria

1. THE Greenhouse ATS module SHALL replace all Playwright Page method calls with equivalent Selenium WebDriver calls (find_element, send_keys, click, Select).
2. THE Lever ATS module SHALL replace all Playwright Page method calls with equivalent Selenium WebDriver calls.
3. THE generic external form handler SHALL use Selenium WebDriver for all browser interactions.
4. AFTER migration, THE codebase SHALL have zero runtime imports of the playwright package.
5. THE migrated ATS modules SHALL use the shared BrowserSession singleton to obtain the WebDriver instance.

### Requirement 26: Form Field Value Persistence in Iframes

**User Story:** As a developer, I want form field values to persist after filling inside iframes, so that Easy Apply and external ATS forms submit correctly.

#### Acceptance Criteria

1. BEFORE filling fields inside an iframe, THE FormFiller SHALL switch the driver context to the target iframe using driver.switch_to.frame().
2. WHEN filling text inputs inside React-based forms, THE FormFiller SHALL use the native input value setter (Object.getOwnPropertyDescriptor on HTMLInputElement.prototype) followed by dispatching input, change, and blur events.
3. WHEN filling text inputs, THE FormFiller SHALL use element.send_keys() as the primary method and fall back to JavaScript native setter only if send_keys fails.
4. AFTER filling all fields in an iframe, THE FormFiller SHALL switch back to the default content using driver.switch_to.default_content().
5. THE FormFiller SHALL search ALL iframes on the page when looking for form fields, not just iframes matching specific URL patterns.
