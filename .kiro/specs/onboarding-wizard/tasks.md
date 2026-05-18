# Implementation Plan: Onboarding Wizard

## Overview

Build a multi-step tooltip wizard that guides first-time users through the Tailrd extension's features on a demo Greenhouse-style job application page. Implementation follows three phases: (1) frontend demo page + wizard overlay, (2) extension background script wiring, (3) integration and polish. The wizard is entirely frontend-driven with localStorage persistence and works independently of the extension.

## Tasks

- [ ] 1. Create the DemoApply page with Greenhouse-style form
  - [x] 1.1 Create `frontend/src/pages/DemoApply.tsx` with the demo job application form
    - Render company header with Tailrd logo and job title "Software Engineer — Full Stack"
    - Add form fields: First Name, Last Name, Email, Phone, LinkedIn Profile, "Why are you a good fit for Tailrd?" textarea, Resume upload
    - Add a disabled Submit button
    - Assign id attributes to key elements for wizard targeting: `#autofill-btn`, `#demo-form-fields`, `#custom-question-textarea`, `#generate-resume-btn`, `#extension-popup-area`, `#autofill-info-section`, `#demo-submit-btn`
    - Style as a realistic Greenhouse-style ATS form using TailwindCSS/custom CSS
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 1.2 Register the `/demo-apply` route in `frontend/src/main.tsx`
    - Import DemoApply component
    - Add `<Route path="/demo-apply" element={<DemoApply />} />` outside the ProtectedRoute wrapper
    - Ensure no authentication is required
    - _Requirements: 14.1, 14.2_

- [ ] 2. Implement the OnboardingWizard component
  - [x] 2.1 Create `frontend/src/components/OnboardingWizard.tsx` with wizard state machine and step configuration
    - Define `WizardStep` and `WizardState` TypeScript interfaces
    - Define `WIZARD_STEPS` constant array (welcome + 8 numbered steps) with id, type, target, position, heading, description, buttonLabel, showBack
    - Define `DEMO_PROFILE` constant with sample autofill data
    - Define `STORAGE_KEY = "tailrd_wizard_step"` and `COMPLETION_FLAG = "onboarding_complete"`
    - Implement step state management with `useState` (currentStep, isComplete)
    - Implement `goNext()`, `goBack()`, `skipTutorial()`, `finishSetup()` functions
    - Implement localStorage persistence: save step on change, restore on mount, clear on completion
    - _Requirements: 3.1, 3.2, 3.3, 10.1, 10.2, 10.3, 10.4, 10.5, 12.1, 12.2, 12.3, 13.1, 13.2, 13.3_

  - [x] 2.2 Implement the WizardOverlay sub-component with cutout rendering
    - Render a full-viewport semi-transparent gray overlay (50% opacity)
    - Calculate target element bounding rect and render a cutout hole around it
    - Handle case where target element is not found (fall back to no cutout)
    - Recalculate position on window resize (debounced 100ms)
    - _Requirements: 11.1, 11.2_

  - [x] 2.3 Implement the WizardTooltip sub-component with positioning and navigation
    - Render white card with 12px rounded corners and drop shadow
    - Display triangular arrow pointing at target element based on position (top/bottom/left/right)
    - Display Step_Counter showing "{n+1}/8" for steps 0-7 (hidden on welcome step)
    - Render heading, description (with purple-highlighted inline markup), and navigation buttons
    - Purple accent color for highlighted text, "Back" link, and filled "Next" button
    - Calculate tooltip position relative to target element with `calculateTooltipPosition()`
    - For modal-type steps (welcome, supported platforms), center on screen without arrow
    - _Requirements: 11.3, 11.4, 11.5, 10.5_

  - [x] 2.4 Implement the demo autofill trigger and form interaction
    - `triggerDemoAutofill()`: fill form fields with DEMO_PROFILE data on step 1/8 entry
    - Use native value setter pattern to work with React controlled inputs
    - Retry autofill after 500ms if fields not rendered (max 3 retries)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 2.5 Implement wizard completion flow
    - `setCompletionFlag()`: try chrome.storage.local first, fall back to localStorage
    - `finishSetup()`: set flag, clear localStorage wizard state, redirect to /app
    - Implement WizardToast sub-component: "You're all set! Tailrd is ready to autofill your applications."
    - Toast auto-dismisses after 5 seconds
    - `skipTutorial()`: set flag, redirect to /app (no toast)
    - Render "Skip Tutorial" link in top-right corner on all steps
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 13.1, 13.2, 13.3_

- [x] 3. Checkpoint - Verify frontend wizard renders and navigates
  - Ensure `npm run build` succeeds in frontend directory
  - Ensure /demo-apply route loads the DemoApply page with form and wizard
  - Ensure wizard navigation (Next/Back/Skip) works through all 9 steps
  - Ask the user if questions arise.

- [ ] 4. Wire up extension background script for first-install detection
  - [x] 4.1 Create `extension/onboarding.ts` with install detection logic
    - Export `registerOnboardingListener()` function
    - Listen to `chrome.runtime.onInstalled` event
    - If reason !== "install", return early
    - Check `chrome.storage.local` for `onboarding_complete` flag
    - If not set, call `chrome.tabs.create({ url: "https://www.tailrd.ca/demo-apply" })`
    - If already set, do nothing
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 4.2 Modify `extension/background.ts` to import and call the onboarding listener
    - Add `import { registerOnboardingListener } from "./onboarding"`
    - Call `registerOnboardingListener()` after `registerMessageHandlers()`
    - _Requirements: 1.1_

- [x] 5. Checkpoint - Verify extension builds with onboarding handler
  - Ensure `npm run build` succeeds in extension directory (Plasmo build)
  - Verify onboarding.ts exports correctly and background.ts imports it
  - Ask the user if questions arise.

- [ ] 6. Write property-based tests for wizard correctness
  - [x] 6.1 Write property test: Navigation button visibility
    - **Property 1: Navigation button visibility**
    - Generate random step indices from -1 to 7 using `fc.integer({ min: -1, max: 7 })`
    - Verify "Next" button is displayed if and only if step is not 7 (final step 8/8)
    - Verify "Back" button is displayed if and only if step is not -1 (welcome) and not 0 (step 1/8)
    - Verify "Finish Setup" button appears only on step 7
    - **Validates: Requirements 10.1, 10.2**

  - [x] 6.2 Write property test: Navigation step correctness
    - **Property 2: Navigation step correctness**
    - Generate random step indices where Next is available (fc.integer({ min: -1, max: 6 }))
    - Simulate Next click, verify step increments by exactly 1
    - Generate random step indices where Back is available (fc.integer({ min: 1, max: 7 }))
    - Simulate Back click, verify step decrements by exactly 1
    - **Validates: Requirements 10.3, 10.4**

  - [x] 6.3 Write property test: Step counter accuracy
    - **Property 3: Step counter accuracy**
    - Generate random step indices in range [0, 7] using `fc.integer({ min: 0, max: 7 })`
    - Verify step counter displays text matching `"{index + 1}/8"`
    - Verify step counter is NOT displayed on welcome step (index -1)
    - **Validates: Requirements 10.5**

  - [x] 6.4 Write property test: Wizard state persistence round-trip
    - **Property 4: Wizard state persistence round-trip**
    - Generate random valid step numbers using `fc.integer({ min: -1, max: 7 })`
    - Set localStorage `tailrd_wizard_step` to generated value
    - Mount OnboardingWizard component
    - Verify wizard resumes at the persisted step
    - Advance to a new step, verify localStorage is updated to new value
    - **Validates: Requirements 12.1, 12.2**

  - [x] 6.5 Write property test: Skip Tutorial availability
    - **Property 5: Skip Tutorial availability**
    - Generate random step indices from -1 to 7 using `fc.integer({ min: -1, max: 7 })`
    - Mount wizard at each generated step
    - Verify "Skip Tutorial" link is present and visible in the DOM
    - **Validates: Requirements 13.1**

- [x] 7. Final checkpoint - Ensure all tests pass and builds succeed
  - Run `npm run test` in frontend directory
  - Ensure all property-based tests pass (minimum 100 iterations each)
  - Ensure frontend build succeeds
  - Ensure extension build succeeds
  - Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The design specifies TypeScript/React with Vitest + fast-check for PBT
- The wizard works independently of the extension (for marketing/demo use)
- localStorage handles wizard step persistence; chrome.storage.local handles the completion flag
- Phase 3 polish (animations, confetti, analytics) is out of scope for this implementation plan
- Each property test should use minimum 100 iterations per fast-check property
- Checkpoints ensure incremental validation between phases
