# Implementation Plan: Settings Profile Page

## Overview

Replace the Settings page stub with a full Jobright-inspired profile editor. The implementation builds incrementally: CSS first, then the component skeleton, then data layer (fetch/save/upload), then wiring everything together. Property-based tests validate correctness properties from the design using fast-check.

## Tasks

- [x] 1. Create the settings CSS file with all styles
  - [x] 1.1 Create `frontend/src/settings.css` with section card styles, form grid, toggle switch, key-value editor, toast notification, save button, and responsive breakpoints
    - Section cards: white bg, `var(--radius)` border-radius, `1px solid var(--border)`, padding 1.25rem+
    - Section headers: icon + title, flex row, font-weight 600
    - Two-column grid for inputs (collapses at 768px)
    - Toggle switch: 36×20px track, 16px circle, `var(--accent)` active, `#d1d5db` inactive, 150ms transitions
    - Key-value editor rows: two inputs + remove button, add button pill-shaped
    - Toast: fixed position, slide-in animation, success (green) / error (red) variants
    - Save button: sticky bottom, pill-shaped, `var(--accent)` bg, disabled state
    - Responsive: single-column below 768px, max-width for readability on wide screens
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 9.1, 9.2, 9.3, 9.4_

- [x] 2. Implement the Settings component with all sections
  - [x] 2.1 Replace `frontend/src/pages/Settings.tsx` with the full component structure
    - Import `settings.css`
    - Define TypeScript interfaces: `SettingsData`, `PrefilledEntry`, `Toast`
    - Implement helper functions: `computeDiff`, `entriesToDict`, `dictToEntries`
    - Implement `ToggleSwitch` sub-component with label and description
    - Implement `KeyValueEditor` sub-component with add/remove/edit rows
    - Implement `Toast` notification component with auto-dismiss (3s)
    - Implement main `Settings` component with all five section cards:
      - Personal Info (2-col grid: first_name, last_name, email, phone, city, linkedin_url, website)
      - Job Preferences (job_title, location, remote_only toggle)
      - Pre-filled Answers (KeyValueEditor)
      - Resume (file name display + upload button)
      - Extension Settings (3 toggle switches)
    - Loading spinner and error message states
    - Save button with dirty indicator and loading state
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.5, 7.6, 8.5, 10.1, 10.2, 11.1, 11.2, 11.3_

  - [x] 2.2 Implement data fetching, save, and resume upload logic
    - `fetchSettings()`: GET /settings on mount, populate formData + originalData
    - `saveSettings()`: compute diff, PUT /settings with only changed fields, show toast
    - `uploadResume()`: POST /settings/resume with FormData, update file name, show toast
    - Dirty tracking via `useMemo` comparing originalData vs current formData + prefilledEntries
    - Disable save button while saving, re-enable on completion
    - All API calls use relative URLs (no hardcoded domains)
    - _Requirements: 1.1, 5.4, 5.5, 5.6, 7.2, 7.3, 7.4, 7.5, 10.1, 10.2, 10.3_

- [x] 3. Checkpoint - Verify component renders correctly
  - Ensure the app builds without errors (`npm run build` in frontend)
  - Ensure all five section cards render with correct headers and icons
  - Ensure the Settings page works within the existing app layout with sidebar visible
  - Ask the user if questions arise.

- [x] 4. Set up test framework (Vitest + React Testing Library + fast-check)
  - [x] 4.1 Install test dependencies and configure Vitest
    - Add devDependencies: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `fast-check`
    - Add `test` script to package.json: `"test": "vitest --run"`
    - Configure Vitest in `vite.config.ts` with jsdom environment and setup file
    - Create test setup file for `@testing-library/jest-dom` matchers
    - _Requirements: (testing infrastructure for all properties)_

- [ ] 5. Write property-based tests for correctness properties
  - [-] 5.1 Write property test: Data load round-trip
    - **Property 1: Data load round-trip**
    - Generate random valid SettingsData objects with fast-check arbitraries
    - Mock fetch to return generated data, render Settings, verify all form fields match
    - **Validates: Requirements 1.1, 2.4, 3.3, 6.4**

  - [~] 5.2 Write property test: Key-Value Editor faithfulness
    - **Property 2: Key-Value Editor faithfulness**
    - Generate random `prefilled_answers` dictionaries
    - Verify one row per entry renders, and editing a row updates component state
    - **Validates: Requirements 4.2, 4.5**

  - [~] 5.3 Write property test: Key-Value Editor add grows list
    - **Property 3: Key-Value Editor add grows list**
    - Generate random entry lists (including empty), click Add, verify count increases by 1
    - **Validates: Requirements 4.3**

  - [~] 5.4 Write property test: Key-Value Editor remove shrinks list
    - **Property 4: Key-Value Editor remove shrinks list**
    - Generate random non-empty entry lists, click Remove on random row, verify count decreases by 1
    - **Validates: Requirements 4.4**

  - [~] 5.5 Write property test: Resume file name display
    - **Property 5: Resume file name display**
    - Generate random non-empty file name strings, verify displayed in UI
    - **Validates: Requirements 5.3**

  - [~] 5.6 Write property test: Dirty diff correctness
    - **Property 6: Dirty diff correctness**
    - Generate random original state + random modifications, verify PUT payload contains exactly changed fields
    - **Validates: Requirements 7.2**

  - [~] 5.7 Write property test: Dirty indicator on modification
    - **Property 7: Dirty indicator on modification**
    - Generate random loaded state, modify one field, verify dirty indicator visible; revert, verify hidden
    - **Validates: Requirements 7.6**

- [ ] 6. Final checkpoint - Ensure all tests pass
  - Run `npm run test` in frontend directory
  - Ensure all property-based tests and unit tests pass
  - Ensure build still succeeds
  - Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The design specifies TypeScript/React, so all implementation uses that stack
- All settings logic is self-contained in a single file for future Chrome extension extraction
- CSS uses existing variables from `index.css` — no component library introduced
- Backend endpoints (GET/PUT /settings, POST /settings/resume) already exist
- Property tests use fast-check with minimum 100 iterations per property
- Checkpoints ensure incremental validation before moving to testing phase
