# Requirements Document

## Introduction

The current job scraping system has two paths that both fall short of the user's "Max Jobs Per Scrape" target. The "Scrape Jobs" button uses LinkedIn's unauthenticated guest API, which caps results at ~70-100 jobs regardless of pagination. The "Scrape Page" button uses client-side scraping from the user's authenticated session but is hardcoded to 10 pages (~250 jobs max) and ignores the user's `maxJobsPerRun` setting entirely.

This feature overhauls the page-scraping pipeline so the authenticated "Scrape Page" approach becomes the primary scraping method, respects the user's configured job limit (up to 500+), handles LinkedIn's various page layouts (SDUI, infinite scroll, URL-based pagination), provides real-time progress feedback, deduplicates against existing jobs, and applies rate limiting to avoid detection.

## Glossary

- **Page_Scraper**: The client-side content script (`content.js`) that extracts job card data from the user's authenticated LinkedIn page
- **Popup**: The Chrome extension popup UI (`popup.js` / `popup.html`) that provides controls and settings to the user
- **Backend**: The FastAPI server that stores scraped jobs and manages application state
- **Save_Batch_Endpoint**: The `POST /api/extension/jobs/save-batch` backend endpoint that persists scraped jobs
- **maxJobsPerRun**: The user-configurable setting controlling how many jobs to scrape in a single run
- **SDUI**: LinkedIn's Server-Driven UI rendering approach where job cards are rendered as `role="button"` divs with job IDs in data attributes rather than traditional anchor links
- **Collections_Page**: A LinkedIn page at `/jobs/collections/` that uses infinite scroll instead of numbered pagination
- **Search_Page**: A LinkedIn jobs search results page that uses numbered pagination or URL `start=` parameter

## Requirements

### Requirement 1: Dynamic Page Limit from User Setting

**User Story:** As a user, I want the page scraper to respect my "Max Jobs Per Scrape" setting, so that I can control how many jobs are scraped without being limited by a hardcoded page count.

#### Acceptance Criteria

1. WHEN the user clicks "Scrape Page", THE Popup SHALL read the `maxJobsPerRun` setting from extension storage and pass it to the Page_Scraper as `maxJobs`
2. WHEN the Page_Scraper receives `maxJobs`, THE Page_Scraper SHALL calculate `maxPages` as `Math.ceil(maxJobs / 25)` and use that as the pagination limit
3. IF `maxJobsPerRun` is not set or is invalid, THEN THE Popup SHALL default to 25 and pass that value to the Page_Scraper
4. WHEN the Page_Scraper has collected a number of jobs equal to or exceeding `maxJobs`, THE Page_Scraper SHALL stop pagination and return the collected jobs
5. THE Popup SHALL allow `maxJobsPerRun` values up to 500 in the settings input field

### Requirement 2: Scrape Page as Primary Scrape Method

**User Story:** As a user, I want the "Scrape Jobs" button to use authenticated page scraping instead of the guest API, so that I get more accurate results and am not limited to ~70 jobs.

#### Acceptance Criteria

1. WHEN the user clicks "Scrape Jobs", THE Popup SHALL trigger the same authenticated page-scraping flow used by "Scrape Page" instead of calling the backend guest API
2. WHEN the user is not on a LinkedIn jobs page, THE Popup SHALL construct a LinkedIn search URL from the user's `jobTitle`, `searchLocation`, and filter settings, navigate the active tab to that URL, and then start scraping
3. WHEN the scrape completes, THE Popup SHALL save the results to the Save_Batch_Endpoint and offer to start applying

### Requirement 3: Robust Multi-Strategy Pagination

**User Story:** As a user, I want the scraper to handle all LinkedIn page layouts reliably, so that pagination works regardless of which UI variant LinkedIn serves me.

#### Acceptance Criteria

1. WHEN the current page is a Search_Page, THE Page_Scraper SHALL attempt pagination in this order: (a) click numbered page button, (b) click "Next" button, (c) fall back to URL `start=` parameter navigation
2. WHEN the current page is a Collections_Page, THE Page_Scraper SHALL scroll the job list container to trigger infinite-scroll loading of additional jobs
3. WHEN a pagination attempt loads no new jobs after waiting up to 5 seconds, THE Page_Scraper SHALL stop pagination and return all jobs collected so far
4. WHEN navigating to a new page via URL parameter, THE Page_Scraper SHALL wait for job card elements to appear in the DOM before scraping (up to 10 seconds timeout)

### Requirement 4: Real-Time Progress Feedback

**User Story:** As a user, I want to see how many jobs have been found during a multi-page scrape, so that I know the scrape is progressing and can estimate completion.

#### Acceptance Criteria

1. WHEN the Page_Scraper finishes scraping a page, THE Page_Scraper SHALL send a progress message to the Popup containing the current page number, total jobs found so far, and the target `maxJobs` value
2. WHEN the Popup receives a progress message, THE Popup SHALL display a toast showing "Scraping page X... (Y / Z jobs)"
3. WHEN the scrape completes, THE Popup SHALL display a final toast showing the total jobs found and how many were new (not duplicates)

### Requirement 5: Server-Side Deduplication

**User Story:** As a user, I want scraped jobs to be deduplicated against my existing database, so that I don't waste time re-processing jobs I've already seen.

#### Acceptance Criteria

1. WHEN the Save_Batch_Endpoint receives a batch of jobs, THE Backend SHALL skip any job whose URL already exists in the database
2. WHEN the save operation completes, THE Save_Batch_Endpoint SHALL return both the count of newly saved jobs and the count of duplicates skipped
3. THE Save_Batch_Endpoint SHALL return the response in the format `{ "saved": <number>, "duplicates": <number>, "total": <number> }`

### Requirement 6: Rate Limiting Between Pages

**User Story:** As a user, I want the scraper to add random delays between page navigations, so that LinkedIn does not detect automated behavior and throttle or block my account.

#### Acceptance Criteria

1. WHEN the Page_Scraper navigates to a new page, THE Page_Scraper SHALL wait a random delay between 2 and 5 seconds before starting to scrape the new page
2. WHEN the Page_Scraper scrolls to load lazy content, THE Page_Scraper SHALL use scroll intervals of 250–400ms between scroll steps
3. IF the Page_Scraper receives an HTTP error or detects a "too many requests" indicator on the page, THEN THE Page_Scraper SHALL stop pagination, return all jobs collected so far, and report the reason in the response

### Requirement 7: Client-Side Pre-Deduplication

**User Story:** As a user, I want the scraper to avoid sending duplicate job URLs within the same scrape session, so that the batch sent to the backend is clean and efficient.

#### Acceptance Criteria

1. THE Page_Scraper SHALL maintain a Set of scraped job URLs during the scrape session
2. WHEN the Page_Scraper encounters a job URL that is already in the session Set, THE Page_Scraper SHALL skip that job and not add it to the results array
3. WHEN all pages have been scraped, THE Page_Scraper SHALL report the total unique jobs found and the number of in-session duplicates skipped in the console log
