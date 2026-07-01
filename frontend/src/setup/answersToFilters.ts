import type { JobFilters } from "../components/JobFilterBar";
import type { SetupAnswers } from "./types";

/**
 * Pure mapping from wizard answers to the dashboard's JobFilters shape.
 * Only fields with a real JobFilters counterpart are mapped; job_types,
 * work_authorization, and target_titles are captured in settings elsewhere.
 * The returned object must match JobFilters exactly (written to
 * localStorage["job-aggregator-filters"], read on the Jobs page).
 */
export function answersToFilters(a: SetupAnswers): JobFilters {
  return {
    country: a.country,
    location: a.city.trim() ? [a.city.trim()] : [],
    work_type: a.open_to_remote ? ["remote"] : [],
    role_category: [...a.job_functions],
    experience_level: a.experience_level ? [a.experience_level] : [],
    date_posted: "",
  };
}
