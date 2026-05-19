# Requirements Document

## Introduction

This document defines the requirements for the Tailrd Chrome Extension Onboarding Wizard. When a first-time user installs the extension, the system automatically opens a demo Greenhouse-style job application page and guides the user through the extension's features using a step-by-step tooltip wizard. The wizard covers autofill, custom question saving, AI resume tailoring, supported ATS platforms, and profile copy-to-clipboard functionality.

## Glossary

- **Extension**: The Tailrd Chrome Extension built with the Plasmo framework (Chrome MV3)
- **Background_Script**: The extension service worker (background.ts) that handles lifecycle events
- **Content_Script**: The extension script injected into matching web pages to interact with DOM elements
- **Demo_Page**: A fake Greenhouse-style job application form hosted at /demo-apply on the Tailrd frontend
- **Wizard**: The step-by-step tooltip overlay component that guides users through extension features
- **Tooltip**: A white card popup with an arrow pointing at a specific UI element
- **Overlay**: A semi-transparent gray background (50% opacity) displayed behind the active tooltip
- **Cutout**: A highlighted region in the overlay that exposes the target UI element
- **Step_Counter**: A label showing current progress (e.g., "3/8") displayed in the tooltip
- **Onboarding_Flag**: The `onboarding_complete` boolean stored in chrome.storage.local
- **Dashboard**: The main Tailrd application page at /app
- **ATS**: Applicant Tracking System (e.g., Workday, Lever, Greenhouse)

## Requirements

### Requirement 1: Extension Install Detection

**User Story:** As a first-time user, I want the extension to detect when it is freshly installed, so that I am automatically guided through the onboarding experience.

#### Acceptance Criteria

1. WHEN the chrome.runtime.onInstalled event fires with reason "install", THE Background_Script SHALL check chrome.storage.local for the Onboarding_Flag
2. WHEN the Onboarding_Flag is not set, THE Background_Script SHALL open https://www.tailrd.ca/demo-apply in a new browser tab
3. WHEN the Onboarding_Flag is already set to true, THE Background_Script SHALL not open the Demo_Page
4. WHEN the chrome.runtime.onInstalled event fires with reason "update", THE Background_Script SHALL not open the Demo_Page

### Requirement 2: Demo Application Page

**User Story:** As a first-time user, I want to see a realistic job application form, so that I can understand how the extension works in a real-world context.

#### Acceptance Criteria

1. THE Demo_Page SHALL display a Greenhouse-style job application form with company name "Tailrd", company logo, and job title "Software Engineer — Full Stack"
2. THE Demo_Page SHALL include input fields for First Name, Last Name, Email, Phone, LinkedIn Profile, a "Why are you a good fit for Tailrd?" textarea, and a Resume upload field
3. THE Demo_Page SHALL display a Submit button in a disabled state
4. THE Demo_Page SHALL be accessible at the /demo-apply route without requiring user authentication
5. THE Demo_Page SHALL load the Wizard component when the page renders
6. THE Demo_Page SHALL be accessible to visitors regardless of whether the Extension is installed

### Requirement 3: Wizard Welcome Step

**User Story:** As a first-time user, I want to see a welcome message when the wizard starts, so that I understand what the onboarding will cover.

#### Acceptance Criteria

1. WHEN the Demo_Page loads and the Wizard initializes, THE Wizard SHALL display a centered modal overlay with the heading "Welcome to Tailrd" and description text explaining autofill functionality
2. THE Wizard SHALL display a "Get Started" button on the welcome modal
3. WHEN the user clicks "Get Started", THE Wizard SHALL advance to step 1 of 8

### Requirement 4: Autofill Demonstration

**User Story:** As a first-time user, I want to see the autofill feature in action, so that I understand how the extension fills job application forms.

#### Acceptance Criteria

1. WHEN the Wizard advances to step 1/8, THE Wizard SHALL display a Tooltip pointing at the Autofill button element
2. WHEN step 1/8 is displayed, THE Wizard SHALL auto-trigger the autofill action on the Demo_Page form using sample profile data
3. THE Wizard SHALL fill the Demo_Page form fields with predefined sample data including first name, last name, email, phone, location, LinkedIn URL, and a generated response for the custom question
4. WHEN the Wizard advances to step 2/8, THE Wizard SHALL display a Tooltip pointing at the filled form fields explaining that the application was filled from the user's Tailrd profile

### Requirement 5: Custom Question Explanation

**User Story:** As a first-time user, I want to understand how custom question answers are saved, so that I know my answers will be reused in future applications.

#### Acceptance Criteria

1. WHEN the Wizard advances to step 3/8, THE Wizard SHALL display a Tooltip pointing at the "Why are you a good fit?" textarea
2. THE Tooltip at step 3/8 SHALL explain that custom application answers are saved and reused for future applications with the same question

### Requirement 6: Resume Tailoring Explanation

**User Story:** As a first-time user, I want to learn about AI resume tailoring, so that I know how to optimize my resume for each job.

#### Acceptance Criteria

1. WHEN the Wizard advances to step 4/8, THE Wizard SHALL display a Tooltip pointing at the "Generate Custom Resume" button
2. THE Tooltip at step 4/8 SHALL explain that the AI analyzes job descriptions and optimizes the resume to match keywords and requirements
3. WHEN the Wizard advances to step 5/8, THE Wizard SHALL display a Tooltip pointing at the extension popup area explaining AI-generated resumes and cover letters

### Requirement 7: Supported Platforms Information

**User Story:** As a first-time user, I want to know which job platforms are supported, so that I understand where I can use the extension.

#### Acceptance Criteria

1. WHEN the Wizard advances to step 6/8, THE Wizard SHALL display a centered Tooltip without a pointer arrow
2. THE Tooltip at step 6/8 SHALL list supported ATS platforms including Workday, Lever, and Greenhouse
3. THE Tooltip at step 6/8 SHALL explain that unsupported platforms still allow access to profile information for reference

### Requirement 8: Profile Copy-to-Clipboard

**User Story:** As a first-time user, I want to learn about the click-to-copy feature, so that I can quickly paste my information into any application.

#### Acceptance Criteria

1. WHEN the Wizard advances to step 7/8, THE Wizard SHALL display a Tooltip pointing at the "Your Autofill Information" section
2. THE Tooltip at step 7/8 SHALL explain that clicking on any profile text copies it directly to the clipboard

### Requirement 9: Wizard Completion

**User Story:** As a first-time user, I want to finish the onboarding and start using the extension, so that I can begin applying to jobs.

#### Acceptance Criteria

1. WHEN the Wizard advances to step 8/8, THE Wizard SHALL display a Tooltip pointing at the Submit button with a "Finish Setup" button
2. WHEN the user clicks "Finish Setup", THE Wizard SHALL set the Onboarding_Flag to true in chrome.storage.local
3. WHEN the user clicks "Finish Setup", THE Wizard SHALL redirect the browser to the Dashboard at /app
4. WHEN the redirect to the Dashboard completes, THE Wizard SHALL display a toast notification with the message "You're all set! Tailrd is ready to autofill your applications."

### Requirement 10: Wizard Navigation

**User Story:** As a first-time user, I want to navigate back and forth between wizard steps, so that I can review information at my own pace.

#### Acceptance Criteria

1. THE Wizard SHALL display a "Next" button on every step except the final step (8/8)
2. THE Wizard SHALL display a "Back" button on every step except the welcome step and step 1/8
3. WHEN the user clicks "Next", THE Wizard SHALL advance to the next sequential step
4. WHEN the user clicks "Back", THE Wizard SHALL return to the previous sequential step
5. THE Wizard SHALL display a Step_Counter showing the current step number out of 8 total steps on each step (excluding the welcome step)

### Requirement 11: Wizard Visual Overlay

**User Story:** As a first-time user, I want the wizard to highlight relevant UI elements, so that I can clearly see which part of the interface is being explained.

#### Acceptance Criteria

1. WHILE a Wizard step is active, THE Overlay SHALL display a semi-transparent gray background at 50% opacity covering the entire viewport
2. WHILE a Wizard step targets a specific element, THE Overlay SHALL render a Cutout around the target element making it visually prominent
3. THE Tooltip SHALL display as a white card with 12px rounded corners and a drop shadow
4. WHILE a Wizard step targets a specific element, THE Tooltip SHALL display a triangular arrow pointing at the target element
5. THE Tooltip SHALL use purple accent color for highlighted text, a purple "Back" link, and a purple filled "Next" button with rounded corners

### Requirement 12: Wizard State Persistence

**User Story:** As a user who closed the tab mid-wizard, I want to resume where I left off, so that I do not have to restart the onboarding.

#### Acceptance Criteria

1. WHEN the Wizard advances to a new step, THE Wizard SHALL persist the current step number to browser storage
2. WHEN the Demo_Page loads and a persisted wizard step exists, THE Wizard SHALL resume from the persisted step
3. WHEN the user completes the Wizard, THE Wizard SHALL clear the persisted step data from browser storage

### Requirement 13: Skip Tutorial Option

**User Story:** As a power user, I want to skip the onboarding tutorial, so that I can start using the extension immediately without going through all steps.

#### Acceptance Criteria

1. THE Wizard SHALL display a "Skip Tutorial" link in the top-right corner of the viewport during all wizard steps
2. WHEN the user clicks "Skip Tutorial", THE Wizard SHALL set the Onboarding_Flag to true in chrome.storage.local
3. WHEN the user clicks "Skip Tutorial", THE Wizard SHALL redirect the browser to the Dashboard at /app

### Requirement 14: Frontend Route Registration

**User Story:** As a developer, I want the /demo-apply route registered in the frontend router, so that the Demo_Page is accessible via URL navigation.

#### Acceptance Criteria

1. THE Frontend SHALL register a /demo-apply route in the application router that renders the Demo_Page component
2. THE /demo-apply route SHALL not require authentication or a protected route wrapper
