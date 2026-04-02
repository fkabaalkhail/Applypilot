/**
 * Unit tests for popup auto-save and tab switching logic.
 *
 * Can be run:
 *   - In a browser via test_popup.html
 *   - In Node.js: node extension/tests/test_popup.js
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
  // Browser output
  if (typeof document !== 'undefined' && document.getElementById) {
    const out = document.getElementById('output');
    const sum = document.getElementById('summary');
    if (out) {
      out.innerHTML = _results
        .map(r => {
          if (r.suite) return `<div class="suite">${r.suite}</div>`;
          const cls = r.pass ? 'pass' : 'fail';
          const icon = r.pass ? '✓' : '✗';
          const err = r.error ? ` — ${r.error}` : '';
          return `<div class="result ${cls}">${icon} ${r.name}${err}</div>`;
        })
        .join('');
    }
    if (sum) {
      const cls = _failed === 0 ? 'pass' : 'fail';
      sum.innerHTML = `<span class="${cls}">${_passed} passed, ${_failed} failed</span>`;
    }
  }
  // Console output (Node or browser console)
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
  // Exit code for CI
  if (typeof process !== 'undefined' && process.exit && _failed > 0) {
    process.exitCode = 1;
  }
}

// ── DOM helpers (works in Node via minimal shims below) ───────────────

function buildTabDOM() {
  // Mimics the popup.html tab structure
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="tabs">
      <button class="tab active" data-tab="dashboard">Dashboard</button>
      <button class="tab" data-tab="personal">Personal Info</button>
      <button class="tab" data-tab="settings">Settings</button>
      <button class="tab" data-tab="applied">Applied Jobs</button>
    </div>
    <div id="dashboard-tab" class="tab-content active"></div>
    <div id="personal-tab" class="tab-content"></div>
    <div id="settings-tab" class="tab-content"></div>
    <div id="applied-tab" class="tab-content"></div>
  `;
  document.body.appendChild(container);
  return container;
}


// ── Re-implement core logic under test (extracted from popup.js) ──────
// We extract the pure logic so tests don't depend on chrome.* APIs at load time.

/**
 * Tab switching logic — mirrors setupTabs() from popup.js.
 * Attaches click handlers that toggle .active on tabs and panels.
 */
function setupTabs(root) {
  const tabs = (root || document).querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      (root || document).querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      (root || document).querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      const panel = (root || document).querySelector(`#${tabName}-tab`);
      if (panel) panel.classList.add('active');
    });
  });
}

/**
 * Debounce helper — mirrors the debounce inside setupAutoSave().
 * Returns { trigger, cancel, isPending } for testability.
 * Uses global timer functions to avoid jsdom recursion issues.
 */
const _setTimeout = (typeof globalThis !== 'undefined' && globalThis.setTimeout) || setTimeout;
const _clearTimeout = (typeof globalThis !== 'undefined' && globalThis.clearTimeout) || clearTimeout;

function createDebouncedSave(callback, delay) {
  let timer = null;
  return {
    trigger() {
      if (timer !== null) _clearTimeout(timer);
      timer = _setTimeout(() => {
        timer = null;
        callback();
      }, delay);
    },
    cancel() {
      if (timer !== null) {
        _clearTimeout(timer);
        timer = null;
      }
    },
    isPending() {
      return timer !== null;
    },
  };
}

// ── Node.js DOM shim (only when running outside a browser) ────────────

if (typeof window === 'undefined') {
  // Minimal JSDOM-free shim — enough for our tests
  const { JSDOM } = (() => {
    try { return require('jsdom'); } catch { return { JSDOM: null }; }
  })();

  if (JSDOM) {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    global.document = dom.window.document;
    global.window = dom.window;
    global.HTMLElement = dom.window.HTMLElement;
    // Keep Node's native timers — jsdom's can cause recursion
  } else {
    console.error('jsdom not available — run: npm install jsdom   (or open test_popup.html in a browser)');
    process.exit(1);
  }
}

// ── Load popup.js exports (Node.js only) ──────────────────────────────

let showToast, dismissToast, validators, validateField, validateAllFields, displayFillResult;

if (typeof require !== 'undefined') {
  // Mock chrome APIs before requiring popup.js
  if (typeof global.chrome === 'undefined') {
    global.chrome = {
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
      runtime: { onMessage: { addListener: () => {} } },
      tabs: { query: () => Promise.resolve([]) },
      scripting: { executeScript: () => Promise.resolve() }
    };
  }

  try {
    const popup = require('../popup/popup.js');
    showToast = popup.showToast;
    dismissToast = popup.dismissToast;
    validators = popup.validators;
    validateField = popup.validateField;
    validateAllFields = popup.validateAllFields;
    displayFillResult = popup.displayFillResult;
  } catch (e) {
    console.error('Could not load popup.js:', e.message);
  }
}

// Helper: delay using Node's native timers (avoids jsdom timer issues)
function delay(ms) {
  return new Promise(resolve => _setTimeout(resolve, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────

async function runTests() {

  // ── Tab Switching ───────────────────────────────────────────────────

  suite('Tab Switching');

  await test('initial state: dashboard tab and panel are active', () => {
    const root = buildTabDOM();
    const tabs = root.querySelectorAll('.tab');
    const panels = root.querySelectorAll('.tab-content');

    assertEqual(tabs[0].classList.contains('active'), true, 'dashboard tab');
    assertEqual(panels[0].classList.contains('active'), true, 'dashboard panel');
    // Others inactive
    for (let i = 1; i < tabs.length; i++) {
      assertEqual(tabs[i].classList.contains('active'), false, `tab ${i} should be inactive`);
      assertEqual(panels[i].classList.contains('active'), false, `panel ${i} should be inactive`);
    }
    root.remove();
  });

  await test('clicking Personal Info tab activates it and deactivates Dashboard', () => {
    const root = buildTabDOM();
    setupTabs(root);

    const personalTab = root.querySelector('[data-tab="personal"]');
    personalTab.click();

    // Personal tab + panel active
    assertEqual(personalTab.classList.contains('active'), true, 'personal tab active');
    assertEqual(root.querySelector('#personal-tab').classList.contains('active'), true, 'personal panel active');

    // Dashboard deactivated
    assertEqual(root.querySelector('[data-tab="dashboard"]').classList.contains('active'), false, 'dashboard tab inactive');
    assertEqual(root.querySelector('#dashboard-tab').classList.contains('active'), false, 'dashboard panel inactive');

    root.remove();
  });

  await test('clicking Settings tab activates only Settings', () => {
    const root = buildTabDOM();
    setupTabs(root);

    root.querySelector('[data-tab="settings"]').click();

    const activeTabs = root.querySelectorAll('.tab.active');
    const activePanels = root.querySelectorAll('.tab-content.active');

    assertEqual(activeTabs.length, 1, 'exactly one active tab');
    assertEqual(activeTabs[0].getAttribute('data-tab'), 'settings', 'settings tab is active');
    assertEqual(activePanels.length, 1, 'exactly one active panel');
    assertEqual(activePanels[0].id, 'settings-tab', 'settings panel is active');

    root.remove();
  });

  await test('clicking Applied Jobs tab activates only Applied Jobs', () => {
    const root = buildTabDOM();
    setupTabs(root);

    root.querySelector('[data-tab="applied"]').click();

    const activeTabs = root.querySelectorAll('.tab.active');
    const activePanels = root.querySelectorAll('.tab-content.active');

    assertEqual(activeTabs.length, 1, 'exactly one active tab');
    assertEqual(activeTabs[0].getAttribute('data-tab'), 'applied', 'applied tab is active');
    assertEqual(activePanels.length, 1, 'exactly one active panel');
    assertEqual(activePanels[0].id, 'applied-tab', 'applied panel is active');

    root.remove();
  });

  await test('switching tabs multiple times always leaves exactly one active', () => {
    const root = buildTabDOM();
    setupTabs(root);

    const tabNames = ['settings', 'personal', 'applied', 'dashboard', 'settings', 'applied'];
    for (const name of tabNames) {
      root.querySelector(`[data-tab="${name}"]`).click();
      const activeTabs = root.querySelectorAll('.tab.active');
      const activePanels = root.querySelectorAll('.tab-content.active');
      assertEqual(activeTabs.length, 1, `one active tab after clicking ${name}`);
      assertEqual(activePanels.length, 1, `one active panel after clicking ${name}`);
      assertEqual(activeTabs[0].getAttribute('data-tab'), name, `active tab is ${name}`);
      assertEqual(activePanels[0].id, `${name}-tab`, `active panel is ${name}-tab`);
    }

    root.remove();
  });

  await test('clicking the already-active tab keeps it active (no deselection)', () => {
    const root = buildTabDOM();
    setupTabs(root);

    root.querySelector('[data-tab="dashboard"]').click();
    root.querySelector('[data-tab="dashboard"]').click();

    assertEqual(root.querySelectorAll('.tab.active').length, 1, 'still one active tab');
    assertEqual(root.querySelector('[data-tab="dashboard"]').classList.contains('active'), true);

    root.remove();
  });

  // ── Auto-Save Debounce ─────────────────────────────────────────────

  suite('Auto-Save Debounce');

  await test('save is NOT called immediately on trigger', () => {
    let called = false;
    const debounced = createDebouncedSave(() => { called = true; }, 500);

    debounced.trigger();
    assertEqual(called, false, 'should not fire immediately');
    assertEqual(debounced.isPending(), true, 'timer should be pending');

    debounced.cancel();
  });

  await test('save fires after 500ms delay', async () => {
    let called = false;
    const debounced = createDebouncedSave(() => { called = true; }, 500);

    debounced.trigger();

    // Wait 600ms to be safe
    await delay(600);

    assertEqual(called, true, 'should have fired after 500ms');
    assertEqual(debounced.isPending(), false, 'timer should be cleared');
  });

  await test('rapid triggers reset the timer — save fires only once', async () => {
    let callCount = 0;
    const debounced = createDebouncedSave(() => { callCount++; }, 500);

    // Simulate rapid typing: trigger every 100ms for 400ms
    debounced.trigger();
    await delay(100);
    debounced.trigger();
    await delay(100);
    debounced.trigger();
    await delay(100);
    debounced.trigger();

    // At this point ~300ms since last trigger. Should not have fired yet.
    assertEqual(callCount, 0, 'should not fire during rapid input');

    // Wait for debounce to complete (500ms from last trigger)
    await delay(600);

    assertEqual(callCount, 1, 'should fire exactly once after debounce');
  });

  await test('cancel prevents the save from firing', async () => {
    let called = false;
    const debounced = createDebouncedSave(() => { called = true; }, 500);

    debounced.trigger();
    debounced.cancel();

    await delay(600);

    assertEqual(called, false, 'should not fire after cancel');
    assertEqual(debounced.isPending(), false, 'no pending timer');
  });

  await test('trigger after cancel starts a fresh timer', async () => {
    let callCount = 0;
    const debounced = createDebouncedSave(() => { callCount++; }, 500);

    debounced.trigger();
    debounced.cancel();
    debounced.trigger();

    await delay(600);

    assertEqual(callCount, 1, 'should fire once from the second trigger');
  });

  // ── Toast Notification System ────────────────────────────────────────

  suite('Toast Notification System');

  await test('showToast creates a toast element in the container', () => {
    // Setup toast container
    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);

    const toast = showToast('Test message', 'success', 0);

    assert(toast !== undefined, 'should return toast element');
    assertEqual(container.children.length, 1, 'container should have one toast');
    assert(toast.classList.contains('toast'), 'should have toast class');
    assert(toast.classList.contains('toast-success'), 'should have toast-success class');

    const msg = toast.querySelector('.toast-message');
    assertEqual(msg.textContent, 'Test message', 'message text');

    const closeBtn = toast.querySelector('.toast-close');
    assert(closeBtn !== null, 'should have close button');

    container.remove();
  });

  await test('showToast supports all four types', () => {
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);

    const types = ['success', 'error', 'warning', 'info'];
    types.forEach(type => {
      container.innerHTML = '';
      const toast = showToast('msg', type, 0);
      assert(toast.classList.contains('toast-' + type), 'should have toast-' + type + ' class');
    });

    container.remove();
  });

  await test('showToast defaults to info type', () => {
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);

    const toast = showToast('default type', undefined, 0);
    assert(toast.classList.contains('toast-info'), 'should default to info');

    container.remove();
  });

  await test('toast close button removes the toast', async () => {
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);

    const toast = showToast('close me', 'info', 0);
    assertEqual(container.children.length, 1, 'toast present');

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.click();

    // Wait for removal animation (200ms)
    await delay(300);

    assertEqual(container.children.length, 0, 'toast removed after close');

    container.remove();
  });

  await test('toast auto-dismisses after duration', async () => {
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);

    showToast('auto dismiss', 'success', 300);
    assertEqual(container.children.length, 1, 'toast present initially');

    // Wait for auto-dismiss (300ms) + removal animation (200ms)
    await delay(600);

    assertEqual(container.children.length, 0, 'toast removed after duration');

    container.remove();
  });

  await test('multiple toasts can coexist', () => {
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);

    showToast('first', 'success', 0);
    showToast('second', 'error', 0);
    showToast('third', 'warning', 0);

    assertEqual(container.children.length, 3, 'three toasts present');

    container.remove();
  });

  // ── Field Validation ───────────────────────────────────────────────

  suite('Field Validation');

  await test('email validator: valid email passes', () => {
    assertEqual(validators.email('test@example.com'), '', 'valid email');
  });

  await test('email validator: empty email fails', () => {
    assert(validators.email('') !== '', 'empty email should fail');
  });

  await test('email validator: missing @ fails', () => {
    assert(validators.email('testexample.com') !== '', 'no @ should fail');
  });

  await test('email validator: missing domain fails', () => {
    assert(validators.email('test@') !== '', 'no domain should fail');
  });

  await test('phone validator: valid digits pass', () => {
    assertEqual(validators.phone('1234567890'), '', 'valid phone');
  });

  await test('phone validator: empty is ok (optional)', () => {
    assertEqual(validators.phone(''), '', 'empty phone is ok');
  });

  await test('phone validator: too short fails', () => {
    assert(validators.phone('123') !== '', 'too short should fail');
  });

  await test('phone validator: allows dashes and spaces', () => {
    assertEqual(validators.phone('123-456-7890'), '', 'dashes ok');
    assertEqual(validators.phone('123 456 7890'), '', 'spaces ok');
  });

  await test('firstName validator: non-empty passes', () => {
    assertEqual(validators.firstName('John'), '', 'valid first name');
  });

  await test('firstName validator: empty fails', () => {
    assert(validators.firstName('') !== '', 'empty first name should fail');
  });

  await test('firstName validator: whitespace-only fails', () => {
    assert(validators.firstName('   ') !== '', 'whitespace-only should fail');
  });

  await test('lastName validator: non-empty passes', () => {
    assertEqual(validators.lastName('Doe'), '', 'valid last name');
  });

  await test('lastName validator: empty fails', () => {
    assert(validators.lastName('') !== '', 'empty last name should fail');
  });

  await test('yearsOfExperience validator: valid number passes', () => {
    assertEqual(validators.yearsOfExperience('5'), '', 'valid years');
    assertEqual(validators.yearsOfExperience('0'), '', 'zero is valid');
    assertEqual(validators.yearsOfExperience('50'), '', '50 is valid');
  });

  await test('yearsOfExperience validator: empty is ok (optional)', () => {
    assertEqual(validators.yearsOfExperience(''), '', 'empty is ok');
  });

  await test('yearsOfExperience validator: negative fails', () => {
    assert(validators.yearsOfExperience('-1') !== '', 'negative should fail');
  });

  await test('yearsOfExperience validator: over 50 fails', () => {
    assert(validators.yearsOfExperience('51') !== '', 'over 50 should fail');
  });

  await test('yearsOfExperience validator: non-number fails', () => {
    assert(validators.yearsOfExperience('abc') !== '', 'non-number should fail');
  });

  await test('validateField shows inline error on invalid input', () => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const input = document.createElement('input');
    input.setAttribute('data-field', 'email');
    input.value = 'bad-email';
    group.appendChild(input);
    const errorEl = document.createElement('span');
    errorEl.className = 'field-error';
    group.appendChild(errorEl);
    document.body.appendChild(group);

    const error = validateField(input);
    assert(error !== '', 'should return error');
    assert(input.classList.contains('invalid'), 'input should have invalid class');
    assert(errorEl.classList.contains('visible'), 'error should be visible');

    group.remove();
  });

  await test('validateField clears error on valid input', () => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const input = document.createElement('input');
    input.setAttribute('data-field', 'email');
    input.value = 'test@example.com';
    group.appendChild(input);
    const errorEl = document.createElement('span');
    errorEl.className = 'field-error visible';
    errorEl.textContent = 'old error';
    group.appendChild(errorEl);
    document.body.appendChild(group);

    input.classList.add('invalid');
    const error = validateField(input);
    assertEqual(error, '', 'should return empty');
    assertEqual(input.classList.contains('invalid'), false, 'invalid class removed');
    assertEqual(errorEl.classList.contains('visible'), false, 'error hidden');

    group.remove();
  });

  // ── Report ─────────────────────────────────────────────────────────

  report();
}

runTests();
