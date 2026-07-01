/**
 * Unit tests for scrape-helpers.js — extracted helper functions
 * for the deep scrape pagination feature.
 *
 * Run: node extension/tests/test_scrape_helpers.js
 */

// ── Minimal test harness ──────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
const _results = [];

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected ${b}, got ${a}`
    );
  }
}

async function test(name, fn) {
  try {
    await fn();
    _passed++;
    _results.push({ name, pass: true });
  } catch (e) {
    _failed++;
    _results.push({ name, pass: false, error: e.message });
  }
}

function suite(name) {
  _results.push({ suite: name });
}

function report() {
  for (const r of _results) {
    if (r.suite) {
      console.log(`\n  ${r.suite}`);
    } else if (r.pass) {
      console.log(`    ✓ ${r.name}`);
    } else {
      console.log(`    ✗ ${r.name} — ${r.error}`);
    }
  }
  console.log(`\n  ${_passed} passed, ${_failed} failed\n`);
  if (typeof process !== 'undefined' && process.exit && _failed > 0) {
    process.exitCode = 1;
  }
}

// ── Import helpers ────────────────────────────────────────────────────

const {
  calculateMaxPages,
  resolveMaxJobs,
  randomDelay,
  deduplicateJobs,
  formatProgressToast,
  buildLinkedInSearchUrl,
} = require('../scrape-helpers');

// ── Tests ─────────────────────────────────────────────────────────────

async function runTests() {

  // ── calculateMaxPages ───────────────────────────────────────────────

  suite('calculateMaxPages');

  await test('1 job → 1 page', () => {
    assertEqual(calculateMaxPages(1), 1);
  });

  await test('25 jobs → 1 page', () => {
    assertEqual(calculateMaxPages(25), 1);
  });

  await test('26 jobs → 2 pages', () => {
    assertEqual(calculateMaxPages(26), 2);
  });

  await test('50 jobs → 2 pages', () => {
    assertEqual(calculateMaxPages(50), 2);
  });

  await test('500 jobs → 20 pages', () => {
    assertEqual(calculateMaxPages(500), 20);
  });

  await test('100 jobs → 4 pages', () => {
    assertEqual(calculateMaxPages(100), 4);
  });

  // ── resolveMaxJobs ─────────────────────────────────────────────────

  suite('resolveMaxJobs');

  await test('undefined → 25', () => {
    assertEqual(resolveMaxJobs(undefined), 25);
  });

  await test('null → 25', () => {
    assertEqual(resolveMaxJobs(null), 25);
  });

  await test('0 → 25', () => {
    assertEqual(resolveMaxJobs(0), 25);
  });

  await test('-1 → 25', () => {
    assertEqual(resolveMaxJobs(-1), 25);
  });

  await test('NaN → 25', () => {
    assertEqual(resolveMaxJobs(NaN), 25);
  });

  await test('"abc" → 25', () => {
    assertEqual(resolveMaxJobs('abc'), 25);
  });

  await test('501 → 500 (clamped)', () => {
    assertEqual(resolveMaxJobs(501), 500);
  });

  await test('500 → 500', () => {
    assertEqual(resolveMaxJobs(500), 500);
  });

  await test('1 → 1', () => {
    assertEqual(resolveMaxJobs(1), 1);
  });

  await test('100 → 100', () => {
    assertEqual(resolveMaxJobs(100), 100);
  });

  await test('"50" (string number) → 50', () => {
    assertEqual(resolveMaxJobs('50'), 50);
  });

  await test('Infinity → 25', () => {
    assertEqual(resolveMaxJobs(Infinity), 25);
  });

  await test('fractional 25.7 → 25 (floored)', () => {
    assertEqual(resolveMaxJobs(25.7), 25);
  });

  // ── randomDelay ────────────────────────────────────────────────────

  suite('randomDelay');

  await test('returns a promise that resolves with a number in [2000, 5000]', async () => {
    const delay = await randomDelay(2000, 5000);
    assert(delay >= 2000, `delay ${delay} should be >= 2000`);
    assert(delay <= 5000, `delay ${delay} should be <= 5000`);
  });

  await test('defaults to [2000, 5000] when no args', async () => {
    const delay = await randomDelay();
    assert(delay >= 2000, `delay ${delay} should be >= 2000`);
    assert(delay <= 5000, `delay ${delay} should be <= 5000`);
  });

  await test('respects custom range [100, 200]', async () => {
    const delay = await randomDelay(100, 200);
    assert(delay >= 100, `delay ${delay} should be >= 100`);
    assert(delay <= 200, `delay ${delay} should be <= 200`);
  });

  // ── deduplicateJobs ────────────────────────────────────────────────

  suite('deduplicateJobs');

  await test('empty array → empty unique, 0 skipped', () => {
    const result = deduplicateJobs([]);
    assertEqual(result.unique.length, 0);
    assertEqual(result.duplicatesSkipped, 0);
  });

  await test('no duplicates → all unique', () => {
    const jobs = [
      { title: 'A', url: 'https://linkedin.com/jobs/view/1' },
      { title: 'B', url: 'https://linkedin.com/jobs/view/2' },
    ];
    const result = deduplicateJobs(jobs);
    assertEqual(result.unique.length, 2);
    assertEqual(result.duplicatesSkipped, 0);
  });

  await test('all duplicates → keeps first, skips rest', () => {
    const jobs = [
      { title: 'A', url: 'https://linkedin.com/jobs/view/1' },
      { title: 'A copy', url: 'https://linkedin.com/jobs/view/1' },
      { title: 'A copy 2', url: 'https://linkedin.com/jobs/view/1' },
    ];
    const result = deduplicateJobs(jobs);
    assertEqual(result.unique.length, 1);
    assertEqual(result.unique[0].title, 'A');
    assertEqual(result.duplicatesSkipped, 2);
  });

  await test('mixed duplicates', () => {
    const jobs = [
      { title: 'A', url: 'https://linkedin.com/jobs/view/1' },
      { title: 'B', url: 'https://linkedin.com/jobs/view/2' },
      { title: 'A dup', url: 'https://linkedin.com/jobs/view/1' },
      { title: 'C', url: 'https://linkedin.com/jobs/view/3' },
      { title: 'B dup', url: 'https://linkedin.com/jobs/view/2' },
    ];
    const result = deduplicateJobs(jobs);
    assertEqual(result.unique.length, 3);
    assertEqual(result.duplicatesSkipped, 2);
  });

  await test('jobs without url are kept', () => {
    const jobs = [
      { title: 'No URL 1' },
      { title: 'No URL 2' },
      { title: 'Has URL', url: 'https://linkedin.com/jobs/view/1' },
    ];
    const result = deduplicateJobs(jobs);
    assertEqual(result.unique.length, 3);
    assertEqual(result.duplicatesSkipped, 0);
  });

  // ── formatProgressToast ────────────────────────────────────────────

  suite('formatProgressToast');

  await test('basic formatting', () => {
    assertEqual(
      formatProgressToast(1, 25, 100),
      'Scraping page 1... (25 / 100 jobs)'
    );
  });

  await test('page=1, totalJobs=0, maxJobs=25', () => {
    assertEqual(
      formatProgressToast(1, 0, 25),
      'Scraping page 1... (0 / 25 jobs)'
    );
  });

  await test('large values', () => {
    assertEqual(
      formatProgressToast(20, 487, 500),
      'Scraping page 20... (487 / 500 jobs)'
    );
  });

  // ── buildLinkedInSearchUrl ─────────────────────────────────────────

  suite('buildLinkedInSearchUrl');

  await test('basic URL construction', () => {
    const url = buildLinkedInSearchUrl('Software Engineer', 'Ottawa, ON');
    assert(url.startsWith('https://www.linkedin.com/jobs/search/?'), 'should start with base URL');
    assert(url.includes('keywords=Software+Engineer') || url.includes('keywords=Software%20Engineer'), 'should contain encoded job title');
    assert(url.includes('location=Ottawa'), 'should contain location');
    assert(url.includes('f_AL=true'), 'should contain Easy Apply filter');
  });

  await test('special characters in title are encoded', () => {
    const url = buildLinkedInSearchUrl('C++ Developer & Architect', 'New York, NY');
    assert(url.includes('f_AL=true'), 'should contain Easy Apply filter');
    // The URL should be valid (no raw & or + that break params)
    const parsed = new URL(url);
    assertEqual(parsed.searchParams.get('keywords'), 'C++ Developer & Architect');
    assertEqual(parsed.searchParams.get('f_AL'), 'true');
  });

  await test('additional filters are included', () => {
    const url = buildLinkedInSearchUrl('Data Scientist', 'Remote', { f_WT: '2', f_E: '3' });
    const parsed = new URL(url);
    assertEqual(parsed.searchParams.get('f_WT'), '2');
    assertEqual(parsed.searchParams.get('f_E'), '3');
    assertEqual(parsed.searchParams.get('f_AL'), 'true');
  });

  await test('empty filters object is fine', () => {
    const url = buildLinkedInSearchUrl('PM', 'SF', {});
    assert(url.includes('f_AL=true'), 'should contain Easy Apply filter');
  });

  await test('no filters param is fine', () => {
    const url = buildLinkedInSearchUrl('PM', 'SF');
    assert(url.includes('f_AL=true'), 'should contain Easy Apply filter');
  });

  // ── Done ───────────────────────────────────────────────────────────

  report();
}

runTests();
