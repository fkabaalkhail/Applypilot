import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

/**
 * Feature: city-multi-tag-filter
 * Property-based tests for city tag filter logic
 */

// --- Pure logic functions extracted from JobFilterBar.tsx and Jobs.tsx ---

/**
 * Adds a city tag to the list. Returns the new list.
 * Trims input, rejects empty/whitespace-only, rejects duplicates.
 */
function addCityTag(tags: string[], city: string): string[] {
  const trimmed = city.trim();
  if (!trimmed) return tags;
  if (tags.includes(trimmed)) return tags;
  return [...tags, trimmed];
}

/**
 * Removes a city tag from the list. Returns the new list.
 */
function removeCityTag(tags: string[], city: string): string[] {
  return tags.filter((tag) => tag !== city);
}

/**
 * Handles Backspace on empty input: removes the last tag.
 * Returns the new list.
 */
function handleBackspaceOnEmpty(tags: string[]): string[] {
  if (tags.length === 0) return tags;
  return tags.slice(0, -1);
}

/**
 * Serializes a location array for the API as a comma-separated string.
 * Filters out empty and whitespace-only values, trims each value.
 * Returns the serialized string, or empty string if no valid values.
 */
function serializeLocationForApi(locations: string[]): string {
  return locations
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .join(",");
}

/**
 * Loads location from localStorage value (parsed JSON field).
 * Handles: valid array, legacy string, corrupted/invalid data.
 */
function loadLocationFromStorage(value: unknown): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
}

// --- Arbitraries ---

/** Generates a non-empty, non-whitespace-only city string */
const validCityArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

/** Generates a list of unique trimmed city tags */
const uniqueTagListArb = fc
  .array(validCityArb, { maxLength: 20 })
  .map((arr) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const s of arr) {
      const trimmed = s.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    return result;
  });

// ============================================================
// Property 1: Adding a city tag grows the list with trimmed value
// ============================================================

describe("Feature: city-multi-tag-filter, Property 1: Adding a valid city tag grows the list with trimmed value", () => {
  /**
   * Validates: Requirements 1.1, 1.6
   *
   * For any non-empty, non-whitespace-only city string and any existing tag list
   * that does not already contain the trimmed version of that string, adding the
   * city shall result in the tag list growing by exactly one element, and the new
   * element shall be the trimmed version of the input string.
   */
  it("adding a valid, non-duplicate city grows the list by one with trimmed value", () => {
    fc.assert(
      fc.property(uniqueTagListArb, validCityArb, (existingTags, newCity) => {
        const trimmedCity = newCity.trim();
        // Pre-condition: the trimmed city is not already in the list
        fc.pre(!existingTags.includes(trimmedCity));

        const result = addCityTag(existingTags, newCity);

        // List grows by exactly one
        expect(result.length).toBe(existingTags.length + 1);
        // The new element is the trimmed version
        expect(result[result.length - 1]).toBe(trimmedCity);
        // All original elements are preserved
        expect(result.slice(0, existingTags.length)).toEqual(existingTags);
      }),
      { numRuns: 100 }
    );
  });
});


// ============================================================
// Property 2: Invalid inputs are rejected without modifying the tag list
// ============================================================

describe("Feature: city-multi-tag-filter, Property 2: Invalid inputs (empty, whitespace-only, duplicates) are rejected without modifying the tag list", () => {
  /**
   * Validates: Requirements 1.4, 1.5
   *
   * For any input that is empty, composed entirely of whitespace, or already exists
   * (case-sensitive) in the current tag list, attempting to add it shall leave the
   * tag list unchanged.
   */
  it("empty string input leaves the tag list unchanged", () => {
    fc.assert(
      fc.property(uniqueTagListArb, (existingTags) => {
        const result = addCityTag(existingTags, "");
        expect(result).toEqual(existingTags);
      }),
      { numRuns: 100 }
    );
  });

  it("whitespace-only input leaves the tag list unchanged", () => {
    const whitespaceArb = fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 10 })
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(uniqueTagListArb, whitespaceArb, (existingTags, whitespace) => {
        const result = addCityTag(existingTags, whitespace);
        expect(result).toEqual(existingTags);
      }),
      { numRuns: 100 }
    );
  });

  it("duplicate input (case-sensitive) leaves the tag list unchanged", () => {
    fc.assert(
      fc.property(
        uniqueTagListArb.filter((tags) => tags.length > 0),
        (existingTags) => {
          // Pick a random existing tag to try adding again
          const duplicateCity = existingTags[Math.floor(Math.random() * existingTags.length)];
          const result = addCityTag(existingTags, duplicateCity);
          expect(result).toEqual(existingTags);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ============================================================
// Property 3: Removing a city tag preserves all other tags in order
// ============================================================

describe("Feature: city-multi-tag-filter, Property 3: Removing a city tag preserves all other tags in order", () => {
  /**
   * Validates: Requirements 1.2
   *
   * For any tag list containing at least one element and any city chosen from that
   * list, removing that city shall result in a list that contains all original
   * elements except the removed one, in the same relative order.
   */
  it("removing a tag preserves all other tags in their original order", () => {
    fc.assert(
      fc.property(
        uniqueTagListArb.filter((tags) => tags.length > 0),
        fc.nat(),
        (existingTags, indexSeed) => {
          // Pick a tag to remove
          const indexToRemove = indexSeed % existingTags.length;
          const cityToRemove = existingTags[indexToRemove];

          const result = removeCityTag(existingTags, cityToRemove);

          // Result has one fewer element
          expect(result.length).toBe(existingTags.length - 1);
          // The removed city is not in the result
          expect(result).not.toContain(cityToRemove);
          // All other elements are preserved in order
          const expected = existingTags.filter((tag) => tag !== cityToRemove);
          expect(result).toEqual(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ============================================================
// Property 4: Backspace on empty input removes only the last tag
// ============================================================

describe("Feature: city-multi-tag-filter, Property 4: Backspace on empty input removes only the last tag", () => {
  /**
   * Validates: Requirements 7.2
   *
   * For any non-empty tag list, pressing Backspace when the input field is empty
   * shall result in a list equal to the original list with the last element removed.
   */
  it("backspace on empty input removes only the last tag", () => {
    fc.assert(
      fc.property(
        uniqueTagListArb.filter((tags) => tags.length > 0),
        (existingTags) => {
          const result = handleBackspaceOnEmpty(existingTags);

          // Result has one fewer element
          expect(result.length).toBe(existingTags.length - 1);
          // Result equals the original list without the last element
          expect(result).toEqual(existingTags.slice(0, -1));
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ============================================================
// Property 5: Serialization produces valid comma-separated string excluding invalid values
// ============================================================

describe("Feature: city-multi-tag-filter, Property 5: Serialization produces valid comma-separated string excluding invalid values", () => {
  /**
   * Validates: Requirements 3.1, 3.2, 3.3
   *
   * For any array of strings (including empty strings and whitespace-only strings),
   * serializing for the API shall produce a comma-separated string containing only
   * the non-empty trimmed values, or no parameter at all if no valid values remain.
   */
  it("serialization includes only non-empty trimmed values as comma-separated string", () => {
    const whitespaceOnlyArb = fc
      .array(fc.constantFrom(" ", "\t", "\n"), { minLength: 1, maxLength: 5 })
      .map((chars) => chars.join(""));

    const mixedStringArrayArb = fc.array(
      fc.oneof(
        validCityArb,
        fc.constant(""),
        whitespaceOnlyArb
      ),
      { maxLength: 15 }
    );

    fc.assert(
      fc.property(mixedStringArrayArb, (locations) => {
        const result = serializeLocationForApi(locations);

        // Compute expected valid values
        const validValues = locations
          .map((c) => c.trim())
          .filter((c) => c.length > 0);

        if (validValues.length === 0) {
          // No valid values → empty string (no parameter)
          expect(result).toBe("");
        } else {
          // Result is comma-separated valid values
          expect(result).toBe(validValues.join(","));
          // Result is non-empty
          expect(result.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });
});


// ============================================================
// Property 7: Location array round-trips through localStorage with migration
// ============================================================

describe("Feature: city-multi-tag-filter, Property 7: Location array round-trips through localStorage with migration from legacy string and corrupted data handling", () => {
  /**
   * Validates: Requirements 5.1, 5.2, 5.3, 5.4
   *
   * For any valid location array, saving to localStorage and loading back shall
   * produce the same array. Additionally, for any non-empty legacy string value
   * stored in the old format, loading shall produce a single-element array
   * containing that string. For any invalid or corrupted location value, loading
   * shall produce an empty array.
   */

  const FILTER_STORAGE_KEY = "job-aggregator-filters";

  /** Simulates saving filters to localStorage (as Jobs.tsx does) */
  function saveLocationToStorage(location: string[]): void {
    const filters = { country: "", location, work_type: [], role_category: [], experience_level: [], date_posted: "" };
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  }

  /** Simulates loading location from localStorage (as Jobs.tsx does) */
  function loadLocationFromStorageFull(): string[] {
    try {
      const saved = localStorage.getItem(FILTER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return loadLocationFromStorage(parsed.location);
      }
    } catch {
      // Ignore parse errors
    }
    return [];
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it("valid location array round-trips through localStorage", () => {
    fc.assert(
      fc.property(
        fc.array(validCityArb, { maxLength: 10 }),
        (locationArray) => {
          saveLocationToStorage(locationArray);
          const loaded = loadLocationFromStorageFull();
          expect(loaded).toEqual(locationArray);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("legacy string value migrates to single-element array", () => {
    fc.assert(
      fc.property(
        validCityArb,
        (legacyString) => {
          // Store as legacy format (location is a plain string)
          const filters = { country: "", location: legacyString, work_type: [], role_category: [], experience_level: [], date_posted: "" };
          localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));

          const loaded = loadLocationFromStorageFull();
          expect(loaded).toEqual([legacyString]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("corrupted or invalid location value defaults to empty array", () => {
    const corruptedValueArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(0),
      fc.constant(false),
      fc.constant(""),
      fc.constant({}),
    );

    fc.assert(
      fc.property(corruptedValueArb, (corruptedValue) => {
        const filters = { country: "", location: corruptedValue, work_type: [], role_category: [], experience_level: [], date_posted: "" };
        localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));

        const loaded = loadLocationFromStorageFull();
        expect(loaded).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it("completely corrupted localStorage JSON defaults to empty array", () => {
    localStorage.setItem(FILTER_STORAGE_KEY, "not valid json{{{");
    const loaded = loadLocationFromStorageFull();
    expect(loaded).toEqual([]);
  });
});
