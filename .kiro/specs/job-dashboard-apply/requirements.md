# Requirements Document

## Introduction

This feature reworks the ApplyPilot job dashboard and Chrome extension to provide a Jobright.ai-style experience. The system actively fetches jobs from multiple sources (LinkedIn scraping, GitHub repos, aggregated feeds), displays them in a rich detail view with match score breakdowns and AI tools, and provides a Chrome extension that injects overlay UI on job sites with form autofill capabilities. The apply flow integrates AI-powered resume customization, cover letter generation, and match analysis.

## Glossary

- **Dashboard**: The React + Vite web frontend that displays jobs, match scores, AI tools, and apply controls
- **Job_Fetcher**: Backend service that scrapes and aggregates job listings from multiple sources
- **Match_Engine**: AI-powered service (Ollama/Llama) that scores jobs against the user's resume profile
- **Extension**: Chrome extension built with Plasmo framework that injects UI overlays on job sites
- **Form_Filler**: Extension component that autofills job application forms with user profile data
- **Resume_Tailor**: AI service that customizes the user's resume for a specific job posting
- **Cover_Letter_Generator**: AI service that generates tailored cover letters for job applications
- **Connection_Finder**: Service that identifies insider connections at a target company
- **Email_Finder**: Service that resolves work email addresses from LinkedIn profile URLs
- **GitHub_Scraper**: Service that fetches job listings from auto-updating GitHub repositories
- **Progress_Tracker**: Extension component that tracks form-fill completion percentage

## Requirements

### Requirement 1: Multi-Source Job Fetching

**User Story:** As a job seeker, I want the system to automatically fetch jobs from multiple sources, so that I have a comprehensive view of available opportunities without manually searching each platform.

#### Acceptance Criteria

1. WHEN a scheduled fetch cycle runs, THE Job_Fetcher SHALL scrape job listings from LinkedIn using the existing Selenium-based scraper running on the user's local machine
2. WHEN a GitHub repository URL is configured, THE GitHub_Scraper SHALL poll the repository for new job listings at a configurable interval (default: 60 minutes)
3. WHEN new jobs are fetched from any source, THE Job_Fetcher SHALL deduplicate listings by URL before storing them in the database
4. WHEN a job is fetched, THE Job_Fetcher SHALL extract and store: title, company, location, URL, description, posted date, salary range (if available), and source platform
5. THE Job_Fetcher SHALL support adding new GitHub repository sources through the Dashboard settings
6. IF a fetch operation fails, THEN THE Job_Fetcher SHALL log the error and retry after a configurable backoff period (default: 5 minutes)
7. WHEN jobs are fetched from GitHub repositories, THE GitHub_Scraper SHALL parse markdown-formatted job tables into structured job records

### Requirement 2: Job Detail View with Match Score Breakdown

**User Story:** As a job seeker, I want to see a detailed view of each job with a match score breakdown, so that I can quickly assess how well I fit each position.

#### Acceptance Criteria

1. WHEN a user selects a job from the list, THE Dashboard SHALL display a detail view with: company logo, company name, posted time, job title, location/type/level tags, full job description, and industry tags
2. WHEN a job has been analyzed, THE Dashboard SHALL display an overall match score (0-100%) as a circular progress indicator with a label (STRONG MATCH, GOOD MATCH, or FAIR MATCH)
3. WHEN a job has been analyzed, THE Dashboard SHALL display a match breakdown showing individual scores for: Experience Level, Skill Match, and Industry Experience
4. THE Match_Engine SHALL compute the match breakdown by comparing the user's resume profile against the job description using the Ollama LLM
5. WHEN a job detail view is opened, THE Dashboard SHALL display the applicant count if available from the source platform
6. THE Dashboard SHALL display a link to the original job posting on the source platform
7. WHEN a job has not yet been analyzed, THE Match_Engine SHALL automatically queue it for analysis upon first view

### Requirement 3: AI Tools Sidebar

**User Story:** As a job seeker, I want AI-powered tools available when viewing a job, so that I can quickly customize my application materials for each position.

#### Acceptance Criteria

1. WHEN a user views a job detail, THE Dashboard SHALL display an AI Tools sidebar with three actions: "Customize Your Resume", "Build Cover Letter", and "Analyze How Well You Fit"
2. WHEN the user clicks "Customize Your Resume", THE Resume_Tailor SHALL generate a tailored version of the user's resume highlighting skills and experience relevant to the specific job
3. WHEN the user clicks "Build Cover Letter", THE Cover_Letter_Generator SHALL generate a cover letter tailored to the job posting using the user's resume profile and the job description
4. WHEN the user clicks "Analyze How Well You Fit", THE Match_Engine SHALL provide a detailed analysis of strengths and weaknesses relative to the job requirements
5. WHILE an AI tool is processing, THE Dashboard SHALL display a loading indicator with estimated completion time
6. WHEN an AI tool completes, THE Dashboard SHALL display the generated content with options to copy, download, or edit inline
7. IF the Ollama service is unreachable, THEN THE Dashboard SHALL display an error message instructing the user to start Ollama

### Requirement 4: Insider Connections

**User Story:** As a job seeker, I want to see insider connections at a company, so that I can leverage my network for referrals.

#### Acceptance Criteria

1. WHEN a user views a job detail, THE Dashboard SHALL display an "Insider Connections" section showing contacts at the company
2. THE Connection_Finder SHALL categorize connections by relationship type: Beyond Network, Previous Company, and School
3. WHEN connections are found, THE Dashboard SHALL display each connection's name, title, and relationship type
4. WHEN no connections are found, THE Dashboard SHALL display a message indicating no insider connections were identified

### Requirement 5: Email Finder

**User Story:** As a job seeker, I want to find work email addresses from LinkedIn profiles, so that I can reach out directly to hiring managers and recruiters.

#### Acceptance Criteria

1. THE Dashboard SHALL display a "Find Any Email" input field in the job detail sidebar
2. WHEN a user pastes a LinkedIn profile URL into the Email_Finder input, THE Email_Finder SHALL attempt to resolve the work email address associated with that profile
3. WHEN an email is successfully found, THE Dashboard SHALL display the email address with a copy-to-clipboard button
4. IF the Email_Finder cannot resolve an email address, THEN THE Dashboard SHALL display a message indicating the email could not be found
5. THE Email_Finder SHALL validate that the input is a valid LinkedIn profile URL before attempting resolution

### Requirement 6: Apply Flow

**User Story:** As a job seeker, I want a streamlined apply flow with AI assistance, so that I can submit high-quality applications quickly.

#### Acceptance Criteria

1. WHEN a user clicks "APPLY NOW" on a job detail, THE Dashboard SHALL initiate the apply flow
2. WHEN the apply flow starts, THE Dashboard SHALL present a pre-apply checklist showing: resume version (original or tailored), cover letter status, and match analysis summary
3. WHEN the user confirms the apply action, THE Dashboard SHALL open the job application page and signal the Extension to begin form autofill
4. WHILE the apply flow is in progress, THE Dashboard SHALL update the job status to "applying"
5. WHEN the application is submitted successfully, THE Dashboard SHALL update the job status to "applied" and record the application in the ApplicationRecord table
6. IF the apply flow encounters a question it cannot answer, THEN THE Dashboard SHALL create a PendingQuestion record and notify the user
7. WHEN the user has a tailored resume ready, THE apply flow SHALL use the tailored resume instead of the original

### Requirement 7: Chrome Extension with Plasmo Framework

**User Story:** As a job seeker, I want a Chrome extension that overlays helpful UI on job sites, so that I can get AI assistance directly while browsing jobs.

#### Acceptance Criteria

1. THE Extension SHALL be built using the Plasmo framework with Manifest V3 and React
2. THE Extension SHALL inject content scripts on LinkedIn, Lever, Greenhouse, and Workday job pages
3. WHEN the Extension detects a job listing page, THE Extension SHALL inject a floating overlay panel showing the match score and quick-action buttons
4. THE Extension SHALL request permissions for: storage, tabs, activeTab, and scripting
5. WHEN the user clicks "Apply" in the overlay, THE Extension SHALL trigger the form autofill flow on the current page
6. THE Extension SHALL communicate with the backend API to fetch match scores and AI-generated content
7. THE Extension SHALL persist user authentication state using Chrome storage API

### Requirement 8: Form Autofill with Progress Tracking

**User Story:** As a job seeker, I want the extension to automatically fill application forms with my profile data, so that I can apply faster with fewer errors.

#### Acceptance Criteria

1. WHEN the Extension detects an application form, THE Form_Filler SHALL identify all fillable fields (text inputs, selects, radio buttons, checkboxes, textareas)
2. THE Form_Filler SHALL map detected fields to user profile data (name, email, phone, location, LinkedIn URL, work authorization, etc.)
3. WHILE filling a form, THE Progress_Tracker SHALL display a progress bar showing the percentage of fields completed
4. WHEN a field requires a value not in the user's profile, THE Form_Filler SHALL use the Ollama AI to generate an appropriate answer based on the question context and resume
5. THE Form_Filler SHALL handle forms inside iframes by switching context to each iframe before attempting to fill fields
6. WHEN filling React-controlled inputs, THE Form_Filler SHALL use native value setters and dispatch input, change, and blur events to ensure values persist
7. IF a form field cannot be filled automatically, THEN THE Form_Filler SHALL highlight the field and prompt the user to fill it manually
8. WHEN all fillable fields are completed, THE Progress_Tracker SHALL display 100% and enable the submit action

### Requirement 9: Job List Dashboard Enhancements

**User Story:** As a job seeker, I want an enhanced job list with filtering and source indicators, so that I can efficiently browse and prioritize my job search.

#### Acceptance Criteria

1. THE Dashboard SHALL display job cards with: title, company, location, salary range, match score badge, source platform indicator, and posted time
2. THE Dashboard SHALL provide tab filters for: Recommended (sorted by match score), Applied, New, and Saved
3. WHEN a user clicks "Save" on a job card, THE Dashboard SHALL mark the job as saved and persist the status
4. THE Dashboard SHALL display aggregate stats in the sidebar: total jobs, applied count, new count, and average match score
5. THE Dashboard SHALL support filtering jobs by: source platform, minimum match score, location, and experience level
6. WHEN new jobs are fetched, THE Dashboard SHALL indicate the count of new jobs since the user's last visit
7. THE Dashboard SHALL support infinite scroll or pagination for the job list (configurable page size, default 50)

### Requirement 10: Resume Customization for Apply Flow

**User Story:** As a job seeker, I want my resume automatically customized for each job I apply to, so that my application highlights the most relevant experience.

#### Acceptance Criteria

1. WHEN the user triggers "Customize Your Resume" for a job, THE Resume_Tailor SHALL generate a tailored resume emphasizing skills and experience matching the job requirements
2. THE Resume_Tailor SHALL preserve the original resume structure while reordering and emphasizing relevant content
3. WHEN a tailored resume is generated, THE Dashboard SHALL display a diff view showing changes from the original
4. THE Dashboard SHALL allow the user to accept, edit, or reject the tailored version before using it in an application
5. THE Resume_Tailor SHALL store each tailored version linked to the specific job for reuse

### Requirement 11: GitHub Repository Job Source Configuration

**User Story:** As a job seeker, I want to configure GitHub repositories as job sources, so that I can automatically receive listings from curated job boards that update frequently.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a settings interface to add, edit, and remove GitHub repository job sources
2. WHEN a user adds a GitHub repository source, THE Dashboard SHALL validate that the URL points to a valid GitHub repository
3. THE GitHub_Scraper SHALL parse job listings from markdown files in the repository, extracting: job title, company, location, URL, and posted date
4. WHEN a repository is polled, THE GitHub_Scraper SHALL only process entries added since the last successful poll
5. IF a GitHub repository is unreachable or returns an error, THEN THE GitHub_Scraper SHALL mark the source as temporarily unavailable and retry on the next cycle
6. THE GitHub_Scraper SHALL support repositories that use table-formatted markdown (pipe-delimited columns) for job listings
