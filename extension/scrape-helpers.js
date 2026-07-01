/**
 * Scrape Helpers — Pure utility functions for the deep scrape pagination feature.
 * Extracted from content.js for testability.
 *
 * These helpers are used by content.js (pagination loop) and popup.js (settings/UI).
 * All functions are pure (no DOM, no chrome.* APIs) except randomDelay which returns a Promise.
 */

/**
 * Calculate the number of pages to scrape based on the target job count.
 * LinkedIn shows ~25 jobs per page.
 * @param {number} maxJobs — target number of jobs (1–500)
 * @returns {number} number of pages to scrape
 */
function calculateMaxPages(maxJobs) {
  return Math.ceil(maxJobs / 25);
}

/**
 * Validate and default the maxJobsPerRun setting.
 * Accepts values in [1, 500]. Invalid inputs (undefined, null, NaN, 0, negative,
 * non-numeric strings) resolve to the default of 25. Values above 500 are clamped to 500.
 * @param {*} setting — raw value from extension storage
 * @returns {number} validated maxJobs value in [1, 500]
 */
function resolveMaxJobs(setting) {
  let n;
  try {
    n = Number(setting);
  } catch (e) {
    return 25;
  }
  if (!Number.isFinite(n) || n < 1) {
    return 25;
  }
  if (n > 500) {
    return 500;
  }
  return Math.floor(n);
}

/**
 * Return a promise that resolves after a random delay in [min, max] ms.
 * Used for rate limiting between page navigations.
 * @param {number} [min=2000] — minimum delay in ms
 * @param {number} [max=5000] — maximum delay in ms
 * @returns {Promise<number>} resolves with the actual delay value in ms
 */
function randomDelay(min, max) {
  if (min === undefined || min === null) min = 2000;
  if (max === undefined || max === null) max = 5000;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(() => resolve(delay), delay));
}

/**
 * Deduplicate an array of job objects by URL.
 * Jobs without a url property are kept (treated as unique).
 * @param {Array<Object>} jobs — array of job objects with `url` property
 * @returns {{ unique: Array<Object>, duplicatesSkipped: number }}
 */
function deduplicateJobs(jobs) {
  const seen = new Set();
  const unique = [];
  let duplicatesSkipped = 0;

  for (const job of jobs) {
    if (job.url && seen.has(job.url)) {
      duplicatesSkipped++;
    } else {
      if (job.url) {
        seen.add(job.url);
      }
      unique.push(job);
    }
  }

  return { unique, duplicatesSkipped };
}

/**
 * Format a progress toast message for the scraping UI.
 * @param {number} page — current page number (1-based)
 * @param {number} totalJobs — total jobs found so far
 * @param {number} maxJobs — target job count
 * @returns {string} formatted progress string
 */
function formatProgressToast(page, totalJobs, maxJobs) {
  return `Scraping page ${page}... (${totalJobs} / ${maxJobs} jobs)`;
}

/**
 * Construct a LinkedIn job search URL with encoded parameters and Easy Apply filter.
 * @param {string} jobTitle — job title / keywords
 * @param {string} searchLocation — location string
 * @param {Object} [filters={}] — additional filter params (reserved for future use)
 * @returns {string} full LinkedIn search URL
 */
function buildLinkedInSearchUrl(jobTitle, searchLocation, filters) {
  const base = 'https://www.linkedin.com/jobs/search/';
  const params = new URLSearchParams();
  params.set('keywords', jobTitle);
  params.set('location', searchLocation);
  params.set('f_AL', 'true'); // Easy Apply filter

  if (filters && typeof filters === 'object') {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
  }

  return `${base}?${params.toString()}`;
}

// ── Exports ──────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateMaxPages,
    resolveMaxJobs,
    randomDelay,
    deduplicateJobs,
    formatProgressToast,
    buildLinkedInSearchUrl,
  };
}
