# Requirements Document

## Introduction

This feature spec covers three related improvements to the Auto Apply Bot Chrome extension:

1. Converting single-select dropdown filters (Experience Level, Work Type, Posted Within) in the Settings tab to multi-select pill/chip buttons, enabling users to select multiple values simultaneously.
2. Fixing the Greenhouse ATS form-filling flow in the extension's content script so it correctly fills and submits Greenhouse application forms from the client side.
3. Fixing the Easy Apply filter so that jobs are correctly classified as Easy Apply or external ATS during scraping, and the backend respects that classification when filtering.

## Glossary

- **Popup**: The Chrome extension popup UI rendered from `popup.html`, `popup.css`, and `popup.js`.
- **Pill_Button**: A toggle-style chip/button UI element that represents a single filter option; visually indicates selected/deselected state.
- **Pill_Group**: A container of Pill_Buttons for a single filter category, allowing zero or more selections.
- **Settings_Tab**: The "Settings" tab in the Popup containing job search filters, backend integration, and configuration options.
- **Content_Script**: The extension's content script (`content.js`) injected into LinkedIn and ATS pages to scrape jobs and fill forms.
- **Scraper**: The `scrapeCurrentPage()` function inside the Content_Script that extracts job listings from LinkedIn search result pages.
- **Backend**: The FastAPI server (`backend/routers/extension.py`) that stores scraped jobs and serves them for auto-apply.
- **ScrapedJob**: The database model representing a scraped job listing, with fields including `ats_type` and `easy_apply`.
- **ATS_Type**: A string classification for a job: `easy_apply`, `greenhouse`, `lever`, `workday`, `external`, or empty.
- **Easy_Apply_Badge**: A visual indicator on a LinkedIn job card (text "Easy Apply" or SVG badge) that identifies the job as a LinkedIn Easy Apply listing.
- **Greenhouse_Form**: An application form hosted on `boards.greenhouse.io`, `*.greenhouse.io`, or `grnh.se` domains.
- **Auto_Save**: The mechanism in `popup.js` (`setupAutoSave()` and `saveConfig()`) that persists Popup field values to `chrome.storage.local` on change.
- **Chrome_Storage**: The `chrome.storage.local` API used to persist extension configuration between sessions.

## Requirements

### Requirement 1: Multi-Select Pill UI for Experience Level Filter

**User Story:** As a job seeker, I want to select multiple experience levels simultaneously, so that I can search for jobs matching any of my target levels (e.g., both Entry Level and Mid-Senior).

#### Acceptance Criteria

1. WHEN the Settings_Tab loads, THE Popup SHALL render the Experience Level filter as a Pill_Group containing one Pill_Button for each option: Internship, Entry Level, Mid-Senior, Senior, Director, Executive.
2. WHEN the user clicks an unselected Pill_Button in the Experience Level Pill_Group, THE Popup SHALL toggle that Pill_Button to the selected visual state.
3. WHEN the user clicks a selected Pill_Button in the Experience Level Pill_Group, THE Popup SHALL toggle that Pill_Button to the unselected visual state.
4. THE Popup SHALL allow zero or more Pill_Buttons to be selected simultaneously within the Experience Level Pill_Group.
5. WHEN any Pill_Button selection changes in the Experience Level Pill_Group, THE Auto_Save SHALL persist the set of selected values as an array to Chrome_Storage under the `experienceLevel` settings key.
6. WHEN the Settings_Tab loads with previously saved Experience Level selections, THE Popup SHALL restore each previously selected Pill_Button to the selected visual state.

### Requirement 2: Multi-Select Pill UI for Work Type Filter

**User Story:** As a job seeker, I want to select multiple work types simultaneously, so that I can search for jobs matching any combination of Remote, On-site, and Hybrid.

#### Acceptance Criteria

1. WHEN the Settings_Tab loads, THE Popup SHALL render the Work Type filter as a Pill_Group containing one Pill_Button for each option: Remote, On-site, Hybrid.
2. WHEN the user clicks an unselected Pill_Button in the Work Type Pill_Group, THE Popup SHALL toggle that Pill_Button to the selected visual state.
3. WHEN the user clicks a selected Pill_Button in the Work Type Pill_Group, THE Popup SHALL toggle that Pill_Button to the unselected visual state.
4. THE Popup SHALL allow zero or more Pill_Buttons to be selected simultaneously within the Work Type Pill_Group.
5. WHEN any Pill_Button selection changes in the Work Type Pill_Group, THE Auto_Save SHALL persist the set of selected values as an array to Chrome_Storage under the `workType` settings key.
6. WHEN the Settings_Tab loads with previously saved Work Type selections, THE Popup SHALL restore each previously selected Pill_Button to the selected visual state.

### Requirement 3: Multi-Select Pill UI for Posted Within Filter

**User Story:** As a job seeker, I want to select multiple posting timeframes, so that I can see jobs from both the last 24 hours and the last week in a single search.

#### Acceptance Criteria

1. WHEN the Settings_Tab loads, THE Popup SHALL render the Posted Within filter as a Pill_Group containing one Pill_Button for each option: Last 24 Hours, Last Week, Last Month.
2. WHEN the user clicks an unselected Pill_Button in the Posted Within Pill_Group, THE Popup SHALL toggle that Pill_Button to the selected visual state.
3. WHEN the user clicks a selected Pill_Button in the Posted Within Pill_Group, THE Popup SHALL toggle that Pill_Button to the unselected visual state.
4. THE Popup SHALL allow zero or more Pill_Buttons to be selected simultaneously within the Posted Within Pill_Group.
5. WHEN any Pill_Button selection changes in the Posted Within Pill_Group, THE Auto_Save SHALL persist the set of selected values as an array to Chrome_Storage under the `postedWithin` settings key.
6. WHEN the Settings_Tab loads with previously saved Posted Within selections, THE Popup SHALL restore each previously selected Pill_Button to the selected visual state.

### Requirement 4: Pill Button Visual Design

**User Story:** As a user, I want the pill buttons to match the existing dark theme, so that the UI feels cohesive and polished.

#### Acceptance Criteria

1. THE Popup SHALL render unselected Pill_Buttons with a transparent background, a 1px border using the `--border` CSS variable color, and text in the `--text-secondary` color.
2. THE Popup SHALL render selected Pill_Buttons with the `--accent` (#B09255) background color, white text, and no visible border distinct from the background.
3. WHEN the user hovers over a Pill_Button, THE Popup SHALL display a subtle hover effect (background opacity change or border highlight).
4. THE Popup SHALL render each Pill_Button with `border-radius: var(--radius-full)` to produce a rounded pill shape.
5. THE Popup SHALL render each Pill_Group as a flex-wrap container so Pill_Buttons wrap to the next line when the container width is insufficient.

### Requirement 5: Pill UI Backward Compatibility with Auto-Save

**User Story:** As a developer, I want the pill UI to integrate with the existing auto-save system, so that no changes are needed to the save/load architecture.

#### Acceptance Criteria

1. THE `saveConfig()` function SHALL collect Pill_Group values by reading the selected state of each Pill_Button and storing the result as an array (e.g., `["entry", "mid"]`) instead of a single string.
2. THE `populateSettingsFields()` function SHALL detect when a settings key maps to a Pill_Group and restore selections from an array value.
3. IF a previously saved value for a Pill_Group key is a single string (legacy format from the old dropdown), THEN THE `populateSettingsFields()` function SHALL treat it as a single-element array and select the corresponding Pill_Button.
4. WHEN no Pill_Buttons are selected in a Pill_Group, THE `saveConfig()` function SHALL store an empty array for that settings key.

### Requirement 6: Easy Apply Badge Detection During Scraping

**User Story:** As a user who filters for Easy Apply jobs, I want the scraper to correctly identify which jobs are Easy Apply, so that the filter actually works.

#### Acceptance Criteria

1. WHEN the Scraper processes a job card from a LinkedIn search results page, THE Content_Script SHALL check for the presence of an Easy_Apply_Badge on that job card.
2. WHEN a job card contains an Easy_Apply_Badge, THE Scraper SHALL set `atsType` to `"easy_apply"` and `easyApply` to `1` for that job.
3. WHEN a job card does not contain an Easy_Apply_Badge, THE Scraper SHALL set `atsType` to `"external"` and `easyApply` to `0` for that job.
4. IF the LinkedIn URL contains the `f_AL=true` parameter (Easy Apply filter active), THE Scraper SHALL still check each individual job card for the Easy_Apply_Badge rather than assuming all jobs are Easy Apply.

### Requirement 7: Backend Respects Client-Provided ATS Type

**User Story:** As a user, I want the backend to store the correct ATS type from the scraper, so that filtering by Easy Apply actually excludes external ATS jobs.

#### Acceptance Criteria

1. WHEN the `save_job_batch` endpoint receives a job object with an `atsType` field, THE Backend SHALL use the client-provided `atsType` value for the `ats_type` column instead of hardcoding `"easy_apply"`.
2. WHEN the `save_job_batch` endpoint receives a job object with an `easyApply` field, THE Backend SHALL use the client-provided `easyApply` value for the `easy_apply` column instead of hardcoding `1`.
3. IF a job object in the batch does not include an `atsType` field, THEN THE Backend SHALL default to `"easy_apply"` for backward compatibility.
4. IF a job object in the batch does not include an `easyApply` field, THEN THE Backend SHALL default to `1` for backward compatibility.

### Requirement 8: Greenhouse Form Detection in Content Script

**User Story:** As a user applying to Greenhouse jobs via the extension, I want the content script to detect Greenhouse forms, so that it can fill them correctly.

#### Acceptance Criteria

1. WHEN the Content_Script is injected into a page matching the Greenhouse URL pattern (`greenhouse.io`, `boards.greenhouse`, `grnh.se`), THE Content_Script SHALL identify the ATS type as `"greenhouse"`.
2. WHEN a Greenhouse_Form is detected, THE Content_Script SHALL locate the application form container using selectors `#application_form`, `#main_fields`, or `#application`.
3. IF no Greenhouse_Form container is found on a Greenhouse domain page, THEN THE Content_Script SHALL log a warning and fall back to full-page field extraction.

### Requirement 9: Greenhouse Standard Field Filling

**User Story:** As a user, I want the extension to auto-fill standard Greenhouse form fields (name, email, phone, LinkedIn URL), so that I do not have to type them manually.

#### Acceptance Criteria

1. WHEN a Greenhouse_Form is detected, THE Content_Script SHALL fill the first name field using selectors `#first_name`, `input[name*="first_name"]`, or `input[autocomplete="given-name"]` from the user profile.
2. WHEN a Greenhouse_Form is detected, THE Content_Script SHALL fill the last name field using selectors `#last_name`, `input[name*="last_name"]`, or `input[autocomplete="family-name"]` from the user profile.
3. WHEN a Greenhouse_Form is detected, THE Content_Script SHALL fill the email field using selectors `#email`, `input[name*="email"]`, or `input[type="email"]` from the user profile.
4. WHEN a Greenhouse_Form is detected, THE Content_Script SHALL fill the phone field using selectors `#phone`, `input[name*="phone"]`, or `input[type="tel"]` from the user profile.
5. WHEN a Greenhouse_Form is detected, THE Content_Script SHALL fill the LinkedIn URL field using selectors matching `input[name*="linkedin"]`, `input[placeholder*="linkedin"]`, or `input[id*="linkedin"]` from the user profile.
6. IF a standard field already contains a value, THEN THE Content_Script SHALL skip that field to avoid overwriting user-entered data.

### Requirement 10: Greenhouse Resume Upload

**User Story:** As a user, I want the extension to upload my resume to Greenhouse forms, so that I do not have to manually attach it each time.

#### Acceptance Criteria

1. WHEN a Greenhouse_Form contains a file input (`input[type="file"]`) with a nearby label containing "resume", "cv", or "curriculum", THE Content_Script SHALL upload the user's stored resume file to that input.
2. IF no resume file is configured in the user's profile, THEN THE Content_Script SHALL skip the resume upload step and log a message.
3. IF the resume upload fails, THEN THE Content_Script SHALL log the error and continue filling the remaining form fields.

### Requirement 11: Greenhouse Custom Question Handling

**User Story:** As a user, I want the extension to answer custom Greenhouse questions using my prefilled answers or AI, so that I can submit complete applications.

#### Acceptance Criteria

1. WHEN a Greenhouse_Form contains select dropdowns (custom questions), THE Content_Script SHALL attempt to match each dropdown's label against the user's prefilled Q&A answers.
2. WHEN a Greenhouse_Form contains text inputs (custom questions, excluding standard fields), THE Content_Script SHALL attempt to match each input's label against the user's prefilled Q&A answers.
3. WHEN a Greenhouse_Form contains radio button groups in fieldsets, THE Content_Script SHALL attempt to match each fieldset's legend against the user's prefilled Q&A answers.
4. IF a prefilled answer is not found and AI is enabled, THEN THE Content_Script SHALL use the backend AI endpoint to generate an answer.
5. IF neither a prefilled answer nor an AI answer is available, THEN THE Content_Script SHALL add the question to an unfilled fields list and report it to the user.

### Requirement 12: Greenhouse Form Submission

**User Story:** As a user, I want the extension to submit the Greenhouse form after filling, so that my application is completed.

#### Acceptance Criteria

1. WHEN all required fields in a Greenhouse_Form are filled, THE Content_Script SHALL locate the submit button using selectors `#submit_app`, `button[type="submit"]`, `input[type="submit"]`, or buttons containing "Submit" or "Apply" text.
2. WHEN the submit button is found, THE Content_Script SHALL click the submit button.
3. WHEN the form is submitted, THE Content_Script SHALL check for a success confirmation (page text containing "thank" or "success").
4. IF validation errors appear after submission, THEN THE Content_Script SHALL report the errors and set the application status to failed.
5. IF no submit button is found, THEN THE Content_Script SHALL log an error and set the application status to failed.
