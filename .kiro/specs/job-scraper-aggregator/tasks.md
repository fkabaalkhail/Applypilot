# Implementation Plan: Job Scraper Aggregator

## Overview

This plan implements a multi-repository job aggregation system that scrapes 9 jobright-ai GitHub repositories, classifies jobs by country/work type/role category, deduplicates by URL, and provides rich API filtering with a frontend filter bar. Implementation builds incrementally on the existing `GitHubScraper`, `GitHubSource`, and `ScrapedJob` models.

## Tasks

- [ ] 1. Update data models with new fields
  - [x] 1.1 Add new fields to ScrapedJob model
    - Add `work_type` (String, default "onsite"), `role_category` (String, default ""), `country` (String, default ""), `experience_level` (String, default "") columns to `ScrapedJob` in `backend/db/models.py`
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [x] 1.2 Add new fields to GitHubSource model
    - Add `role_category` (String, default "") and `experience_level` (String, default "") columns to `GitHubSource` in `backend/db/models.py`
    - _Requirements: 1.4, 1.6_
  - [x] 1.3 Create Alembic migration or update table creation
    - Ensure new columns are reflected in the database schema (add migration script or update `Base.metadata.create_all` usage)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 2. Implement Country Filter service
  - [x] 2.1 Create `backend/services/country_filter.py`
    - Implement `CountryFilter` class with `classify(location: str) -> Optional[str]` method
    - Include US state abbreviations set, US state full names set, CA province abbreviations set, CA province names set
    - Implement `_is_usa()` and `_is_canada()` helper methods
    - Handle "Remote" without country indicator as USA (default)
    - Return `None` for non-US/CA locations
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [x] 2.2 Write property test for Country Classification (Property 5)
    - **Property 5: Country Classification Correctness**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.5**
    - Create `backend/tests/test_country_filter_properties.py`
    - Use Hypothesis to generate location strings with US/CA/other indicators and verify correct classification

- [ ] 3. Implement Work Type Classifier service
  - [x] 3.1 Create `backend/services/work_type_classifier.py`
    - Implement `WorkTypeClassifier` class with `classify(location: str) -> str` method
    - Define `REMOTE_INDICATORS`, `HYBRID_INDICATORS`, `ONSITE_INDICATORS` lists
    - Handle "Remote in <location>" as "remote"
    - Default to "onsite" when no indicator found
    - Priority order for ambiguous cases: Remote > Hybrid > On Site
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 3.2 Write property test for Work Type Classification (Property 6)
    - **Property 6: Work Type Classification Correctness**
    - **Validates: Requirements 4.1, 4.2, 4.4**
    - Create `backend/tests/test_work_type_properties.py`
    - Use Hypothesis to generate location strings with work type indicators and verify correct classification

- [ ] 4. Implement Enhanced Markdown Parser service
  - [x] 4.1 Create `backend/services/markdown_parser.py`
    - Implement `MarkdownParser` class with `parse(content: str, is_mega_repo: bool = False) -> list[ParsedJob]` method
    - Implement `parse_markdown_table()` for single table parsing
    - Implement `_detect_section_headers()` for mega-repo section header detection
    - Implement `_handle_continuation_row()` for ↳ symbol handling (inherit company from previous row)
    - Implement `_extract_markdown_link()` for `[text](url)` extraction
    - Implement `_extract_image_url()` for `![alt](url)` company logo extraction
    - Implement `format_job_to_row()` for round-trip testing
    - Handle column order independence via keyword-based header detection
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - [x] 4.2 Write property test for Markdown Table Parsing Round-Trip (Property 1)
    - **Property 1: Markdown Table Parsing Round-Trip**
    - **Validates: Requirements 2.9**
    - Create `backend/tests/test_markdown_parser_properties.py`
    - Use Hypothesis to generate valid ParsedJob records, format to markdown row, parse back, and verify equivalence
  - [x] 4.3 Write property test for Continuation Row Company Inheritance (Property 2)
    - **Property 2: Continuation Row Company Inheritance**
    - **Validates: Requirements 2.2**
    - Use Hypothesis to generate markdown tables with ↳ rows and verify company inheritance
  - [x] 4.4 Write property test for Column Order Independence (Property 3)
    - **Property 3: Column Order Independence**
    - **Validates: Requirements 2.7**
    - Use Hypothesis to generate tables with shuffled column orders and verify same parsed results
  - [x] 4.5 Write property test for Section Header Category Assignment (Property 4)
    - **Property 4: Section Header Category Assignment**
    - **Validates: Requirements 1.5, 2.8**
    - Use Hypothesis to generate markdown with section headers and job tables, verify category assignment

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Aggregator Service
  - [x] 6.1 Create `backend/services/aggregator.py`
    - Implement `AggregatorService` class with `REPOS` seed configuration for all 9 repos
    - Define `REPO_CATEGORY_MAP` mapping repo names to role categories
    - Implement `seed_sources()` method — idempotent creation of 9 GitHubSource records with role_category and experience_level
    - Implement `poll_source()` method — check commit SHA → fetch README → parse → classify (country, work_type) → deduplicate → store
    - Implement `poll_all_sources()` method — iterate all active sources
    - Implement `_check_commit_sha()` using GitHub API to compare stored vs current SHA
    - Implement `_get_experience_level()` returning "internship" or "new_grad" based on repo name
    - Integrate `CountryFilter`, `WorkTypeClassifier`, and `MarkdownParser` services
    - Exclude jobs where `CountryFilter.classify()` returns None
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 5.1, 6.1, 6.2, 6.3, 6.4, 6.5, 7.2, 7.3, 7.4, 7.5, 8.5_
  - [x] 6.2 Write property test for URL Uniqueness Invariant (Property 7)
    - **Property 7: URL Uniqueness Invariant (Deduplication)**
    - **Validates: Requirements 6.1, 6.2, 6.4**
    - Create `backend/tests/test_deduplication_properties.py` (or extend existing)
    - Use Hypothesis to generate sequences of jobs with overlapping URLs and verify at most one record per URL
  - [x] 6.3 Write property test for Seed Idempotence (Property 10)
    - **Property 10: Seed Idempotence**
    - **Validates: Requirements 11.2**
    - Create `backend/tests/test_aggregator_properties.py`
    - Use Hypothesis to generate random invocation counts and verify exactly 9 GitHubSource records after any number of seed calls

- [ ] 7. Update API endpoints
  - [x] 7.1 Add seed endpoint to `backend/routers/github_sources.py`
    - Implement `POST /github-sources/seed` endpoint that calls `AggregatorService.seed_sources()`
    - Return counts of created vs already-existing sources
    - Update `vercel.json` rewrites if needed
    - _Requirements: 11.1, 11.2, 11.3, 11.4_
  - [x] 7.2 Enhance `GET /jobs` endpoint with new filter parameters
    - Add `country`, `work_type`, `role_category`, `experience_level` query parameters to `list_jobs()` in `backend/routers/jobs.py`
    - Implement comma-separated value support for multi-value filters
    - Apply AND logic across different filter types
    - Change default sort to `posted_date` descending (newest first)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7_
  - [x] 7.3 Enhance `GET /jobs/stats` endpoint with breakdowns
    - Add `by_country`, `by_work_type`, `by_role_category`, `by_experience_level` breakdown counts to stats response
    - _Requirements: 9.6_
  - [x] 7.4 Write property test for API Filter AND Composition (Property 8)
    - **Property 8: API Filter AND Composition**
    - **Validates: Requirements 9.5**
    - Create `backend/tests/test_api_filter_properties.py`
    - Use Hypothesis to generate filter combinations and verify all returned jobs satisfy ALL filter conditions
  - [x] 7.5 Write property test for API Sort Order Invariant (Property 9)
    - **Property 9: API Sort Order Invariant**
    - **Validates: Requirements 9.7**
    - Verify posted_date descending order for all returned results

- [x] 8. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement Frontend Filter Bar
  - [x] 9.1 Create `frontend/src/components/JobFilterBar.tsx`
    - Implement `JobFilterBar` component with props `{ filters, onChange }`
    - Add Country toggle/dropdown: "All", "USA", "Canada"
    - Add Work Type multi-select: "Remote", "Hybrid", "On Site"
    - Add Role Category multi-select with all 17 categories
    - Add Experience Level toggle: "All", "New Grad", "Internship"
    - Display total count of matching jobs
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.8_
  - [x] 9.2 Integrate filter bar into Jobs Dashboard page
    - Wire `JobFilterBar` into the existing jobs dashboard component
    - Pass filter state as query parameters to `GET /jobs` API calls
    - Re-fetch job list on any filter change
    - _Requirements: 10.6_
  - [x] 9.3 Implement filter persistence in localStorage
    - Save filter selections to `localStorage` on change
    - Load saved filters on component mount
    - _Requirements: 10.7_
  - [x] 9.4 Write property test for Filter Persistence Round-Trip (Property 11)
    - **Property 11: Filter Persistence Round-Trip**
    - **Validates: Requirements 10.7**
    - Create `frontend/src/__tests__/jobFilters.property.test.tsx`
    - Use fast-check to generate valid filter states, save to localStorage mock, load back, and verify equivalence

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (11 total)
- Backend uses Python with Hypothesis for property-based tests
- Frontend uses TypeScript with fast-check for property-based tests
- The existing `GitHubScraper` in `backend/services/github_scraper.py` is superseded by the new `MarkdownParser` + `AggregatorService` but remains for backward compatibility
- Test commands: `pytest backend/tests/ -k "property" --tb=short` (backend PBT), `cd frontend && npx vitest --run` (frontend)
