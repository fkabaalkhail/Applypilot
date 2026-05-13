# Implementation Plan: Job Detail Inline Panel

## Overview

Transform the job detail view from a fixed-position modal overlay into an inline split-panel layout. The implementation follows an incremental approach: layout structure first, then behavior/interaction, then visual polish, and finally tests. All changes are in the frontend (React + TypeScript) with no backend modifications needed.

## Tasks

- [x] 1. Create the split-layout container structure in Jobs.tsx
  - [x] 1.1 Wrap the `jobs-feed` and detail panel in a new `jobs-content-area` flex container
    - Add a wrapper div with class `jobs-content-area` around the job list and detail panel area
    - Apply `has-detail` class conditionally when `selectedJob` is non-null
    - The container should be a flex row with `flex: 1` and `overflow: hidden`
    - _Requirements: 1.1, 1.2, 1.4, 5.1_

  - [x] 1.2 Remove the overlay/modal pattern from Jobs.tsx
    - Delete the `job-detail-overlay` wrapper div and its click-to-dismiss `onClick` handler
    - Delete the `job-detail-panel` inner wrapper with `stopPropagation`
    - Replace with a `job-detail-inline` div that renders `JobDetailView` as a sibling of `jobs-feed`
    - Ensure the inline panel only renders when `selectedJob` is non-null
    - _Requirements: 2.1, 2.2_

  - [x] 1.3 Add CSS for the split-layout and inline detail panel
    - Add `.jobs-content-area` styles: `display: flex`, `flex: 1`, `overflow: hidden`
    - Add `.jobs-content-area.has-detail .jobs-feed` styles: `width: 40%`, `overflow-y: auto`
    - Add `.jobs-content-area .jobs-feed` default: `width: 100%`, `overflow-y: auto`
    - Add `.job-detail-inline` styles: `width: 60%`, `overflow-y: auto`, `border-left`
    - Ensure both panels have independent scrolling with constrained heights
    - _Requirements: 5.1, 5.2, 5.3, 2.3_

- [x] 2. Implement selected job card highlighting
  - [x] 2.1 Pass selection state to job cards and apply selected class
    - Compare each job card's `job.id` against `selectedJob?.id`
    - Add `selected` CSS class to the job card div when it matches
    - Ensure only one card has the `selected` class at any time
    - _Requirements: 6.1, 6.2_

  - [x] 2.2 Add CSS for the selected job card state
    - Add `.job-card.selected` styles with a distinct border color or background highlight
    - Ensure the selected state is visually distinct from hover state
    - _Requirements: 6.1_

- [x] 3. Implement keyboard support and focus management
  - [x] 3.1 Add Escape key listener to close the detail panel
    - Add a `useEffect` with a `keydown` event listener for the Escape key
    - When Escape is pressed and `selectedJob` is non-null, call `setSelectedJob(null)`
    - Clean up the event listener on unmount
    - _Requirements: 7.1_

  - [x] 3.2 Implement focus restoration on panel close
    - When the detail panel closes (via Escape or close button), return focus to the job list area
    - Ensure the close button in `JobDetailView` remains a focusable `<button>` with `aria-label`
    - _Requirements: 7.1, 7.2_

- [x] 4. Handle edge cases for job selection
  - [x] 4.1 Auto-close detail panel when selected job is filtered out
    - Add a `useEffect` that checks if `selectedJob` is still present in `filteredJobs`
    - If the selected job is no longer in the filtered list, call `setSelectedJob(null)`
    - _Requirements: 1.4, 4.1_

  - [x] 4.2 Ensure job switching updates the detail panel correctly
    - Verify that clicking a different job card while the panel is open updates `selectedJob`
    - The `JobDetailView` component already re-renders on `job.id` change via its `useEffect`
    - _Requirements: 4.2_

- [x] 5. Checkpoint - Verify layout and interactions
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Write property-based and unit tests
  - [x] 6.1 Write property test: Inline rendering without overlay
    - **Property 1: Inline rendering without overlay**
    - **Validates: Requirements 1.1, 1.3, 2.1, 2.2**
    - Generate random job objects with fast-check, render Jobs page with selectedJob set, assert no `job-detail-overlay` element exists and detail panel is an inline sibling of the job list

  - [x] 6.2 Write property test: Detail panel content completeness
    - **Property 2: Detail panel content completeness**
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5**
    - Generate jobs with populated fields, render JobDetailView, assert title, company, location, work type, description, match score, and applicant count are present

  - [x] 6.3 Write property test: Close button removes detail panel
    - **Property 3: Close button removes detail panel**
    - **Validates: Requirements 4.1**
    - For any selected job, simulate close action, assert detail panel is removed and `has-detail` class is gone

  - [x] 6.4 Write property test: Job switching updates detail content
    - **Property 4: Job switching updates detail content**
    - **Validates: Requirements 4.2**
    - Generate two distinct jobs, select job A then job B, assert detail panel shows job B's title and company

  - [x] 6.5 Write property test: Selection highlight exclusivity
    - **Property 5: Selection highlight exclusivity**
    - **Validates: Requirements 6.1, 6.2**
    - Generate a list of jobs and a selected job, assert exactly one card has `selected` class matching the selected job's ID

  - [x] 6.6 Write property test: Escape key closes panel
    - **Property 6: Escape key closes panel and restores focus**
    - **Validates: Requirements 7.1**
    - For any selected job, dispatch Escape keydown event, assert detail panel is removed from DOM

  - [x] 6.7 Write unit tests for layout and accessibility
    - Test default state renders full-width list without detail panel (Req 1.4)
    - Test split layout applies ~40%/60% width classes (Req 5.1)
    - Test both panels have independent scroll (Req 5.2, 5.3)
    - Test close button is focusable with aria-label (Req 7.2)
    - Test no `job-detail-overlay` element exists (Req 2.2)
    - Test "Apply with Autofill" and "View Original Post" buttons render (Req 3.2)
    - Test AI Tools Sidebar renders all three tool buttons (Req 3.6)

- [x] 7. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The feature is purely a layout/presentation change — no backend or data model modifications needed
- The existing `selectedJob` state and `JobDetailView` component are reused as-is
- Property tests use `fast-check` (already installed) with Vitest
- Test files: `frontend/src/__tests__/job-detail-inline-panel.property.test.tsx` and `frontend/src/__tests__/job-detail-inline-panel.test.tsx`
