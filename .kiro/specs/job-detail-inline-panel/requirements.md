# Requirements Document

## Introduction

This feature replaces the current modal/overlay job detail view with an inline split-panel layout. When a user clicks a job in the job list, the detail view renders as a side panel within the page layout (list on the left, detail on the right) instead of appearing as a popup overlay. This provides a more seamless browsing experience where users can scan the list and read details without losing context.

## Glossary

- **Jobs_Page**: The main page component (`Jobs.tsx`) that renders the job dashboard including tabs, filters, job list, and job detail.
- **Job_List**: The scrollable list of job cards displayed on the left side of the split layout.
- **Detail_Panel**: The inline panel that displays full job information (description, match score, actions) on the right side of the layout when a job is selected.
- **AI_Tools_Sidebar**: A secondary sidebar within the Detail_Panel that provides AI-powered tools (resume tailoring, cover letter, fit analysis).
- **Split_Layout**: A horizontal two-column layout where the Job_List occupies the left portion and the Detail_Panel occupies the right portion of the available content area.
- **Selected_Job**: The job currently chosen by the user for detailed viewing.

## Requirements

### Requirement 1: Split Layout Structure

**User Story:** As a job seeker, I want the job detail to appear beside the job list in a split-view layout, so that I can browse jobs and read details without losing my place in the list.

#### Acceptance Criteria

1. WHEN a user selects a job from the Job_List, THE Jobs_Page SHALL render the Detail_Panel inline beside the Job_List in a Split_Layout.
2. WHILE a Selected_Job is active, THE Jobs_Page SHALL display the Job_List on the left and the Detail_Panel on the right within the same viewport.
3. THE Jobs_Page SHALL NOT render the Detail_Panel as a modal, overlay, or popup.
4. WHEN no job is selected, THE Jobs_Page SHALL display the Job_List at full width without the Detail_Panel.

### Requirement 2: Remove Modal/Overlay Behavior

**User Story:** As a job seeker, I want clicking a job to show details inline rather than in a popup, so that I have a smoother browsing experience without disruptive overlays.

#### Acceptance Criteria

1. WHEN a user clicks a job card, THE Jobs_Page SHALL transition from a single-column layout to the Split_Layout without displaying any overlay backdrop.
2. THE Jobs_Page SHALL remove the existing overlay container element (`job-detail-overlay`) and its click-to-dismiss backdrop behavior.
3. WHEN the Detail_Panel is visible, THE user SHALL still be able to scroll and interact with the Job_List independently.

### Requirement 3: Detail Panel Content

**User Story:** As a job seeker, I want the inline detail panel to show all the same job information as before, so that I do not lose any functionality with the new layout.

#### Acceptance Criteria

1. THE Detail_Panel SHALL display the close button, company logo, company name, time posted, job title, location, work type badges, and experience level.
2. THE Detail_Panel SHALL display action buttons including "Apply with Autofill" and "View Original Post".
3. THE Detail_Panel SHALL display the job description under an "Overview" section.
4. THE Detail_Panel SHALL display the match score breakdown (overall score, experience, skills, industry) when available.
5. WHEN the job has an applicant count greater than zero, THE Detail_Panel SHALL display the applicant count.
6. THE Detail_Panel SHALL include the AI_Tools_Sidebar with buttons for "Customize Your Resume", "Build Cover Letter", and "Analyze How Well You Fit".

### Requirement 4: Close Detail Panel

**User Story:** As a job seeker, I want to close the detail panel and return to the full-width job list, so that I can focus on browsing when I no longer need the detail view.

#### Acceptance Criteria

1. WHEN the user clicks the close button (X) in the Detail_Panel, THE Jobs_Page SHALL hide the Detail_Panel and return the Job_List to full-width layout.
2. WHEN the user clicks a different job card while the Detail_Panel is open, THE Detail_Panel SHALL update to show the newly selected job's details.

### Requirement 5: Responsive Layout Proportions

**User Story:** As a job seeker, I want the split layout to allocate space appropriately between the list and detail, so that both panels are usable without excessive scrolling.

#### Acceptance Criteria

1. WHILE the Detail_Panel is visible, THE Split_Layout SHALL allocate approximately 40% of the horizontal space to the Job_List and 60% to the Detail_Panel.
2. THE Detail_Panel SHALL be independently scrollable so that long job descriptions do not affect the Job_List scroll position.
3. THE Job_List SHALL be independently scrollable so that the user can browse other jobs while the Detail_Panel remains visible.

### Requirement 6: Visual Indication of Selected Job

**User Story:** As a job seeker, I want to see which job is currently selected in the list, so that I can maintain context about what I am viewing in the detail panel.

#### Acceptance Criteria

1. WHILE a job is displayed in the Detail_Panel, THE Job_List SHALL visually highlight the corresponding job card with a distinct selected state (e.g., border color or background change).
2. WHEN the user selects a different job, THE Job_List SHALL remove the highlight from the previously selected card and apply it to the newly selected card.

### Requirement 7: Keyboard Accessibility

**User Story:** As a job seeker using keyboard navigation, I want to be able to open and close the detail panel with keyboard controls, so that the feature is accessible without a mouse.

#### Acceptance Criteria

1. WHEN the Detail_Panel is open and the user presses the Escape key, THE Jobs_Page SHALL close the Detail_Panel and return focus to the previously selected job card in the Job_List.
2. THE close button in the Detail_Panel SHALL be focusable and activatable via keyboard (Enter or Space).
