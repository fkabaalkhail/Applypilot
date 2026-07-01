/**
 * Property-based tests for Popup Pills & Greenhouse features.
 *
 * Run: node extension/tests/test_pills_greenhouse_property.js
 *
 * Uses fast-check + JSDOM for standalone execution.
 */

const fc = require('fast-check');
const { JSDOM } = require('jsdom');

// ── Test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function runProperty(name, arb, predicate, numRuns) {
  if (typeof numRuns === 'undefined') numRuns = 100;
  try {
    fc.assert(
      fc.property(arb, predicate),
      { numRuns: numRuns, verbose: false }
    );
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.log('  \u2717 ' + name);
    console.log('    ' + e.message.split('\n').slice(0, 5).join('\n    '));
  }
}

// Helper: build a string arbitrary from a character set
function strArb(chars, minLen, maxLen) {
  return fc.array(fc.constantFrom.apply(fc, chars), { minLength: minLen, maxLength: maxLen })
    .map(function(a) { return a.join(''); });
}

// ══════════════════════════════════════════════════════════════════════
// Replicated logic from popup.js and content.js for standalone testing
// ══════════════════════════════════════════════════════════════════════

// ── Pill group values (from popup.html) ──────────────────────────────

var PILL_GROUPS = {
  experienceLevel: ['intern', 'entry', 'mid', 'senior', 'director', 'executive'],
  workType: ['remote', 'onsite', 'hybrid'],
  postedWithin: ['24h', 'week', 'month'],
};

// ── populateSettingsFields logic (from popup.js) ─────────────────────

function populateSettingsFields(doc, settings) {
  var pillGroups = doc.querySelectorAll('.pill-group[data-setting]');
  pillGroups.forEach(function(group) {
    var key = group.getAttribute('data-setting');
    if (settings[key] === undefined || settings[key] === null) return;
    var values = settings[key];
    if (typeof values === 'string') {
      values = values ? [values] : [];
    }
    if (!Array.isArray(values)) return;
    group.querySelectorAll('.pill-btn').forEach(function(btn) {
      btn.classList.remove('selected');
      if (values.includes(btn.getAttribute('data-value'))) {
        btn.classList.add('selected');
      }
    });
  });
}

// ── saveConfig logic (from popup.js) — collects pill selections ──────

function collectPillSelections(doc) {
  var settings = {};
  var pillGroups = doc.querySelectorAll('.pill-group[data-setting]');
  pillGroups.forEach(function(group) {
    var key = group.getAttribute('data-setting');
    var selected = [];
    group.querySelectorAll('.pill-btn.selected').forEach(function(btn) {
      selected.push(btn.getAttribute('data-value'));
    });
    settings[key] = selected;
  });
  return settings;
}

// ── hasEasyApplyBadge logic (from content.js) ────────────────────────

function hasEasyApplyBadge(cardElement) {
  if (!cardElement) return false;
  var textElements = cardElement.querySelectorAll('span, div, li-icon, [class*="badge"], [class*="apply"]');
  for (var i = 0; i < textElements.length; i++) {
    if (/easy\s+apply/i.test(textElements[i].textContent.trim())) return true;
  }
  var icons = cardElement.querySelectorAll('li-icon[type*="apply"], li-icon[type*="easy"], svg[data-test-icon*="apply"]');
  if (icons.length > 0) return true;
  var svgs = cardElement.querySelectorAll('svg');
  for (var j = 0; j < svgs.length; j++) {
    var parent = svgs[j].parentElement;
    if (parent && /easy\s+apply/i.test(parent.textContent.trim())) return true;
  }
  return false;
}

// ── ATS detection logic (from content.js) ────────────────────────────

var ATS_PATTERNS = {
  linkedin:       /linkedin\.com/i,
  greenhouse:     /greenhouse\.io|grnh\.se/i,
  lever:          /lever\.co/i,
  workday:        /myworkdayjobs\.com|workday\.com/i,
  rippling:       /rippling\.com/i,
  jazzhr:         /applytojob\.com|jazz\.co/i,
  icims:          /icims\.com/i,
  smartrecruiters:/smartrecruiters\.com/i,
  ashby:          /ashbyhq\.com/i,
  bamboohr:       /bamboohr\.com/i,
  jobvite:        /jobvite\.com/i,
  taleo:          /taleo\.net/i,
  successfactors: /successfactors\.com/i,
};

function detectATS(url) {
  if (!url) return 'generic';
  for (var ats in ATS_PATTERNS) {
    if (ATS_PATTERNS[ats].test(url)) return ats;
  }
  return 'generic';
}

// ── matchPrefilled logic (from content.js) ───────────────────────────

function matchPrefilled(label, prefilled) {
  if (!label || !prefilled) return null;
  var labelLower = label.toLowerCase().trim();
  var keys = Object.keys(prefilled);
  for (var i = 0; i < keys.length; i++) {
    var qLower = keys[i].toLowerCase().trim();
    if (qLower.includes(labelLower) || labelLower.includes(qLower)) {
      return String(prefilled[keys[i]]);
    }
  }
  return null;
}

// ── Greenhouse standard field filling logic (from content.js) ────────

function fillStandardFields(formRoot, profile) {
  var result = { filled: 0, skipped: 0 };
  var standardFields = [
    { name: 'first_name', selectors: ['#first_name', 'input[name*="first_name"]', 'input[autocomplete="given-name"]'], value: profile.firstName || '' },
    { name: 'last_name', selectors: ['#last_name', 'input[name*="last_name"]', 'input[autocomplete="family-name"]'], value: profile.lastName || '' },
    { name: 'email', selectors: ['#email', 'input[name*="email"]', 'input[type="email"]'], value: profile.email || '' },
    { name: 'phone', selectors: ['#phone', 'input[name*="phone"]', 'input[type="tel"]'], value: profile.phone || '' },
    { name: 'linkedin', selectors: ['input[name*="linkedin"]', 'input[placeholder*="linkedin"]', 'input[id*="linkedin"]'], value: profile.linkedinUrl || '' },
  ];
  for (var i = 0; i < standardFields.length; i++) {
    var field = standardFields[i];
    if (!field.value) continue;
    for (var j = 0; j < field.selectors.length; j++) {
      var el = formRoot.querySelector(field.selectors[j]);
      if (el) {
        if ((el.value || '').trim()) {
          result.skipped++;
          break;
        }
        el.value = field.value;
        result.filled++;
        break;
      }
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// DOM helpers
// ══════════════════════════════════════════════════════════════════════

function buildAllPillGroupsHTML() {
  var html = '';
  for (var key in PILL_GROUPS) {
    var btns = PILL_GROUPS[key].map(function(v) {
      return '<button type="button" class="pill-btn" data-value="' + v + '">' + v + '</button>';
    }).join('');
    html += '<div class="pill-group" data-setting="' + key + '">' + btns + '</div>';
  }
  return '<!DOCTYPE html><html><body>' + html + '</body></html>';
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildGreenhouseFormHTML(pv) {
  pv = pv || {};
  return '<!DOCTYPE html><html><body>' +
    '<form id="application_form">' +
    '<input id="first_name" name="first_name" type="text" value="' + escapeAttr(pv.firstName || '') + '">' +
    '<input id="last_name" name="last_name" type="text" value="' + escapeAttr(pv.lastName || '') + '">' +
    '<input id="email" name="email" type="email" value="' + escapeAttr(pv.email || '') + '">' +
    '<input id="phone" name="phone" type="tel" value="' + escapeAttr(pv.phone || '') + '">' +
    '<input id="linkedin_url" name="linkedin_url" placeholder="linkedin" type="url" value="' + escapeAttr(pv.linkedinUrl || '') + '">' +
    '</form></body></html>';
}

// ══════════════════════════════════════════════════════════════════════
// Generators
// ══════════════════════════════════════════════════════════════════════

var ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('');
var ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789@.-_ '.split('');

var pillGroupNameArb = fc.constantFrom('experienceLevel', 'workType', 'postedWithin');

function subsetOfGroup(groupName) {
  return fc.subarray(PILL_GROUPS[groupName], { minLength: 0 });
}

var pillGroupSubsetArb = pillGroupNameArb.chain(function(name) {
  return subsetOfGroup(name).map(function(subset) {
    return { groupName: name, subset: subset };
  });
});

var fieldValueArb = strArb(ALPHANUM, 1, 30);

var qaKeyArb = strArb(ALPHA.concat([' ']), 3, 30);
var qaValArb = strArb('abcdefghijklmnop0123YN'.split(''), 1, 20);
var qaArb = fc.dictionary(qaKeyArb, qaValArb);

// ══════════════════════════════════════════════════════════════════════
// Property Tests
// ══════════════════════════════════════════════════════════════════════

console.log('\n  Property tests \u2014 Popup Pills & Greenhouse\n');

// ── Property 1: Pill toggle involution ───────────────────────────────
// **Validates: Requirements 1.2, 1.3, 2.2, 2.3, 3.2, 3.3**

console.log('  --- Property 1: Pill toggle involution ---');

runProperty(
  'P1: clicking a pill twice restores original state (involution)',
  fc.tuple(pillGroupNameArb, fc.nat({ max: 100 })),
  function(args) {
    var groupName = args[0];
    var seed = args[1];
    var dom = new JSDOM(buildAllPillGroupsHTML());
    var doc = dom.window.document;
    var group = doc.querySelector('[data-setting="' + groupName + '"]');
    var pills = group.querySelectorAll('.pill-btn');

    // Set random initial state based on seed bits
    for (var i = 0; i < pills.length; i++) {
      if ((seed >> i) & 1) pills[i].classList.add('selected');
    }

    // Capture initial state
    var initialState = [];
    for (var i = 0; i < pills.length; i++) {
      initialState.push(pills[i].classList.contains('selected'));
    }

    // Pick a random pill to click
    var pillIndex = seed % pills.length;
    var target = pills[pillIndex];

    // Click once (toggle)
    target.classList.toggle('selected');
    // Verify state changed
    if (target.classList.contains('selected') === initialState[pillIndex]) return false;

    // Click again (toggle back)
    target.classList.toggle('selected');

    // Verify all pills restored
    for (var i = 0; i < pills.length; i++) {
      if (pills[i].classList.contains('selected') !== initialState[i]) return false;
    }
    return true;
  },
  100
);

// ── Property 2: Pill save/load round-trip ────────────────────────────
// **Validates: Requirements 1.5, 1.6, 2.5, 2.6, 3.5, 3.6, 5.1, 5.2, 5.3, 5.4**

console.log('  --- Property 2: Pill save/load round-trip ---');

runProperty(
  'P2a: save then load restores exact pill selection for any subset',
  pillGroupSubsetArb,
  function(data) {
    var groupName = data.groupName;
    var subset = data.subset;
    var dom = new JSDOM(buildAllPillGroupsHTML());
    var doc = dom.window.document;
    var group = doc.querySelector('[data-setting="' + groupName + '"]');

    // Set desired selection
    group.querySelectorAll('.pill-btn').forEach(function(btn) {
      if (subset.includes(btn.getAttribute('data-value'))) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Save
    var saved = collectPillSelections(doc);

    // Clear all
    group.querySelectorAll('.pill-btn').forEach(function(btn) {
      btn.classList.remove('selected');
    });

    // Load
    populateSettingsFields(doc, saved);

    // Verify
    var restored = [];
    group.querySelectorAll('.pill-btn.selected').forEach(function(btn) {
      restored.push(btn.getAttribute('data-value'));
    });
    if (restored.length !== subset.length) return false;
    for (var i = 0; i < subset.length; i++) {
      if (!restored.includes(subset[i])) return false;
    }
    return true;
  },
  100
);

runProperty(
  'P2b: legacy single-string value loads correctly',
  pillGroupNameArb.chain(function(name) {
    return fc.constantFrom.apply(fc, PILL_GROUPS[name]).map(function(val) {
      return { groupName: name, value: val };
    });
  }),
  function(data) {
    var dom = new JSDOM(buildAllPillGroupsHTML());
    var doc = dom.window.document;
    var settings = {};
    settings[data.groupName] = data.value; // string, not array
    populateSettingsFields(doc, settings);
    var group = doc.querySelector('[data-setting="' + data.groupName + '"]');
    var selected = group.querySelectorAll('.pill-btn.selected');
    if (selected.length !== 1) return false;
    return selected[0].getAttribute('data-value') === data.value;
  },
  100
);

// ── Property 3: Easy Apply badge classification ──────────────────────
// **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

console.log('  --- Property 3: Easy Apply badge classification ---');

runProperty(
  'P3a: card with Easy Apply text \u2192 hasEasyApplyBadge returns true',
  fc.tuple(
    strArb(ALPHA, 0, 20),
    fc.constantFrom('Easy Apply', 'easy apply', 'Easy  Apply', 'EASY APPLY')
  ),
  function(args) {
    var randomText = args[0];
    var badgeText = args[1];
    var html = '<!DOCTYPE html><html><body><div class="job-card">' +
      '<span>' + randomText + '</span><span>' + badgeText + '</span>' +
      '</div></body></html>';
    var dom = new JSDOM(html);
    var card = dom.window.document.querySelector('.job-card');
    return hasEasyApplyBadge(card) === true;
  },
  100
);

runProperty(
  'P3b: card without Easy Apply badge \u2192 hasEasyApplyBadge returns false',
  strArb(ALPHA.concat([' ', '-', '_']), 0, 40).filter(function(s) {
    return !/easy\s+apply/i.test(s);
  }),
  function(text) {
    var html = '<!DOCTYPE html><html><body><div class="job-card">' +
      '<span>' + text + '</span><div>Some Company</div>' +
      '</div></body></html>';
    var dom = new JSDOM(html);
    var card = dom.window.document.querySelector('.job-card');
    return hasEasyApplyBadge(card) === false;
  },
  100
);

runProperty(
  'P3c: card with li-icon apply type \u2192 hasEasyApplyBadge returns true',
  fc.constantFrom('apply', 'easy-apply', 'app-aware-apply-icon'),
  function(iconType) {
    var html = '<!DOCTYPE html><html><body><div class="job-card">' +
      '<li-icon type="' + iconType + '"></li-icon>' +
      '</div></body></html>';
    var dom = new JSDOM(html);
    var card = dom.window.document.querySelector('.job-card');
    return hasEasyApplyBadge(card) === true;
  },
  100
);

// ── Property 5: Greenhouse URL detection ─────────────────────────────
// **Validates: Requirements 8.1**

console.log('  --- Property 5: Greenhouse URL detection ---');

var greenhouseUrlArb = fc.oneof(
  fc.constant('https://boards.greenhouse.io/company/jobs/123'),
  fc.constant('https://acme.greenhouse.io/apply/456'),
  fc.constant('https://grnh.se/abc123'),
  fc.constant('https://greenhouse.io/embed/job_board'),
  fc.tuple(
    fc.constantFrom('https://', 'http://'),
    strArb(ALPHA, 1, 8),
    fc.constantFrom('.greenhouse.io', '.grnh.se'),
    strArb('/abc123'.split(''), 0, 10)
  ).map(function(p) { return p[0] + p[1] + p[2] + p[3]; })
);

var nonGreenhouseUrlArb = fc.oneof(
  fc.constant('https://www.linkedin.com/jobs/view/12345'),
  fc.constant('https://jobs.lever.co/company/abc'),
  fc.constant('https://example.com/careers'),
  fc.constant('https://acme.workday.com/en-US/job/12345'),
  strArb('abcdefghijk./:'.split(''), 5, 40).filter(function(s) {
    return !/greenhouse\.io|grnh\.se/i.test(s);
  })
);

runProperty(
  'P5a: URL with greenhouse pattern \u2192 detectATS returns "greenhouse"',
  greenhouseUrlArb,
  function(url) { return detectATS(url) === 'greenhouse'; },
  100
);

runProperty(
  'P5b: URL without greenhouse pattern \u2192 detectATS does NOT return "greenhouse"',
  nonGreenhouseUrlArb,
  function(url) { return detectATS(url) !== 'greenhouse'; },
  100
);

// ── Property 7: Pre-filled field preservation ────────────────────────
// **Validates: Requirements 9.6**

console.log('  --- Property 7: Pre-filled field preservation ---');

// Non-whitespace-only field value: the filler treats whitespace-only as empty
var nonEmptyFieldArb = fieldValueArb.filter(function(s) { return s.trim().length > 0; });

runProperty(
  'P7: pre-filled fields are not overwritten by the filler',
  fc.record({
    firstName: nonEmptyFieldArb,
    lastName: nonEmptyFieldArb,
    email: nonEmptyFieldArb,
    phone: nonEmptyFieldArb,
    linkedinUrl: nonEmptyFieldArb,
  }),
  function(prefilledValues) {
    var dom = new JSDOM(buildGreenhouseFormHTML(prefilledValues));
    var doc = dom.window.document;
    var formRoot = doc.querySelector('#application_form');

    // Capture DOM values after construction (browser may sanitize, e.g. type=email strips spaces)
    var expected = {
      firstName: doc.querySelector('#first_name').value,
      lastName: doc.querySelector('#last_name').value,
      email: doc.querySelector('#email').value,
      phone: doc.querySelector('#phone').value,
      linkedinUrl: doc.querySelector('#linkedin_url').value,
    };

    var profile = {
      firstName: 'NEW_FIRST',
      lastName: 'NEW_LAST',
      email: 'new@example.com',
      phone: '9999999999',
      linkedinUrl: 'https://linkedin.com/in/new',
    };

    var result = fillStandardFields(formRoot, profile);

    // Verify all pre-filled values are unchanged
    if (doc.querySelector('#first_name').value !== expected.firstName) return false;
    if (doc.querySelector('#last_name').value !== expected.lastName) return false;
    if (doc.querySelector('#email').value !== expected.email) return false;
    if (doc.querySelector('#phone').value !== expected.phone) return false;
    if (doc.querySelector('#linkedin_url').value !== expected.linkedinUrl) return false;
    if (result.skipped !== 5) return false;
    if (result.filled !== 0) return false;
    return true;
  },
  100
);

// ── Property 8: Prefilled answer matching ────────────────────────────
// **Validates: Requirements 11.1, 11.2, 11.3**

console.log('  --- Property 8: Prefilled answer matching ---');

runProperty(
  'P8a: exact label match returns correct answer',
  fc.tuple(qaKeyArb, qaValArb),
  function(args) {
    var question = args[0];
    var answer = args[1];
    var prefilled = {};
    prefilled[question] = answer;
    return matchPrefilled(question, prefilled) === String(answer);
  },
  100
);

runProperty(
  'P8b: label substring of question key returns correct answer',
  fc.tuple(
    strArb(ALPHA, 3, 10),
    strArb(ALPHA, 3, 10),
    qaValArb
  ),
  function(args) {
    var prefix = args[0];
    var label = args[1];
    var answer = args[2];
    var question = prefix + label;
    var prefilled = {};
    prefilled[question] = answer;
    return matchPrefilled(label, prefilled) === String(answer);
  },
  100
);

runProperty(
  'P8c: non-matching label returns null',
  fc.tuple(qaArb, fieldValueArb).filter(function(args) {
    var qa = args[0];
    var label = args[1];
    var labelLower = label.toLowerCase().trim();
    var keys = Object.keys(qa);
    for (var i = 0; i < keys.length; i++) {
      var qLower = keys[i].toLowerCase().trim();
      if (qLower.includes(labelLower) || labelLower.includes(qLower)) return false;
    }
    return true;
  }),
  function(args) {
    return matchPrefilled(args[1], args[0]) === null;
  },
  100
);

// ── Report ───────────────────────────────────────────────────────────

console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0 && typeof process !== 'undefined') {
  process.exitCode = 1;
}
