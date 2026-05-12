import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

/**
 * Feature: job-scraper-aggregator, Property 11: Filter Persistence Round-Trip
 * Validates: Requirements 10.7
 */

const FILTER_STORAGE_KEY = "job-aggregator-filters";

interface JobFilters {
  country: string;
  work_type: string[];
  role_category: string[];
  experience_level: string[];
}

const COUNTRY_VALUES = ["", "US", "CA"];
const WORK_TYPE_VALUES = ["remote", "hybrid", "onsite"];
const ROLE_CATEGORIES = [
  "Software Engineering", "Data Analysis", "Business Analyst",
  "Management and Executive", "Engineering and Development",
  "Creatives and Design", "Product Management", "Sales",
  "Accounting and Finance", "Arts and Entertainment",
  "Legal and Compliance", "Human Resources",
  "Public Sector and Government", "Education and Training",
  "Customer Service and Support", "Marketing", "Consultant",
];
const EXPERIENCE_VALUES = ["new_grad", "internship", "entry", "mid", "senior", "lead", "director"];

// Strategy for generating valid JobFilters
const jobFiltersArb = fc.record({
  country: fc.constantFrom(...COUNTRY_VALUES),
  work_type: fc.subarray(WORK_TYPE_VALUES),
  role_category: fc.subarray(ROLE_CATEGORIES),
  experience_level: fc.subarray(EXPERIENCE_VALUES),
});

// Simulate the save/load logic from Jobs.tsx
function saveFilters(filters: JobFilters): void {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
}

function loadFilters(): JobFilters {
  try {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        country: parsed.country || "",
        work_type: Array.isArray(parsed.work_type) ? parsed.work_type : [],
        role_category: Array.isArray(parsed.role_category) ? parsed.role_category : [],
        experience_level: Array.isArray(parsed.experience_level) ? parsed.experience_level : parsed.experience_level ? [parsed.experience_level] : [],
      };
    }
  } catch {
    // Ignore parse errors
  }
  return { country: "", work_type: [], role_category: [], experience_level: [] };
}

describe("Property 11: Filter Persistence Round-Trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saving and loading filters produces equivalent state", () => {
    fc.assert(
      fc.property(jobFiltersArb, (filters) => {
        saveFilters(filters);
        const loaded = loadFilters();

        expect(loaded.country).toBe(filters.country);
        expect(loaded.work_type).toEqual(filters.work_type);
        expect(loaded.role_category).toEqual(filters.role_category);
        expect(loaded.experience_level).toEqual(filters.experience_level);
      }),
      { numRuns: 100 }
    );
  });

  it("loading from empty localStorage returns defaults", () => {
    const loaded = loadFilters();
    expect(loaded.country).toBe("");
    expect(loaded.work_type).toEqual([]);
    expect(loaded.role_category).toEqual([]);
    expect(loaded.experience_level).toEqual([]);
  });

  it("loading from corrupted localStorage returns defaults", () => {
    localStorage.setItem(FILTER_STORAGE_KEY, "not valid json{{{");
    const loaded = loadFilters();
    expect(loaded.country).toBe("");
    expect(loaded.work_type).toEqual([]);
    expect(loaded.role_category).toEqual([]);
    expect(loaded.experience_level).toEqual([]);
  });

  it("loading from partial data fills in defaults", () => {
    fc.assert(
      fc.property(
        fc.record({
          country: fc.constantFrom(...COUNTRY_VALUES),
        }),
        (partial) => {
          localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(partial));
          const loaded = loadFilters();
          expect(loaded.country).toBe(partial.country);
          expect(loaded.work_type).toEqual([]);
          expect(loaded.role_category).toEqual([]);
          expect(loaded.experience_level).toEqual([]);
        }
      ),
      { numRuns: 50 }
    );
  });
});
