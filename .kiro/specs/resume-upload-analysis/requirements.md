# Requirements Document

## Introduction

The Resume Upload & Analysis feature transforms the stub `/app/resume` page into a full resume management system inspired by Jobright.ai. Users can upload PDF/DOCX resumes, have them analyzed by Ollama AI into structured profiles (name, email, phone, location, education, experience, projects, skills), view and edit the parsed data in a rich editor, run quality analysis reports, manage multiple resumes with a primary selection, and assign target job titles. The parsed profile data feeds directly into the Chrome extension's form autofill via the existing `GET /apply/{session}/profile` endpoint. The backend already has `POST /resumes/upload`, `ResumeProfileDB`, `OllamaService.analyze_resume()`, and `resume_parser.extract_text()` — this feature extends them with richer schema fields, multiple resume support, and a quality grading endpoint.

## Glossary

- **Resume_List_Page**: The main view at `/app/resume` showing all uploaded resumes in a table with name, target job title, last modified, created date, status badge, and primary badge
- **Resume_Detail_Page**: The editable structured view of a single parsed resume, showing all extracted sections in card-based editors
- **Upload_Modal**: The modal dialog for uploading a new resume file (PDF or DOCX) with drag-and-drop or file picker
- **Analysis_Progress_Indicator**: A progress bar with status text shown while Ollama processes the uploaded resume
- **Upload_Success_Modal**: The modal shown after successful analysis, prompting for resume name and target job title
- **Resume_Editor**: The full-page structured editor displaying parsed resume sections (header, education, experience, projects, technologies) with inline editing
- **Analysis_Report**: The AI-generated quality assessment view showing overall grade, fix counts, summary, and highlights
- **Resume_API**: The backend endpoints for resume CRUD operations (`POST /resumes/upload`, `GET /resumes`, `GET /resumes/{id}`, `PUT /resumes/{id}`, `DELETE /resumes/{id}`, `PUT /resumes/{id}/primary`, `POST /resumes/{id}/analyze`)
- **Ollama_Service**: The backend AI service that parses resume text into structured data and generates quality analysis reports
- **Resume_Profile**: The structured data model containing all parsed resume fields (personal info, education, experience, projects, skills/technologies)
- **Primary_Resume**: The single resume marked as active, whose profile data is returned by the autofill endpoint for the Chrome extension
- **Section_Card**: A visually distinct card container grouping related resume fields in the editor view
- **Skill_Tag**: A pill-shaped badge displaying a single skill or technology, optionally categorized

## Requirements

### Requirement 1: Resume List View

**User Story:** As a user, I want to see all my uploaded resumes in a table view, so that I can manage multiple resumes and identify which one is active.

#### Acceptance Criteria

1. WHEN the user navigates to `/app/resume`, THE Resume_List_Page SHALL call `GET /resumes` and display all resumes in a table with columns: Resume Name, Target Job Title, Last Modified, and Created
2. WHEN a resume is marked as primary, THE Resume_List_Page SHALL display a "PRIMARY" badge next to that resume's name
3. WHEN a resume has been successfully analyzed, THE Resume_List_Page SHALL display an "Analysis Complete" status badge for that resume
4. THE Resume_List_Page SHALL display an "+ Add Resume" button that opens the Upload_Modal
5. WHEN the user clicks a resume row, THE Resume_List_Page SHALL navigate to the Resume_Detail_Page for that resume
6. WHILE the `GET /resumes` request is in progress, THE Resume_List_Page SHALL display a loading indicator
7. IF the `GET /resumes` request fails, THEN THE Resume_List_Page SHALL display an error message indicating resumes could not be loaded
8. WHEN no resumes exist, THE Resume_List_Page SHALL display an empty state with a prompt to upload the first resume

### Requirement 2: Resume Upload Flow

**User Story:** As a user, I want to upload a PDF or DOCX resume and see progress while it is analyzed, so that I know the system is processing my file.

#### Acceptance Criteria

1. WHEN the user clicks "+ Add Resume", THE Upload_Modal SHALL open with a file drop zone accepting PDF and DOCX files
2. WHEN the user selects or drops a valid file, THE Upload_Modal SHALL call `POST /resumes/upload` with the file as multipart form data
3. IF the user selects a file that is not PDF or DOCX, THEN THE Upload_Modal SHALL display an error message stating only PDF and DOCX files are accepted
4. WHILE the upload and analysis is in progress, THE Analysis_Progress_Indicator SHALL display a progress bar with the text "Analyzing Your Resume" and a rotating tip message
5. WHEN the `POST /resumes/upload` request succeeds, THE Upload_Success_Modal SHALL appear displaying "Upload Success!" with input fields for Resume Name and Target Job Title
6. THE Upload_Success_Modal SHALL provide a "View My Resume" button that navigates to the Resume_Detail_Page and an "Update to Profile" button that sets the resume as primary
7. IF the `POST /resumes/upload` request fails, THEN THE Upload_Modal SHALL display the error message returned by the API

### Requirement 3: Resume Profile Schema Extension

**User Story:** As a developer, I want the resume profile schema to support richer structured data (projects, categorized skills, GitHub/LinkedIn URLs, GPA, coursework), so that the editor can display all parsed sections.

#### Acceptance Criteria

1. THE Resume_Profile SHALL include fields for: name, email, phone, location, linkedin_url, github_url, other_link
2. THE Resume_Profile education entries SHALL include fields for: school, degree, start_date, end_date, gpa, achievements (list of strings), and coursework (list of strings)
3. THE Resume_Profile experience entries SHALL include fields for: company, title, location, start_date, end_date, and bullets (list of strings)
4. THE Resume_Profile SHALL include a projects section with entries containing: name, link, organization, location, start_date, end_date, and bullets (list of strings)
5. THE Resume_Profile SHALL include a technologies section as a dictionary mapping category names (strings) to lists of skill strings
6. THE ResumeProfileDB model SHALL store the extended profile fields as JSON columns for projects and technologies
7. THE Ollama_Service analyze_resume method SHALL extract all extended fields from resume text and return them in the extended Resume_Profile format

### Requirement 4: Resume Detail Editor View

**User Story:** As a user, I want to view and edit my parsed resume in a structured format with sections for header, education, experience, projects, and technologies, so that I can correct any parsing errors before using it for autofill.

#### Acceptance Criteria

1. WHEN the Resume_Detail_Page loads, THE Resume_Editor SHALL call `GET /resumes/{id}` and display the parsed profile in editable Section_Cards
2. THE Resume_Editor SHALL display a header Section_Card with editable fields for: name, email, phone, location, LinkedIn URL, GitHub URL, and Other Link
3. THE Resume_Editor SHALL display an Education Section_Card with entries showing: university, dates, GPA, degree, achievements, and coursework tags
4. THE Resume_Editor SHALL display an Experience Section_Card with entries showing: company, dates, location, title, and editable bullet points
5. THE Resume_Editor SHALL display a Projects Section_Card with entries showing: project name, link, dates, location, organization, and editable bullet points
6. THE Resume_Editor SHALL display a Technologies Section_Card with categorized Skill_Tags grouped by category name
7. WHEN the user clicks "+ Add" on any section, THE Resume_Editor SHALL append a new empty entry to that section
8. WHEN the user clicks "+ Bullet Points" on an experience or project entry, THE Resume_Editor SHALL append a new empty bullet point to that entry
9. WHEN the user clicks Save, THE Resume_Editor SHALL call `PUT /resumes/{id}` with the modified profile data
10. WHEN the `PUT /resumes/{id}` request succeeds, THE Resume_Editor SHALL display a success notification
11. IF the `PUT /resumes/{id}` request fails, THEN THE Resume_Editor SHALL display an error notification

### Requirement 5: Resume Analysis Report

**User Story:** As a user, I want to run an AI quality analysis on my resume and see a graded report with improvement suggestions, so that I can improve my resume before applying to jobs.

#### Acceptance Criteria

1. THE Resume_Detail_Page SHALL display an "Analyze" button that triggers a quality analysis
2. WHEN the user clicks "Analyze", THE Resume_Detail_Page SHALL call `POST /resumes/{id}/analyze` and display an "Analysis in Progress" state with a progress bar
3. WHEN the analysis completes, THE Analysis_Report SHALL display an overall grade (EXCELLENT, GOOD, or FAIR) with a corresponding letter badge
4. THE Analysis_Report SHALL display counts for: Urgent Fixes, Critical Fixes, and Optional Fixes
5. THE Analysis_Report SHALL display an AI-generated Analysis Summary paragraph describing the resume quality
6. THE Analysis_Report SHALL display an Analysis Highlights section listing specific findings
7. THE Analysis_Report SHALL display a "Begin Improvements Now" button that scrolls the user to the Resume_Editor
8. IF the `POST /resumes/{id}/analyze` request fails, THEN THE Resume_Detail_Page SHALL display an error notification indicating analysis could not be completed

### Requirement 6: Multiple Resume Support with Primary Selection

**User Story:** As a user, I want to manage multiple resumes and designate one as primary, so that the Chrome extension always uses my preferred resume for autofill.

#### Acceptance Criteria

1. THE Resume_API SHALL support storing multiple resumes per user, each with a unique id, name, target_job_title, is_primary flag, created_at, and updated_at timestamps
2. WHEN the user sets a resume as primary via `PUT /resumes/{id}/primary`, THE Resume_API SHALL mark that resume as primary and unmark all other resumes
3. THE Resume_Detail_Page SHALL display a "Set as Primary" button for non-primary resumes
4. WHEN a resume is already primary, THE Resume_Detail_Page SHALL display a "PRIMARY" badge instead of the set-primary button
5. THE autofill endpoint (`GET /apply/{session}/profile`) SHALL return the profile data from the resume marked as primary
6. IF no resume is marked as primary, THEN THE autofill endpoint SHALL return the most recently created resume profile

### Requirement 7: Target Job Title Per Resume

**User Story:** As a user, I want to assign a target job title to each resume, so that I can tailor different resumes for different roles.

#### Acceptance Criteria

1. THE Resume_Profile SHALL include a target_job_title field that is editable in both the Upload_Success_Modal and the Resume_Detail_Page
2. WHEN the user saves a target job title, THE Resume_API SHALL persist it alongside the resume profile
3. THE Resume_List_Page SHALL display the target job title in the table for each resume
4. WHEN the target_job_title field is empty, THE Resume_List_Page SHALL display a dash or "Not set" placeholder in the Target Job Title column

### Requirement 8: Backend API Endpoints

**User Story:** As a developer, I want complete CRUD endpoints for resume management, so that the frontend can list, view, update, delete, and analyze resumes.

#### Acceptance Criteria

1. THE Resume_API SHALL provide `GET /resumes` returning a list of all resumes with id, name, target_job_title, is_primary, status, created_at, and updated_at
2. THE Resume_API SHALL provide `GET /resumes/{id}` returning the full resume profile including all parsed sections
3. THE Resume_API SHALL provide `PUT /resumes/{id}` accepting an updated profile body and persisting changes to the database
4. THE Resume_API SHALL provide `DELETE /resumes/{id}` removing the resume from the database
5. THE Resume_API SHALL provide `PUT /resumes/{id}/primary` marking the specified resume as primary
6. THE Resume_API SHALL provide `POST /resumes/{id}/analyze` triggering an AI quality analysis and returning the graded report
7. IF a request references a resume id that does not exist, THEN THE Resume_API SHALL return a 404 status with a descriptive error message

### Requirement 9: AI Quality Analysis Endpoint

**User Story:** As a developer, I want an Ollama-powered endpoint that grades a resume and returns structured feedback, so that the frontend can display the Analysis Report.

#### Acceptance Criteria

1. WHEN `POST /resumes/{id}/analyze` is called, THE Ollama_Service SHALL analyze the resume raw text and return a structured report
2. THE analysis report SHALL include: overall_grade (EXCELLENT, GOOD, or FAIR), urgent_fix_count, critical_fix_count, optional_fix_count, summary (string), and highlights (list of strings)
3. THE Ollama_Service SHALL use a dedicated prompt template (`analyze_resume_quality.txt`) for quality analysis, separate from the parsing prompt
4. IF the Ollama_Service is unreachable, THEN THE endpoint SHALL return a 502 status with a descriptive error message
5. THE analysis report SHALL be persisted on the resume record so it can be retrieved without re-running analysis

### Requirement 10: Jobright-Inspired Visual Design

**User Story:** As a user, I want the resume pages to look modern and polished like Jobright.ai, so that the experience feels premium and cohesive with the rest of the app.

#### Acceptance Criteria

1. THE Resume_List_Page and Resume_Detail_Page SHALL use the CSS variables defined in `index.css` (`--accent`, `--bg`, `--bg-page`, `--border`, `--radius`, `--radius-pill`, `--text`, `--text-secondary`)
2. EACH Section_Card SHALL have a white background, `var(--radius)` border-radius, `1px solid var(--border)` border, and internal padding of at least 1.25rem
3. THE Skill_Tags SHALL be rendered as pill-shaped badges with a light background and category-appropriate styling
4. THE Resume_List_Page table SHALL use alternating row backgrounds or hover highlights for readability
5. THE Analysis_Report grade badge SHALL use color coding: green for EXCELLENT, blue for GOOD, orange for FAIR
6. ALL action buttons SHALL use pill-shaped styling (`border-radius: var(--radius-pill)`) consistent with the existing app design
7. THE pages SHALL use plain CSS consistent with the existing frontend approach, without introducing a component library

### Requirement 11: Integration with Chrome Extension Autofill

**User Story:** As a user, I want my parsed resume profile to be available for the Chrome extension's form autofill, so that job applications are filled automatically with my resume data.

#### Acceptance Criteria

1. THE `GET /apply/{session}/profile` endpoint SHALL return the primary resume's full profile data including all extended fields (education, experience, projects, technologies)
2. THE profile data returned SHALL match the format expected by the Chrome extension's FormFiller component
3. WHEN the user updates their resume profile via the Resume_Editor, THE changes SHALL be immediately reflected in subsequent autofill requests
4. THE Resume_Profile serialization SHALL include a flat skills list (merged from all technology categories) for backward compatibility with the existing FormFiller

### Requirement 12: Responsive Layout

**User Story:** As a user, I want the resume pages to work well on different screen sizes, so that I can manage resumes on both desktop and smaller windows.

#### Acceptance Criteria

1. THE Resume_List_Page table SHALL be horizontally scrollable on narrow viewports while maintaining column alignment
2. THE Resume_Editor Section_Cards SHALL stack vertically with consistent gap spacing
3. WHEN the viewport width is 768px or wider, THE Resume_Editor header fields SHALL use a two-column grid layout
4. WHEN the viewport width is below 768px, THE Resume_Editor SHALL collapse all grids to single-column layout
5. THE Resume_Detail_Page SHALL have a maximum content width to maintain readability on wide screens
