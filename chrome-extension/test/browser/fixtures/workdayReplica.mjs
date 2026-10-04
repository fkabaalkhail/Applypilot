/**
 * A replica of a Workday candidate-experience application, end to end, for
 * driving the REAL packaged extension through every page of one application.
 *
 * Served by Playwright routing under a real Workday host name, so the
 * extension's Workday adapter is the one that runs. Built from the Workday
 * markup the unit suite already pins (test/fixtures/workday.ts,
 * workdayFieldOfStudy.test.ts, comboboxEngine.test.ts, workdayDateParts.test.ts,
 * workday-account-probe.mjs): data-automation-id anchors, button listboxes
 * portalled to the body, searchBox multiselects with selectedItem chips,
 * dateSection spinbuttons, the hidden createAccountCheckbox, the drop zone.
 * NOT copied markup: real Workday is a React app behind a sign-in, which no
 * test here can reach (creating accounts and POSTs are off limits).
 *
 * What it reproduces on purpose:
 *  - the posting's "Apply" opens a chooser; "Apply Manually" is a real navigation;
 *  - Create Account behind Workday's click_filter overlay (the handler is on
 *    the overlay, the button itself is inert);
 *  - one document for every application step (an SPA), one footer button
 *    REUSED by every step, its text "Save and Continue" until Review's "Submit";
 *  - a loading skeleton between steps, then a re-render that REPLACES the
 *    nodes twice while keeping their values (React state survives, DOM does not);
 *  - the page's own state is what counts: a value is registered only through
 *    the events a person's typing or clicking fires. `window.__wd.submissions`
 *    is what each step sent when it was saved;
 *  - validation: a step with a required answer missing shows "Errors Found"
 *    (role=alert) and does not move;
 *  - work experience and education start EMPTY behind "Add" buttons.
 */

export const WD_ORIGIN = "https://acme.wd5.myworkdayjobs.com";
export const POSTING_PATH = "/en-US/External/job/Austin-TX/Software-Engineer_R-1042";
export const APPLY_PATH = `${POSTING_PATH}/apply/applyManually`;

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #333; }
  main { max-width: 640px; margin: 24px 40px; }
  [data-automation-id^="formField"] { margin: 12px 0; display: flex; flex-direction: column; gap: 4px; }
  input[type=text], input[type=password], input[type=email], textarea { padding: 6px; width: 320px; }
  input[role=spinbutton] { width: 48px; padding: 6px; }
  button { padding: 6px 12px; }
  [role=listbox] { position: absolute; background: #fff; border: 1px solid #999; max-height: 240px; overflow: auto; z-index: 10; }
  [role=option] { padding: 4px 8px; cursor: pointer; }
  [role=option]:hover { background: #eef; }
  .row { border: 1px solid #ddd; padding: 8px; margin: 8px 0; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; }
  [data-automation-id=selectedItem] { background: #eef; padding: 2px 6px; border-radius: 8px; }
  .hidden-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  #wd-footer { position: sticky; bottom: 0; background: #f6f6f6; padding: 12px 40px; display: flex; gap: 8px; }
  .err { color: #b00; }
</style></head><body>${body}</body></html>`;

export const POSTING_HTML = shell(
  "Software Engineer",
  `<main>
  <div data-automation-id="jobPostingHeader"><h2>Software Engineer</h2></div>
  <div data-automation-id="locations"><dl><dt>locations</dt><dd>Austin, TX</dd></dl></div>
  <div data-automation-id="time"><dl><dt>time type</dt><dd>Full time</dd></dl></div>
  <div data-automation-id="jobPostingDescription">
    <p>Acme is hiring a Software Engineer to build distributed systems in Go and Java on AWS.
    This is a hybrid role out of our Austin, TX office.</p>
  </div>
  <a role="button" href="#" data-automation-id="adventureButton">Apply</a>
  <div id="chooser" role="dialog" aria-label="Start Your Application" hidden>
    <h2>Start Your Application</h2>
    <a role="button" href="#" data-automation-id="autofillWithResume">Autofill with Resume</a>
    <a role="button" href="${APPLY_PATH}" data-automation-id="applyManually">Apply Manually</a>
    <a role="button" href="#" data-automation-id="useMyLastApplication">Use My Last Application</a>
  </div>
</main>
<script>
  document.querySelector('[data-automation-id="adventureButton"]').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('chooser').hidden = false;
  });
  document.querySelector('[data-automation-id="autofillWithResume"]').addEventListener('click', function (e) {
    e.preventDefault();
    window.__wrongChoice = 'autofillWithResume';
  });
  document.querySelector('[data-automation-id="useMyLastApplication"]').addEventListener('click', function (e) {
    e.preventDefault();
    window.__wrongChoice = 'useMyLastApplication';
  });
</script>`
);

// The application: one document, every step rendered by this script.
const APP_SCRIPT = String.raw`
(function () {
  var W = window;
  var wd = (W.__wd = { submissions: [], steps: [], submitClicked: false, rejected: [], renders: 0 });
  var content = document.getElementById('wd-content');
  var title = document.getElementById('wd-step-title');
  var banner = document.getElementById('wd-errors');
  var next = document.getElementById('wd-next'); // ONE element for every step
  var footer = document.getElementById('wd-footer');
  var S = {}; // the page's own state: only events put values here
  var uid = 100;
  function id(p) { uid += 1; return p + '-' + uid; }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') { for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]); }
      else e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.append(c); });
    return e;
  }
  function closeLists() {
    document.querySelectorAll('[data-wd-popup]').forEach(function (n) { n.remove(); });
    document.querySelectorAll('[aria-expanded="true"]').forEach(function (n) { n.setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('mousedown', function (e) {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('[data-wd-popup]') || e.target.closest('[data-wd-opener]')) return;
    closeLists();
  }, true);
  function labelFor(text, forId, required) {
    var l = h('label', { for: forId, id: forId + '-label' }, [document.createTextNode(text)]);
    if (required) l.append(h('abbr', { title: 'required', text: '*' }));
    return l;
  }
  function wrap(aid, kids) { return h('div', { 'data-automation-id': 'formField-' + aid }, kids); }

  // ---- widgets: each reads its value from S and writes S only on events ----
  function textField(key, aid, label, opts) {
    opts = opts || {};
    var i = id('input');
    var input = h(opts.multiline ? 'textarea' : 'input', {
      id: i, type: opts.multiline ? null : (opts.type || 'text'), 'data-automation-id': aid,
      'aria-required': opts.required ? 'true' : null,
      on: { input: function () { S[key] = input.value; }, change: function () { S[key] = input.value; } }
    });
    input.value = S[key] || '';
    return wrap(aid, [labelFor(label, i, opts.required), input]);
  }
  function listbox(key, aid, label, options, opts) {
    opts = opts || {};
    var i = id('button');
    var btn = h('button', {
      type: 'button', id: i, 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
      'aria-labelledby': i + '-label', 'data-automation-id': aid, 'data-wd-opener': true,
      text: S[key] || 'Select One'
    });
    btn.addEventListener('click', function () {
      if (btn.getAttribute('aria-expanded') === 'true') { closeLists(); return; }
      closeLists();
      btn.setAttribute('aria-expanded', 'true');
      var r = btn.getBoundingClientRect();
      var lb = h('ul', { role: 'listbox', 'data-wd-popup': true, id: i + '-listbox', style: 'top:' + (r.bottom + scrollY) + 'px;left:' + r.left + 'px' });
      options.forEach(function (o) {
        lb.append(h('li', { role: 'option', 'data-automation-id': 'promptOption', 'aria-selected': S[key] === o ? 'true' : 'false',
          on: { click: function () { S[key] = o; btn.textContent = o; closeLists(); } } }, [h('div', { text: o })]));
      });
      document.body.append(lb);
    });
    return wrap(aid, [labelFor(label, i, opts.required), btn]);
  }
  function search(key, aid, label, options, opts) {
    opts = opts || {};
    var i = id('search');
    if (!Array.isArray(S[key])) S[key] = opts.preset ? [opts.preset] : [];
    var chips = h('ul', { 'data-automation-id': 'selectedItemList', class: 'chips' });
    function drawChips() {
      chips.textContent = '';
      S[key].forEach(function (v) {
        chips.append(h('li', { 'data-automation-id': 'selectedItem', title: v }, [h('div', { text: v })]));
      });
    }
    drawChips();
    var input = h('input', { type: 'text', id: i, placeholder: 'Search', autocomplete: 'off', 'data-automation-id': 'searchBox',
      'data-uxi-widget-type': 'selectinput', 'aria-labelledby': i + '-label', 'data-wd-opener': true });
    var timer = null;
    function render() {
      closeLists();
      var q = input.value.trim().toLowerCase();
      var hits = options.filter(function (o) { return !q || o.toLowerCase().indexOf(q) >= 0; });
      var r = input.getBoundingClientRect();
      var lb = h('div', { role: 'listbox', 'data-wd-popup': true, id: i + '-listbox', style: 'top:' + (r.bottom + scrollY) + 'px;left:' + r.left + 'px' });
      (hits.length ? hits : ['No Items.']).forEach(function (o) {
        var row = h('div', { role: 'option', 'data-automation-id': 'promptOption', 'aria-selected': 'false', text: o });
        if (o !== 'No Items.') row.addEventListener('click', function () {
          if (opts.multi) { if (S[key].indexOf(o) < 0) S[key].push(o); } else { S[key] = [o]; }
          input.value = '';
          drawChips();
          closeLists();
        });
        lb.append(row);
      });
      input.setAttribute('aria-expanded', 'true');
      document.body.append(lb);
    }
    function soon() { clearTimeout(timer); timer = setTimeout(render, 120); }
    input.addEventListener('click', soon);
    input.addEventListener('input', soon);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); soon(); } });
    var box = h('div', { 'data-automation-id': 'multiselectInputContainer' }, [input]);
    return wrap(aid, [labelFor(label, i, opts.required), chips, box]);
  }
  function radios(key, aid, legend, options, opts) {
    opts = opts || {};
    var name = id('radio');
    var fs = h('fieldset', { 'data-automation-id': 'formField-' + aid }, [h('legend', {}, [document.createTextNode(legend), opts.required ? h('abbr', { title: 'required', text: '*' }) : null])]);
    options.forEach(function (o) {
      var rid = id('radio');
      var r = h('input', { type: 'radio', id: rid, name: name, value: o, on: { change: function () { if (r.checked) S[key] = o; } } });
      r.checked = S[key] === o;
      fs.append(h('div', {}, [r, h('label', { for: rid, text: o })]));
    });
    return fs;
  }
  function checkbox(key, aid, label, opts) {
    opts = opts || {};
    var i = id('checkbox');
    var c = h('input', { type: 'checkbox', id: i, 'data-automation-id': aid, on: { change: function () { S[key] = c.checked; if (opts.onChange) opts.onChange(); } } });
    c.checked = S[key] === true;
    return wrap(aid, [h('div', {}, [c, labelFor(label, i, opts.required)])]);
  }
  function date(key, idPrefix, label, parts, opts) {
    opts = opts || {};
    if (!S[key]) S[key] = {};
    var lid = id('date');
    var kids = [h('div', { id: lid, text: label + (opts.required ? '*' : '') })];
    var holder = h('div', { 'data-automation-id': 'dateInputWrapper', role: 'group', 'aria-labelledby': lid });
    parts.forEach(function (p) {
      var cap = p.charAt(0).toUpperCase() + p.slice(1);
      var inp = h('input', { type: 'text', role: 'spinbutton', id: idPrefix + '-dateSection' + cap + '-input',
        'data-automation-id': 'dateSection' + cap + '-input', 'aria-label': cap, 'aria-valuemin': p === 'year' ? '1900' : '1',
        'aria-valuemax': p === 'month' ? '12' : p === 'day' ? '31' : '2100', placeholder: p === 'year' ? 'YYYY' : p === 'month' ? 'MM' : 'DD',
        on: { input: function () { S[key][p] = inp.value.replace(/\D/g, ''); } } });
      inp.value = S[key][p] || '';
      holder.append(inp);
    });
    kids.push(holder);
    return h('div', { 'data-automation-id': 'formField-' + idPrefix.split('--').pop() }, kids);
  }
  function upload(key, label, opts) {
    opts = opts || {};
    var i = id('file');
    var done = h('div', { 'data-automation-id': 'file-upload-successful', text: S[key] ? 'Successfully Uploaded! ' + S[key] : '' });
    var input = h('input', { type: 'file', id: i, class: 'hidden-input', 'data-automation-id': 'file-upload-input-ref', 'aria-labelledby': i + '-label',
      on: { change: function () { var f = input.files && input.files[0]; if (f) { S[key] = f.name; done.textContent = 'Successfully Uploaded! ' + f.name; } } } });
    var zone = h('div', { 'data-automation-id': 'file-upload-drop-zone' }, [h('p', { text: 'Drop file here' }),
      h('button', { type: 'button', 'data-automation-id': 'select-files', text: 'Select files', on: { click: function () { input.click(); } } }), input]);
    return h('div', { 'data-automation-id': 'resumeSection' }, [h('h3', { id: i + '-label', text: label + (opts.required ? '*' : '') }), zone, done]);
  }

  // ---- the steps ----------------------------------------------------------
  var MONTHS = ['month', 'year'];
  var STATES = ['Alabama', 'Arizona', 'California', 'Colorado', 'Florida', 'Georgia', 'Illinois', 'Massachusetts', 'New York', 'North Carolina', 'Ohio', 'Oregon', 'Pennsylvania', 'Texas', 'Utah', 'Virginia', 'Washington'];
  function workRows() {
    var holder = h('div', { 'data-automation-id': 'workExperienceSection' }, [h('h3', { text: 'Work Experience' })]);
    (S.work || []).forEach(function (_, n) {
      var p = 'workExperience-' + (21 + n);
      var current = S['w' + n + 'current'] === true;
      var row = h('div', { class: 'row', role: 'group', 'data-automation-id': 'workExperience-' + (n + 1), 'aria-labelledby': p + '-heading' }, [
        h('h4', { id: p + '-heading', text: 'Work Experience ' + (n + 1) }),
        textField('w' + n + 'title', 'jobTitle', 'Job Title', { required: true }),
        textField('w' + n + 'company', 'company', 'Company', { required: true }),
        textField('w' + n + 'location', 'location', 'Location'),
        checkbox('w' + n + 'current', 'currentlyWorkHere', 'I currently work here', { onChange: function () { draw(); } }),
        date('w' + n + 'from', p + '--startDate', 'From', MONTHS, { required: true }),
        current ? null : date('w' + n + 'to', p + '--endDate', 'To', MONTHS, { required: true }),
        textField('w' + n + 'desc', 'description', 'Role Description', { multiline: true })
      ]);
      row.querySelectorAll('input, textarea').forEach(function (e) { if (!/dateSection/.test(e.id)) e.id = p + '--' + e.getAttribute('data-automation-id'); });
      row.querySelectorAll('label[for]').forEach(function (l) { var c = l.parentElement.querySelector('input, textarea'); if (c) { l.setAttribute('for', c.id); l.id = c.id + '-label'; } });
      holder.append(row);
    });
    var more = (S.work || []).length > 0;
    holder.append(h('button', { type: 'button', 'data-automation-id': 'Add', 'aria-label': more ? 'Add Another Work Experience' : 'Add Work Experience',
      text: more ? 'Add Another' : 'Add', on: { click: function () { S.work = (S.work || []).concat([{}]); draw(); } } }));
    return holder;
  }
  function educationRows() {
    var holder = h('div', { 'data-automation-id': 'educationSection' }, [h('h3', { text: 'Education' })]);
    (S.edu || []).forEach(function (_, n) {
      var p = 'education-' + (31 + n);
      holder.append(h('div', { class: 'row', role: 'group', 'data-automation-id': 'education-' + (n + 1), 'aria-labelledby': p + '-heading' }, [
        h('h4', { id: p + '-heading', text: 'Education ' + (n + 1) }),
        search('e' + n + 'school', 'school', 'School or University', ['University of Texas at Austin', 'University of Texas at Dallas', 'Texas A&M University', 'Rice University', 'Other'], { required: true }),
        listbox('e' + n + 'degree', 'degree', 'Degree', ['High School Diploma', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctorate'], { required: true }),
        search('e' + n + 'field', 'fieldOfStudy', 'Field of Study', ['Computer Engineering', 'Computer Science', 'Electrical Engineering', 'Mathematics', 'Information Technology']),
        textField('e' + n + 'gpa', 'gradeAverage', 'Overall Result (GPA)'),
        date('e' + n + 'to', p + '--lastYearAttended', 'To (Actual or Expected)', ['year'])
      ]));
    });
    var more = (S.edu || []).length > 0;
    holder.append(h('button', { type: 'button', 'data-automation-id': 'Add', 'aria-label': more ? 'Add Another Education' : 'Add Education',
      text: more ? 'Add Another' : 'Add', on: { click: function () { S.edu = (S.edu || []).concat([{}]); draw(); } } }));
    return holder;
  }

  var STEPS = [
    { key: 'createAccount', title: 'Create Account', footer: false, render: function () {
        var rules = h('div', { 'data-automation-id': 'passwordRequirements' });
        function check() {
          rules.textContent = '';
          var pw = S.password || '';
          [[/.{8,}/, 'Minimum 8 characters'], [/[A-Z]/, 'An uppercase character'], [/[a-z]/, 'A lowercase character'],
           [/[0-9]/, 'A numeric character'], [/[^A-Za-z0-9]/, 'A special character']].forEach(function (r) {
            if (pw && !r[0].test(pw)) rules.append(h('div', { role: 'alert', class: 'err', text: r[1] }));
          });
        }
        var pw = textField('password', 'password', 'Password', { type: 'password', required: true });
        pw.querySelector('input').addEventListener('input', check);
        check();
        var consentId = id('consent');
        var consent = h('input', { type: 'checkbox', id: consentId, 'data-automation-id': 'createAccountCheckbox', on: { change: function () { S.consent = consent.checked; } } });
        consent.checked = S.consent === true;
        return [
          h('div', { 'data-automation-id': 'createAccountPage' }, [
            textField('email', 'email', 'Email Address', { type: 'text', required: true }),
            pw, rules,
            textField('verify', 'verifyPassword', 'Verify New Password', { type: 'password', required: true }),
            h('span', { class: 'hidden-input', 'data-automation-id': 'createAccountCheckbox' }, [consent]),
            h('label', { for: consentId, text: 'Yes, I have read and consent to the terms and conditions' }),
            // In the card, not the footer (the footer is hidden on this step).
            // Workday's NoCaptchaButtonClickFilter: an overlay div holds the
            // click handler and sits just before the real button, which does
            // nothing when clicked itself.
            h('div', { style: 'position:relative;display:inline-block' }, [
              h('div', { role: 'button', tabindex: '0', 'aria-label': 'Create Account', 'data-automation-id': 'click_filter',
                style: 'position:absolute;inset:0;cursor:pointer', on: { click: function (e) { e.stopPropagation(); advance(); } } }),
              h('button', { type: 'button', tabindex: '-1', 'data-automation-id': 'createAccountSubmitButton', text: 'Create Account' })
            ]),
            h('p', {}, [h('a', { href: '#', 'data-automation-id': 'signInLink', text: 'Already have an account? Sign In' })])
          ])
        ];
      },
      valid: function () {
        var errs = [];
        if (!S.email) errs.push('Email Address');
        if (!S.password || S.password !== S.verify) errs.push('Passwords must match');
        if (!S.consent) errs.push('Consent');
        return errs;
      },
      sent: function () { return { email: S.email, password: S.password, verify: S.verify, consent: S.consent === true }; }
    },
    { key: 'myInformation', title: 'My Information', render: function () {
        return [
          search('source', 'source', 'How Did You Hear About Us?', ['Company Website', 'Employee Referral', 'Indeed', 'LinkedIn', 'Career Fair', 'Other'], { required: true }),
          radios('previous', 'candidateIsPreviousWorker', 'Have you previously worked for Acme?', ['Yes', 'No'], { required: true }),
          listbox('country', 'countryDropdown', 'Country', ['Canada', 'Mexico', 'United Kingdom', 'United States of America'], { required: true }),
          textField('first', 'legalNameSection_firstName', 'First Name', { required: true }),
          textField('last', 'legalNameSection_lastName', 'Last Name', { required: true }),
          textField('line1', 'addressSection_addressLine1', 'Address Line 1', { required: true }),
          textField('city', 'addressSection_city', 'City', { required: true }),
          listbox('state', 'addressSection_countryRegion', 'State', STATES, { required: true }),
          textField('postal', 'addressSection_postalCode', 'Postal Code', { required: true }),
          listbox('device', 'phone-device-type', 'Phone Device Type', ['Home', 'Mobile', 'Work'], { required: true }),
          search('dial', 'countryPhoneCode', 'Country Phone Code', ['Canada (+1)', 'Mexico (+52)', 'United Kingdom (+44)', 'United States of America (+1)'], { required: true, preset: 'United States of America (+1)' }),
          textField('phone', 'phone-number', 'Phone Number', { type: 'text', required: true }),
          textField('ext', 'phone-extension', 'Phone Extension')
        ];
      },
      required: ['source', 'previous', 'country', 'first', 'last', 'line1', 'city', 'state', 'postal', 'device', 'dial', 'phone']
    },
    { key: 'myExperience', title: 'My Experience', render: function () {
        return [
          workRows(),
          educationRows(),
          search('skills', 'skills', 'Type to Add Skills', ['AWS', 'C++', 'Docker', 'Go', 'Java', 'JavaScript', 'Kubernetes', 'Python', 'React', 'SQL'], { multi: true }),
          upload('resume', 'Resume/CV', { required: true }),
          textField('linkedin', 'linkedinQuestion', 'LinkedIn')
        ];
      },
      valid: function () {
        var errs = [];
        (S.work || []).forEach(function (_, n) {
          if (!S['w' + n + 'title'] || !S['w' + n + 'company']) errs.push('Work Experience ' + (n + 1));
          var f = S['w' + n + 'from'] || {};
          if (!f.month || !f.year) errs.push('Work Experience ' + (n + 1) + ' From');
          if (S['w' + n + 'current'] !== true) { var t = S['w' + n + 'to'] || {}; if (!t.month || !t.year) errs.push('Work Experience ' + (n + 1) + ' To'); }
        });
        (S.edu || []).forEach(function (_, n) {
          if (!(S['e' + n + 'school'] || []).length || !S['e' + n + 'degree']) errs.push('Education ' + (n + 1));
        });
        if (!S.resume) errs.push('Resume/CV');
        return errs;
      }
    },
    { key: 'applicationQuestions', title: 'Application Questions', render: function () {
        return [
          listbox('q_auth', 'q-authorized', 'Are you legally authorized to work in the United States?', ['Yes', 'No'], { required: true }),
          listbox('q_sponsor', 'q-sponsorship', 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?', ['Yes', 'No'], { required: true }),
          listbox('q_age', 'q-age', 'Are you at least 18 years of age?', ['Yes', 'No'], { required: true }),
          radios('q_onsite', 'q-onsite', 'Are you able to work a hybrid schedule in Austin, TX (three days a week in the office)?', ['Yes', 'No'], { required: true }),
          listbox('q_years', 'q-years', 'How many years of professional software engineering experience do you have?', ['0-1 years', '2-4 years', '5-7 years', '8+ years'], { required: true }),
          radios('q_former', 'q-former', 'Have you ever been employed by Acme or any of its subsidiaries?', ['Yes', 'No'], { required: true }),
          textField('q_salary', 'q-salary', 'What are your salary expectations?')
        ];
      },
      required: ['q_auth', 'q_sponsor', 'q_age', 'q_onsite', 'q_years', 'q_former']
    },
    { key: 'voluntaryDisclosures', title: 'Voluntary Disclosures', render: function () {
        return [
          listbox('gender', 'gender', 'Please select your gender:', ['Female', 'Male', 'I do not wish to self-identify'], { required: true }),
          listbox('ethnicity', 'ethnicityDropdown', 'Please select the ethnicity which most accurately describes how you identify yourself:', [
            'American Indian or Alaska Native (Not Hispanic or Latino) (United States of America)',
            'Asian (Not Hispanic or Latino) (United States of America)',
            'Black or African American (Not Hispanic or Latino) (United States of America)',
            'Hispanic or Latino (United States of America)',
            'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino) (United States of America)',
            'Two or More Races (Not Hispanic or Latino) (United States of America)',
            'White (Not Hispanic or Latino) (United States of America)',
            'I do not wish to self-identify (United States of America)'], { required: true }),
          listbox('veteran', 'veteranStatus', 'Please select the veteran status which most accurately describes your status:', [
            'I am not a protected veteran',
            'I identify as one or more of the classifications of protected veteran',
            'I do not wish to self-identify'], { required: true }),
          checkbox('terms', 'agreementCheckbox', 'I have read and consent to the terms and conditions', { required: true })
        ];
      },
      required: ['gender', 'ethnicity', 'veteran', 'terms']
    },
    { key: 'selfIdentify', title: 'Self Identify', render: function () {
        var fs = h('fieldset', { 'data-automation-id': 'formField-disabilityStatus' }, [h('legend', { text: 'Please check one of the boxes below:*' })]);
        ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'].forEach(function (o) {
          var cid = id('disability');
          var c = h('input', { type: 'checkbox', id: cid, on: { change: function () { S.disability = c.checked ? o : (S.disability === o ? '' : S.disability); } } });
          c.checked = S.disability === o;
          fs.append(h('div', {}, [c, h('label', { for: cid, text: o })]));
        });
        return [
          h('h3', { text: 'Voluntary Self-Identification of Disability' }),
          listbox('lang', 'language', 'Language', ['English'], { required: true }),
          textField('sname', 'name', 'Name', { required: true }),
          textField('empid', 'employeeId', 'Employee ID (if applicable)'),
          date('signed', 'selfIdentifiedDisabilityData--dateSignedOn', 'Date', ['month', 'day', 'year'], { required: true }),
          fs
        ];
      },
      required: ['lang', 'sname', 'disability'],
      valid: function () { var d = S.signed || {}; return d.month && d.day && d.year ? [] : ['Date']; }
    },
    { key: 'review', title: 'Review', next: 'Submit', render: function () {
        return [h('p', { text: 'Review your application, then submit it.' }), h('div', { 'data-automation-id': 'reviewSummary', text: (S.first || '') + ' ' + (S.last || '') })];
      }
    }
  ];
  S.lang = 'English';
  S.country = 'United States of America';

  var at = 0;
  function draw() {
    var step = STEPS[at];
    wd.renders += 1;
    title.textContent = step.title;
    content.textContent = '';
    step.render().forEach(function (n) { if (n) content.append(n); });
    next.textContent = step.next || 'Save and Continue';
    footer.style.display = step.footer === false ? 'none' : '';
  }
  function settleIn() {
    // Workday: a skeleton first, then the step, then two re-renders that
    // replace every node (values survive in state, the DOM does not).
    content.textContent = '';
    content.append(h('div', { 'data-automation-id': 'loadingSkeleton', text: 'Loading…' }));
    setTimeout(function () { draw(); setTimeout(draw, 250); setTimeout(draw, 600); }, 900);
  }
  function errorsFor(step) {
    var errs = (step.valid ? step.valid() : []).slice();
    (step.required || []).forEach(function (k) {
      var v = S[k];
      if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) errs.push(k);
    });
    return errs;
  }
  next.addEventListener('click', advance);
  function advance() {
    var step = STEPS[at];
    if (step.key === 'review') { wd.submitClicked = true; location.href = '/submitted'; return; }
    var errs = errorsFor(step);
    banner.textContent = '';
    if (errs.length) {
      wd.rejected.push({ step: step.key, errs: errs });
      banner.append(h('div', { role: 'alert', 'data-automation-id': 'errorBanner', text: 'Errors Found: ' + errs.join(', ') }));
      return;
    }
    wd.submissions.push({ step: step.key, sent: step.sent ? step.sent() : JSON.parse(JSON.stringify(S)) });
    at += 1;
    wd.steps.push(STEPS[at].key);
    settleIn();
  }
  // Debugging hooks for the probe: what this step still lacks, and the state.
  W.__wdMissing = function () { return errorsFor(STEPS[at]); };
  W.__wdState = function () { return JSON.parse(JSON.stringify(S)); };
  wd.steps.push(STEPS[0].key);
  settleIn();
})();
`;

export const APP_HTML = shell(
  "Acme Careers: Apply",
  `<main>
  <div data-automation-id="progressBar">Create Account · My Information · My Experience · Application Questions · Voluntary Disclosures · Self Identify · Review</div>
  <h2 data-automation-id="pageHeader" id="wd-step-title"></h2>
  <div id="wd-errors"></div>
  <div data-automation-id="applyFlowPage" id="wd-content"></div>
</main>
<div id="wd-footer" data-automation-id="pageFooter">
  <button type="button" data-automation-id="pageFooterBackButton">Back</button>
  <button type="button" data-automation-id="pageFooterNextButton" id="wd-next">Save and Continue</button>
</div>
<script>${APP_SCRIPT}</script>`
);
