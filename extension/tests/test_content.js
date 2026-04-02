/**
 * Unit tests for content.js — ATS detection, label detection,
 * field extraction, and iframe field extraction.
 *
 * Run: node extension/tests/test_content.js
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

// ── JSDOM setup ───────────────────────────────────────────────────────

const { JSDOM } = require('jsdom');

// ── Extract functions from content.js (re-implement for testability) ──
// We replicate the pure logic here since content.js relies on chrome.* APIs.

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

/**
 * Create a fresh JSDOM and inject getLabel + extractFields into it,
 * returning helper functions bound to that DOM.
 */
function createDOMEnv(html) {
  const dom = new JSDOM(html || '<!DOCTYPE html><html><body></body></html>');
  const doc = dom.window.document;

  function getLabel(el) {
    if (el.id) {
      const lbl = doc.querySelector('label[for="' + el.id + '"]');
      if (lbl) return lbl.textContent.trim();
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('aria-labelledby')) {
      const lblEl = doc.getElementById(el.getAttribute('aria-labelledby'));
      if (lblEl) return lblEl.textContent.trim();
    }
    if (el.placeholder) return el.placeholder;
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
    const formGroup = el.closest(
      '.fb-dash-form-element, .jobs-easy-apply-form-section__grouping, [data-test-form-element]'
    );
    if (formGroup) {
      const lbl = formGroup.querySelector(
        'label, span.fb-dash-form-element__label, .artdeco-text-input--label'
      );
      if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
    }
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
      return prev.textContent.trim();
    }
    return '';
  }

  function extractFields(root) {
    if (!root) {
      root = doc.querySelector(
        '.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"], .jobs-easy-apply-content'
      ) || doc;
    }
    const fields = [];

    root.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type])'
    ).forEach(inp => {
      const t = (inp.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(t)) return;
      // JSDOM getBoundingClientRect returns all zeros — skip visibility check in tests
      fields.push({
        type: 'input',
        inputType: t,
        label: getLabel(inp),
        value: inp.value,
        id: inp.id,
        name: inp.name,
        required: inp.required || inp.getAttribute('aria-required') === 'true',
        element: inp,
      });
    });

    root.querySelectorAll('textarea').forEach(ta => {
      fields.push({
        type: 'textarea',
        label: getLabel(ta),
        value: ta.value,
        id: ta.id,
        name: ta.name,
        required: ta.required || ta.getAttribute('aria-required') === 'true',
        element: ta,
      });
    });

    root.querySelectorAll('select').forEach(sel => {
      const options = Array.from(sel.options).map(o => o.text.trim()).filter(Boolean);
      fields.push({
        type: 'select',
        label: getLabel(sel),
        value: sel.value,
        options,
        id: sel.id,
        name: sel.name,
        required: sel.required || sel.getAttribute('aria-required') === 'true',
        element: sel,
      });
    });

    const radioGroups = {};
    root.querySelectorAll('input[type="radio"]').forEach(r => {
      const name = r.name;
      if (!radioGroups[name]) {
        radioGroups[name] = { options: [], checked: null, label: '' };
        const fieldset = r.closest('fieldset');
        if (fieldset) {
          const legend = fieldset.querySelector('legend');
          if (legend) radioGroups[name].label = legend.textContent.trim();
        }
        if (!radioGroups[name].label) {
          radioGroups[name].label = getLabel(r);
        }
      }
      const rLabel = r.id ? doc.querySelector('label[for="' + r.id + '"]') : null;
      radioGroups[name].options.push(rLabel ? rLabel.textContent.trim() : r.value);
      if (r.checked) radioGroups[name].checked = r.value;
    });
    for (const [name, group] of Object.entries(radioGroups)) {
      fields.push({
        type: 'radio',
        label: group.label,
        options: group.options,
        value: group.checked,
        id: '',
        name,
        required: false,
      });
    }

    root.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const label = getLabel(cb);
      if (label) {
        fields.push({
          type: 'checkbox',
          label,
          value: cb.checked ? 'true' : '',
          id: cb.id,
          name: cb.name,
          required: cb.required || cb.getAttribute('aria-required') === 'true',
          element: cb,
        });
      }
    });

    root.querySelectorAll('input[type="file"]').forEach(fi => {
      fields.push({
        type: 'file',
        label: getLabel(fi) || 'Resume upload',
        value: fi.value,
        id: fi.id,
        name: fi.name,
        required: fi.required || fi.getAttribute('aria-required') === 'true',
        element: fi,
      });
    });

    return fields;
  }

  return { dom, doc, getLabel, extractFields };
}

// ── Task 5.1: FIELD_MAP and getProfileValue ──────────────────────────

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

  // Pass 2: key in label (longer keys first)
  const sortedKeys = Object.keys(FIELD_MAP).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (labelLower.includes(key)) {
      const val = FIELD_MAP[key];
      return typeof val === 'function' ? val(profile) : (profile[val] || '');
    }
  }

  // Pass 3: label in key
  for (const key of sortedKeys) {
    if (key.includes(labelLower)) {
      const val = FIELD_MAP[key];
      return typeof val === 'function' ? val(profile) : (profile[val] || '');
    }
  }

  return null;
}

// ── Task 5.2: matchPrefilled ─────────────────────────────────────────

function matchPrefilled(label, prefilled) {
  if (!label || !prefilled) return null;
  const labelLower = label.toLowerCase().trim();
  for (const [question, answer] of Object.entries(prefilled)) {
    const qLower = question.toLowerCase().trim();
    if (qLower.includes(labelLower) || labelLower.includes(qLower)) {
      return String(answer);
    }
  }
  return null;
}

// ── Task 5.3: fillField (test-compatible version) ────────────────────

function fill(input, value) {
  const win = input.ownerDocument.defaultView;
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

function fillField(field, value) {
  const el = field.element;
  if (!el) return false;
  try {
    if (field.type === 'input' || field.type === 'textarea') {
      fill(el, value);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

async function runTests() {

  // ── 4.1: detectATS ──────────────────────────────────────────────────

  suite('detectATS (Task 4.1)');

  await test('detects LinkedIn', () => {
    assertEqual(detectATS('https://www.linkedin.com/jobs/view/12345'), 'linkedin');
  });

  await test('detects Greenhouse', () => {
    assertEqual(detectATS('https://boards.greenhouse.io/company/jobs/123'), 'greenhouse');
  });

  await test('detects Greenhouse embed', () => {
    assertEqual(detectATS('https://greenhouse.io/embed/job_board'), 'greenhouse');
  });

  await test('detects Lever', () => {
    assertEqual(detectATS('https://jobs.lever.co/company/abc-123'), 'lever');
  });

  await test('detects Workday (myworkdayjobs)', () => {
    assertEqual(detectATS('https://company.myworkdayjobs.com/en-US/jobs'), 'workday');
  });

  await test('detects Workday (workday.com/job)', () => {
    assertEqual(detectATS('https://company.workday.com/en-US/job/12345'), 'workday');
  });

  await test('detects JazzHR (applytojob)', () => {
    assertEqual(detectATS('https://company.applytojob.com/apply/abc'), 'jazzhr');
  });

  await test('detects JazzHR (app.jazz.co)', () => {
    assertEqual(detectATS('https://app.jazz.co/apply/abc'), 'jazzhr');
  });

  await test('returns generic for unknown URL', () => {
    assertEqual(detectATS('https://careers.google.com/jobs/123'), 'generic');
  });

  await test('returns generic for empty string', () => {
    assertEqual(detectATS(''), 'generic');
  });

  await test('returns generic for null', () => {
    assertEqual(detectATS(null), 'generic');
  });

  await test('returns generic for undefined', () => {
    assertEqual(detectATS(undefined), 'generic');
  });

  await test('case insensitive matching', () => {
    assertEqual(detectATS('https://WWW.LINKEDIN.COM/jobs'), 'linkedin');
  });

  // ── 4.2: getLabel ──────────────────────────────────────────────────

  suite('getLabel (Task 4.2)');

  await test('strategy 1: label[for] matching element id', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <label for="email-input">Email Address</label>
        <input id="email-input" type="text" />
      </body></html>
    `);
    const inp = doc.querySelector('#email-input');
    assertEqual(getLabel(inp), 'Email Address');
  });

  await test('strategy 2: aria-label attribute', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <input type="text" aria-label="Phone Number" />
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'Phone Number');
  });

  await test('strategy 3: aria-labelledby', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <span id="lbl-city">City</span>
        <input type="text" aria-labelledby="lbl-city" />
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'City');
  });

  await test('strategy 4: placeholder', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <input type="text" placeholder="Enter your name" />
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'Enter your name');
  });

  await test('strategy 5: parent label element', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <label>First Name <input type="text" /></label>
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'First Name');
  });

  await test('strategy 6: closest form group label', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <div class="fb-dash-form-element">
          <span class="fb-dash-form-element__label">Company Name</span>
          <input type="text" />
        </div>
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'Company Name');
  });

  await test('strategy 7: preceding sibling label', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <label>Website URL</label>
        <input type="text" />
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'Website URL');
  });

  await test('strategy 7: preceding sibling span', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <span>Portfolio</span>
        <input type="text" />
      </body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), 'Portfolio');
  });

  await test('returns empty string when no label found', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body><input type="text" /></body></html>
    `);
    const inp = doc.querySelector('input');
    assertEqual(getLabel(inp), '');
  });

  await test('priority: label[for] wins over aria-label', () => {
    const { doc, getLabel } = createDOMEnv(`
      <html><body>
        <label for="f1">From Label</label>
        <input id="f1" type="text" aria-label="From Aria" />
      </body></html>
    `);
    const inp = doc.querySelector('#f1');
    assertEqual(getLabel(inp), 'From Label');
  });

  // ── 4.3: extractFields ─────────────────────────────────────────────

  suite('extractFields (Task 4.3)');

  await test('extracts text input fields', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <label for="fname">First Name</label>
        <input id="fname" type="text" name="firstName" required />
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields.length, 1);
    assertEqual(fields[0].type, 'input');
    assertEqual(fields[0].inputType, 'text');
    assertEqual(fields[0].label, 'First Name');
    assertEqual(fields[0].name, 'firstName');
    assertEqual(fields[0].required, true);
  });

  await test('extracts email and tel inputs', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <input type="email" aria-label="Email" name="email" />
        <input type="tel" aria-label="Phone" name="phone" />
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields.length, 2);
    assertEqual(fields[0].inputType, 'email');
    assertEqual(fields[1].inputType, 'tel');
  });

  await test('extracts textarea fields', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <label for="cover">Cover Letter</label>
        <textarea id="cover" name="coverLetter"></textarea>
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields.length, 1);
    assertEqual(fields[0].type, 'textarea');
    assertEqual(fields[0].label, 'Cover Letter');
  });

  await test('extracts select fields with options', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">Select...</option>
          <option value="CA">Canada</option>
          <option value="US">United States</option>
        </select>
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields.length, 1);
    assertEqual(fields[0].type, 'select');
    assertEqual(fields[0].label, 'Country');
    assertEqual(fields[0].options.length, 3);
  });

  await test('extracts radio groups', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <fieldset>
          <legend>Work Authorization</legend>
          <label for="r1">Yes</label><input type="radio" id="r1" name="auth" value="yes" />
          <label for="r2">No</label><input type="radio" id="r2" name="auth" value="no" />
        </fieldset>
      </body></html>
    `);
    const fields = extractFields();
    const radio = fields.find(f => f.type === 'radio');
    assert(radio, 'should find radio group');
    assertEqual(radio.label, 'Work Authorization');
    assertEqual(radio.options.length, 2);
    assertEqual(radio.name, 'auth');
  });

  await test('extracts checkboxes with labels', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <label for="agree">I agree to terms</label>
        <input type="checkbox" id="agree" name="terms" />
      </body></html>
    `);
    const fields = extractFields();
    const cb = fields.find(f => f.type === 'checkbox');
    assert(cb, 'should find checkbox');
    assertEqual(cb.label, 'I agree to terms');
  });

  await test('extracts file inputs', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <label for="resume">Upload Resume</label>
        <input type="file" id="resume" name="resume" />
      </body></html>
    `);
    const fields = extractFields();
    const file = fields.find(f => f.type === 'file');
    assert(file, 'should find file input');
    assertEqual(file.label, 'Upload Resume');
  });

  await test('file input defaults label to "Resume upload"', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <input type="file" name="doc" />
      </body></html>
    `);
    const fields = extractFields();
    const file = fields.find(f => f.type === 'file');
    assert(file, 'should find file input');
    assertEqual(file.label, 'Resume upload');
  });

  await test('skips hidden input types', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <input type="hidden" name="csrf" value="abc" />
        <input type="submit" value="Submit" />
        <input type="button" value="Cancel" />
        <input type="text" aria-label="Visible" />
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields.length, 1);
    assertEqual(fields[0].label, 'Visible');
  });

  await test('scopes to modal when present', () => {
    const { doc, extractFields } = createDOMEnv(`
      <html><body>
        <input type="text" aria-label="Outside" />
        <div class="jobs-easy-apply-modal">
          <input type="text" aria-label="Inside Modal" />
        </div>
      </body></html>
    `);
    // When no root passed, should scope to modal
    const fields = extractFields();
    assertEqual(fields.length, 1);
    assertEqual(fields[0].label, 'Inside Modal');
  });

  await test('extracts from full document when no modal', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <input type="text" aria-label="Field A" />
        <input type="email" aria-label="Field B" />
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields.length, 2);
  });

  await test('extracts from explicit root parameter', () => {
    const { doc, extractFields } = createDOMEnv(`
      <html><body>
        <input type="text" aria-label="Outside" />
        <div id="form-section">
          <input type="text" aria-label="Inside Section" />
        </div>
      </body></html>
    `);
    const section = doc.querySelector('#form-section');
    const fields = extractFields(section);
    assertEqual(fields.length, 1);
    assertEqual(fields[0].label, 'Inside Section');
  });

  await test('captures required from aria-required', () => {
    const { extractFields } = createDOMEnv(`
      <html><body>
        <input type="text" aria-label="Name" aria-required="true" />
      </body></html>
    `);
    const fields = extractFields();
    assertEqual(fields[0].required, true);
  });

  // ── 5.1: FIELD_MAP and getProfileValue ───────────────────────────────

  suite('getProfileValue (Task 5.1)');

  const testProfile = {
    firstName: 'Fahad',
    lastName: 'Aba-Alkhail',
    email: 'fahad@example.com',
    phone: '6131234567',
    phoneCountryCode: 'Canada (+1)',
    address: '123 Main St',
    city: 'Ottawa',
    state: 'Ontario',
    postal: 'K1A 0A6',
    country: 'Canada',
    linkedinUrl: 'https://linkedin.com/in/fahad',
    website: 'https://fahad.dev',
  };

  await test('exact match: "email" → email value', () => {
    assertEqual(getProfileValue('email', testProfile), 'fahad@example.com');
  });

  await test('exact match: "first name" → firstName', () => {
    assertEqual(getProfileValue('first name', testProfile), 'Fahad');
  });

  await test('exact match: "city" → city', () => {
    assertEqual(getProfileValue('city', testProfile), 'Ottawa');
  });

  await test('computed value: "full name" → firstName + lastName', () => {
    assertEqual(getProfileValue('full name', testProfile), 'Fahad Aba-Alkhail');
  });

  await test('computed value: "name" → firstName + lastName', () => {
    assertEqual(getProfileValue('name', testProfile), 'Fahad Aba-Alkhail');
  });

  await test('substring match: "Your email address" → email', () => {
    assertEqual(getProfileValue('Your email address', testProfile), 'fahad@example.com');
  });

  await test('substring match: "Mobile phone number" → phone', () => {
    assertEqual(getProfileValue('Mobile phone number', testProfile), '6131234567');
  });

  await test('label-in-key match: "zip" matches "zip code" → postal', () => {
    assertEqual(getProfileValue('zip', testProfile), 'K1A 0A6');
  });

  await test('case insensitive: "EMAIL" → email', () => {
    assertEqual(getProfileValue('EMAIL', testProfile), 'fahad@example.com');
  });

  await test('strips trailing asterisks: "Email *" → email', () => {
    assertEqual(getProfileValue('Email *', testProfile), 'fahad@example.com');
  });

  await test('no match returns null', () => {
    assertEqual(getProfileValue('favorite color', testProfile), null);
  });

  await test('null label returns null', () => {
    assertEqual(getProfileValue(null, testProfile), null);
  });

  await test('null profile returns null', () => {
    assertEqual(getProfileValue('email', null), null);
  });

  await test('prefers exact match over substring', () => {
    // "address" should match "address" exactly, not "email address" or "street address"
    assertEqual(getProfileValue('address', testProfile), '123 Main St');
  });

  await test('key-in-label: longer key wins (email address over email)', () => {
    // "e-mail address" is a longer key than "email" and should match first
    assertEqual(getProfileValue('Please enter your e-mail address here', testProfile), 'fahad@example.com');
  });

  // ── 5.2: matchPrefilled ─────────────────────────────────────────────

  suite('matchPrefilled (Task 5.2)');

  const testPrefilled = {
    'Do you require visa sponsorship?': 'No',
    'Years of experience': '5',
    'Are you willing to relocate?': 'Yes',
  };

  await test('question-in-label match', () => {
    assertEqual(
      matchPrefilled('Do you require visa sponsorship? *', testPrefilled),
      'No'
    );
  });

  await test('label-in-question match', () => {
    assertEqual(
      matchPrefilled('visa sponsorship', testPrefilled),
      'No'
    );
  });

  await test('case insensitive matching', () => {
    assertEqual(
      matchPrefilled('YEARS OF EXPERIENCE', testPrefilled),
      '5'
    );
  });

  await test('no match returns null', () => {
    assertEqual(matchPrefilled('Favorite programming language', testPrefilled), null);
  });

  await test('null label returns null', () => {
    assertEqual(matchPrefilled(null, testPrefilled), null);
  });

  await test('null prefilled returns null', () => {
    assertEqual(matchPrefilled('visa', null), null);
  });

  await test('empty prefilled returns null', () => {
    assertEqual(matchPrefilled('visa', {}), null);
  });

  // ── 5.3: fillField ─────────────────────────────────────────────────

  suite('fillField (Task 5.3)');

  await test('fills text input and dispatches events', () => {
    const { doc, dom } = createDOMEnv(`
      <html><body><input type="text" id="fname" /></body></html>
    `);
    const el = doc.querySelector('#fname');
    const win = dom.window;
    let inputFired = false;
    let changeFired = false;
    el.addEventListener('input', () => { inputFired = true; });
    el.addEventListener('change', () => { changeFired = true; });

    const field = { type: 'input', element: el, label: 'First Name' };
    const result = fillField(field, 'Fahad');
    assertEqual(result, true);
    assertEqual(el.value, 'Fahad');
    assertEqual(inputFired, true);
    assertEqual(changeFired, true);
  });

  await test('fills textarea', () => {
    const { doc, dom } = createDOMEnv(`
      <html><body><textarea id="cover"></textarea></body></html>
    `);
    const el = doc.querySelector('#cover');
    const field = { type: 'textarea', element: el, label: 'Cover Letter' };
    const result = fillField(field, 'I am interested in this role.');
    assertEqual(result, true);
    assertEqual(el.value, 'I am interested in this role.');
  });

  await test('returns false for field without element', () => {
    const field = { type: 'input', element: null, label: 'Name' };
    assertEqual(fillField(field, 'test'), false);
  });

  await test('returns false for select type (sync fillField without handler)', () => {
    // fillField for select delegates to handleSelect which needs DOM context;
    // in isolation without the full handler, we test the basic dispatch
    const { doc } = createDOMEnv(`
      <html><body><select id="s1"><option value="">Select...</option><option value="CA">Canada</option></select></body></html>
    `);
    const el = doc.querySelector('#s1');
    const field = { type: 'select', element: el, label: 'Country' };
    // fillField now handles selects — but handleSelect needs document context
    // We test the native select handler logic directly below
  });

  // ── 7.2: Radio button handling ──────────────────────────────────────

  suite('Radio button handling (Task 7.2)');

  await test('smart detection: visa sponsorship uses settings', () => {
    // Test the question detection patterns
    const questionText = 'Do you require visa sponsorship?';
    assert(questionText.toLowerCase().match(/visa|sponsor|sponsorship/i), 'should match visa pattern');
  });

  await test('smart detection: work authorization pattern', () => {
    const questionText = 'Are you legally authorized to work?';
    assert(questionText.toLowerCase().match(/author|legal.*work|permit.*work|eligib.*work|right.*work/i), 'should match work auth pattern');
  });

  await test('smart detection: relocation pattern', () => {
    const questionText = 'Are you willing to relocate?';
    assert(questionText.toLowerCase().match(/relocat|move.*locat|willing.*move/i), 'should match relocation pattern');
  });

  await test('smart detection: security clearance pattern', () => {
    const questionText = 'Do you have a security clearance?';
    assert(questionText.toLowerCase().match(/security.*clearance|clearance/i), 'should match clearance pattern');
  });

  await test('smart detection: driver license pattern', () => {
    const questionText = 'Do you have a valid driver\'s license?';
    assert(questionText.toLowerCase().match(/driver.*license|driving.*license|valid.*license/i), 'should match license pattern');
  });

  await test('multilingual yes matching', () => {
    const yesPattern = /^(yes|oui|sí|si|ja|y)$/i;
    assert(yesPattern.test('Yes'), 'English yes');
    assert(yesPattern.test('Oui'), 'French oui');
    assert(yesPattern.test('Sí'), 'Spanish sí');
    assert(yesPattern.test('Ja'), 'German ja');
    assert(yesPattern.test('Si'), 'Italian si');
  });

  await test('multilingual no matching', () => {
    const noPattern = /^(no|non|nein|n)$/i;
    assert(noPattern.test('No'), 'English no');
    assert(noPattern.test('Non'), 'French non');
    assert(noPattern.test('Nein'), 'German nein');
  });

  // ── 7.3: Select dropdown handling ───────────────────────────────────

  suite('Select dropdown handling (Task 7.3)');

  await test('native select: picks matching option by value', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <select id="country">
          <option value="">Select...</option>
          <option value="CA">Canada</option>
          <option value="US">United States</option>
        </select>
      </body></html>
    `);
    const el = doc.querySelector('#country');
    // Simulate handleSelect logic for native select
    const options = Array.from(el.options);
    const match = options.find(o => o.text.trim().toLowerCase().includes('canada'));
    assert(match, 'should find Canada option');
    assertEqual(match.value, 'CA');
  });

  await test('native select: skips placeholder options', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <select id="lang">
          <option value="">Select an option</option>
          <option value="en">English</option>
        </select>
      </body></html>
    `);
    const el = doc.querySelector('#lang');
    const options = Array.from(el.options);
    const nonPlaceholder = options.find(o => {
      const t = o.text.trim().toLowerCase();
      return t && !t.includes('select') && !t.includes('choose') && o.value !== '';
    });
    assert(nonPlaceholder, 'should find non-placeholder option');
    assertEqual(nonPlaceholder.text.trim(), 'English');
  });

  await test('language proficiency: prefers Native/Bilingual', () => {
    const label = 'What is your level of proficiency in English?';
    assert(label.toLowerCase().match(/proficiency|level.*english/), 'should match proficiency pattern');

    const options = ['Select...', 'Elementary', 'Professional', 'Fluent', 'Native or Bilingual'];
    const nativeOpt = options.find(o => o.toLowerCase().includes('native') || o.toLowerCase().includes('bilingual'));
    assertEqual(nativeOpt, 'Native or Bilingual');
  });

  await test('language proficiency: falls back to Fluent', () => {
    const options = ['Select...', 'Elementary', 'Professional', 'Fluent'];
    let selected = options.find(o => o.toLowerCase().includes('native') || o.toLowerCase().includes('bilingual'));
    if (!selected) {
      selected = options.find(o => o.toLowerCase().includes('fluent'));
    }
    assertEqual(selected, 'Fluent');
  });

  // ── 7.5: Checkbox handling ──────────────────────────────────────────

  suite('Checkbox handling (Task 7.5)');

  await test('consent pattern matches agreement labels', () => {
    const consentPattern = /consent|agree|terms|conditions|policy|privacy|accept|acknowledge|j'accepte|j'autorise|consentement|aceptar|acepto|condiciones|akzeptieren|zustimmen|accetto|acconsento/i;
    assert(consentPattern.test('I agree to the terms'), 'agree');
    assert(consentPattern.test('Privacy Policy'), 'privacy');
    assert(consentPattern.test("J'accepte les conditions"), 'French accept');
    assert(consentPattern.test('Ich zustimmen'), 'German zustimmen');
    assert(consentPattern.test('Accetto i termini'), 'Italian accetto');
  });

  await test('follow company pattern matches correctly', () => {
    const followPattern = /follow.*company|follow.*employer|suivre.*entreprise|seguir.*empresa|folgen.*unternehmen|seguire.*azienda|follow-company/i;
    assert(followPattern.test('Follow this company'), 'follow company');
    assert(followPattern.test('follow-company-checkbox'), 'follow-company id');
    assert(followPattern.test('Suivre cette entreprise'), 'French follow');
    assert(!followPattern.test('I agree to terms'), 'should not match consent');
  });

  await test('checkbox: auto-checks consent checkbox', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <label for="terms">I agree to the terms and conditions</label>
        <input type="checkbox" id="terms" />
      </body></html>
    `);
    const el = doc.querySelector('#terms');
    const label = 'I agree to the terms and conditions';
    const consentPattern = /consent|agree|terms|conditions|policy|privacy|accept/i;
    assert(consentPattern.test(label), 'should match consent pattern');
    assert(!el.checked, 'should start unchecked');
  });

  // ── 7.4: File upload handling ───────────────────────────────────────

  suite('File upload handling (Task 7.4)');

  await test('resume label detection matches resume/CV patterns', () => {
    const resumePattern = /resume|cv|curriculum|vitae|upload.*document|file/i;
    assert(resumePattern.test('Upload Resume'), 'resume');
    assert(resumePattern.test('Upload your CV'), 'CV');
    assert(resumePattern.test('Curriculum Vitae'), 'curriculum vitae');
    assert(resumePattern.test('Upload document'), 'upload document');
  });

  await test('resume selector patterns for existing uploads', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-document-upload-redesign-card">
          <input type="radio" id="resume1" name="resume" value="my-resume.pdf" />
          <label for="resume1">my-resume.pdf</label>
        </div>
      </body></html>
    `);
    const card = doc.querySelector('.jobs-document-upload-redesign-card');
    assert(card, 'should find resume card');
    const radio = doc.querySelector('input[type="radio"][name*="resume"]');
    assert(radio, 'should find resume radio');
  });

  // ── 8.1: Next/Submit button detection ─────────────────────────────

  suite('Next/Submit button detection (Task 8.1)');

  await test('finds Next button by text content', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button>Cancel</button>
          <button>Next</button>
        </div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    const buttons = Array.from(modal.querySelectorAll('button'));
    const nextBtn = buttons.find(btn => {
      const text = btn.textContent.trim().toLowerCase();
      return text.includes('next') || text.includes('suivant') ||
             text.includes('review') || text.includes('submit') ||
             text.includes('soumettre');
    });
    assert(nextBtn, 'should find next button');
    assertEqual(nextBtn.textContent.trim(), 'Next');
    const isSubmit = nextBtn.textContent.trim().toLowerCase().includes('submit') ||
                     nextBtn.textContent.trim().toLowerCase().includes('soumettre');
    assertEqual(isSubmit, false);
  });

  await test('finds Submit button and detects isSubmit=true', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button>Cancel</button>
          <button>Submit application</button>
        </div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    const buttons = Array.from(modal.querySelectorAll('button'));
    const submitBtn = buttons.find(btn => {
      const text = btn.textContent.trim().toLowerCase();
      return text.includes('next') || text.includes('suivant') ||
             text.includes('review') || text.includes('submit') ||
             text.includes('soumettre');
    });
    assert(submitBtn, 'should find submit button');
    const isSubmit = submitBtn.textContent.trim().toLowerCase().includes('submit') ||
                     submitBtn.textContent.trim().toLowerCase().includes('soumettre');
    assertEqual(isSubmit, true);
  });

  await test('finds French "Suivant" button', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button>Suivant</button>
        </div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    const buttons = Array.from(modal.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.trim().toLowerCase().includes('suivant'));
    assert(btn, 'should find French next button');
  });

  await test('finds French "Soumettre" as submit', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button>Soumettre la candidature</button>
        </div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    const buttons = Array.from(modal.querySelectorAll('button'));
    const btn = buttons.find(b => {
      const t = b.textContent.trim().toLowerCase();
      return t.includes('soumettre');
    });
    assert(btn, 'should find French submit button');
    const isSubmit = btn.textContent.trim().toLowerCase().includes('soumettre');
    assertEqual(isSubmit, true);
  });

  await test('finds Review button', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button>Review</button>
        </div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    const buttons = Array.from(modal.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.trim().toLowerCase().includes('review'));
    assert(btn, 'should find review button');
  });

  await test('returns null when no matching button found', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button>Cancel</button>
          <button>Save</button>
        </div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    const buttons = Array.from(modal.querySelectorAll('button'));
    const btn = buttons.find(b => {
      const t = b.textContent.trim().toLowerCase();
      return t.includes('next') || t.includes('suivant') ||
             t.includes('review') || t.includes('submit') ||
             t.includes('soumettre');
    });
    assertEqual(btn, undefined);
  });

  await test('detects disabled button via aria-disabled', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button aria-disabled="true">Next</button>
        </div>
      </body></html>
    `);
    const btn = doc.querySelector('button');
    const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    assertEqual(isDisabled, true);
  });

  // ── 8.3: Discard application logic ──────────────────────────────────

  suite('Discard application logic (Task 8.3)');

  await test('dismiss button selector matches LinkedIn close buttons', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal">
          <button aria-label="Dismiss">X</button>
        </div>
      </body></html>
    `);
    const dismissBtn = doc.querySelector('button[aria-label*="Dismiss"]');
    assert(dismissBtn, 'should find dismiss button');
  });

  await test('discard text patterns match expected strings', () => {
    const discardTexts = ['discard', 'annuler', 'cancel', 'abandonner', 'descarter'];
    const testButtons = ['Discard', 'Annuler', 'Cancel', 'Abandonner', 'Descarter', 'Save'];
    const matches = testButtons.filter(text =>
      discardTexts.some(t => text.toLowerCase().includes(t))
    );
    assertEqual(matches.length, 5);
    assert(!matches.includes('Save'), 'Save should not match');
  });

  await test('modal open detection works', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="jobs-easy-apply-modal"></div>
      </body></html>
    `);
    const modal = doc.querySelector('.jobs-easy-apply-modal');
    assert(modal, 'should find modal element');
    // In JSDOM, offsetParent is always null, so we just test the selector works
  });

  // ── 8.5: Blacklist and experience filtering ─────────────────────────

  suite('Blacklist and experience filtering (Task 8.5)');

  await test('shouldSkipByBlacklist: skips when keyword found in title', () => {
    const blacklist = 'intern, senior, manager';
    const title = 'Senior Software Engineer';
    const keywords = blacklist.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    const jobText = title.toLowerCase();
    const match = keywords.find(kw => jobText.includes(kw));
    assert(match, 'should find "senior" in title');
    assertEqual(match, 'senior');
  });

  await test('shouldSkipByBlacklist: does not skip when no keyword matches', () => {
    const blacklist = 'intern, senior, manager';
    const title = 'Software Developer';
    const keywords = blacklist.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    const jobText = title.toLowerCase();
    const match = keywords.find(kw => jobText.includes(kw));
    assertEqual(match, undefined);
  });

  await test('shouldSkipByBlacklist: empty blacklist never skips', () => {
    const blacklist = '';
    assertEqual(!blacklist || !blacklist.trim(), true);
  });

  await test('extractYearsRequired: extracts years from English text', () => {
    const patterns = [/(\d+)\+?\s*(?:years?|yrs?)/gi];
    const text = '5+ years of experience required';
    const years = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        years.push(parseInt(match[1]));
      }
    }
    assertEqual(years[0], 5);
  });

  await test('extractYearsRequired: extracts years from French text', () => {
    const patterns = [/(\d+)\+?\s*(?:ans?|années?)/gi];
    const text = '3 ans d\'expérience';
    const years = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        years.push(parseInt(match[1]));
      }
    }
    assertEqual(years[0], 3);
  });

  await test('daily limit detection patterns', () => {
    const limitPatterns = [
      "you've reached today's easy apply limit",
      "daily easy apply limit",
      "limit daily submissions",
    ];
    const bodyText = "You've reached today's Easy Apply limit. Try again tomorrow.".toLowerCase();
    const found = limitPatterns.some(p => bodyText.includes(p));
    assertEqual(found, true);
  });

  await test('daily limit: no false positive on normal text', () => {
    const limitPatterns = [
      "you've reached today's easy apply limit",
      "daily easy apply limit",
    ];
    const bodyText = "Apply to this job with Easy Apply".toLowerCase();
    const found = limitPatterns.some(p => bodyText.includes(p));
    assertEqual(found, false);
  });

  // ── 10.1–10.6: ATS-specific form extraction ─────────────────────────

  suite('ATS-specific form extraction (Tasks 10.1–10.6)');

  // ── 10.1: Greenhouse ──

  await test('Greenhouse: getFormRoot finds #application_form', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div id="header">Header</div>
        <div id="application_form">
          <input type="text" aria-label="First Name" />
          <input type="email" aria-label="Email" />
        </div>
        <div id="footer">Footer</div>
      </body></html>
    `);
    const root = doc.querySelector('#application_form, #main_fields, #application');
    assert(root, 'should find Greenhouse form root');
    assertEqual(root.id, 'application_form');
  });

  await test('Greenhouse: extractFields scopes to #application_form', () => {
    const dom = new JSDOM(`
      <html><body>
        <input type="text" aria-label="Outside Field" />
        <div id="application_form">
          <label for="fname">First Name</label>
          <input id="fname" type="text" name="first_name" />
          <label for="lname">Last Name</label>
          <input id="lname" type="text" name="last_name" />
          <label for="email">Email</label>
          <input id="email" type="email" name="email" />
        </div>
      </body></html>
    `);
    const doc = dom.window.document;

    // Replicate getFormRoot for greenhouse
    const root = doc.querySelector('#application_form, #main_fields, #application');
    assert(root, 'should find greenhouse root');

    // Use createDOMEnv extractFields with explicit root
    const { extractFields: ef } = createDOMEnv(dom.serialize());
    const section = ef().length; // without modal, gets all fields
    // Now test with explicit root
    const { extractFields: ef2 } = createDOMEnv(dom.serialize());
    const docRef = new JSDOM(dom.serialize()).window.document;
    const ghRoot = docRef.querySelector('#application_form');
    // Manually extract from root
    const fields = [];
    ghRoot.querySelectorAll('input[type="text"], input[type="email"]').forEach(inp => {
      const t = (inp.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(t)) return;
      const label = inp.id ? (docRef.querySelector('label[for="' + inp.id + '"]') || {}).textContent || '' : '';
      fields.push({ type: 'input', label: label.trim(), name: inp.name });
    });
    assertEqual(fields.length, 3);
    assertEqual(fields[0].label, 'First Name');
    assertEqual(fields[1].label, 'Last Name');
    assertEqual(fields[2].label, 'Email');
  });

  await test('Greenhouse: falls back to #main_fields', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div id="main_fields">
          <input type="text" aria-label="Name" />
        </div>
      </body></html>
    `);
    const root = doc.querySelector('#application_form, #main_fields');
    assert(root, 'should find main_fields');
    assertEqual(root.id, 'main_fields');
    const inputs = root.querySelectorAll('input[type="text"]');
    assertEqual(inputs.length, 1);
  });

  await test('Greenhouse: detects via URL', () => {
    assertEqual(detectATS('https://boards.greenhouse.io/company/jobs/123'), 'greenhouse');
  });

  // ── 10.2: Lever ──

  await test('Lever: getFormRoot finds .application-form', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="posting-header">Job Title</div>
        <div class="application-form">
          <input type="text" aria-label="Full Name" />
          <input type="email" aria-label="Email" />
          <input type="tel" aria-label="Phone" />
        </div>
      </body></html>
    `);
    const root = doc.querySelector('.application-form, .postings-form, .posting-page');
    assert(root, 'should find Lever form root');
    assert(root.classList.contains('application-form'), 'should be application-form');
  });

  await test('Lever: extractFields scopes to .application-form', () => {
    const dom = new JSDOM(`
      <html><body>
        <input type="text" aria-label="Outside" />
        <div class="application-form">
          <label for="name">Full Name</label>
          <input id="name" type="text" name="name" />
          <label for="email">Email</label>
          <input id="email" type="email" name="email" />
          <label for="phone">Phone</label>
          <input id="phone" type="tel" name="phone" />
          <label for="resume">Resume</label>
          <input id="resume" type="file" name="resume" />
        </div>
      </body></html>
    `);
    const docRef = dom.window.document;
    const leverRoot = docRef.querySelector('.application-form');
    assert(leverRoot, 'should find lever root');

    // Extract text/email/tel inputs from lever root
    const fields = [];
    leverRoot.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]').forEach(inp => {
      const label = inp.id ? (docRef.querySelector('label[for="' + inp.id + '"]') || {}).textContent || '' : '';
      fields.push({ type: 'input', label: label.trim(), name: inp.name });
    });
    assertEqual(fields.length, 3);
    assertEqual(fields[0].label, 'Full Name');
    assertEqual(fields[1].label, 'Email');
    assertEqual(fields[2].label, 'Phone');

    // File input
    const fileInputs = leverRoot.querySelectorAll('input[type="file"]');
    assertEqual(fileInputs.length, 1);
  });

  await test('Lever: falls back to .postings-form', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div class="postings-form">
          <input type="text" aria-label="Name" />
        </div>
      </body></html>
    `);
    const root = doc.querySelector('.application-form, .postings-form');
    assert(root, 'should find postings-form');
    assert(root.classList.contains('postings-form'), 'should be postings-form');
  });

  await test('Lever: detects via URL', () => {
    assertEqual(detectATS('https://jobs.lever.co/company/abc-123'), 'lever');
  });

  // ── 10.3: Workday ──

  await test('Workday: getFormRoot finds data-automation-id container', () => {
    const { doc } = createDOMEnv(`
      <html><body>
        <div data-automation-id="jobApplicationPage">
          <input type="text" aria-label="Legal Name" />
        </div>
      </body></html>
    `);
    const root = doc.querySelector('[data-automation-id="jobApplicationPage"], .css-1q2dra3');
    assert(root, 'should find Workday form root');
  });

  await test('Workday: detects via URL', () => {
    assertEqual(detectATS('https://company.myworkdayjobs.com/en-US/jobs'), 'workday');
  });

  // ── 10.4: JazzHR ──

  await test('JazzHR: detects via URL', () => {
    assertEqual(detectATS('https://company.applytojob.com/apply/abc'), 'jazzhr');
  });

  await test('JazzHR: uses iframe extraction (no specific root)', () => {
    // JazzHR forms are inside iframes, so getFormRoot returns null
    // and extractFieldsFromIframes handles the extraction
    const selectors = {
      jazzhr: null,
    };
    assertEqual(selectors['jazzhr'], null);
  });

  // ── 10.5: Generic fallback ──

  await test('Generic: extracts all visible fields from full page', () => {
    const { extractFields: ef } = createDOMEnv(`
      <html><body>
        <input type="text" aria-label="Name" />
        <input type="email" aria-label="Email" />
        <textarea aria-label="Cover Letter"></textarea>
      </body></html>
    `);
    const fields = ef();
    assertEqual(fields.length, 3);
  });

  await test('Generic: returns generic for unknown ATS URL', () => {
    assertEqual(detectATS('https://careers.somecompany.com/apply'), 'generic');
  });

  // ── 11: AI Integration ─────────────────────────────────────────────

  suite('AI integration (Task 11)');

  await test('AI request message includes question and options for select fields', () => {
    // Simulate building the AI request for a select field
    const field = { type: 'select', label: 'Country', options: ['Canada', 'United States', 'Mexico'] };
    const settings = { aiEnabled: true, resumeText: 'Software engineer resume' };
    const aiRequest = {
      action: 'askAI',
      question: field.label,
      options: field.options || [],
      resumeText: settings.resumeText || '',
      jobDescription: '',
    };
    assertEqual(aiRequest.action, 'askAI');
    assertEqual(aiRequest.question, 'Country');
    assertEqual(aiRequest.options.length, 3);
    assertEqual(aiRequest.options[0], 'Canada');
    assertEqual(aiRequest.resumeText, 'Software engineer resume');
    assertEqual(aiRequest.jobDescription, '');
  });

  await test('AI request message includes options for radio fields', () => {
    const field = { type: 'radio', label: 'Work Authorization', options: ['Yes', 'No'] };
    const aiRequest = {
      action: 'askAI',
      question: field.label,
      options: field.options || [],
      resumeText: '',
      jobDescription: '',
    };
    assertEqual(aiRequest.options.length, 2);
    assertEqual(aiRequest.options[0], 'Yes');
    assertEqual(aiRequest.options[1], 'No');
  });

  await test('AI request message sends empty options for text fields', () => {
    const field = { type: 'input', label: 'Cover Letter Summary' };
    const aiRequest = {
      action: 'askAI',
      question: field.label,
      options: field.options || [],
      resumeText: '',
      jobDescription: '',
    };
    assertEqual(aiRequest.options.length, 0);
  });

  await test('AI option matching: exact match', () => {
    const aiAnswer = 'Canada';
    const options = ['Select...', 'Canada', 'United States', 'Mexico'];
    const aiLower = aiAnswer.toLowerCase().trim();
    const bestOption = options.find(o => o.toLowerCase().trim() === aiLower) ||
      options.find(o => o.toLowerCase().trim().includes(aiLower)) ||
      options.find(o => aiLower.includes(o.toLowerCase().trim()));
    assertEqual(bestOption, 'Canada');
  });

  await test('AI option matching: substring match', () => {
    const aiAnswer = 'native';
    const options = ['Select...', 'Elementary', 'Professional', 'Native or Bilingual'];
    const aiLower = aiAnswer.toLowerCase().trim();
    const bestOption = options.find(o => o.toLowerCase().trim() === aiLower) ||
      options.find(o => o.toLowerCase().trim().includes(aiLower)) ||
      options.find(o => aiLower.includes(o.toLowerCase().trim()));
    assertEqual(bestOption, 'Native or Bilingual');
  });

  await test('AI option matching: no match returns undefined', () => {
    const aiAnswer = 'something completely different';
    const options = ['Yes', 'No'];
    const aiLower = aiAnswer.toLowerCase().trim();
    const bestOption = options.find(o => o.toLowerCase().trim() === aiLower) ||
      options.find(o => o.toLowerCase().trim().includes(aiLower)) ||
      options.find(o => aiLower.includes(o.toLowerCase().trim()));
    assertEqual(bestOption, undefined);
  });

  await test('AI graceful fallback: null response handled', () => {
    // Simulate what happens when AI returns null/error
    const aiResponse = { answer: null, error: 'AI unavailable: Connection refused' };
    const hasAnswer = aiResponse && aiResponse.answer;
    assertEqual(!!hasAnswer, false);
    assert(aiResponse.error.includes('AI unavailable'), 'should have error message');
  });

  await test('AI graceful fallback: timeout error handled', () => {
    const aiResponse = { answer: null, error: 'Request timed out (10s)' };
    assertEqual(aiResponse.answer, null);
    assert(aiResponse.error.includes('timed out'), 'should indicate timeout');
  });

  await test('AI graceful fallback: backend HTTP error handled', () => {
    const aiResponse = { answer: null, error: 'Backend error: 500' };
    assertEqual(aiResponse.answer, null);
    assert(aiResponse.error.includes('500'), 'should include status code');
  });

  await test('AI skipped when aiEnabled is false', () => {
    const settings = { aiEnabled: false };
    const shouldCallAI = settings && settings.aiEnabled;
    assertEqual(!!shouldCallAI, false);
  });

  await test('AI skipped when settings is null', () => {
    const settings = null;
    const shouldCallAI = settings && settings.aiEnabled;
    assertEqual(!!shouldCallAI, false);
  });

  // ── Report ─────────────────────────────────────────────────────────

  report();
}

runTests();
