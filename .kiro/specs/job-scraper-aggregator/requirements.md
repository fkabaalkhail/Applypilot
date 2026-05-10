# Requirements Document

## Introduction

This feature builds a robust job aggregation system that scrapes job listings from multiple jobright-ai GitHub repositories (8 New Grad repos + 1 Internship mega-repo), stores them in the existing PostgreSQL database, and provides rich filtering capabilities by country, work type, role category, and experience level. The repositories are updated hourly with fresh job listings in markdown table format. The Internship repo is a mega-repo containing jobs across 17 categories organized by section headers. The system integrates with the existing FastAPI backend, GitHubSource model, and GitHubScraper service to provide automated polling, deduplication, and a filterable job feed for the React frontend.

## Glossary

- **Aggregator**: The backend orchestration service that coordinates scraping across all configured jobright-ai repositories and manages the polling schedule
- **Markdown_Parser**: The component that parses pipe-delimited markdown tables from GitHub README files into structured job records, handling continuation rows (↳ symbol) and extracting all metadata
- **Country_Filter**: The filtering logic that classifies jobs as Canada or USA based on location text and excludes jobs from other countries
- **Work_Type_Classifier**: The component that extracts work arrangement type (Remote, Hybrid, On Site) from job location or metadata fields
- **Role_Category**: A classification derived from which jobright-ai repository a job was scraped from, or from the section headers within the Internship mega-repo. Categories include: Software Engineering, Data Analysis, Business Analyst, Management and Executive, Engineering and Development, Creatives and Design, Product Management, Sales, Accounting and Finance, Arts and Entertainment, Legal and Compliance, Human Resources, Public Sector and Government, Education and Training, Customer Service and Support, Marketing, Consultant
- **Deduplicator**: The component that prevents duplicate job entries by matching on job URL and handling re-posted listings
- **Poll_Scheduler**: The mechanism that triggers periodic scraping of all active GitHub sources at configurable intervals
- **ScrapedJob**: The existing database model that stores job listings with fields for title, company, location, URL, source_platform, github_source_id, etc.
- **GitHubSource**: The existing database model that tracks configured repository URLs, poll intervals, last poll timestamps, and commit SHAs

## Requirements

### Requirement 1: Multi-Repository Source Configuration

**User Story:** As a job seeker, I want the system to be pre-configured with all nine jobright-ai repositories, so that I receive a comprehensive feed of new grad and internship job listings across multiple disciplines.

#### Acceptance Criteria

1. THE Aggregator SHALL support the following nine jobright-ai repositories as job sources:
   - https://github.com/jobright-ai/2026-Software-Engineer-New-Grad
   - https://github.com/jobright-ai/2026-Data-Analysis-New-Grad
   - https://github.com/jobright-ai/2026-Engineering-New-Grad
   - https://github.com/jobright-ai/2026-Account-New-Grad
   - https://github.com/jobright-ai/2026-Consultant-New-Grad
   - https://github.com/jobright-ai/2026-Design-New-Grad
   - https://github.com/jobright-ai/2026-Product-Management-New-Grad
   - https://github.com/jobright-ai/2026-Management-New-Grad
   - https://github.com/jobright-ai/2026-Internship
2. WHEN the system is initialized for the first time, THE Aggregator SHALL seed the GitHubSource table with all nine repositories configured with a 60-minute poll interval and README.md as the file path
3. WHEN a new repository source is added, THE Aggregator SHALL assign a Role_Category based on the repository name (e.g., "2026-Software-Engineer-New-Grad" maps to "Software Engineering")
4. THE Aggregator SHALL store the Role_Category mapping on the GitHubSource record so that all jobs scraped from that source inherit the category
5. FOR the Internship mega-repo, THE Aggregator SHALL parse section headers within the README to assign per-job Role_Category values, since this single repo contains jobs across all categories (Software Engineering, Data Analysis, Business Analyst, Management and Executive, Engineering and Development, Creatives and Design, Product Management, Sales, Accounting and Finance, Arts and Entertainment, Legal and Compliance, Human Resources, Public Sector and Government, Education and Training, Customer Service and Support, Marketing, Consultant)
6. THE Aggregator SHALL tag jobs from the Internship repo with an experience_level of "Internship" and jobs from the New-Grad repos with "New Grad"

### Requirement 2: Markdown Table Parsing

**User Story:** As a job seeker, I want the system to accurately parse job listings from GitHub markdown tables, so that I get complete and correct job data including company, role, location, and application links.

#### Acceptance Criteria

1. WHEN a repository README is fetched, THE Markdown_Parser SHALL identify and parse pipe-delimited markdown tables with columns for Company, Role, Location, Application/Link, and Date Posted
2. WHEN a table row contains the "↳" symbol, THE Markdown_Parser SHALL treat it as a continuation row belonging to the same company as the preceding row and inherit the company name
3. WHEN a table cell contains a markdown link in the format `[text](url)`, THE Markdown_Parser SHALL extract both the display text and the URL
4. WHEN a job URL points to jobright.ai/jobs/info/{id}, THE Markdown_Parser SHALL store the full URL as the job application link
5. WHEN a table cell contains an image tag (company logo), THE Markdown_Parser SHALL extract the image URL and store it in the company_logo field
6. IF a table row is missing required fields (title or URL), THEN THE Markdown_Parser SHALL skip that row and log a warning
7. THE Markdown_Parser SHALL handle variations in column ordering by matching column headers using keyword detection (company, role/title, location, link/apply, date)
8. FOR the Internship mega-repo, THE Markdown_Parser SHALL detect section headers (e.g., "## Software Engineering", "## Data Analysis") and assign the corresponding Role_Category to all jobs listed under that section until the next section header
9. FOR ALL valid markdown table content, parsing then formatting back to a table row then parsing again SHALL produce an equivalent job record (round-trip property)

### Requirement 3: Country Filtering

**User Story:** As a job seeker in North America, I want only Canada and USA jobs displayed, so that I see relevant opportunities without noise from other countries.

#### Acceptance Criteria

1. WHEN a job is parsed from a repository, THE Country_Filter SHALL classify the job's country based on the location text
2. THE Country_Filter SHALL identify USA jobs by matching state abbreviations (e.g., "CA", "NY", "TX"), full state names, city-state patterns, or the text "United States"
3. THE Country_Filter SHALL identify Canada jobs by matching province abbreviations (e.g., "ON", "BC", "AB"), full province names, city-province patterns, or the text "Canada"
4. WHEN a job location contains "Remote" without a specific country indicator, THE Country_Filter SHALL classify it as USA (the default country for these repositories)
5. WHEN a job's country is neither Canada nor USA, THE Aggregator SHALL exclude that job from storage
6. THE Country_Filter SHALL expose a filter parameter on the jobs API endpoint allowing users to filter by country ("CA", "US", or both)

### Requirement 4: Work Type Classification

**User Story:** As a job seeker, I want to filter jobs by work arrangement (Remote, Hybrid, On Site), so that I can focus on opportunities matching my preferred work style.

#### Acceptance Criteria

1. WHEN a job is parsed, THE Work_Type_Classifier SHALL extract the work type from the location field or dedicated column
2. THE Work_Type_Classifier SHALL recognize the following work type indicators: "Remote", "Hybrid", "On Site", "On-Site", "Onsite", "In-Person", "In Office"
3. WHEN a location field contains "Remote in" followed by a location, THE Work_Type_Classifier SHALL classify the job as "Remote"
4. WHEN no work type indicator is found in the location text, THE Work_Type_Classifier SHALL default to "On Site"
5. THE Aggregator SHALL store the classified work type on the ScrapedJob record in a dedicated field
6. THE jobs API endpoint SHALL accept a work_type filter parameter with values: "remote", "hybrid", "onsite"

### Requirement 5: Role Category Filtering

**User Story:** As a job seeker, I want to filter jobs by role category (Software Engineer, Data Analysis, etc.), so that I can focus on positions matching my career interests.

#### Acceptance Criteria

1. WHEN a job is stored from a GitHub source, THE Aggregator SHALL tag it with the Role_Category derived from the source repository name or from the section header within the Internship mega-repo
2. THE Aggregator SHALL support the following Role_Category values: "Software Engineering", "Data Analysis", "Business Analyst", "Management and Executive", "Engineering and Development", "Creatives and Design", "Product Management", "Sales", "Accounting and Finance", "Arts and Entertainment", "Legal and Compliance", "Human Resources", "Public Sector and Government", "Education and Training", "Customer Service and Support", "Marketing", "Consultant"
3. THE jobs API endpoint SHALL accept a role_category filter parameter that filters jobs by their assigned category
4. WHEN multiple role categories are specified in a filter request, THE jobs API endpoint SHALL return jobs matching any of the specified categories (OR logic)
5. THE jobs API endpoint SHALL accept an experience_level filter parameter with values: "internship", "new_grad", or comma-separated for both

### Requirement 6: Deduplication and Update Handling

**User Story:** As a job seeker, I want the system to avoid duplicate job entries and handle updates gracefully, so that my job feed stays clean and accurate.

#### Acceptance Criteria

1. WHEN a job is parsed from a repository, THE Deduplicator SHALL check for an existing ScrapedJob record with the same URL before inserting
2. WHEN a duplicate URL is detected, THE Deduplicator SHALL skip insertion and not modify the existing record
3. WHEN a repository is polled and the commit SHA has not changed since the last poll, THE Aggregator SHALL skip parsing entirely to save resources
4. THE Deduplicator SHALL handle the case where the same job appears in multiple repositories (e.g., a Software Engineer role also listed in Engineering) by storing only the first occurrence
5. WHEN a previously stored job is no longer present in the repository markdown, THE Aggregator SHALL retain the job record (jobs are not deleted when removed from source)

### Requirement 7: Scheduled Polling and Live Updates

**User Story:** As a job seeker, I want the system to automatically check for new jobs every hour, so that I see fresh listings without manual intervention.

#### Acceptance Criteria

1. THE Poll_Scheduler SHALL trigger a poll of all active GitHubSource records at their configured poll_interval_minutes (default: 60 minutes)
2. WHEN a poll is triggered, THE Aggregator SHALL fetch the latest commit SHA for each repository and compare it to the stored last_commit_sha
3. WHEN the commit SHA has changed, THE Aggregator SHALL fetch the README content and parse new job listings
4. WHEN a poll completes successfully, THE Aggregator SHALL update the GitHubSource record with the current timestamp and commit SHA
5. IF a poll fails due to network error or GitHub API rate limiting, THEN THE Aggregator SHALL mark the source status as "error", store the error message, and retry on the next scheduled cycle
6. THE Poll_Scheduler SHALL support a manual "poll now" trigger via the API endpoint POST /github-sources/{id}/poll
7. WHEN the system starts (serverless cold start on Vercel), THE Aggregator SHALL check if any sources are overdue for polling and trigger immediate polls for those sources

### Requirement 8: Enhanced Job Storage Fields

**User Story:** As a job seeker, I want job records to include rich metadata (work type, role category, country, company logo), so that the dashboard can display comprehensive job cards with filtering.

#### Acceptance Criteria

1. THE ScrapedJob model SHALL include a work_type field storing one of: "remote", "hybrid", "onsite"
2. THE ScrapedJob model SHALL include a role_category field storing the category derived from the source repository or section header
3. THE ScrapedJob model SHALL include a country field storing "US", "CA", or the detected country code
4. THE ScrapedJob model SHALL include an experience_level field storing "new_grad" or "internship"
5. WHEN a job is stored, THE Aggregator SHALL populate work_type, role_category, country, and experience_level fields based on the parsed and classified data
6. THE ScrapedJob model SHALL use the existing company_logo field to store extracted logo image URLs from the markdown table

### Requirement 9: Jobs API Filtering Enhancements

**User Story:** As a job seeker, I want the jobs API to support filtering by country, work type, and role category, so that the frontend can provide a rich filtering experience.

#### Acceptance Criteria

1. THE jobs API GET /jobs endpoint SHALL accept a country query parameter with values "US", "CA", or comma-separated for both
2. THE jobs API GET /jobs endpoint SHALL accept a work_type query parameter with values "remote", "hybrid", "onsite", or comma-separated for multiple
3. THE jobs API GET /jobs endpoint SHALL accept a role_category query parameter accepting one or more category names (comma-separated)
4. THE jobs API GET /jobs endpoint SHALL accept an experience_level query parameter with values "new_grad", "internship", or comma-separated for both
5. WHEN multiple filter parameters are provided simultaneously, THE jobs API SHALL apply all filters with AND logic (e.g., country=CA AND work_type=remote AND experience_level=internship)
6. THE jobs API GET /jobs/stats endpoint SHALL return counts broken down by country, work_type, role_category, and experience_level
7. THE jobs API SHALL return results sorted by posted_date descending (newest first) as the default sort order

### Requirement 10: Frontend Filter UI

**User Story:** As a job seeker, I want filter controls on the job dashboard for country, work type, and role category, so that I can quickly narrow down relevant opportunities.

#### Acceptance Criteria

1. THE Dashboard SHALL display a filter bar above the job list with controls for: Country, Work Type, and Role Category
2. THE Dashboard SHALL render Country as a toggle or dropdown with options: "All", "USA", "Canada"
3. THE Dashboard SHALL render Work Type as a multi-select with options: "Remote", "Hybrid", "On Site"
4. THE Dashboard SHALL render Role Category as a multi-select with options corresponding to the 17 role categories: Software Engineering, Data Analysis, Business Analyst, Management and Executive, Engineering and Development, Creatives and Design, Product Management, Sales, Accounting and Finance, Arts and Entertainment, Legal and Compliance, Human Resources, Public Sector and Government, Education and Training, Customer Service and Support, Marketing, Consultant
5. THE Dashboard SHALL render Experience Level as a toggle or multi-select with options: "All", "New Grad", "Internship"
6. WHEN a user changes any filter, THE Dashboard SHALL immediately re-fetch the job list with the updated filter parameters
7. THE Dashboard SHALL persist the user's filter selections in browser local storage so they survive page refreshes
8. THE Dashboard SHALL display the total count of jobs matching the current filters

### Requirement 11: Bulk Source Initialization Endpoint

**User Story:** As a system administrator, I want a single API call to seed all nine jobright-ai repositories, so that initial setup is simple and repeatable.

#### Acceptance Criteria

1. THE Aggregator SHALL expose a POST /github-sources/seed endpoint that creates GitHubSource records for all nine jobright-ai repositories
2. WHEN the seed endpoint is called, THE Aggregator SHALL skip any repositories that already exist in the database (idempotent operation)
3. WHEN the seed endpoint completes, THE Aggregator SHALL return the count of newly created sources and the count of already-existing sources
4. WHEN a source is seeded, THE Aggregator SHALL assign the correct Role_Category mapping based on the repository name
