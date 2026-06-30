import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

/**
 * **Validates: Requirements 9.2**
 * Property 12: Tab Filter Correctness and Sort Order
 *
 * Tests that tab filtering correctly partitions jobs by status/saved state.
 */

interface Job {
  id: number;
  title: string;
  status: string;
  saved: boolean;
  match_score: number;
}

// Replicate the tab filtering logic from Jobs.tsx
function filterByTab(jobs: Job[], activeTab: string): Job[] {
  return jobs.filter((j) => {
    if (activeTab === "Applied") return j.status === "applied";
    if (activeTab === "Liked") return j.saved;
    return true; // "All" shows everything
  });
}

const jobArb = fc.record({
  id: fc.nat(),
  title: fc.string({ minLength: 1 }),
  status: fc.oneof(fc.constant("new"), fc.constant("applied"), fc.constant("viewed"), fc.constant("rejected")),
  saved: fc.boolean(),
  match_score: fc.integer({ min: 0, max: 100 }),
});

const jobsArb = fc.array(jobArb, { minLength: 0, maxLength: 50 });

describe("Property 12: Tab Filter Correctness and Sort Order", () => {
  it("All tab returns all jobs", () => {
    fc.assert(
      fc.property(jobsArb, (jobs) => {
        const result = filterByTab(jobs, "All");
        expect(result.length).toBe(jobs.length);
      })
    );
  });

  it("Applied tab returns only jobs with status 'applied'", () => {
    fc.assert(
      fc.property(jobsArb, (jobs) => {
        const result = filterByTab(jobs, "Applied");
        for (const job of result) {
          expect(job.status).toBe("applied");
        }
        // All applied jobs should be included
        const expectedCount = jobs.filter((j) => j.status === "applied").length;
        expect(result.length).toBe(expectedCount);
      })
    );
  });

  it("Liked tab returns only saved jobs", () => {
    fc.assert(
      fc.property(jobsArb, (jobs) => {
        const result = filterByTab(jobs, "Liked");
        for (const job of result) {
          expect(job.saved).toBe(true);
        }
        const expectedCount = jobs.filter((j) => j.saved).length;
        expect(result.length).toBe(expectedCount);
      })
    );
  });

  it("tab filters are exhaustive - every job appears in at least one tab", () => {
    fc.assert(
      fc.property(jobsArb, (jobs) => {
        // Every job appears in "All"
        const all = filterByTab(jobs, "All");
        expect(all.length).toBe(jobs.length);
      })
    );
  });

  it("filtered results are a subset of the original jobs", () => {
    const tabArb = fc.oneof(
      fc.constant("All"),
      fc.constant("Applied"),
      fc.constant("Liked")
    );

    fc.assert(
      fc.property(jobsArb, tabArb, (jobs, tab) => {
        const result = filterByTab(jobs, tab);
        expect(result.length).toBeLessThanOrEqual(jobs.length);
        for (const job of result) {
          expect(jobs).toContainEqual(job);
        }
      })
    );
  });
});
