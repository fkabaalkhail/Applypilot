/**
 * Property-based tests for profile value matching (content.js).
 *
 * **Validates: Design §2 (getProfileValue)**
 *
 * Property 2: Profile mapping prefers exact matches over substring matches.
 *
 * Run: node extension/tests/test_profile_property.js
 */

const fc = require('fast-check');

// ── Replicate FIELD_MAP and getProfileValue from content.js ──────────

const FIELD_MAP = {
  "first name": "firstName",
  "last name": "lastName",
  "full name": (p) => `${p.firstName} ${p.lastName}`,
  "name": (p) => `${p.firstName} ${p.lastName}`,
  "email address": "email",
  "e-mail address": "email",
  "email": "email",
  "e-mail": "email",
  "phone": "phone",
  "mobile phone": "phone",
  "mobile phone number": "phone",
  "phone number": "phone",
  "phone country code": "phoneCountryCode",
  "street address": "address",
  "address": "address",
  "city": "city",
  "state": "state",
  "province": "state",
  "state/province": "state",
  "postal": "postal",
  "postal code": "postal",
  "zip": "postal",
  "zip code": "postal",
  "country": "country",
  "linkedin": "linkedinUrl",
  "linkedin url": "linkedinUrl",
  "linkedin profile": "linkedinUrl",
  "website": "website",
  "portfolio": "website",
};

function getProfileValue(label, profile) {
  if (!label || !profile) return null;
  const labelLower = label.toLowerCase().trim().replace(/\*+$/, '').trim();

  // Pass 1: exact match
  for (const [key, val] of Object.entries(FIELD_MAP)) {
    if (key === labelLower) {
      return typeof val === 'function' ? val(profile) : (profile[val] || '');
    }
  }

  // Pass 2: key in label (longer keys first to prefer specific matches)
  const sortedKeys = Object.keys(FIELD_MAP).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (labelLower.includes(key)) {
      const val = FIELD_MAP[key];
      return typeof val === 'function' ? val(profile) : (profile[val] || '');
    }
  }

  // Pass 3: label in key (for partial labels like "zip" matching "zip code")
  for (const key of sortedKeys) {
    if (key.includes(labelLower)) {
      const val = FIELD_MAP[key];
      return typeof val === 'function' ? val(profile) : (profile[val] || '');
    }
  }

  return null;
}


// ── Test helpers ─────────────────────────────────────────────────────

const FIELD_MAP_KEYS = Object.keys(FIELD_MAP);

/** A complete profile with unique values so we can trace which field matched. */
const FULL_PROFILE = {
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  phone: "5551234567",
  phoneCountryCode: "+1",
  address: "123 Main St",
  city: "Ottawa",
  state: "Ontario",
  postal: "K1A0B1",
  country: "Canada",
  linkedinUrl: "https://linkedin.com/in/alice",
  website: "https://alice.dev",
};

/**
 * Resolve the expected value for a FIELD_MAP key given a profile.
 */
function expectedValue(key, profile) {
  const val = FIELD_MAP[key];
  return typeof val === 'function' ? val(profile) : (profile[val] || '');
}

// ── Generators ───────────────────────────────────────────────────────

/** Arbitrary that picks one of the exact FIELD_MAP keys. */
const exactKey = fc.constantFrom(...FIELD_MAP_KEYS);

/** Arbitrary that wraps a FIELD_MAP key with random prefix/suffix whitespace and trailing asterisks. */
const decoratedKey = exactKey.chain((key) =>
  fc.tuple(
    fc.array(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 }).map((a) => a.join('')),
    fc.constant(key),
    fc.array(fc.constant('*'), { minLength: 0, maxLength: 3 }).map((a) => a.join('')),
    fc.array(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 }).map((a) => a.join('')),
  ).map(([pre, k, stars, post]) => `${pre}${k}${stars}${post}`)
);

/** Arbitrary that produces a random non-empty string unlikely to match any FIELD_MAP key. */
const unmatchedLabel = fc.array(fc.constantFrom('x', 'q', '7', '!', '#'), { minLength: 3, maxLength: 12 })
  .map((a) => a.join(''))
  .filter((s) => {
    const lower = s.toLowerCase().trim();
    return !FIELD_MAP_KEYS.some((k) => k.includes(lower) || lower.includes(k));
  });

// ── Property tests ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function runProperty(name, arb, predicate, numRuns = 200) {
  try {
    fc.assert(
      fc.property(arb, predicate),
      { numRuns, verbose: false }
    );
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n  Property tests — Profile value matching (Task 5.5)\n');

/**
 * Property 2a: For any exact key in FIELD_MAP, getProfileValue returns
 * the correct profile value (not null).
 *
 * **Validates: Design §2 (getProfileValue)**
 */
runProperty(
  'exact FIELD_MAP key always returns correct profile value (not null)',
  exactKey,
  (key) => {
    const result = getProfileValue(key, FULL_PROFILE);
    const expected = expectedValue(key, FULL_PROFILE);
    return result === expected && result !== null;
  }
);

/**
 * Property 2b: Exact matches are preferred over substring matches.
 * If a label exactly matches a FIELD_MAP key, the result must equal
 * the value for that exact key — not a value from a different key
 * that happens to be a substring.
 *
 * **Validates: Design §2 (getProfileValue)**
 */
runProperty(
  'exact match is preferred over substring match',
  exactKey,
  (key) => {
    const result = getProfileValue(key, FULL_PROFILE);
    const expected = expectedValue(key, FULL_PROFILE);
    return result === expected;
  }
);

/**
 * Property 2b (decorated): Same as above but with whitespace padding
 * and trailing asterisks — getProfileValue normalises these away,
 * so the exact-match result should still hold.
 *
 * **Validates: Design §2 (getProfileValue)**
 */
runProperty(
  'exact match preferred even with whitespace/asterisk decoration',
  decoratedKey,
  (label) => {
    const normalised = label.toLowerCase().trim().replace(/\*+$/, '').trim();
    if (!FIELD_MAP_KEYS.includes(normalised)) return true; // skip if decoration broke the key
    const result = getProfileValue(label, FULL_PROFILE);
    const expected = expectedValue(normalised, FULL_PROFILE);
    return result === expected;
  }
);

/**
 * Property 2c: getProfileValue always returns either a string or null
 * (never undefined or other types).
 *
 * **Validates: Design §2 (getProfileValue)**
 */
runProperty(
  'getProfileValue always returns string or null',
  fc.oneof(exactKey, unmatchedLabel, fc.constant(''), fc.constant(null)),
  (label) => {
    const result = getProfileValue(label, FULL_PROFILE);
    return result === null || typeof result === 'string';
  }
);

// ── Report ───────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0 && typeof process !== 'undefined') {
  process.exitCode = 1;
}
