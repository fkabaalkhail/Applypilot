# Requirements Document

## Introduction

This feature builds a direct ATS (Applicant Tracking System) platform scraping pipeline that crawls company career pages on Greenhouse, Lever, Ashby, and Workday to aggregate 10,000-50,000+ entry-level job listings with direct company apply URLs. The system targets 200-300 top tech companies, filters for New Grad and Intern positions, classifies jobs by category, and stores them in the existing Neon PostgreSQL database using the same ScrapedJob model. The pipeline runs on GitHub Actions every 6 hours and is configured via an expandable JSON company registry.

## Glossary

- **ATS_Scraper**: The orchestration service that coordinates scraping across all configured ATS platforms and manages the crawl pipeline
- **Greenhouse_Client**: The component that fetches job listings from the Greenhouse public boards API (`boards-api.greenhouse.io/v1/boards/{company}/jobs`)
- **Lever_Client**: The component that fetches job listings from the Lever public postings API (`api.lever.co/v0/postings/{company}?mode=json`)
- **Ashby_Client**: The component that fetches job listings from the Ashby public posting API (`api.ashbyhq.com/posting-api/job-board/{company}`)
- **Workday_Client**: The component that fetches job listings from Workday company career sites (`{company}.wd{n}.myworkdayjobs.com`)
- **Company_Registry**: A JSON configuration file listing all target companies with their ATS platform, board slug, and metadata
- **Entry_Level_Filter**: The component that identifies entry-level positions (intern, new grad, junior) by analyzing job titles and metadata
- **Category_Classifier**: The component that assigns a role category (Software Engineering, Data Analysis, etc.) to each job based on title and department keywords
- **Location_Filter**: The component that filters jobs to US and Canada only based on location data from the ATS response
- **Deduplicator**: The component that prevents duplicate job entries by matching on the unique job apply URL
- **ScrapedJob**: The existing database model that stores job listings with fields for title, company, location, url, work_type, role_category, country, experience_level, company_logo, posted_date, salary_range

## Requirements

### Requirement 1: Company Registry Configuration

**User Story:** As a developer, I want a centralized JSON configuration file listing all target companies and their ATS platforms, so that I can easily add or remove companies without code changes.

#### Acceptance Criteria

1. THE ATS_Scraper SHALL load company configurations from a JSON file located at `scraper/companies.json`
2. WHEN a company entry is read from the Company_Registry, THE ATS_Scraper SHALL extract the following fields: company_name, ats_platform (greenhouse, lever, ashby, workday), board_slug, company_logo_url, and enabled flag
3. THE Company_Registry SHALL support a minimum of 200 company entries across four ATS platforms: approximately 100 Greenhouse, 50 Lever, 30 Ashby, and 20 Workday companies
4. WHEN a company entry has the enabled flag set to false, THE ATS_Scraper SHALL skip that company during crawl execution
5. THE Company_Registry SHALL validate that each entry contains the required fields (company_name, ats_platform, board_slug) at load time
6. IF a company entry is missing required fields, THEN THE ATS_Scraper SHALL log a warning and skip that entry without halting the pipeline

### Requirement 2: Greenhouse Platform Scraping

**User Story:** As a job seeker, I want the system to scrape all open positions from Greenhouse-powered career pages, so that I get direct apply links to companies like Stripe, Coinbase, Figma, and Notion.

#### Acceptance Criteria

1. WHEN scraping a Greenhouse company, THE Greenhouse_Client SHALL fetch job listings from `https://boards-api.greenhouse.io/v1/boards/{board_slug}/jobs?content=true`
2. WHEN the Greenhouse API returns a successful response, THE Greenhouse_Client SHALL extract the following fields from each job object: title, location (name), absolute_url (as apply link), updated_at (as posted date), and departments
3. WHEN a Greenhouse job object contains a metadata field with salary information, THE Greenhouse_Client SHALL extract and store the salary range
4. THE Greenhouse_Client SHALL construct the direct apply URL in the format `https://boards.greenhouse.io/{board_slug}/jobs/{job_id}`
5. IF the Greenhouse API returns a 404 status for a company board, THEN THE Greenhouse_Client SHALL log a warning and continue to the next company
6. IF the Greenhouse API returns a rate limit response (429), THEN THE Greenhouse_Client SHALL wait 60 seconds before retrying that request up to 3 times

### Requirement 3: Lever Platform Scraping

**User Story:** As a job seeker, I want the system to scrape all open positions from Lever-powered career pages, so that I get direct apply links to companies like Netflix and Twitch.

#### Acceptance Criteria

1. WHEN scraping a Lever company, THE Lever_Client SHALL fetch job listings from `https://api.lever.co/v0/postings/{board_slug}?mode=json`
2. WHEN the Lever API returns a successful response, THE Lever_Client SHALL extract the following fields from each posting object: text (as title), categories.location, categories.team, categories.department, hostedUrl (as apply link), and createdAt (as posted date)
3. THE Lever_Client SHALL use the hostedUrl field as the direct apply URL for each job
4. WHEN a Lever posting contains a categories.commitment field, THE Lever_Client SHALL use it to identify work type (Full-time, Part-time, Intern)
5. IF the Lever API returns a 404 status for a company, THEN THE Lever_Client SHALL log a warning and continue to the next company
6. IF the Lever API returns a rate limit response (429), THEN THE Lever_Client SHALL wait 60 seconds before retrying that request up to 3 times

### Requirement 4: Ashby Platform Scraping

**User Story:** As a job seeker, I want the system to scrape all open positions from Ashby-powered career pages, so that I get direct apply links to companies like Ramp, Linear, and Vercel.

#### Acceptance Criteria

1. WHEN scraping an Ashby company, THE Ashby_Client SHALL fetch job listings from `https://api.ashbyhq.com/posting-api/job-board/{board_slug}`
2. WHEN the Ashby API returns a successful response, THE Ashby_Client SHALL extract the following fields from each job object: title, location, department, employmentType, applyUrl (as direct apply link), and publishedAt (as posted date)
3. THE Ashby_Client SHALL use the applyUrl field from the API response as the direct apply URL
4. IF the Ashby API returns a 404 status for a company board, THEN THE Ashby_Client SHALL log a warning and continue to the next company
5. IF the Ashby API returns a rate limit response (429), THEN THE Ashby_Client SHALL wait 60 seconds before retrying that request up to 3 times

### Requirement 5: Workday Platform Scraping

**User Story:** As a job seeker, I want the system to scrape entry-level positions from Workday-powered career sites, so that I get direct apply links to companies like Salesforce, Adobe, and Amazon.

#### Acceptance Criteria

1. WHEN scraping a Workday company, THE Workday_Client SHALL send a POST request to the company's Workday search API endpoint with entry-level keyword filters
2. WHEN the Workday search API returns results, THE Workday_Client SHALL extract the following fields: title, location, postedOn (as posted date), and the job external URL
3. THE Workday_Client SHALL construct the direct apply URL from the Workday job posting path
4. WHEN the Company_Registry entry for a Workday company includes a workday_url_template field, THE Workday_Client SHALL use that template to construct the correct API endpoint
5. IF the Workday API returns an error response, THEN THE Workday_Client SHALL log a warning and continue to the next company
6. IF the Workday API returns a rate limit response, THEN THE Workday_Client SHALL wait 120 seconds before retrying that request up to 2 times

### Requirement 6: Entry-Level Position Filtering

**User Story:** As a new grad or intern job seeker, I want only entry-level positions shown, so that I see relevant opportunities without senior roles cluttering the feed.

#### Acceptance Criteria

1. WHEN a job is fetched from any ATS platform, THE Entry_Level_Filter SHALL evaluate the job title against a set of entry-level indicators
2. THE Entry_Level_Filter SHALL classify a job as entry-level when the title contains any of the following patterns (case-insensitive): "intern", "internship", "new grad", "new graduate", "entry level", "entry-level", "junior", "associate", "I" (as a Roman numeral suffix, e.g., "Engineer I"), "0-2 years", "early career", "university", "co-op", "coop"
3. WHEN a job title matches an intern-specific pattern ("intern", "internship", "co-op", "coop"), THE Entry_Level_Filter SHALL assign experience_level as "internship"
4. WHEN a job title matches a new-grad-specific pattern ("new grad", "new graduate", "entry level", "entry-level", "junior", "associate", "I", "0-2 years", "early career"), THE Entry_Level_Filter SHALL assign experience_level as "new_grad"
5. WHEN a job title does not match any entry-level indicator, THE Entry_Level_Filter SHALL exclude that job from storage
6. THE Entry_Level_Filter SHALL not match "I" when it appears as part of a word (e.g., "Senior" should not match) — it SHALL only match "I" as a standalone Roman numeral suffix preceded by a space

### Requirement 7: Role Category Classification

**User Story:** As a job seeker, I want jobs classified by category (Software Engineering, Data Analysis, etc.), so that I can filter for roles matching my career interests.

#### Acceptance Criteria

1. WHEN a job passes the entry-level filter, THE Category_Classifier SHALL assign a role_category based on the job title and department metadata
2. THE Category_Classifier SHALL support the following categories: "Software Engineering", "Data Analysis", "Machine Learning/AI", "Product Management", "Marketing", "Design", "Business Analyst", "Accounting/Finance", "Sales", "Human Resources", "Legal", "Operations", "Customer Support", "Hardware Engineering", "Cybersecurity", "DevOps/Infrastructure", "Other"
3. THE Category_Classifier SHALL use keyword matching on the job title to determine category (e.g., titles containing "software", "developer", "SWE", "full stack", "backend", "frontend" map to "Software Engineering")
4. WHEN the job title does not match any category keywords, THE Category_Classifier SHALL use the department field from the ATS response as a fallback classification signal
5. WHEN neither title nor department yields a category match, THE Category_Classifier SHALL assign "Other" as the role_category
6. THE Category_Classifier SHALL prioritize title-based classification over department-based classification when both yield different results

### Requirement 8: Location Filtering (US and Canada Only)

**User Story:** As a North American job seeker, I want only US and Canada jobs displayed, so that I see geographically relevant opportunities.

#### Acceptance Criteria

1. WHEN a job is fetched from any ATS platform, THE Location_Filter SHALL evaluate the job location to determine the country
2. THE Location_Filter SHALL identify US jobs by matching US state abbreviations, full state names, US city names, or the text "United States" or "USA"
3. THE Location_Filter SHALL identify Canada jobs by matching Canadian province abbreviations, full province names, Canadian city names, or the text "Canada"
4. WHEN a job location contains "Remote" without a specific country indicator, THE Location_Filter SHALL classify it as "US" (default for US-headquartered tech companies)
5. WHEN a job location contains "Remote" with a country indicator (e.g., "Remote - Canada"), THE Location_Filter SHALL use the specified country
6. WHEN a job's country is neither US nor Canada, THE ATS_Scraper SHALL exclude that job from storage
7. THE Location_Filter SHALL extract the work_type from location data: "remote" for remote positions, "hybrid" for hybrid positions, and "onsite" for all others

### Requirement 9: URL-Based Deduplication

**User Story:** As a job seeker, I want no duplicate job listings in my feed, so that the dashboard stays clean and accurate.

#### Acceptance Criteria

1. WHEN a job is processed for storage, THE Deduplicator SHALL check for an existing ScrapedJob record with the same URL
2. WHEN a duplicate URL is detected, THE Deduplicator SHALL skip insertion and not modify the existing record
3. THE Deduplicator SHALL perform URL normalization before comparison (strip trailing slashes, normalize query parameters)
4. WHEN the same job appears on multiple ATS platforms (rare but possible), THE Deduplicator SHALL store only the first occurrence based on URL uniqueness

### Requirement 10: Job Storage in Existing Database

**User Story:** As a developer, I want scraped ATS jobs stored in the same ScrapedJob table used by the existing aggregator, so that the frontend displays all jobs from a single source.

#### Acceptance Criteria

1. WHEN a job passes all filters (entry-level, location, deduplication), THE ATS_Scraper SHALL create a ScrapedJob record with the following fields populated: title, company, location, url, posted_date, company_logo, salary_range, work_type, role_category, country, experience_level, source_platform, and ats_type
2. THE ATS_Scraper SHALL set source_platform to "ats" for all jobs scraped by this pipeline
3. THE ATS_Scraper SHALL set ats_type to the platform name ("greenhouse", "lever", "ashby", "workday") for each job
4. THE ATS_Scraper SHALL set the platform field to the ATS platform name for each job
5. WHEN a job does not have salary information available from the ATS API, THE ATS_Scraper SHALL store an empty string in the salary_range field
6. WHEN a job has a posted_date older than 30 days, THE ATS_Scraper SHALL exclude that job from storage (stale listing)

### Requirement 11: GitHub Actions Scheduled Execution

**User Story:** As a developer, I want the scraper to run automatically every hour on GitHub Actions in a separate public repository, so that the job feed stays fresh and I get unlimited free CI minutes.

#### Acceptance Criteria

1. THE ATS_Scraper SHALL live in a separate public GitHub repository (e.g., `resumate-jobs-scraper`) independent of the main application repo
2. THE ATS_Scraper SHALL be executable via a GitHub Actions workflow file at `.github/workflows/scrape.yml`
3. THE GitHub Actions workflow SHALL trigger on a cron schedule of every hour (`0 * * * *`)
4. THE GitHub Actions workflow SHALL also support manual trigger via `workflow_dispatch`
5. WHEN the workflow runs, THE ATS_Scraper SHALL connect to the Neon PostgreSQL database using the DATABASE_URL secret configured in the GitHub repository
6. THE GitHub Actions workflow SHALL install Python dependencies from `requirements.txt` at the repo root
7. WHEN the scraper completes execution, THE ATS_Scraper SHALL log a summary including: total companies scraped, total jobs found, total jobs after filtering, total new jobs stored, and total duplicates skipped
8. IF the scraper encounters a fatal error (database connection failure), THEN THE ATS_Scraper SHALL exit with a non-zero status code so GitHub Actions marks the run as failed
9. THE repository README SHALL describe the project as a job aggregation data pipeline without revealing private infrastructure details (no database URLs, no connection strings, no internal architecture)

### Requirement 12: Scraper Execution Pipeline

**User Story:** As a developer, I want the scraper to process companies in parallel with proper error handling, so that a single company failure does not halt the entire pipeline.

#### Acceptance Criteria

1. WHEN the scraper is executed, THE ATS_Scraper SHALL process companies grouped by ATS platform (all Greenhouse companies, then Lever, then Ashby, then Workday)
2. WHEN processing a company fails due to network error or API error, THE ATS_Scraper SHALL log the error and continue to the next company
3. THE ATS_Scraper SHALL implement a configurable delay between API requests to the same platform (default: 1 second) to avoid triggering rate limits
4. THE ATS_Scraper SHALL complete a full crawl of all 200+ companies within the GitHub Actions free tier time limit of 6 hours
5. WHEN the scraper starts, THE ATS_Scraper SHALL log the total number of enabled companies and their platform distribution
6. THE ATS_Scraper SHALL support a `--platform` command-line argument to scrape only a specific ATS platform (for debugging and partial runs)
7. THE ATS_Scraper SHALL support a `--company` command-line argument to scrape only a specific company by name (for debugging)

### Requirement 13: Company Logo Extraction

**User Story:** As a job seeker, I want company logos displayed on job cards, so that I can quickly identify companies visually.

#### Acceptance Criteria

1. WHEN the Company_Registry entry includes a company_logo_url field, THE ATS_Scraper SHALL use that URL as the company_logo for all jobs from that company
2. WHEN the Greenhouse API response includes a company logo in the board metadata, THE Greenhouse_Client SHALL extract and use that logo URL
3. WHEN no logo URL is available from either the registry or the API response, THE ATS_Scraper SHALL store an empty string in the company_logo field

### Requirement 14: Salary Range Extraction

**User Story:** As a job seeker, I want salary information displayed when available, so that I can evaluate compensation before applying.

#### Acceptance Criteria

1. WHEN a Greenhouse job listing includes salary information in the content or metadata fields, THE Greenhouse_Client SHALL extract and store the salary range as a formatted string (e.g., "$80,000 - $120,000")
2. WHEN a Lever job listing includes salary information in the categories or description, THE Lever_Client SHALL extract and store the salary range
3. WHEN an Ashby job listing includes compensation data in the response, THE Ashby_Client SHALL extract and store the salary range
4. WHEN no salary information is available for a job, THE ATS_Scraper SHALL store an empty string in the salary_range field

