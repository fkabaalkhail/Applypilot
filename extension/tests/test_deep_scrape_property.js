/**
 * Property-based tests for deep scrape pagination helpers.
 * Uses fast-check for generative testing.
 *
 * Run: node extension/tests/test_deep_scrape_property.js
 */

const fc = require('fast-check');
const {
  calculateMaxPages,
  resolveMaxJobs,
  randomDelay,
  deduplicateJobs,
  formatProgressToast,
  buildLinkedInSearchUrl,
} = require('../scrape-helpers');

let _passed = 0;
let _failed = 0;
const _results = [];

function suite(name) { _results.push({ suite: name }); }

async function property(name, fn) {
  try {
    await fn();
    _passed++;
    _results.push({ name, pass: true });
  } catch (e) {
    _failed++;
    _results.push({ name, pass: false, error: e.message });
  }
}

function report() {
  for (const r of _results) {
    if (r.suite) console.log(`\n  ${r.suite}`);
    else if (r.pass) console.log(`    ✓ ${r.name}`);
    else console.log(`    ✗ ${r.name} — ${r.error}`);
  }
  console.log(`\n  ${_passed} passed, ${_failed} failed\n`);
  if (_failed > 0) process.exitCode = 1;
}

async function run() {

// ── P1: maxPages calculation (Feature: deep-scrape-pagination, Property 1: maxPages calculation) ──
suite('P1: maxPages calculation');
await property('for any maxJobs in [1,500], maxPages*25 >= maxJobs and (maxPages-1)*25 < maxJobs', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), (maxJobs) => {
    const mp = calculateMaxPages(maxJobs);
    return mp * 25 >= maxJobs && (mp - 1) * 25 < maxJobs;
  }), { numRuns: 200 });
});

// ── P2: Pagination stops at job limit (Feature: deep-scrape-pagination, Property 2: Pagination stops at job limit) ──
suite('P2: Pagination stops at job limit');
await property('simulated loop stops at maxJobs, total never exceeds maxJobs+24', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 500 }),
    fc.array(fc.integer({ min: 0, max: 25 }), { minLength: 1, maxLength: 25 }),
    (maxJobs, pageResults) => {
      const maxPages = calculateMaxPages(maxJobs);
      let total = 0;
      for (let i = 0; i < Math.min(pageResults.length, maxPages); i++) {
        total += pageResults[i];
        if (total >= maxJobs) break;
        if (pageResults[i] === 0 && i > 0) break;
      }
      return total <= maxJobs + 24;
    }
  ), { numRuns: 200 });
});

// ── P3: maxJobsPerRun validation (Feature: deep-scrape-pagination, Property 3: maxJobsPerRun input validation) ──
suite('P3: maxJobsPerRun input validation');
await property('for any input, resolveMaxJobs returns integer in [1,500]', () => {
  fc.assert(fc.property(fc.anything(), (input) => {
    const r = resolveMaxJobs(input);
    return Number.isInteger(r) && r >= 1 && r <= 500;
  }), { numRuns: 200 });
});
await property('valid integers in [1,500] are preserved', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), (n) => resolveMaxJobs(n) === n), { numRuns: 200 });
});
await property('values > 500 are clamped to 500', () => {
  fc.assert(fc.property(fc.integer({ min: 501, max: 10000 }), (n) => resolveMaxJobs(n) === 500), { numRuns: 100 });
});
await property('invalid inputs resolve to 25', () => {
  fc.assert(fc.property(
    fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant(NaN), fc.constant(0), fc.constant(-1), fc.constant(Infinity), fc.constant(-Infinity)),
    (input) => resolveMaxJobs(input) === 25
  ), { numRuns: 100 });
});

// ── P4: URL construction (Feature: deep-scrape-pagination, Property 4: LinkedIn search URL construction) ──
suite('P4: LinkedIn search URL construction');
await property('URL contains encoded title, location, and f_AL=true', () => {
  fc.assert(fc.property(
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    (title, location) => {
      const url = buildLinkedInSearchUrl(title, location);
      const parsed = new URL(url);
      return parsed.searchParams.get('keywords') === title &&
             parsed.searchParams.get('location') === location &&
             parsed.searchParams.get('f_AL') === 'true' &&
             url.startsWith('https://www.linkedin.com/jobs/search/');
    }
  ), { numRuns: 200 });
});

// ── P5: Empty page stops pagination (Feature: deep-scrape-pagination, Property 5: Empty page stops pagination) ──
suite('P5: Empty page stops pagination');
await property('loop terminates when a page returns 0 jobs after first page', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 500 }),
    fc.integer({ min: 1, max: 20 }),
    (maxJobs, emptyPageIndex) => {
      const maxPages = calculateMaxPages(maxJobs);
      const actualEmptyIdx = Math.min(emptyPageIndex, maxPages - 1);
      let total = 0;
      let stopped = false;
      for (let i = 0; i < maxPages; i++) {
        const pageJobs = i < actualEmptyIdx ? 25 : 0;
        total += pageJobs;
        if (total >= maxJobs) { stopped = true; break; }
        if (pageJobs === 0 && i > 0) { stopped = true; break; }
      }
      return stopped || actualEmptyIdx === 0;
    }
  ), { numRuns: 200 });
});

// ── P6: Progress message formatting (Feature: deep-scrape-pagination, Property 6: Progress message formatting) ──
suite('P6: Progress message formatting');
await property('formatted string matches expected pattern', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 100 }),
    fc.integer({ min: 0, max: 10000 }),
    fc.integer({ min: 1, max: 500 }),
    (page, totalJobs, maxJobs) => {
      const result = formatProgressToast(page, totalJobs, maxJobs);
      return result === `Scraping page ${page}... (${totalJobs} / ${maxJobs} jobs)`;
    }
  ), { numRuns: 200 });
});

// ── P8: Delay bounds (Feature: deep-scrape-pagination, Property 8: Rate limiting delay bounds) ──
suite('P8: Rate limiting delay bounds');
await property('randomDelay returns value in [2000, 5000]', async () => {
  for (let i = 0; i < 20; i++) {
    const delay = await randomDelay(2000, 5000);
    if (delay < 2000 || delay > 5000) throw new Error(`delay ${delay} out of bounds`);
  }
});

// ── P9: Client-side session deduplication (Feature: deep-scrape-pagination, Property 9: Client-side session deduplication) ──
suite('P9: Client-side session deduplication');
await property('unique URLs and correct skip count', () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      title: fc.string({ minLength: 1, maxLength: 50 }),
      url: fc.oneof(
        fc.constant('https://linkedin.com/jobs/view/1'),
        fc.constant('https://linkedin.com/jobs/view/2'),
        fc.constant('https://linkedin.com/jobs/view/3'),
        fc.constant('https://linkedin.com/jobs/view/4'),
        fc.constant('https://linkedin.com/jobs/view/5'),
      ),
    }), { minLength: 0, maxLength: 30 }),
    (jobs) => {
      const { unique, duplicatesSkipped } = deduplicateJobs(jobs);
      const urls = unique.map(j => j.url).filter(Boolean);
      const urlSet = new Set(urls);
      return urlSet.size === urls.length && duplicatesSkipped === jobs.length - unique.length;
    }
  ), { numRuns: 200 });
});

report();
}

run();
