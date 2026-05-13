# Tasks: City Multi-Tag Filter

## Task 1: Update JobFilters interface and data model

- [x] 1.1 Change `location` field in `JobFilters` interface from `string` to `string[]` in `frontend/src/components/JobFilterBar.tsx`
- [x] 1.2 Update `tempLocation` state in `JobFilterBar` from `string` to `string[]` (rename to `tempLocationTags`) and add `locationInput` string state for the text input
- [x] 1.3 Update `confirmCountry` handler to pass `location: tempLocationTags` (array) instead of single string
- [x] 1.4 Update `resetCountry` handler to reset `tempLocationTags` to `[]` and `locationInput` to `""`
- [x] 1.5 Update `useEffect` sync to set `tempLocationTags` from `filters.location` (array)

## Task 2: Implement multi-tag input UI in JobFilterBar

- [x] 2.1 Create `addCityTag` function that trims input, validates non-empty, checks no duplicate, and appends to `tempLocationTags`
- [x] 2.2 Create `removeCityTag` function that filters out the specified city from `tempLocationTags`
- [x] 2.3 Create `handleLocationKeyDown` handler: Enter calls `addCityTag`, Backspace on empty input removes last tag
- [x] 2.4 Replace the single text input in the Country dropdown with a multi-tag input area: render `tempLocationTags` as pill elements with × buttons, followed by the text input
- [x] 2.5 Style city tags with pill shape (border-radius 999px, background #F0EEFF, border #D3D3FF, text #374151) and × button with brand color
- [x] 2.6 Update `countryActive` badge logic to check `filters.location.length > 0` instead of truthy string

## Task 3: Update Jobs.tsx state management and localStorage

- [x] 3.1 Update `aggFilters` initialization in `Jobs.tsx` to handle `location` as `string[]` with migration from legacy string format
- [x] 3.2 Update the `fetchJobs` function to serialize `aggFilters.location` as comma-separated string (filtering empty/whitespace values) for the API `location` parameter
- [x] 3.3 Remove the old `filters.location` single-string parameter from `fetchJobs` to avoid conflict with the new array-based `aggFilters.location`

## Task 4: Update backend location filter to support OR logic

- [x] 4.1 Modify the `location` filter in `backend/routers/jobs.py` `list_jobs` endpoint to split comma-separated values, trim each, and apply OR logic using `sqlalchemy.or_` with `ilike` per city value
- [x] 4.2 Ensure single city value still works correctly (backward compatible — single element after split)

## Task 5: Write property-based tests (frontend)

- [x] 5.1 Create `frontend/src/__tests__/cityTagFilter.property.test.tsx` with Property 1 test: adding a valid city tag grows the list with trimmed value (fast-check, 100 runs)
- [x] 5.2 Add Property 2 test: invalid inputs (empty, whitespace-only, duplicates) are rejected without modifying the tag list
- [x] 5.3 Add Property 3 test: removing a city tag preserves all other tags in order
- [x] 5.4 Add Property 4 test: Backspace on empty input removes only the last tag
- [x] 5.5 Add Property 5 test: serialization produces valid comma-separated string excluding invalid values
- [x] 5.6 Add Property 7 test: location array round-trips through localStorage with migration from legacy string and corrupted data handling

## Task 6: Write property-based test (backend)

- [x] 6.1 Create `backend/tests/test_city_filter_properties.py` with Property 6 test: OR-logic filter returns exactly matching jobs for any set of jobs and city filter values (Hypothesis, 100 examples)

## Task 7: Keyboard accessibility

- [x] 7.1 Ensure × button on each city tag has `tabIndex={0}`, `role="button"`, and `aria-label` for screen readers
- [x] 7.2 Ensure × button responds to Enter and Space key presses (onKeyDown handler)
- [x] 7.3 Add `aria-label` to the city tag input field describing its purpose
