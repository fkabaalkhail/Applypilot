# Requirements Document

## Introduction

The Settings Profile Page is a full-page profile editor rendered at the `/settings` route in the existing React frontend. It follows the visual and UX patterns of Jobright's Info Modal and Settings Panel — clean card-based sections, Inter font, green accent color, toggle switches, and section headers with icons. The page allows users to manage personal info, job preferences, pre-filled screening answers, resume, and extension behavior settings. All data syncs to the backend via the existing `GET/PUT /settings` and `POST /settings/resume` endpoints, powering the `/api/fill` endpoint used by the Chrome extension. The code is structured so it can later be extracted into the Chrome extension's options page or overlay modal.

## Glossary

- **Settings_Page**: The React page rendered at the `/settings` route, styled as a Jobright-inspired profile editor with card-based sections
- **Section_Card**: A visually distinct card container (white background, rounded corners, subtle border) that groups related settings fields, inspired by Jobright's overlay panels
- **Personal_Info_Card**: The Section_Card containing identity and contact fields (name, email, phone, city, LinkedIn URL, website)
- **Job_Preferences_Card**: The Section_Card containing job search preference fields (target title, location, remote toggle)
- **Prefilled_Answers_Card**: The Section_Card containing the key-value editor for common screening question answers
- **Resume_Card**: The Section_Card for uploading and displaying the user's resume file, inspired by Jobright's resume picker
- **Extension_Settings_Card**: The Section_Card containing toggle switches for extension autofill behavior (autofill after page turn, auto-submit, pause before submit, smooth scrolling)
- **Settings_API**: The backend endpoints (`GET /settings`, `PUT /settings`, `POST /settings/resume`) that persist user settings
- **Key_Value_Editor**: A UI component that allows adding, editing, and removing question-answer pairs for pre-filled screening answers
- **Toggle_Switch**: A styled on/off switch component (pill-shaped track with sliding circle) used for boolean settings, matching Jobright's Settings Panel toggles
- **Toast_Notification**: A temporary success or error notification that slides in after a save or upload operation
- **Section_Header**: A card header with an icon and title label, matching Jobright's panel section styling

## Requirements

### Requirement 1: Load and Display Settings

**User Story:** As a user, I want the Settings page to load my saved settings on mount, so that I can see my current profile data across all sections.

#### Acceptance Criteria

1. WHEN the Settings_Page mounts, THE Settings_Page SHALL call `GET /settings` using a relative URL and populate all Section_Card fields with the returned values
2. WHILE the Settings_API request is in progress, THE Settings_Page SHALL display a centered loading indicator
3. IF the `GET /settings` request fails, THEN THE Settings_Page SHALL display an error message indicating settings could not be loaded
4. WHEN the `GET /settings` request succeeds, THE Settings_Page SHALL render all five Section_Cards (Personal_Info_Card, Job_Preferences_Card, Prefilled_Answers_Card, Resume_Card, Extension_Settings_Card) in a single-column stacked layout

### Requirement 2: Personal Info Card

**User Story:** As a user, I want to edit my personal information (name, email, phone, city, LinkedIn URL, website) in a clean card layout, so that the extension can fill identity fields on job applications.

#### Acceptance Criteria

1. THE Personal_Info_Card SHALL render inside a Section_Card with a Section_Header displaying a person icon and the title "Personal Info"
2. THE Personal_Info_Card SHALL render text inputs for `first_name` and `last_name`, an email input for `email`, a tel input for `phone`, a text input for `city`, and url inputs for `linkedin_url` and `website`
3. THE Personal_Info_Card SHALL arrange inputs in a two-column grid layout on screens wider than 768px, collapsing to single-column on smaller screens
4. WHEN the Settings_Page loads, THE Personal_Info_Card SHALL pre-populate each input with the corresponding value from the `GET /settings` response

### Requirement 3: Job Preferences Card

**User Story:** As a user, I want to set my target job title, location, and remote preference in a dedicated card, so that the extension knows my job search criteria.

#### Acceptance Criteria

1. THE Job_Preferences_Card SHALL render inside a Section_Card with a Section_Header displaying a briefcase icon and the title "Job Preferences"
2. THE Job_Preferences_Card SHALL render text inputs for `job_title` and `location`, and a Toggle_Switch for `remote_only`
3. WHEN the Settings_Page loads, THE Job_Preferences_Card SHALL pre-populate each input with the corresponding value from the `GET /settings` response
4. THE Toggle_Switch for `remote_only` SHALL display a label "Remote Only" and visually indicate the on/off state using the green accent color

### Requirement 4: Pre-filled Answers Card

**User Story:** As a user, I want to add, edit, and remove pre-filled answers to common screening questions, so that the extension can auto-answer questions like "Are you authorized to work?" or "Years of experience with Python?"

#### Acceptance Criteria

1. THE Prefilled_Answers_Card SHALL render inside a Section_Card with a Section_Header displaying a chat/question icon and the title "Pre-filled Answers"
2. THE Prefilled_Answers_Card SHALL render a Key_Value_Editor displaying all entries from the `prefilled_answers` dictionary as rows with a question field and an answer field
3. WHEN the user clicks an Add button, THE Key_Value_Editor SHALL append a new empty question-answer row at the bottom of the list
4. WHEN the user clicks a Remove button on a row, THE Key_Value_Editor SHALL remove that question-answer pair from the list
5. THE Key_Value_Editor SHALL allow the user to edit both the question key and the answer value of each entry inline
6. THE Add button SHALL be styled as a pill-shaped outline button consistent with the Jobright button pattern

### Requirement 5: Resume Upload Card

**User Story:** As a user, I want to upload my resume (PDF or DOCX) and see the current file name, so that the extension and backend can reference it for form filling.

#### Acceptance Criteria

1. THE Resume_Card SHALL render inside a Section_Card with a Section_Header displaying a document icon and the title "Resume"
2. THE Resume_Card SHALL render a file input that accepts PDF and DOCX files, styled as a pill-shaped upload button
3. WHEN a resume has been previously uploaded, THE Resume_Card SHALL display the current file name from the `resume_file_name` field with a file icon
4. WHEN the user selects a file, THE Resume_Card SHALL call `POST /settings/resume` with the file as multipart form data
5. WHEN the upload succeeds, THE Resume_Card SHALL update the displayed file name to the newly uploaded file name and show a success Toast_Notification
6. IF the resume upload request fails, THEN THE Resume_Card SHALL display an error Toast_Notification

### Requirement 6: Extension Settings Card

**User Story:** As a user, I want to configure extension autofill behavior (autofill after page turn, pause before submit, smooth scrolling) using toggle switches, so that I can control how the extension fills forms.

#### Acceptance Criteria

1. THE Extension_Settings_Card SHALL render inside a Section_Card with a Section_Header displaying a gear icon and the title "Extension Settings"
2. THE Extension_Settings_Card SHALL render Toggle_Switches for `pause_before_submit`, `smooth_scrolling`, and `follow_companies`
3. EACH Toggle_Switch SHALL display a descriptive label explaining the setting behavior
4. WHEN the Settings_Page loads, THE Extension_Settings_Card SHALL set each Toggle_Switch to the corresponding boolean value from the `GET /settings` response
5. THE Toggle_Switches SHALL use the green accent color (`--accent`) for the active state and a neutral gray for the inactive state

### Requirement 7: Save Settings with Feedback

**User Story:** As a user, I want to save my settings with a single button and receive clear feedback, so that I know my changes are persisted.

#### Acceptance Criteria

1. THE Settings_Page SHALL render a sticky or prominent Save button at the bottom of the page, styled as a pill-shaped primary button with the green accent background
2. WHEN the user clicks Save, THE Settings_Page SHALL send only the fields that differ from the originally loaded values to `PUT /settings`
3. WHEN the `PUT /settings` request succeeds, THE Settings_Page SHALL display a success Toast_Notification
4. IF the `PUT /settings` request fails, THEN THE Settings_Page SHALL display an error Toast_Notification
5. WHILE the save request is in progress, THE Save button SHALL display a loading state and be disabled to prevent duplicate submissions
6. WHEN the user modifies any field, THE Settings_Page SHALL visually indicate unsaved changes exist (e.g., the Save button becomes highlighted or a dot indicator appears)

### Requirement 8: Jobright-Inspired Visual Design

**User Story:** As a user, I want the Settings page to look modern and polished like Jobright's extension panels, so that the experience feels premium and cohesive with the rest of the app.

#### Acceptance Criteria

1. THE Settings_Page SHALL use the CSS variables defined in `index.css` (`--accent`, `--bg`, `--bg-page`, `--border`, `--radius`, `--radius-pill`, `--text`, `--text-secondary`)
2. EACH Section_Card SHALL have a white background, `var(--radius)` border-radius, `1px solid var(--border)` border, and internal padding of at least 1.25rem
3. THE Settings_Page SHALL use the Inter font family consistent with the existing app and Jobright's styling
4. THE Settings_Page SHALL use pill-shaped buttons (`border-radius: var(--radius-pill)`) for all action buttons (Save, Add, Upload)
5. THE Settings_Page SHALL render inside the existing `main-content` area and follow the app layout pattern with the sidebar visible
6. THE Settings_Page SHALL use plain CSS (added to `index.css` or a dedicated settings CSS file) without introducing a component library, consistent with the existing Jobs page approach
7. THE Settings_Page SHALL include smooth transitions on interactive elements (hover states, toggle switches, button presses) using CSS transitions of 150ms or less

### Requirement 9: Responsive Layout

**User Story:** As a user, I want the Settings page to work well on different screen sizes, so that I can use it on both desktop and smaller windows.

#### Acceptance Criteria

1. THE Settings_Page SHALL stack Section_Cards vertically with consistent gap spacing
2. WHEN the viewport width is 768px or wider, THE Personal_Info_Card and Job_Preferences_Card SHALL use a two-column grid for their input fields
3. WHEN the viewport width is below 768px, THE Settings_Page SHALL collapse all grids to single-column layout
4. THE Settings_Page SHALL have a maximum content width to maintain readability on wide screens

### Requirement 10: Deployment Compatibility

**User Story:** As a user, I want the Settings page to work on both local development and the deployed Vercel URL, so that I can use it in any environment.

#### Acceptance Criteria

1. THE Settings_Page SHALL use relative URLs for all API calls (no hardcoded `localhost` or domain)
2. THE Settings_Page SHALL use the `useState` and `useEffect` hooks with the `fetch` API directly, consistent with the existing frontend patterns
3. THE Settings_Page SHALL function correctly when served by both the Vite dev server (with proxy) and the Vercel production deployment (with rewrites)

### Requirement 11: Future Extension Extraction

**User Story:** As a developer, I want the Settings page code structured for future extraction into the Chrome extension, so that the same UI can be reused in the extension's options page or overlay modal.

#### Acceptance Criteria

1. THE Settings_Page SHALL keep all settings-related state and API logic in a single file or co-located module, avoiding deep coupling to the React Router or app shell
2. THE Settings_Page SHALL not depend on any global state providers beyond what the component itself manages
3. THE Settings_Page SHALL use a data-fetching pattern (fetch with relative URLs) that can be swapped for Chrome storage + `sendToBackground` messaging in the future without restructuring the component hierarchy
