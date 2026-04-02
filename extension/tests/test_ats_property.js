/**
 * Property-based tests for ATS detection (content.js).
 *
 * **Validates: Requirements Design §2 (ATS Detection Patterns)**
 *
 * Property 1: ATS detection is deterministic — same URL always returns same ATS type.
 * Also verifies the result is always one of the valid ATS types.
 *
 * Run: node extension/tests/test_ats_property.js
 */

const fc = require('fast-check');

// ── Replicate ATS logic from content.js for standalone execution ─────

const ATS_PATTERNS = {
  linkedin:   /linkedin\.com/i,
  greenhouse: /boards\.greenhouse\.io|greenhouse\.io\/embed/i,
  lever:      /jobs\.lever\.co/i,
  workday:    /myworkdayjobs\.com|workday\.com\/.*\/job/i,
  jazzhr:     /applytojob\.com|app\.jazz\.co/i,
};

function detectATS(url) {
  if (!url) return 'generic';
  for (const [ats, pattern] of Object.entries(ATS_PATTERNS)) {
    if (pattern.test(url)) return ats;
  }
  return 'generic';
}

const VALID_ATS_TYPES = ['linkedin', 'greenhouse', 'lever', 'workday', 'jazzhr', 'generic'];

// ── URL generators ───────────────────────────────────────────────────

/** Arbitrary that produces URLs known to match specific ATS patterns. */
const knownATSUrl = fc.oneof(
  fc.constant('https://www.linkedin.com/jobs/view/12345'),
  fc.constant('https://boards.greenhouse.io/company/jobs/99'),
  fc.constant('https://greenhouse.io/embed/job_board'),
  fc.constant('https://jobs.lever.co/company/abc-123'),
  fc.constant('https://acme.myworkdayjobs.com/en-US/jobs'),
  fc.constant('https://acme.workday.com/en-US/job/12345'),
  fc.constant('https://acme.applytojob.com/apply/abc'),
  fc.constant('https://app.jazz.co/apply/abc'),
  fc.constant('https://careers.example.com/jobs/42'),
);

/** Arbitrary that produces random URL-like strings. */
const randomUrl = fc.oneof(
  fc.webUrl(),
  fc.string(),
  fc.constant(''),
  fc.constant(null),
  fc.constant(undefined),
);

/** Combined arbitrary covering both known ATS URLs and random strings. */
const anyUrl = fc.oneof(knownATSUrl, randomUrl);

// ── Property tests ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function runProperty(name, arb, predicate) {
  try {
    fc.assert(
      fc.property(arb, predicate),
      { numRuns: 200, verbose: false }
    );
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n  Property tests — ATS detection (Task 4.5)\n');

/**
 * Property 1a: Determinism — calling detectATS twice on the same URL
 * always returns the same result.
 *
 * **Validates: Design §2 (ATS Detection Patterns)**
 */
runProperty(
  'detectATS is deterministic (same URL → same result)',
  anyUrl,
  (url) => {
    const first  = detectATS(url);
    const second = detectATS(url);
    return first === second;
  }
);

/**
 * Property 1b: Valid output — detectATS always returns one of the
 * recognised ATS type strings.
 *
 * **Validates: Design §2 (ATS Detection Patterns)**
 */
runProperty(
  'detectATS always returns a valid ATS type',
  anyUrl,
  (url) => {
    const result = detectATS(url);
    return VALID_ATS_TYPES.includes(result);
  }
);

/**
 * Property 1c: Determinism with known ATS URLs — ensures pattern
 * matching is stable across repeated calls.
 *
 * **Validates: Design §2 (ATS Detection Patterns)**
 */
runProperty(
  'detectATS is deterministic for known ATS URLs',
  knownATSUrl,
  (url) => {
    const first  = detectATS(url);
    const second = detectATS(url);
    return first === second && VALID_ATS_TYPES.includes(first);
  }
);

// ── Report ───────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0 && typeof process !== 'undefined') {
  process.exitCode = 1;
}
