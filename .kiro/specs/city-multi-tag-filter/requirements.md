# Requirements Document

## Introduction

Transform the existing single-text city filter in the job filter bar into a multi-tag input. Users can type a city name, press Enter, and have it added as a removable tag (pill with × button). Multiple cities can be selected simultaneously, and the filter shows jobs matching ANY of the selected cities using OR logic. This change spans the frontend filter component, the Jobs page API integration, the backend query logic, and localStorage persistence.

## Glossary

- **Filter_Bar**: The `JobFilterBar` React component that renders dropdown filter pills for Country, Job Function, Experience Level, Work Model, and Date Posted.
- **City_Tag_Input**: The multi-tag input widget within the Country dropdown that allows users to type city names and add them as removable pill tags.
- **City_Tag**: A visual pill element displaying a city name with a × button to remove it from the active filter list.
- **Jobs_Page**: The `Jobs.tsx` page component that manages filter state, fetches jobs from the API, and renders the job feed.
- **Jobs_API**: The FastAPI `GET /jobs` endpoint that accepts filter parameters and returns matching job listings.
- **Filter_State**: The `JobFilters` interface object containing all active filter values, persisted in localStorage.
- **OR_Logic**: Filtering behavior where a job matches if its location contains ANY one of the selected city values.

## Requirements

### Requirement 1: Multi-Tag City Input

**User Story:** As a job seeker, I want to add multiple city names as tags in the filter bar, so that I can search for jobs across several cities at once.

#### Acceptance Criteria

1. WHEN a user types a city name into the City_Tag_Input and presses Enter, THE Filter_Bar SHALL add the typed text as a new City_Tag and clear the input field.
2. WHEN a user clicks the × button on a City_Tag, THE Filter_Bar SHALL remove that city from the list of selected cities.
3. THE Filter_Bar SHALL display all selected cities as pill-shaped City_Tag elements within the Country dropdown.
4. WHEN a user presses Enter with an empty input field, THE Filter_Bar SHALL not add a blank City_Tag.
5. WHEN a user types a city name that already exists in the selected list, THE Filter_Bar SHALL not add a duplicate City_Tag.
6. THE City_Tag_Input SHALL trim leading and trailing whitespace from the city name before adding it as a tag.

### Requirement 2: Filter State Data Model Change

**User Story:** As a developer, I want the location filter to store an array of city strings instead of a single string, so that the multi-tag input state is correctly represented.

#### Acceptance Criteria

1. THE Filter_State SHALL store the location field as a string array (`string[]`) instead of a single string.
2. WHEN the Filter_State location array is empty, THE Filter_Bar SHALL display no City_Tag elements and apply no city-based filtering.
3. THE Filter_Bar SHALL initialize the temporary location state as an empty array when no prior filter values exist.

### Requirement 3: API Parameter Serialization

**User Story:** As a developer, I want the Jobs page to serialize the city array into a comma-separated string for the API request, so that the backend can parse multiple city values.

#### Acceptance Criteria

1. WHEN the location array contains one or more cities, THE Jobs_Page SHALL pass the location parameter to the Jobs_API as a comma-separated string (e.g., "Ottawa,Toronto,Vancouver").
2. WHEN the location array is empty, THE Jobs_Page SHALL not include the location parameter in the API request.
3. THE Jobs_Page SHALL not include empty strings or whitespace-only values in the comma-separated location parameter.

### Requirement 4: Backend OR-Logic Filtering

**User Story:** As a job seeker, I want the job listing to show jobs from ANY of my selected cities, so that I can browse opportunities across multiple locations simultaneously.

#### Acceptance Criteria

1. WHEN the Jobs_API receives a location parameter with comma-separated values, THE Jobs_API SHALL split the parameter into individual city values.
2. WHEN multiple city values are provided, THE Jobs_API SHALL return jobs where the location field matches ANY of the provided city values using substring matching (OR logic).
3. WHEN a single city value is provided, THE Jobs_API SHALL filter jobs where the location field contains that city value as a substring (preserving existing behavior).
4. THE Jobs_API SHALL perform case-insensitive substring matching for each city value against the job location field.
5. THE Jobs_API SHALL trim whitespace from each city value before performing the match.

### Requirement 5: LocalStorage Persistence

**User Story:** As a job seeker, I want my selected city tags to persist across page reloads, so that I don't have to re-enter my preferred cities every time I visit the dashboard.

#### Acceptance Criteria

1. WHEN the Filter_State changes, THE Jobs_Page SHALL persist the location array to localStorage as part of the serialized filter object.
2. WHEN the Jobs_Page loads, THE Jobs_Page SHALL restore the location field from localStorage as a string array.
3. IF localStorage contains a legacy single-string location value, THEN THE Jobs_Page SHALL migrate it to a single-element array for backward compatibility.
4. IF localStorage contains invalid or corrupted data for the location field, THEN THE Jobs_Page SHALL default to an empty array.

### Requirement 6: Visual Styling Consistency

**User Story:** As a user, I want the city tags to match the existing lavender theme of the application, so that the UI feels cohesive.

#### Acceptance Criteria

1. THE City_Tag SHALL display with a background color of #F0EEFF, a border color of #D3D3FF (company brand color), and text color of #374151.
2. THE City_Tag × button SHALL use the company brand color #D3D3FF or a darker contrast variant for visibility.
3. THE City_Tag SHALL have a pill shape (border-radius 999px) consistent with other filter elements in the Filter_Bar.
4. THE City_Tag_Input SHALL retain the existing search input styling (8px 12px padding, 8px border-radius, #D3D3FF border).

### Requirement 7: Keyboard Accessibility

**User Story:** As a user who navigates with a keyboard, I want to be able to add and remove city tags without using a mouse, so that the filter is accessible.

#### Acceptance Criteria

1. WHEN the City_Tag_Input is focused and the user presses Enter, THE Filter_Bar SHALL add the current input text as a City_Tag.
2. WHEN the City_Tag_Input is focused, contains no text, and the user presses Backspace, THE Filter_Bar SHALL remove the last City_Tag from the list.
3. THE City_Tag × button SHALL be focusable and activatable via keyboard (Enter or Space key).
