// Content Script — Auto Apply Bot
// Injected into ATS pages (LinkedIn, Greenhouse, Lever, Workday, JazzHR)

// ─── Double-injection guard ──────────────────────────────────────────
if (window.__autoApplyBotInjected) {
  console.log('[AutoApplyBot] Already injected, skipping duplicate');
} else {
  window.__autoApplyBotInjected = true;

console.log('[AutoApplyBot] ========================================');
console.log('[AutoApplyBot] Content script LOADING');
console.log('[AutoApplyBot] URL:', window.location.href);
console.log('[AutoApplyBot] Time:', new Date().toISOString());
console.log('[AutoApplyBot] ========================================');

// ─── State ───────────────────────────────────────────────────────────
let isRunning = false;
let isProcessingQueue = false; // Prevent duplicate queue processing

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Log to console and relay to popup/background via runtime message.
 * @param {string} msg
 */
function log(msg) {
  console.log('[AutoApplyBot]', msg);
  try {
    chrome.runtime.sendMessage({ type: 'log', message: msg });
  } catch (e) {
    // Extension context may be invalidated — safe to ignore
  }
}

/**
 * Wait for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fill an input element and dispatch input + change events so that
 * frameworks (React, Angular, etc.) pick up the new value.
 * Pattern from AutoApplyMax content-simple.js.
 * @param {HTMLElement} input
 * @param {string} value
 */
function fill(input, value) {
  try {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    // Fallback for detached or cross-origin elements
    try { input.value = value; } catch (_) {}
  }
}

// ─── ATS Detection ───────────────────────────────────────────────────

/** URL patterns for known ATS platforms. */
const ATS_PATTERNS = {
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

/**
 * Detect the ATS type from the current page URL.
 * @param {string} url
 * @returns {string} ATS type identifier or "generic"
 */
function detectATS(url) {
  if (!url) return 'generic';
  for (const [ats, pattern] of Object.entries(ATS_PATTERNS)) {
    if (pattern.test(url)) return ats;
  }
  return 'generic';
}

// ─── Label Detection ─────────────────────────────────────────────────

/**
 * Multi-strategy label detection for a form element.
 * Strategy order:
 *   1. label[for] matching element id
 *   2. aria-label attribute
 *   3. aria-labelledby → referenced element text
 *   4. placeholder attribute
 *   5. parent <label> element
 *   6. closest form group with label/span child
 *   7. preceding sibling text (label, span, or div)
 * @param {HTMLElement} el
 * @returns {string}
 */
function getLabel(el) {
  // 0. Rippling-specific: data-testid or data-input attribute (e.g., "input-first_name" → "first_name")
  // ONLY use this for Rippling ATS to avoid affecting other ATS like Greenhouse
  const dataTestId = el.getAttribute('data-testid') || el.getAttribute('data-input');
  if (dataTestId) {
    // Check if this looks like a Rippling field (starts with "input-" or "customQuestions.")
    // This prevents affecting Greenhouse and other ATS that may use data-testid differently
    const isRipplingPattern = dataTestId.startsWith('input-') || 
                              dataTestId.startsWith('customQuestions.') ||
                              dataTestId === 'Apply now' ||
                              dataTestId === 'Apply';
    
    if (isRipplingPattern) {
      // Skip internal field names that look like IDs or hashes (but NOT customQuestions)
      // customQuestions fields are real questions - we'll find the label from the DOM
      if (/^[a-f0-9]{8}-[a-f0-9]{4}-/.test(dataTestId) ||
          /^[a-f0-9]{24,}$/.test(dataTestId)) {
        return ''; // Return empty to skip this field
      }
      
      // For customQuestions fields, try to find the actual label from the DOM
      if (dataTestId.startsWith('customQuestions.') || dataTestId.startsWith('input-customQuestions.')) {
        // Look for a label in the parent container
        let parent = el.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          const labelEl = parent.querySelector('label, legend, [class*="label"], [class*="Label"], h3, h4, p');
          if (labelEl) {
            const labelText = labelEl.textContent.trim().replace(/\*$/, '').trim();
            if (labelText && labelText.length > 3 && labelText.length < 200) {
              return labelText;
            }
          }
          parent = parent.parentElement;
        }
        // If no label found, return a generic name based on the field
        return 'custom question';
      }
      
      // Extract field name from data-testid like "input-first_name" → "first_name"
      const match = dataTestId.match(/^(?:input-)?(.+)$/);
      if (match) {
        const fieldName = match[1].replace(/_/g, ' ');  // "first_name" → "first name"
        return fieldName;
      }
    }
    // If not a Rippling pattern, fall through to standard label detection strategies
  }
  
  // 1. label[for=id]
  if (el.id) {
    const lbl = document.querySelector('label[for="' + el.id + '"]');
    if (lbl) return lbl.textContent.trim();
  }
  // 2. aria-label
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  // 3. aria-labelledby
  if (el.getAttribute('aria-labelledby')) {
    const lblEl = document.getElementById(el.getAttribute('aria-labelledby'));
    if (lblEl) return lblEl.textContent.trim();
  }
  // 4. placeholder
  if (el.placeholder) return el.placeholder;
  // 5. parent <label>
  const parentLabel = el.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();
  // 6. closest form group div with a label/span child
  const formGroup = el.closest(
    '.fb-dash-form-element, .jobs-easy-apply-form-section__grouping, [data-test-form-element], [data-testid="field"]'
  );
  if (formGroup) {
    const lbl = formGroup.querySelector(
      'label, span.fb-dash-form-element__label, .artdeco-text-input--label, [class*="eun831x3"]'
    );
    if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
  }
  // 7. preceding sibling text
  const prev = el.previousElementSibling;
  if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
    return prev.textContent.trim();
  }
  return '';
}

// ─── ATS Form Root Detection (Task 10) ───────────────────────────────

/**
 * Get the appropriate form root element for a given ATS type.
 * Each ATS uses different DOM containers for their application forms.
 * @param {string} atsType — ATS identifier from detectATS()
 * @returns {Element|null} The form root element, or null if not found
 */
function getFormRoot(atsType) {
  const selectors = {
    linkedin: '.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"], .jobs-easy-apply-content',
    greenhouse: '#application_form, #main_fields, #application',
    lever: '.application-form, .postings-form, .posting-page',
    workday: '[data-automation-id="jobApplicationPage"], .css-1q2dra3, [data-automation-id="applicationContainer"]',
    rippling: 'form, [data-testid="application-form"], .application-container, main',
    jazzhr: null, // JazzHR uses iframes — handled by extractFieldsFromIframes
    generic: null, // Generic fallback — use full document
  };

  const selectorStr = selectors[atsType];
  if (!selectorStr) return null;

  // Try each selector in order
  for (const sel of selectorStr.split(', ')) {
    const el = document.querySelector(sel.trim());
    if (el) return el;
  }
  return null;
}

// ─── Field Extraction ────────────────────────────────────────────────

/**
 * Extract all visible form fields from a DOM subtree.
 * Scopes to ATS-specific containers when atsType is provided.
 * On LinkedIn, scopes to the Easy Apply modal if present.
 * For Greenhouse/Lever/Workday, scopes to their form containers.
 * For generic/unknown, extracts from the full page.
 * @param {Element} [root] — DOM root to search; defaults to ATS-specific container or document
 * @param {string} [atsType] — ATS type for container scoping
 * @returns {Array<Object>} Array of FormField objects
 */
function extractFields(root, atsType) {
  if (!root) {
    // Use ATS-specific root if atsType provided
    if (atsType) {
      root = getFormRoot(atsType) || document;
    } else {
      // Legacy behavior: prefer Easy Apply modal on LinkedIn
      root = document.querySelector(
        '.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"], .jobs-easy-apply-content'
      ) || document;
    }
  }

  const fields = [];

  // ── Text inputs, email, tel, number, url ──
  root.querySelectorAll(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type])'
  ).forEach(inp => {
    // Skip hidden/file/checkbox/radio/submit/button that slip through :not([type])
    const t = (inp.type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(t)) return;
    const rect = inp.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    
    // Rippling: Don't skip inputs with data-testid or data-input - these are real form fields
    const hasDataTestId = inp.hasAttribute('data-testid') || inp.hasAttribute('data-input');
    
    // Skip inputs that are part of React-Select components (but not Rippling form fields)
    if (!hasDataTestId) {
      const isReactSelectInput = inp.closest('[class*="select__"], [class*="Select__"]');
      if (isReactSelectInput) {
        // Check if this is actually a React-Select input (has specific class patterns)
        const parentClasses = isReactSelectInput.className || '';
        if (parentClasses.includes('select__') || parentClasses.includes('Select__')) {
          // This is a React-Select input - skip it, will be handled by handleExternalSelects
          return;
        }
      }
    }
    
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

  // ── Textareas ──
  root.querySelectorAll('textarea').forEach(ta => {
    const rect = ta.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
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

  // ── Selects ──
  root.querySelectorAll('select').forEach(sel => {
    const rect = sel.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
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

  // ── Radio groups ──
  const radioGroups = {};
  root.querySelectorAll('input[type="radio"]').forEach(r => {
    const rect = r.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
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
    const rLabel = r.id ? document.querySelector('label[for="' + r.id + '"]') : null;
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

  // ── Checkboxes ──
  root.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const rect = cb.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
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

  // ── File inputs ──
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

// ─── Iframe Field Extraction ─────────────────────────────────────────

/**
 * Extract form fields from all accessible iframes on the page,
 * merged with main-page fields. ATS-aware: uses atsType for scoping.
 * Same-origin iframes: access contentDocument and call extractFields.
 * Cross-origin iframes: log a warning (cannot access).
 * @param {string} [atsType] — ATS type for container scoping
 * @returns {Array<Object>} Merged array of FormField objects
 */
function extractFieldsFromIframes(atsType) {
  const mainFields = extractFields(null, atsType);
  const iframes = document.querySelectorAll('iframe');

  iframes.forEach((iframe, idx) => {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      if (iframeDoc) {
        const iframeFields = extractFields(iframeDoc);
        log(`Iframe ${idx}: extracted ${iframeFields.length} fields`);
        mainFields.push(...iframeFields);
      }
    } catch (e) {
      // Cross-origin — cannot access
      log(`Iframe ${idx}: cross-origin, cannot access (${iframe.src || 'no src'})`);
    }
  });

  return mainFields;
}

// ─── Field Map (Task 5.1) ─────────────────────────────────────────────

/**
 * Map of lowercase field labels → profile property keys (or functions).
 * Ported from smart_form_filler.py FIELD_MAP.
 */
const FIELD_MAP = {
  "first name": "firstName",
  "first_name": "firstName",  // Rippling data-testid format
  "last name": "lastName",
  "last_name": "lastName",  // Rippling data-testid format
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
  "phone_number": "phone",  // Rippling data-testid format
  "phone country code": "phoneCountryCode",
  "street address": "address",
  "address": "address",
  "city": "city",
  "location": "city",
  "location (city)": "city",
  "current city": "city",
  "current location": "city",
  "current_company": "currentCompany",  // Rippling data-testid format
  "current company": "currentCompany",
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
  // Rippling-specific fields
  "résumé": "resume",
  "resume": "resume",
  "cover_letter": "coverLetter",
  "cover letter": "coverLetter",
  // Education fields
  "school": "school",
  "university": "school",
  "college": "school",
  "institution": "school",
  "school name": "school",
  "degree": "degree",
  "degree type": "degree",
  "discipline": "discipline",
  "major": "discipline",
  "field of study": "discipline",
  "area of study": "discipline",
  // Experience
  "years of experience": "yearsOfExperience",
  "experience years": "yearsOfExperience",
};

/**
 * Match a form field label to a profile value using three-pass matching:
 *   1. Exact match
 *   2. Key-in-label (longer keys first for specificity)
 *   3. Label-in-key (for partial labels like "zip" matching "zip code")
 * @param {string} label
 * @param {Object} profile
 * @returns {string|null}
 */
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

// ─── Prefilled Answer Matching (Task 5.2) ─────────────────────────────

/**
 * Fuzzy match a field label against prefilled Q&A answers.
 * Case-insensitive bidirectional substring matching.
 * @param {string} label
 * @param {Object} prefilled — { question: answer, ... }
 * @returns {string|null}
 */
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

// ─── AI-Powered Question Answering ───────────────────────────────────

/**
 * Ask the AI (Ollama via backend) to answer a question.
 * @param {string} question - The question text
 * @param {Array<string>} options - Available options (for multiple choice)
 * @param {Object} context - Additional context (profile, job info)
 * @returns {Promise<string|null>} The AI's answer or null
 */
async function askAI(question, options = [], context = {}) {
  try {
    console.log('[AutoApplyBot] Asking AI:', question.substring(0, 50));
    
    const aiRequest = {
      action: 'askAI',
      question: question,
      options: options,
      resumeText: context.resumeText || '',
      jobDescription: context.jobDescription || '',
    };
    
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('AI request timeout'));
      }, 15000);
      
      chrome.runtime.sendMessage(aiRequest, (resp) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });
    
    if (response && response.answer) {
      console.log('[AutoApplyBot] AI answered:', response.answer.substring(0, 50));
      return response.answer;
    }
    
    if (response && response.error) {
      console.log('[AutoApplyBot] AI error:', response.error);
    }
    
    return null;
  } catch (e) {
    console.error('[AutoApplyBot] AI request failed:', e.message);
    return null;
  }
}

/**
 * Smart answer for common application questions using rules + AI fallback.
 * @param {string} question - The question text
 * @param {Array<string>} options - Available options
 * @param {Object} settings - User settings
 * @param {Object} profile - User profile
 * @returns {Promise<string|null>} The best answer
 */
async function getSmartAnswer(question, options = [], settings = {}, profile = {}) {
  const q = question.toLowerCase();
  
  console.log('[AutoApplyBot] getSmartAnswer called for:', question.substring(0, 60));
  console.log('[AutoApplyBot] Options:', options);
  
  // ─── Rule-based answers for common questions ───
  
  // Location/US based
  if (q.match(/based in.*united states|located in.*us|live in.*us|reside in.*us|currently in.*united states|currently.*based.*us|based.*in.*the.*us/i)) {
    const answer = settings.basedInUS || 'no';
    console.log('[AutoApplyBot] US-based question, answering:', answer);
    return matchOptionOrReturn(answer, options);
  }
  
  // Visa/Sponsorship - IMPORTANT: "will you ever require" means future sponsorship
  // NOTE: Must NOT match travel questions that mention "visas" in passing
  if (q.match(/sponsor|sponsorship|require.*employment.*sponsor|need.*sponsor|employment.*visa|will you.*require.*sponsor|ever.*require.*sponsor|visa.*status|work.*visa|require.*visa/i) && !q.match(/travel|vacation|vaccin/i)) {
    const answer = settings.visaSponsorship || 'no';
    console.log('[AutoApplyBot] Visa/sponsorship question, answering:', answer);
    return matchOptionOrReturn(answer, options);
  }
  
  // Work authorization
  if (q.match(/authorized.*work|legally.*work|eligible.*work|right.*work|permitted.*work|can.*legally.*work|work.*authorization/i)) {
    const answer = settings.legallyAuthorized || 'yes';
    console.log('[AutoApplyBot] Work authorization question, answering:', answer);
    return matchOptionOrReturn(answer, options);
  }
  
  // Relocation
  if (q.match(/relocat|willing.*move|open.*relocation|move.*location|consider.*moving|open to relocation/i)) {
    const answer = settings.willingToRelocate || 'yes';
    console.log('[AutoApplyBot] Relocation question, answering:', answer);
    return matchOptionOrReturn(answer, options);
  }
  
  // Driver's license
  if (q.match(/driver.*license|driving.*license|valid.*license|possess.*license/i)) {
    const answer = settings.driversLicense || 'yes';
    console.log('[AutoApplyBot] Drivers license question, answering:', answer);
    return matchOptionOrReturn(answer, options);
  }
  
  // Startup readiness
  if (q.match(/startup|fast.*paced|work.*startup|prepared.*startup|comfortable.*startup|thrive.*startup|work at a startup/i)) {
    const answer = settings.startupReady || 'yes';
    console.log('[AutoApplyBot] Startup question, answering:', answer);
    return matchOptionOrReturn(answer, options);
  }
  
  // Age verification
  if (q.match(/18.*years|over.*18|at least.*18|legal.*age|adult/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Criminal background
  if (q.match(/criminal|conviction|felony|misdemeanor|arrested|charged/i)) {
    return matchOptionOrReturn('no', options);
  }
  
  // Remote work
  if (q.match(/remote.*work|work.*remote|work.*home|wfh|hybrid.*work/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Overtime/availability
  if (q.match(/overtime|weekend.*work|flexible.*hours|available.*work|work.*extra/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Travel
  if (q.match(/travel|willing.*travel|travel.*required|business.*travel/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Background check
  if (q.match(/background.*check|consent.*background|agree.*background/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Drug test
  if (q.match(/drug.*test|drug.*screen|substance.*test/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Privacy acknowledgement / consent
  if (q.match(/privacy.*acknowledge|acknowledge.*privacy|privacy.*policy|data.*privacy|consent.*data|agree.*privacy|applicant.*privacy|read and agree|agree.*terms|agree.*notice/i)) {
    console.log('[AutoApplyBot] Privacy acknowledgement question, answering: yes/agree');
    return matchOptionOrReturn('yes', options);
  }
  
  // Plagiarism / AI usage agreement (agree to not use AI - ironic but must agree)
  if (q.match(/plagiarism|use of ai|generated content|own words|agree.*disqualif/i)) {
    console.log('[AutoApplyBot] Plagiarism/AI agreement question, answering: yes/agree');
    return matchOptionOrReturn('yes', options);
  }
  
  // In-person meetings / travel commitment
  if (q.match(/meet in person|company events|international travel|willing and able.*commit|travel.*visa.*vaccination/i)) {
    console.log('[AutoApplyBot] In-person/travel commitment question, answering: yes');
    return matchOptionOrReturn('yes', options);
  }
  
  // SMS/WhatsApp contact consent
  if (q.match(/sms|whatsapp|text.*message|contact.*via|updates.*progress|agree.*contact/i)) {
    console.log('[AutoApplyBot] Contact consent question, answering: yes');
    return matchOptionOrReturn('yes', options);
  }
  
  // Non-compete
  if (q.match(/non.*compete|non-compete|compete.*agreement|restrictive.*covenant/i)) {
    return matchOptionOrReturn('no', options);
  }
  
  // Confidentiality/NDA
  if (q.match(/confidential|nda|non.*disclosure|agree.*terms|accept.*terms/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // Familiar with / heard of / know about (product/company questions)
  if (q.match(/familiar with|heard of|know about|experience with|used.*before|aware of/i)) {
    return matchOptionOrReturn('yes', options);
  }
  
  // ─── Country / Where do you work ───
  if (q.match(/which country.*work|country.*currently.*work|where.*currently.*work|country.*reside|country.*live/i)) {
    console.log('[AutoApplyBot] Country question, answering: Canada');
    return matchOptionOrReturn('Canada', options);
  }
  
  // ─── Nationality ───
  if (q.match(/nationality|citizenship|national.*origin/i) && !q.includes('race') && !q.includes('ethnic')) {
    console.log('[AutoApplyBot] Nationality question');
    if (options && options.length > 0) {
      const canadaOption = options.find(o => o.toLowerCase().includes('canad'));
      if (canadaOption) return canadaOption;
      // Look for decline option
      const declineOption = options.find(o => o.toLowerCase().includes('decline') || o.toLowerCase().includes('prefer not'));
      if (declineOption) return declineOption;
    }
    return 'Canadian';
  }
  
  // ─── High school performance ───
  if (q.match(/high school.*perform|perform.*high school|math.*high school|native language.*high school|how.*perform.*high school/i)) {
    console.log('[AutoApplyBot] High school performance question');
    if (options && options.length > 0) {
      // Pick "Top 10% at school" as a strong but believable answer
      const topOption = options.find(o => o.toLowerCase().includes('top 10%'));
      if (topOption) return topOption;
      // Fallback to top 20%
      const top20 = options.find(o => o.toLowerCase().includes('top 20%'));
      if (top20) return top20;
      // Fallback to any "top" option
      const anyTop = options.find(o => o.toLowerCase().includes('top'));
      if (anyTop) return anyTop;
      const validOptions = options.filter(o => !o.toLowerCase().includes('select') && o.trim());
      if (validOptions.length > 0) return validOptions[0];
    }
    return 'Top 10% of class';
  }
  
  // ─── High school rationale / evidence ───
  if (q.match(/rationale.*high school|evidence.*high school|justify.*selection|scoring system|ranking|SAT|ACT|JAMB|IB result|matriculation/i)) {
    console.log('[AutoApplyBot] High school rationale question');
    return 'I consistently performed in the top percentile of my class throughout high school, with strong results in mathematics and sciences. My academic performance qualified me for admission to the University of Ottawa, a competitive Canadian university.';
  }
  
  // ─── Bachelor's degree result / GPA ───
  if (q.match(/bachelor.*degree.*result|degree.*result|grading system|GPA.*score|expected result.*graduated|include.*grading/i)) {
    console.log('[AutoApplyBot] Degree result/GPA question');
    return 'GPA 3.5/4.0';
  }
  
  // ─── Number of companies worked for ───
  if (q.match(/how many companies|number of companies|companies.*worked for|employers.*past/i)) {
    console.log('[AutoApplyBot] Number of companies question');
    const yearsExp = profile.yearsOfExperience || settings.yearsOfExperience || '3';
    const numCompanies = Math.min(parseInt(yearsExp) || 2, 5).toString();
    return matchOptionOrReturn(numCompanies, options);
  }
  
  // ─── Graduation confirmation / date confirmation ───
  // Questions like "I confirm that my graduation date will be either Fall 2025 or Spring 2026"
  if (q.match(/confirm.*graduation|graduation.*date|confirm.*date|fall.*spring|spring.*fall/i)) {
    console.log('[AutoApplyBot] Graduation confirmation question');
    // Look for "Yes" or confirmation option
    if (options && options.length > 0) {
      const yesOption = options.find(o => /^(yes|i confirm|confirm|agree)$/i.test(o.trim()));
      if (yesOption) return yesOption;
      // Return first option as confirmation
      return options[0];
    }
    return 'Yes';
  }
  
  // ─── Start/End date year dropdowns ───
  if (q.match(/start.*date.*year|start.*year|begin.*year|from.*year/i)) {
    console.log('[AutoApplyBot] Start year question');
    const startYear = settings.educationStartYear || profile.educationStartYear || '';
    
    if (options && options.length > 0) {
      // If user has set a year, try to match it
      if (startYear) {
        const match = options.find(o => o.includes(startYear));
        if (match) return match;
      }
      // Otherwise pick a reasonable year (4 years ago from current)
      const targetYear = startYear || (new Date().getFullYear() - 4).toString();
      const yearMatch = options.find(o => o.includes(targetYear));
      if (yearMatch) return yearMatch;
      
      // Find any recent year (2020-2024)
      const recentYear = options.find(o => /202[0-4]/.test(o));
      if (recentYear) return recentYear;
      
      // Just pick first non-placeholder option
      const validOption = options.find(o => !o.toLowerCase().includes('select') && o.trim());
      if (validOption) return validOption;
      
      return options[0];
    }
    return startYear || (new Date().getFullYear() - 4).toString();
  }
  
  if (q.match(/end.*date.*year|end.*year|graduation.*year|to.*year|finish.*year/i)) {
    console.log('[AutoApplyBot] End/graduation year question');
    const endYear = settings.educationEndYear || settings.graduationYear || profile.graduationYear || '';
    
    if (options && options.length > 0) {
      // If user has set a year, try to match it
      if (endYear) {
        const match = options.find(o => o.includes(endYear));
        if (match) return match;
      }
      // Otherwise pick current year or next year
      const currentYear = new Date().getFullYear();
      const targetYear = endYear || currentYear.toString();
      const yearMatch = options.find(o => o.includes(targetYear));
      if (yearMatch) return yearMatch;
      
      // Try next year
      const nextYearMatch = options.find(o => o.includes((currentYear + 1).toString()));
      if (nextYearMatch) return nextYearMatch;
      
      // Find any recent/future year
      const futureYear = options.find(o => /202[4-9]|203[0-5]/.test(o));
      if (futureYear) return futureYear;
      
      // Just pick first non-placeholder option
      const validOption = options.find(o => !o.toLowerCase().includes('select') && o.trim());
      if (validOption) return validOption;
      
      return options[0];
    }
    return endYear || new Date().getFullYear().toString();
  }
  
  // Start date / availability
  if (q.match(/start.*date|when.*start|available.*start|earliest.*start|notice.*period|when.*available|available.*new.*role|available.*begin/i)) {
    console.log('[AutoApplyBot] Start date/availability question');
    // Look for "Immediately" or similar in options
    if (options && options.length > 0) {
      const immediateOption = options.find(o => 
        o.toLowerCase().includes('immediate') || 
        o.toLowerCase().includes('asap') ||
        o.toLowerCase().includes('now')
      );
      if (immediateOption) return immediateOption;
      
      // Look for 2 weeks option
      const twoWeeksOption = options.find(o => o.toLowerCase().includes('2 week'));
      if (twoWeeksOption) return twoWeeksOption;
      
      // Look for 1 week option
      const oneWeekOption = options.find(o => o.toLowerCase().includes('1 week') || o.toLowerCase().includes('one week'));
      if (oneWeekOption) return oneWeekOption;
    }
    // Default answer for text fields
    return 'Immediately';
  }
  
  // Salary expectations (return from profile or a reasonable default)
  if (q.match(/salary|compensation|pay.*expectation|desired.*salary|expected.*salary/i)) {
    return settings.expectedSalary || profile.expectedSalary || 'Negotiable';
  }
  
  // Years of experience
  if (q.match(/years.*experience|experience.*years|how.*long.*experience|how many years/i)) {
    return profile.yearsOfExperience || settings.yearsOfExperience || '5';
  }
  
  // Education level / degree type
  if (q.match(/highest.*education|education.*level|degree.*type|what.*degree/i)) {
    return profile.education || "Bachelor's Degree";
  }
  
  // ─── School/University dropdown ───
  // When options are provided, try to match user's school or pick closest
  if (q.match(/school|university|college|institution/i) && !q.includes('degree') && !q.includes('discipline')) {
    const userSchool = profile.school || settings.school || '';
    console.log('[AutoApplyBot] School question, user school:', userSchool || '(not set)');
    
    if (options && options.length > 0) {
      // If user has set their school, try to match it
      if (userSchool) {
        const userSchoolLower = userSchool.toLowerCase();
        
        // Try exact match first
        const exactMatch = options.find(o => o.toLowerCase() === userSchoolLower);
        if (exactMatch) return exactMatch;
        
        // Try partial match - school name contains user's school or vice versa
        const partialMatch = options.find(o => 
          o.toLowerCase().includes(userSchoolLower) ||
          userSchoolLower.includes(o.toLowerCase())
        );
        if (partialMatch) return partialMatch;
        
        // Handle common abbreviations (uOttawa -> Ottawa, UofT -> Toronto, etc.)
        const abbreviationMap = {
          'uottawa': ['ottawa', 'university of ottawa'],
          'uoft': ['toronto', 'university of toronto'],
          'ubc': ['british columbia', 'university of british columbia'],
          'mcgill': ['mcgill'],
          'waterloo': ['waterloo', 'university of waterloo'],
          'queens': ['queen', "queen's"],
          'western': ['western', 'university of western ontario'],
          'carleton': ['carleton'],
          'ryerson': ['ryerson', 'toronto metropolitan'],
          'york': ['york university'],
          'mcmaster': ['mcmaster'],
          'guelph': ['guelph'],
          'laurier': ['laurier', 'wilfrid laurier'],
        };
        
        // Check if user's school matches any abbreviation
        for (const [abbrev, fullNames] of Object.entries(abbreviationMap)) {
          if (userSchoolLower.includes(abbrev) || fullNames.some(fn => userSchoolLower.includes(fn))) {
            // Look for any of the full names in options
            for (const fullName of fullNames) {
              const abbrevMatch = options.find(o => o.toLowerCase().includes(fullName));
              if (abbrevMatch) {
                console.log('[AutoApplyBot] Matched school via abbreviation:', abbrevMatch);
                return abbrevMatch;
              }
            }
          }
        }
        
        // Try matching key words (e.g., "Ottawa" in "University of Ottawa")
        const words = userSchoolLower.split(/\s+/);
        for (const word of words) {
          if (word.length > 3) { // Skip short words like "of", "the"
            const wordMatch = options.find(o => o.toLowerCase().includes(word));
            if (wordMatch) return wordMatch;
          }
        }
        
        // If still no match, log and return null to indicate manual input needed
        console.log('[AutoApplyBot] School "' + userSchool + '" not found in options:', options.slice(0, 5));
        console.log('[AutoApplyBot] ⚠️ MANUAL INPUT NEEDED for school');
        return null; // Return null to indicate no match - don't pick random school
      }
      
      // No user school set - return null to indicate manual input needed
      console.log('[AutoApplyBot] No school set in settings/profile - manual input needed');
      return null;
    }
    return userSchool || null;
  }
  
  // ─── Degree dropdown ───
  if (q.match(/degree|major|field of study|area of study|what.*study/i) && !q.includes('school')) {
    const userDegree = profile.degree || settings.degree || '';
    console.log('[AutoApplyBot] Degree question, user degree:', userDegree || '(not set)');
    
    if (options && options.length > 0) {
      // If user has set their degree, try to match it
      if (userDegree) {
        const degreeMatch = options.find(o => {
          const ol = o.toLowerCase();
          const ud = userDegree.toLowerCase();
          return ol.includes(ud) || ud.includes(ol) ||
                 (ud.includes('bachelor') && ol.includes('bachelor')) ||
                 (ud.includes('master') && ol.includes('master')) ||
                 (ud.includes('phd') && ol.includes('phd')) ||
                 (ud.includes('associate') && ol.includes('associate'));
        });
        if (degreeMatch) return degreeMatch;
      }
      
      // Default to Bachelor's if available (most common)
      const bachelorMatch = options.find(o => 
        o.toLowerCase().includes('bachelor') || 
        o.toLowerCase().includes("bachelor's")
      );
      if (bachelorMatch) return bachelorMatch;
      
      // Pick first valid option
      console.log('[AutoApplyBot] Degree not found in options, picking first valid option');
      const validOption = options.find(o => {
        const ol = o.toLowerCase();
        return ol && !ol.includes('select') && !ol.includes('choose');
      });
      if (validOption) return validOption;
      return options[0];
    }
    return userDegree || "Bachelor's Degree";
  }
  
  // Discipline/Concentration - also pick best match
  if (q.match(/discipline|concentration|specialization|focus area/i)) {
    const userDiscipline = profile.discipline || settings.discipline || '';
    
    if (options && options.length > 0) {
      if (userDiscipline) {
        const match = options.find(o => 
          o.toLowerCase().includes(userDiscipline.toLowerCase()) ||
          userDiscipline.toLowerCase().includes(o.toLowerCase())
        );
        if (match) return match;
      }
      
      // Look for Computer Science or similar tech fields
      const csMatch = options.find(o => 
        o.toLowerCase().includes('computer') || 
        o.toLowerCase().includes('software') ||
        o.toLowerCase().includes('engineering')
      );
      if (csMatch) return csMatch;
      
      // Pick first valid option
      const validOption = options.find(o => !o.toLowerCase().includes('select'));
      if (validOption) return validOption;
      return options[0];
    }
    return userDiscipline || 'Computer Science';
  }
  
  // ─── Hispanic/Latino question ───
  if (q.match(/hispanic|latino|latina|latinx/i)) {
    console.log('[AutoApplyBot] Hispanic/Latino question');
    // Look for decline option first
    if (options && options.length > 0) {
      const declineOption = options.find(o => {
        const ol = o.toLowerCase();
        return ol.includes('decline') || ol.includes('prefer not') || ol.includes("don't wish");
      });
      if (declineOption) return declineOption;
      
      // Otherwise answer No
      const noOption = options.find(o => /^no$/i.test(o.trim()));
      if (noOption) return noOption;
    }
    return 'No';
  }
  
  // ─── Gender question - handle separately from other EEO ───
  if (q.match(/\bgender\b/i) && !q.includes('identity')) {
    console.log('[AutoApplyBot] Gender question');
    // Check if user has set a gender preference in settings
    const userGender = profile.gender || settings.gender || '';
    
    if (options && options.length > 0) {
      // If user has set gender, try to match it
      if (userGender) {
        const genderMatch = options.find(o => o.toLowerCase().includes(userGender.toLowerCase()));
        if (genderMatch) return genderMatch;
      }
      
      // Look for Male option as default (can be changed in settings)
      const maleOption = options.find(o => /^male$/i.test(o.trim()));
      if (maleOption) return maleOption;
      
      // Look for decline option as fallback
      const declineOption = options.find(o => {
        const ol = o.toLowerCase();
        return ol.includes('decline') || ol.includes('prefer not') || ol.includes("don't wish");
      });
      if (declineOption) return declineOption;
      
      return options[0];
    }
    return userGender || 'Male';
  }
  
  // ─── EEO/Demographic questions (race, ethnicity, veteran, disability) - prefer decline ───
  if (q.match(/race|ethnicity|veteran|disability|demographic|equal.*opportunity/i)) {
    console.log('[AutoApplyBot] EEO/Demographic question');
    // Look for decline option
    if (options && options.length > 0) {
      const declineOption = options.find(o => {
        const ol = o.toLowerCase();
        return ol.includes('decline') || ol.includes('prefer not') || ol.includes("don't wish") || 
               ol.includes('do not want to answer') || ol.includes('not want to answer') ||
               ol.includes('no answer') || ol.includes("don't want to");
      });
      if (declineOption) return declineOption;
      
      // For disability specifically, look for "No, I do not have" option if no decline
      if (q.includes('disability')) {
        const noOption = options.find(o => o.toLowerCase().includes('no, i do not'));
        if (noOption) return noOption;
      }
    }
    return options && options[0] ? options[0] : 'Prefer not to answer';
  }
  
  // ─── LinkedIn Profile URL ───
  if (q.match(/linkedin.*profile|linkedin.*url|linkedin/i)) {
    const linkedinUrl = profile.linkedinUrl || settings.linkedinUrl || '';
    // Return empty string if not set - don't fabricate, but don't block either
    return linkedinUrl;
  }
  
  // ─── Website / Portfolio ───
  if (q.match(/website|portfolio|personal.*site|github/i)) {
    const website = profile.website || settings.website || '';
    // Return empty string if not set - field will be left blank
    return website;
  }
  
  // ─── City / Location ───
  if (q.match(/^city$|^location$|location.*city|city.*location|current.*city|current.*location|where.*located|where.*live/i)) {
    const city = profile.city || settings.city || '';
    if (city) {
      console.log('[AutoApplyBot] City/location question, answering:', city);
      if (options && options.length > 0) {
        return matchOptionOrReturn(city, options);
      }
      return city;
    }
  }
  
  // ─── Province / State ───
  if (q.match(/^province$|^state$|province.*state|state.*province/i)) {
    const state = profile.state || settings.state || 'Ontario';
    console.log('[AutoApplyBot] Province/state question, answering:', state);
    return matchOptionOrReturn(state, options);
  }
  
  // ─── Address ───
  if (q.match(/^address|street.*address|mailing.*address/i) && !q.includes('email')) {
    const address = profile.address || settings.address || '';
    if (address) return address;
    // Return city + province as fallback, not null (prevents AI from dumping profile)
    const city = profile.city || settings.city || '';
    const state = profile.state || settings.state || 'Ontario';
    if (city) return `${city}, ${state}`;
    return 'Ottawa, Ontario';
  }
  
  // ─── Postal / Zip Code ───
  if (q.match(/postal|zip.*code/i)) {
    const postal = profile.postal || settings.postal || '';
    if (postal) return postal;
    return null;
  }
  
  // ─── Desired Pay / Salary ───
  if (q.match(/desired.*pay|expected.*pay|salary.*expect|compensation.*expect|desired.*salary/i)) {
    return settings.expectedSalary || profile.expectedSalary || 'Negotiable';
  }
  
  // ─── Date Available ───
  if (q.match(/date.*available|available.*date|when.*available|start.*date|earliest.*date/i) && !options?.length) {
    // Return today's date in yyyy-mm-dd format
    const today = new Date();
    return today.toISOString().split('T')[0];
  }
  
  // ─── Referral / Who referred you ───
  if (q.match(/who.*referred|referr|how.*hear.*about|how.*find.*position|how.*learn.*about.*position|source.*application/i)) {
    return 'LinkedIn';
  }
  
  // ─── AI Fallback for unknown questions ───
  // IMPORTANT: AI should ONLY be used for yes/no questions, NOT for personal info
  // Never let AI fabricate: names, schools, degrees, websites, URLs, dates, etc.
  
  // Check if this is a personal info question that AI should NOT answer
  const personalInfoPatterns = /^(school|university|college|address|phone|email|name|gpa|salary)$/i;
  
  if (personalInfoPatterns.test(q.trim())) {
    console.log('[AutoApplyBot] Personal info question without user data - skipping (will not fabricate)');
    return null; // Don't let AI make up personal information
  }
  
  // Check if AI is enabled (default to true) - only for non-personal questions
  if (settings.aiEnabled !== false) {
    log(`Using AI for unknown question: "${question.substring(0, 40)}..."`);
    console.log('[AutoApplyBot] Calling AI for question:', question.substring(0, 60));
    
    // Load resume text from chrome storage for AI context
    let resumeText = settings.resumeText || '';
    if (!resumeText) {
      try {
        const storageData = await chrome.storage.local.get(['resumeText', 'parsedResumeText']);
        resumeText = storageData.parsedResumeText || storageData.resumeText || '';
      } catch (e) {
        console.log('[AutoApplyBot] Could not load resume from storage:', e.message);
      }
    }
    
    // Build context for AI
    const context = {
      resumeText: resumeText,
      jobDescription: settings.jobDescription || '',
    };
    
    // Add profile info to help AI
    const profileContext = `
You ARE this person filling out a job application. Write in FIRST PERSON ("I have...", "In my role...").

Applicant:
- Name: ${profile.firstName || ''} ${profile.lastName || ''}
- Location: ${profile.city || ''}, ${profile.state || ''}, ${profile.country || 'Canada'}
- Education: ${settings.degree || 'Bachelor\'s in Computer Science'} from ${settings.school || 'University of Ottawa'}
- Years of experience: ${settings.yearsOfExperience || '3'}
- Authorized to work in Canada, no visa sponsorship needed
- Willing to relocate and travel internationally

CRITICAL RULES:
- Return ONLY the answer. No preamble. No "I'm happy to help". No "Sure!". No "Here's".
- For yes/no: just "Yes" or "No"
- For "describe your experience with X": write 2-4 sentences in first person referencing the resume below
- NEVER say "I don't have experience" — always relate the closest relevant skill from the resume
- NEVER say "The applicant" or "The candidate" — you ARE the person
- NEVER make up company names like "ABC Company" or "XYZ Corp" — use real companies from the resume
- Keep answers under 100 words unless it's a detailed paragraph question
`;
    context.resumeText = profileContext + (context.resumeText || '');
    
    const aiAnswer = await askAI(question, options, context);
    console.log('[AutoApplyBot] AI returned:', aiAnswer);
    
    // Reject AI answers that look like fabricated personal info or conversational responses
    if (aiAnswer) {
      // Filter out conversational AI responses
      const conversationalPatterns = [
        "I'm happy to help",
        "I'd be happy to help",
        "I am happy to help",
        "I would be happy",
        "Here's the",
        "Here is the",
        "Please provide",
        "Could you please",
        "I don't have",
        "I cannot",
        "I'm not sure",
        "I am not sure",
        "Based on the",
        "According to",
        "The answer is",
        "Let me",
        "I would",
        "I'll",
        "I will",
        "Sure!",
        "Sure,",
        "Of course",
        "Certainly",
        "Absolutely",
        "Happy to",
        "Glad to",
        "Current company:",
        "Company:",
        "Name:",
        "Email:",
        "Phone:",
        "Address:",
      ];
      
      const isConversational = conversationalPatterns.some(pattern => 
        aiAnswer.toLowerCase().includes(pattern.toLowerCase())
      );
      
      if (isConversational) {
        console.log('[AutoApplyBot] AI gave conversational response - rejecting:', aiAnswer.substring(0, 50));
        return null;
      }
      
      // Reject answers that look like "label: value" format (AI explaining instead of answering)
      const colonPattern = /^[A-Za-z\s]+:\s*.+/;
      if (colonPattern.test(aiAnswer.trim()) && !aiAnswer.includes('://')) {
        console.log('[AutoApplyBot] AI gave label:value format - rejecting:', aiAnswer.substring(0, 50));
        return null;
      }
      
      const looksLikeFabricatedInfo = 
        aiAnswer.includes('www.') || 
        aiAnswer.includes('http') ||
        aiAnswer.includes('.com') ||
        aiAnswer.includes('.edu') ||
        aiAnswer.includes('.org') ||
        aiAnswer.includes('.io') ||
        aiAnswer.includes('.ca') ||
        aiAnswer.includes('.net') ||
        aiAnswer.includes('Note:') ||
        aiAnswer.includes('does not exist') ||
        aiAnswer.includes('not provided') ||
        aiAnswer.includes('not shared') ||
        aiAnswer.includes('would provide') ||
        aiAnswer.includes('please pr') || // "please provide" truncated
        aiAnswer.includes('Please pr');
      
      // Only reject if it looks fabricated AND is short (long answers are likely real experience descriptions)
      if (looksLikeFabricatedInfo && aiAnswer.length < 200) {
        console.log('[AutoApplyBot] AI tried to fabricate info - rejecting:', aiAnswer.substring(0, 50));
        return null;
      }
      
      // If we have options, try to match AI answer to an option
      if (options && options.length > 0) {
        const matched = matchOptionOrReturn(aiAnswer, options);
        console.log('[AutoApplyBot] Matched option:', matched);
        return matched;
      }
      
      return aiAnswer;
    }
  }
  
  // ─── Default fallback ───
  console.log('[AutoApplyBot] Using default fallback for:', question.substring(0, 40));
  if (options && options.length > 0) {
    // For yes/no questions, default to yes
    const yesOption = options.find(o => /^(yes|true|agree|accept)$/i.test(o.trim()));
    if (yesOption) return yesOption;
    
    // Return first non-placeholder option
    const validOption = options.find(o => {
      const ol = o.toLowerCase().trim();
      return ol && !ol.includes('select') && !ol.includes('choose') && !ol.includes('--');
    });
    if (validOption) return validOption;
    
    return options[0];
  }
  
  return null;
}

/**
 * Helper to match an answer to available options.
 * @param {string} answer - The desired answer
 * @param {Array<string>} options - Available options
 * @returns {string} The matched option or original answer
 */
function matchOptionOrReturn(answer, options) {
  if (!options || options.length === 0) return answer;
  
  const answerLower = answer.toLowerCase().trim();
  
  // Exact match
  let match = options.find(o => o.toLowerCase().trim() === answerLower);
  if (match) return match;
  
  // Yes/No matching
  const yesPattern = /^(yes|oui|sí|si|ja|y|true|agree|accept)$/i;
  const noPattern = /^(no|non|nein|n|false|disagree|decline)$/i;
  
  if (yesPattern.test(answerLower) || answerLower === 'yes') {
    match = options.find(o => yesPattern.test(o.trim()));
    if (match) return match;
    // Also check for options containing "yes"
    match = options.find(o => o.toLowerCase().includes('yes'));
    if (match) return match;
  }
  
  if (noPattern.test(answerLower) || answerLower === 'no') {
    match = options.find(o => noPattern.test(o.trim()));
    if (match) return match;
    // Also check for options containing "no" (but not "know", "now", etc.)
    match = options.find(o => {
      const ol = o.toLowerCase();
      return ol === 'no' || ol.startsWith('no ') || ol.endsWith(' no');
    });
    if (match) return match;
  }
  
  // Partial match - answer contains option
  match = options.find(o => answerLower.includes(o.toLowerCase().trim()));
  if (match) return match;
  
  // Partial match - option contains answer
  match = options.find(o => o.toLowerCase().trim().includes(answerLower));
  if (match) return match;
  
  // Return first non-placeholder option as fallback
  const validOption = options.find(o => {
    const ol = o.toLowerCase().trim();
    return ol && !ol.includes('select') && !ol.includes('choose') && !ol.includes('--');
  });
  
  return validOption || options[0] || answer;
}

// ─── Field Filling (Task 5.3) ─────────────────────────────────────────

/**
 * Set a value on a React-controlled input using the native setter,
 * then dispatch input, change, and blur events so React picks it up.
 * @param {HTMLElement} el
 * @param {string} value
 */
function setReactValue(el, value) {
  // Pick the correct prototype descriptor based on element type
  let descriptor;
  if (el instanceof HTMLTextAreaElement || el.tagName === 'TEXTAREA') {
    descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  } else {
    descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  }
  try {
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  } catch (e) {
    // Fallback: direct assignment
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

// ─── Task 7.1: Typeahead Handling ─────────────────────────────────────

/**
 * Handle typeahead/autocomplete inputs (city, location fields).
 * Types the value, waits for dropdown, selects first match.
 * @param {HTMLElement} el
 * @param {string} value
 * @returns {Promise<boolean>}
 */
async function handleTypeahead(el, value) {
  try {
    // Type value into input
    fill(el, value);
    setReactValue(el, value);

    // Wait for autocomplete dropdown to appear
    await wait(1000);

    // Try multiple selectors for autocomplete dropdown
    const dropdownSelectors = [
      '[role="listbox"]',
      '.basic-typeahead__selectable',
      '.artdeco-typeahead__results',
      '.artdeco-dropdown__content-inner',
      'ul[role="listbox"]',
      '.typeahead-results',
    ];

    let dropdown = null;
    for (const selector of dropdownSelectors) {
      dropdown = document.querySelector(selector);
      if (dropdown && dropdown.offsetParent !== null) break;
      dropdown = null;
    }

    if (dropdown) {
      // Find first option
      const optionSelectors = [
        '[role="option"]:first-child',
        'li:first-child',
        '.basic-typeahead__selectable-item:first-child',
      ];

      let firstOption = null;
      for (const selector of optionSelectors) {
        firstOption = dropdown.querySelector(selector);
        if (firstOption) break;
      }

      if (firstOption) {
        firstOption.click();
        log(`Typeahead selected: ${firstOption.textContent.substring(0, 30)}`);
        await wait(500);
        return true;
      }
    }

    // Fallback: keyboard navigation (ArrowDown + Enter)
    log('Typeahead: using keyboard fallback');
    el.focus();
    await wait(300);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
    await wait(500);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    await wait(300);
    return true;
  } catch (e) {
    log(`handleTypeahead error: ${e.message}`);
    return false;
  }
}

// ─── Task 7.2: Radio Button Handling ──────────────────────────────────

/**
 * Handle radio button groups with smart question detection.
 * Matches visa, work auth, relocation, driver's license, security clearance.
 * @param {Object} field — FormField with name, label, options
 * @param {string} value — desired answer or fallback
 * @param {Object} settings — user settings with yes/no config
 * @returns {boolean}
 */
function handleRadio(field, value, settings) {
  const root = document.querySelector(
    '.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]'
  ) || document;

  // Find the fieldset for this radio group
  const fieldsets = root.querySelectorAll(
    'fieldset[data-test-form-builder-radio-button-form-component], fieldset'
  );

  let targetFieldset = null;
  for (const fs of fieldsets) {
    const radios = fs.querySelectorAll(`input[type="radio"][name="${field.name}"]`);
    if (radios.length > 0) {
      targetFieldset = fs;
      break;
    }
  }

  if (!targetFieldset) {
    // Fallback: find radios by name anywhere
    const radios = root.querySelectorAll(`input[type="radio"][name="${field.name}"]`);
    if (radios.length === 0) return false;
    targetFieldset = radios[0].closest('fieldset') || root;
  }

  const questionText = (field.label || '').toLowerCase();
  const radioInputs = targetFieldset.querySelectorAll(`input[type="radio"][name="${field.name}"]`);
  if (radioInputs.length === 0) return false;

  // Smart detection: determine desired answer from settings
  let desiredAnswer = 'yes'; // default

  if (questionText.match(/visa|sponsor|sponsorship/i) && settings && settings.visaSponsorship) {
    desiredAnswer = settings.visaSponsorship;
  } else if (questionText.match(/author|legal.*work|permit.*work|eligib.*work|right.*work/i) && settings && settings.legallyAuthorized) {
    desiredAnswer = settings.legallyAuthorized;
  } else if (questionText.match(/relocat|move.*locat|willing.*move/i) && settings && settings.willingToRelocate) {
    desiredAnswer = settings.willingToRelocate;
  } else if (questionText.match(/security.*clearance|clearance/i)) {
    desiredAnswer = 'no';
  } else if (questionText.match(/driver.*license|driving.*license|valid.*license/i) && settings && settings.driversLicense) {
    desiredAnswer = settings.driversLicense;
  }

  // If a specific value was passed (from prefilled answers), use it
  if (value && value !== '') {
    desiredAnswer = value.toLowerCase();
  }

  // Multilingual yes/no patterns
  const yesPattern = /^(yes|oui|sí|si|ja|y)$/i;
  const noPattern = /^(no|non|nein|n)$/i;

  let answered = false;

  // Try to match desired answer
  for (const radio of radioInputs) {
    const radioLabel = radio.id ? root.querySelector(`label[for="${radio.id}"]`) : null;
    const radioText = radioLabel ? radioLabel.textContent.trim() : radio.value;
    const radioTextLower = radioText.toLowerCase();

    const isYes = yesPattern.test(radioTextLower);
    const isNo = noPattern.test(radioTextLower);

    if ((desiredAnswer === 'yes' && isYes) || (desiredAnswer === 'no' && isNo)) {
      if (!radio.checked) {
        if (radioLabel) radioLabel.click(); else radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
      log(`Radio "${desiredAnswer}": ${questionText.substring(0, 30)}`);
      answered = true;
      break;
    }
  }

  // Default: try "Yes"
  if (!answered) {
    for (const radio of radioInputs) {
      const radioLabel = radio.id ? root.querySelector(`label[for="${radio.id}"]`) : null;
      const radioText = radioLabel ? radioLabel.textContent.trim() : radio.value;
      if (yesPattern.test(radioText.toLowerCase())) {
        if (!radio.checked) {
          if (radioLabel) radioLabel.click(); else radio.click();
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        log(`Radio Yes (default): ${questionText.substring(0, 30)}`);
        answered = true;
        break;
      }
    }
  }

  // Last resort: click first option
  if (!answered && radioInputs.length > 0 && !radioInputs[0].checked) {
    const firstLabel = root.querySelector(`label[for="${radioInputs[0].id}"]`);
    if (firstLabel) firstLabel.click(); else radioInputs[0].click();
    radioInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    log(`Radio first option: ${questionText.substring(0, 30)}`);
    answered = true;
  }

  return answered;
}

// ─── Task 7.3: Select Dropdown Handling ───────────────────────────────

/**
 * Handle native <select> and custom LinkedIn dropdown elements.
 * Smart language proficiency detection with priority ordering.
 * @param {Object} field — FormField with element, label, options
 * @param {string} value — desired value to select
 * @returns {Promise<boolean>}
 */
async function handleSelect(field, value) {
  const el = field.element;
  const label = (field.label || '').toLowerCase();

  // ── Native <select> ──
  if (el && el.tagName === 'SELECT') {
    if (el.selectedIndex > 0) return true; // already selected

    const options = Array.from(el.options);
    let selectedOption = null;

    // If a specific value was provided, try to match it
    if (value) {
      const valLower = value.toLowerCase();
      selectedOption = options.find(o => o.text.trim().toLowerCase() === valLower);
      if (!selectedOption) {
        selectedOption = options.find(o => o.text.trim().toLowerCase().includes(valLower));
      }
    }

    // Smart language proficiency detection
    if (!selectedOption && label.match(/proficiency|level.*english|level.*french|level.*spanish|level.*german|niveau.*anglais|niveau.*français|nivel/)) {
      // Priority: Native/Bilingual → Fluent → Professional
      selectedOption = options.find(o => {
        const t = o.text.toLowerCase();
        return t.includes('native') || t.includes('bilingual') || t.includes('bilingue') || t.includes('langue maternelle');
      });
      if (!selectedOption) {
        selectedOption = options.find(o => {
          const t = o.text.toLowerCase();
          return t.includes('fluent') || t.includes('courant') || t.includes('fluide');
        });
      }
      if (!selectedOption) {
        selectedOption = options.find(o => {
          const t = o.text.toLowerCase();
          return t.includes('professional') || t.includes('professionnel') || t.includes('advanced');
        });
      }
    }

    // Fallback: pick first non-placeholder option
    if (!selectedOption && options.length > 1) {
      selectedOption = options.find(o => {
        const t = o.text.trim().toLowerCase();
        return t && !t.includes('select') && !t.includes('choose') && !t.includes('choisir') && o.value !== '';
      });
      if (!selectedOption) selectedOption = options[1];
    }

    if (selectedOption) {
      el.value = selectedOption.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Select: "${selectedOption.text.trim().substring(0, 30)}" for "${label.substring(0, 30)}"`);
      return true;
    }
    return false;
  }

  // ── Custom LinkedIn dropdown (button[aria-haspopup="listbox"]) ──
  const root = document.querySelector(
    '.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]'
  ) || document;

  const customDropdowns = root.querySelectorAll('button[aria-haspopup="listbox"], button.artdeco-dropdown__trigger');
  for (const dropdown of customDropdowns) {
    // Match dropdown to field by checking nearby labels
    let questionText = '';
    questionText += ' ' + (dropdown.getAttribute('aria-label') || '');
    questionText += ' ' + (dropdown.textContent || '');
    const dropdownId = dropdown.getAttribute('id');
    if (dropdownId) {
      const labelEl = root.querySelector(`label[for="${dropdownId}"]`);
      if (labelEl) questionText += ' ' + labelEl.textContent;
    }
    const parentDiv = dropdown.closest('div[class*="form-component"]');
    if (parentDiv) {
      const lbl = parentDiv.querySelector('label, legend, span[class*="label"]');
      if (lbl) questionText += ' ' + lbl.textContent;
    }

    const question = questionText.toLowerCase();
    if (!question.includes(label) && !label.includes(question.trim())) continue;

    // Click to open
    dropdown.click();
    await wait(500);

    const listbox = document.querySelector('[role="listbox"]');
    if (!listbox) continue;

    const opts = Array.from(listbox.querySelectorAll('[role="option"]'));
    if (opts.length === 0) continue;

    let selectedOpt = null;

    // Try matching provided value
    if (value) {
      const valLower = value.toLowerCase();
      selectedOpt = opts.find(o => o.textContent.trim().toLowerCase() === valLower);
      if (!selectedOpt) {
        selectedOpt = opts.find(o => o.textContent.trim().toLowerCase().includes(valLower));
      }
    }

    // Language proficiency smart matching
    if (!selectedOpt && question.match(/proficiency|level.*english|level.*french|level.*spanish|niveau/)) {
      selectedOpt = opts.find(o => {
        const t = o.textContent.toLowerCase();
        return t.includes('native') || t.includes('bilingual') || t.includes('bilingue');
      });
      if (!selectedOpt) {
        selectedOpt = opts.find(o => {
          const t = o.textContent.toLowerCase();
          return t.includes('fluent') || t.includes('courant');
        });
      }
      if (!selectedOpt) {
        selectedOpt = opts.find(o => {
          const t = o.textContent.toLowerCase();
          return t.includes('professional') || t.includes('professionnel') || t.includes('advanced');
        });
      }
    }

    // Fallback: first non-placeholder option
    if (!selectedOpt) {
      selectedOpt = opts.find(o => {
        const t = o.textContent.trim().toLowerCase();
        return !t.includes('select') && !t.includes('choose') && !t.includes('choisir');
      });
    }

    if (selectedOpt) {
      selectedOpt.click();
      log(`Custom dropdown: "${selectedOpt.textContent.trim().substring(0, 30)}"`);
      await wait(300);
      return true;
    }
  }

  return false;
}

// ─── Task 7.4: File Upload Handling ───────────────────────────────────

/**
 * Handle file upload fields — select existing resume or upload new one.
 * Checks for previously uploaded resumes first (radio/cards), then uploads via DataTransfer.
 * @param {Object} field — FormField with element reference
 * @param {Object} settings — contains resume base64 data
 * @returns {Promise<boolean>}
 */
async function handleFileUpload(field, settings) {
  const root = document.querySelector(
    '.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]'
  ) || document;

  // Step 1: Try to select an existing/previously uploaded resume
  const resumeSelectors = [
    'input[type="radio"][name*="resume"]',
    'input[type="radio"][name*="cv"]',
    'input[type="radio"][id*="resume"]',
    'input[type="radio"][id*="document"]',
    '[data-test-document-upload-item]',
    '.jobs-document-upload-redesign-card',
    '.jobs-document-upload__container',
    '.document-upload-item',
    '[class*="resume-card"]',
    '[class*="document-card"]',
  ];

  for (const selector of resumeSelectors) {
    const resumeOptions = root.querySelectorAll(selector);
    for (const option of resumeOptions) {
      if (option.offsetParent === null) continue; // skip hidden

      if (option.type === 'radio') {
        if (option.checked) {
          log('Resume already selected');
          return true;
        }
        const lbl = root.querySelector(`label[for="${option.id}"]`);
        if (lbl) lbl.click(); else option.click();
        log(`Selected existing resume: ${(lbl ? lbl.textContent : option.value).substring(0, 40)}`);
        await wait(500);
        return true;
      } else {
        // Clickable card
        const isSelected = option.classList.contains('selected') ||
          option.getAttribute('aria-selected') === 'true' ||
          option.querySelector('input[type="radio"]:checked');
        if (isSelected) {
          log('Resume card already selected');
          return true;
        }
        option.click();
        log('Selected existing resume card');
        await wait(500);
        return true;
      }
    }
  }

  // Step 2: Upload new resume from storage
  const el = field.element;
  if (!el) return false;

  // Check label matches resume/CV
  const labelText = (field.label || '').toLowerCase();
  if (!labelText.match(/resume|cv|curriculum|vitae|upload.*document|file/)) {
    log(`Skipping file input (not resume): ${field.label}`);
    return false;
  }

  // Already has a file
  if (el.files && el.files.length > 0) {
    log(`File input already has file: ${el.files[0].name}`);
    return true;
  }

  // Get resume data from storage
  if (!settings || !settings.resumeFile) {
    log('No resume uploaded in extension settings');
    return false;
  }

  try {
    const base64Data = settings.resumeFile;
    const fileName = settings.resumeFileName || 'resume.pdf';
    const fileType = settings.resumeFileType || 'application/pdf';

    // Remove data URL prefix if present
    const rawBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const binaryString = atob(rawBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const file = new File([bytes], fileName, { type: fileType });

    // Use DataTransfer API to set files
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    el.files = dataTransfer.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));

    log(`Resume uploaded: ${fileName}`);
    return true;
  } catch (e) {
    log(`File upload error: ${e.message}`);
    return false;
  }
}

// ─── Task 7.5: Checkbox Handling ──────────────────────────────────────

/** Multilingual patterns for consent/agreement checkboxes. */
const CONSENT_PATTERNS = /consent|agree|terms|conditions|policy|privacy|accept|acknowledge|j'accepte|j'autorise|consentement|aceptar|acepto|condiciones|akzeptieren|zustimmen|accetto|acconsento/i;

/** Pattern for "follow company" checkbox — should be unchecked. */
const FOLLOW_COMPANY_PATTERN = /follow.*company|follow.*employer|suivre.*entreprise|seguir.*empresa|folgen.*unternehmen|seguire.*azienda|follow-company/i;

/**
 * Handle checkbox fields — auto-check consent/terms, skip follow-company.
 * @param {Object} field — FormField with element, label, id
 * @returns {boolean}
 */
function handleCheckbox(field) {
  const el = field.element;
  if (!el) return false;

  const label = (field.label || '').toLowerCase();
  const elId = (el.id || '').toLowerCase();

  // Skip and uncheck "follow company" checkbox
  if (FOLLOW_COMPANY_PATTERN.test(label) || FOLLOW_COMPANY_PATTERN.test(elId)) {
    if (el.checked) {
      el.click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log('Unchecked follow company checkbox');
    }
    return true;
  }

  // Auto-check consent/terms/agreement checkboxes
  if (CONSENT_PATTERNS.test(label)) {
    if (!el.checked) {
      const root = el.ownerDocument || document;
      const lbl = el.id ? root.querySelector(`label[for="${el.id}"]`) : null;
      if (lbl) lbl.click(); else el.click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Checked consent: ${label.substring(0, 40)}`);
    }
    return true;
  }

  return false;
}

// ─── Field Filling Dispatcher ─────────────────────────────────────────

/**
 * Fill a single form field with a value.
 * Dispatches to the appropriate handler based on field type.
 * @param {Object} field — FormField object with element reference
 * @param {string} value
 * @param {Object} [settings] — user settings for radio/file handlers
 * @returns {Promise<boolean>|boolean} true if filled successfully
 */
async function fillField(field, value, settings) {
  const el = field.element;
  if (!el && field.type !== 'radio') return false;

  try {
    switch (field.type) {
      case 'input':
      case 'textarea':
        // Try multiple strategies for filling text fields
        try {
          // Strategy 1: React native setter (most reliable for React forms)
          setReactValue(el, value);
        } catch (e1) {
          try {
            // Strategy 2: Direct value + events
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e2) {
            try {
              // Strategy 3: execCommand (works on contentEditable and some textareas)
              el.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, value);
            } catch (e3) {
              // Strategy 4: setAttribute as last resort
              el.setAttribute('value', value);
            }
          }
        }
        return true;

      case 'select':
        return await handleSelect(field, value);

      case 'radio':
        return handleRadio(field, value, settings);

      case 'checkbox':
        return handleCheckbox(field);

      case 'file':
        return await handleFileUpload(field, settings);

      default:
        return false;
    }
  } catch (e) {
    log(`fillField error for "${field.label}": ${e.message}`);
    return false;
  }
}

// ─── Autofill Orchestrator (Task 5.4) ─────────────────────────────────

/**
 * Check if a field label indicates a city/location typeahead field.
 * @param {string} label
 * @returns {boolean}
 */
function isTypeaheadField(label) {
  return /city|ville|ciudad|stadt|città|location|localisation|ubicación|standort/i.test(label);
}

/**
 * Orchestrate form detection and filling using profile data,
 * prefilled answers, and optional AI fallback.
 * Handles all field types: input, textarea, select, radio, checkbox, file.
 * @param {Object} profile
 * @param {Object} settings
 * @param {Object} prefilledAnswers
 * @returns {Promise<Object>} FillResult
 */
async function autofill(profile, settings, prefilledAnswers) {
  const atsType = detectATS(window.location.href);
  log(`ATS detected: ${atsType}`);

  // Notify popup of ATS type
  try {
    chrome.runtime.sendMessage({ type: 'atsDetected', atsType });
  } catch (_) { /* popup may not be open */ }

  // Extract fields — ATS-aware scoping
  // JazzHR and Workday may use iframes; always merge iframe fields
  const fields = extractFieldsFromIframes(atsType);
  log(`Found ${fields.length} form fields`);

  let filled = 0;
  let skipped = 0;
  let failed = 0;
  const unfilled = [];
  
  // Labels to skip - these are internal React component names, not real fields
  const skipLabels = [
    'select-search-input',
    'undefined',
    'input-undefined',
    'input-select-search-input',
    'input-externalplaceid',
    'externalplaceid',
    'please leave this field blank',
  ];
  
  // Labels to skip AI for - these should only be filled from profile, not AI
  const skipAILabels = [
    'current company',
    'current_company',
  ];
  
  // Patterns to skip - internal field IDs that look like UUIDs or hashes
  // NOTE: We do NOT skip customQuestions fields - they are real questions that need answers
  const skipPatterns = [
    /^[a-f0-9]{8}-[a-f0-9]{4}-/i,  // UUID-like patterns
    /^[a-f0-9]{24,}$/i,  // MongoDB-like IDs (only if ENTIRE label is the ID)
    /^input-[a-f0-9]{8,}/i,  // Input with hash ID
  ];

  for (const field of fields) {
    const label = field.label;
    const labelLower = (label || '').toLowerCase().trim();
    
    // Skip internal React component fields
    if (skipLabels.includes(labelLower) || labelLower.startsWith('input-select-') || labelLower.includes('leave this field blank') || labelLower.includes('nickname')) {
      console.log('[AutoApplyBot] Skipping internal/honeypot field:', label);
      skipped++;
      continue;
    }
    
    // Skip fields with internal ID patterns (customQuestions.xxx, UUIDs, etc.)
    if (skipPatterns.some(pattern => pattern.test(label))) {
      console.log('[AutoApplyBot] Skipping internal ID field:', label);
      skipped++;
      continue;
    }

    // ── Checkboxes: handle regardless of label ──
    if (field.type === 'checkbox') {
      if (handleCheckbox(field)) {
        filled++;
      } else {
        skipped++;
      }
      continue;
    }

    // ── File uploads: delegate to handler ──
    if (field.type === 'file') {
      const ok = await handleFileUpload(field, settings);
      if (ok) filled++; else skipped++;
      continue;
    }

    // ── Radio groups: smart handling ──
    if (field.type === 'radio') {
      // Try prefilled answer first
      const prefilledVal = label ? matchPrefilled(label, prefilledAnswers) : null;
      const ok = handleRadio(field, prefilledVal || '', settings);
      if (ok) filled++; else failed++;
      continue;
    }

    // ── Select dropdowns ──
    if (field.type === 'select') {
      // Skip already-selected
      if (field.value && field.element && field.element.selectedIndex > 0) {
        skipped++;
        continue;
      }
      const prefilledVal = label ? matchPrefilled(label, prefilledAnswers) : null;
      const profileVal = label ? getProfileValue(label, profile) : null;
      const ok = await handleSelect(field, prefilledVal || profileVal || '');
      if (ok) filled++; else failed++;
      continue;
    }

    // ── Text inputs and textareas ──
    if (!label) {
      skipped++;
      continue;
    }

    // Skip already-filled fields
    if (field.value && field.value.trim()) {
      skipped++;
      continue;
    }

    // 1) Try profile mapping
    const profileVal = getProfileValue(label, profile);
    if (profileVal) {
      // City/location fields need typeahead handling
      if (isTypeaheadField(label) && field.type === 'input') {
        await handleTypeahead(field.element, profileVal);
        filled++;
        continue;
      }
      if (await fillField(field, profileVal, settings)) {
        log(`Filled "${label}" from profile: ${profileVal.substring(0, 30)}`);
        filled++;
        continue;
      }
    }

    // 2) Try prefilled answers
    const prefilledVal = matchPrefilled(label, prefilledAnswers);
    if (prefilledVal) {
      if (await fillField(field, prefilledVal, settings)) {
        log(`Filled "${label}" from prefilled: ${prefilledVal.substring(0, 30)}`);
        filled++;
        continue;
      }
    }

    // 3) Try AI fallback (if enabled) — sends to background worker
    // For personal info fields, use getSmartAnswer which will pick best option
    const personalInfoPatterns = /school|university|college|degree|major|discipline|graduation|website|portfolio|github|linkedin|start.*year|end.*year/i;
    const isPersonalInfoField = personalInfoPatterns.test(label.toLowerCase());
    
    // For personal info fields with options, use getSmartAnswer to pick best match
    if (isPersonalInfoField && field.options && field.options.length > 0) {
      const smartAnswer = await getSmartAnswer(label, field.options, settings, profile);
      if (smartAnswer && await fillField(field, smartAnswer, settings)) {
        log(`Filled "${label}" with best match: ${smartAnswer.substring(0, 30)}`);
        filled++;
        continue;
      }
    }
    
    // For personal info text fields without options, skip AI (can't guess URLs, etc.)
    if (isPersonalInfoField && (!field.options || field.options.length === 0)) {
      // Try getSmartAnswer which returns empty string for website/linkedin if not set
      const smartAnswer = await getSmartAnswer(label, [], settings, profile);
      if (smartAnswer !== null) {
        if (smartAnswer === '') {
          // Empty is fine for optional fields like website
          skipped++;
          continue;
        }
        if (await fillField(field, smartAnswer, settings)) {
          log(`Filled "${label}" from smart answer: ${smartAnswer.substring(0, 30)}`);
          filled++;
          continue;
        }
      }
      // If no answer, mark as failed but don't block
      failed++;
      unfilled.push({ label: field.label, type: field.type });
      continue;
    }
    
    // Skip AI for certain fields that should only come from profile
    if (skipAILabels.includes(labelLower)) {
      console.log('[AutoApplyBot] Skipping AI for field (profile-only):', label);
      skipped++;
      continue;
    }
    
    // Try getSmartAnswer first for ALL remaining fields (rules-based + AI)
    const smartAnswer = await getSmartAnswer(label, field.options || [], settings, profile);
    if (smartAnswer !== null && smartAnswer !== '') {
      if (await fillField(field, smartAnswer, settings)) {
        log(`Filled "${label}" from smart answer: ${smartAnswer.substring(0, 30)}`);
        filled++;
        continue;
      }
    }
    
    if (settings && settings.aiEnabled) {
      try {
        const aiRequest = {
          action: 'askAI',
          question: label,
          options: field.options || [],
          resumeText: settings.resumeText || '',
          jobDescription: '',
        };
        const aiResponse = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(aiRequest, (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp);
            }
          });
        });
        if (aiResponse && aiResponse.answer) {
          // Reject fabricated URLs/personal info from AI
          const looksLikeFabricatedInfo = 
            aiResponse.answer.includes('www.') || 
            aiResponse.answer.includes('http') ||
            aiResponse.answer.includes('.com') ||
            aiResponse.answer.includes('.edu') ||
            aiResponse.answer.includes('University') ||
            aiResponse.answer.includes('College') ||
            (aiResponse.answer.includes('Note:') && aiResponse.answer.includes('does not exist'));
          
          if (looksLikeFabricatedInfo) {
            log(`Rejected fabricated AI answer for "${label}"`);
            failed++;
            unfilled.push({ label: field.label, type: field.type });
            continue;
          }
          
          // Reject conversational AI responses
          const conversationalPatterns = [
            "I'm happy to help",
            "I'd be happy to help",
            "I am happy to help",
            "I would be happy",
            "Here's the",
            "Here is the",
            "Please provide",
            "Could you please",
            "I don't have",
            "I cannot",
            "I'm not sure",
            "I am not sure",
            "Based on the",
            "According to",
            "The answer is",
            "Let me",
            "I would",
            "I'll",
            "I will",
            "Sure!",
            "Sure,",
            "Of course",
            "Certainly",
            "Absolutely",
            "Happy to",
            "Glad to",
            "Current company:",
            "Company:",
            "Name:",
            "Email:",
            "Phone:",
            "Address:",
            "What's the",
            "What is the",
            "please pr",
            "Please pr",
          ];
          
          const isConversational = conversationalPatterns.some(pattern => 
            aiResponse.answer.toLowerCase().includes(pattern.toLowerCase())
          );
          
          if (isConversational) {
            log(`Rejected conversational AI answer for "${label}": ${aiResponse.answer.substring(0, 30)}`);
            failed++;
            unfilled.push({ label: field.label, type: field.type });
            continue;
          }
          
          // Reject answers that look like "label: value" format
          const colonPattern = /^[A-Za-z\s]+:\s*.+/;
          if (colonPattern.test(aiResponse.answer.trim()) && !aiResponse.answer.includes('://')) {
            log(`Rejected label:value AI answer for "${label}": ${aiResponse.answer.substring(0, 30)}`);
            failed++;
            unfilled.push({ label: field.label, type: field.type });
            continue;
          }
          
          // For select/radio: pick the best matching option from AI response
          if ((field.type === 'select' || field.type === 'radio') && field.options && field.options.length > 0) {
            const aiLower = aiResponse.answer.toLowerCase().trim();
            const bestOption = field.options.find(o => o.toLowerCase().trim() === aiLower) ||
              field.options.find(o => o.toLowerCase().trim().includes(aiLower)) ||
              field.options.find(o => aiLower.includes(o.toLowerCase().trim()));
            if (bestOption) {
              if (await fillField(field, bestOption, settings)) {
                log(`Filled "${label}" from AI (matched option): ${bestOption.substring(0, 30)}`);
                filled++;
                continue;
              }
            }
          }
          if (await fillField(field, aiResponse.answer, settings)) {
            log(`Filled "${label}" from AI: ${aiResponse.answer.substring(0, 30)}`);
            filled++;
            continue;
          }
        }
      } catch (e) {
        log(`AI fallback error for "${label}": ${e.message}`);
      }
    }

    // Could not fill
    failed++;
    unfilled.push({ label: field.label, type: field.type });
  }

  const result = {
    atsType,
    totalFields: fields.length,
    filled,
    skipped,
    failed,
    unfilled,
  };

  log(`Autofill complete: ${filled} filled, ${skipped} skipped, ${failed} failed`);
  return result;
}

// ─── Autoapply State ──────────────────────────────────────────────────

let appliedCount = 0;
let skippedCount = 0;
let appliedJobs = [];
let lastActivityTime = Date.now();
const STUCK_TIMEOUT = 120000; // 2 minutes
const APPLICATION_TIMEOUT = 180000; // 3 minutes per application
const LOADING_SCREEN_TIMEOUT = 20000; // 20 seconds
const MAX_STEPS = 10;

/** Update last activity timestamp. */
function updateActivity() {
  lastActivityTime = Date.now();
}

/** Check if bot is stuck (no activity for STUCK_TIMEOUT). */
function isStuck() {
  return (Date.now() - lastActivityTime) > STUCK_TIMEOUT;
}

/** Update applied count in storage and notify popup. */
function updateAppliedCount() {
  chrome.storage.local.set({ appliedCount });
  try { chrome.runtime.sendMessage({ type: 'updateCount', count: appliedCount }); } catch (_) {}
}

/** Update skipped count in storage and notify popup. */
function updateSkippedCount() {
  chrome.storage.local.set({ skippedCount });
  try { chrome.runtime.sendMessage({ type: 'updateSkippedCount', count: skippedCount }); } catch (_) {}
}

/** Save applied jobs list to storage. */
function saveAppliedJobsToStorage() {
  chrome.storage.local.set({ appliedJobs });
}

/** Report an applied job to the backend API. */
async function reportAppliedJobToBackend(job) {
  try {
    const data = await chrome.storage.local.get(['settings']);
    const backendUrl = (data.settings && data.settings.backendUrl) || 'http://localhost:8000';

    await fetch(`${backendUrl}/api/extension/applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: job.company || '',
        role: job.role || job.title || '',
        url: job.url || '',
        atsType: job.atsType || 'linkedin',
        status: job.status === 'filled' ? 'applied' : job.status,
        fieldsFilled: job.fieldsFilled || 0,
        fieldsSkipped: job.fieldsSkipped || 0,
        fieldsFailed: job.fieldsFailed || 0,
      }),
    });
    log('Reported to backend: ' + (job.title || job.role));
  } catch (err) {
    log('Backend report failed: ' + err.message);
  }
}

// ─── Task 8.1: Next/Submit Button Detection ──────────────────────────

/**
 * Find the Next or Submit button inside the Easy Apply modal.
 * Searches by text content: next, suivant, review, submit, soumettre.
 * @param {Element} modal — the modal element to search within
 * @returns {{ button: HTMLElement|null, isSubmit: boolean }}
 */
function findNextOrSubmitButton(modal) {
  const buttons = Array.from(modal.querySelectorAll('button'));
  for (const btn of buttons) {
    if (btn.offsetParent === null) continue;
    const text = btn.textContent.trim().toLowerCase();
    if (text.includes('next') || text.includes('suivant') ||
        text.includes('review') || text.includes('submit') ||
        text.includes('soumettre')) {
      const isSubmit = text.includes('submit') || text.includes('soumettre');
      return { button: btn, isSubmit };
    }
  }
  return { button: null, isSubmit: false };
}

/**
 * Handle the unfollow-company checkbox before submitting.
 * @param {Element} modal
 */
async function handleUnfollowBeforeSubmit(modal) {
  const followCheckbox = modal.querySelector('input[id="follow-company-checkbox"]') ||
    modal.querySelector('input[id*="follow-company"][type="checkbox"]');
  if (followCheckbox && followCheckbox.checked) {
    followCheckbox.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(500);
    const lbl = modal.querySelector(`label[for="${followCheckbox.id}"]`);
    if (lbl) lbl.click(); else followCheckbox.click();
    followCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    log('Unchecked follow-company before submit');
    await wait(300);
  }
}

// ─── Task 8.3: Discard Application ───────────────────────────────────

/** Check if the Easy Apply modal is currently open and visible. */
function isModalOpen() {
  const modal = document.querySelector('.jobs-easy-apply-modal');
  return modal && modal.offsetParent !== null;
}

/**
 * Discard the current application by closing the Easy Apply modal.
 * Tries: X/Dismiss button → ESC key → discard/cancel buttons.
 * @returns {Promise<boolean>} true if modal was closed
 */
async function discardApplication() {
  log('Discard: starting close sequence...');
  const discardTexts = ['discard', 'annuler', 'cancel', 'abandonner', 'descarter'];

  // Step 1: X / Dismiss button
  const closeButtons = document.querySelectorAll(
    'button[aria-label*="Dismiss"], button[aria-label*="Close"], button.artdeco-modal__dismiss'
  );
  for (const btn of closeButtons) {
    if (btn.offsetParent) {
      btn.click();
      await wait(1000);
      const discardBtn = Array.from(document.querySelectorAll('button')).find(b =>
        b.offsetParent && discardTexts.some(t => b.textContent.trim().toLowerCase().includes(t))
      );
      if (discardBtn) { discardBtn.click(); await wait(1500); }
      if (!isModalOpen()) { log('Modal closed via dismiss button'); return true; }
    }
  }

  // Step 2: ESC key
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
  await wait(1000);
  if (!isModalOpen()) { log('Modal closed via ESC'); return true; }

  // Step 3: Find any discard/cancel button
  for (let attempt = 0; attempt < 3; attempt++) {
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of allButtons) {
      if (!btn.offsetParent) continue;
      const btnText = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (discardTexts.some(t => btnText.includes(t) || ariaLabel.includes(t))) {
        btn.click();
        await wait(300);
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await wait(1500);
        if (!isModalOpen()) { log('Modal closed via discard button'); return true; }
      }
    }
    await wait(1000);
  }

  log('Discard failed: could not close modal');
  return false;
}

// ─── Task 8.4: Done/Completion Button Handling ───────────────────────

/**
 * Find and click the Done/Dismiss/Close button after a successful submit.
 * Tries multiple click methods: standard → MouseEvent → keyboard Enter.
 * @param {Element} [context=document]
 * @param {number} [maxAttempts=15]
 * @returns {Promise<{ success: boolean, clicked: boolean }>}
 */
async function findAndClickDoneButton(context, maxAttempts) {
  context = context || document;
  maxAttempts = maxAttempts || 15;
  const doneTexts = ['Done', 'Terminé', 'Submit application', 'Soumettre la candidature', 'Dismiss', 'Close', 'Fermer'];
  let doneBtn = null;

  for (let attempt = 0; attempt < maxAttempts && !doneBtn; attempt++) {
    await wait(1000);

    // Method 1: span text (most reliable on LinkedIn)
    for (const targetText of doneTexts) {
      const spans = Array.from(context.querySelectorAll('span.artdeco-button__text, span'));
      for (const span of spans) {
        if (span.textContent.trim() === targetText) {
          const clickable = span.closest('button, [role="button"], .artdeco-button') || span;
          if (clickable.offsetParent !== null) { doneBtn = clickable; break; }
        }
      }
      if (doneBtn) break;
    }

    // Method 2: direct button text
    if (!doneBtn) {
      for (const btn of Array.from(context.querySelectorAll('button, [role="button"]'))) {
        if (doneTexts.includes(btn.textContent.trim()) && btn.offsetParent !== null) {
          doneBtn = btn; break;
        }
      }
    }

    // Method 3: aria-label
    if (!doneBtn) {
      for (const targetText of doneTexts) {
        const ariaBtn = context.querySelector(
          `button[aria-label*="${targetText}"], [role="button"][aria-label*="${targetText}"]`
        );
        if (ariaBtn && ariaBtn.offsetParent !== null) { doneBtn = ariaBtn; break; }
      }
    }
  }

  if (!doneBtn) return { success: false, clicked: false };

  // Try standard click
  try {
    doneBtn.click(); await wait(500); updateActivity();
    return { success: true, clicked: true };
  } catch (_) {}

  // Try MouseEvent dispatch
  try {
    doneBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await wait(500); updateActivity();
    return { success: true, clicked: true };
  } catch (_) {}

  // Try keyboard Enter
  try {
    doneBtn.focus(); await wait(200);
    doneBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    doneBtn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    await wait(500); updateActivity();
    return { success: true, clicked: true };
  } catch (_) {}

  return { success: false, clicked: false };
}

// ─── Loading / Daily Limit Detection ─────────────────────────────────

/**
 * Check if the page is in a loading state (spinners, progressbars).
 * @returns {boolean}
 */
function isPageLoading() {
  if (document.readyState !== 'complete') return true;
  const spinners = document.querySelectorAll(
    '[role="progressbar"], .artdeco-loader, .loading-spinner, .spinner, .loading'
  );
  for (const s of spinners) {
    if (s.offsetParent !== null) return true;
  }
  return false;
}

/**
 * Check for LinkedIn's daily Easy Apply limit messages.
 * @returns {boolean}
 */
function checkDailyLimit() {
  const limitPatterns = [
    "you've reached today's easy apply limit",
    "reached today's easy apply limit",
    "great effort applying today",
    "we limit daily submissions",
    "continue applying tomorrow",
    "exceeded the daily application limit",
    "daily easy apply limit",
    "limit daily submissions",
  ];
  const bodyText = (document.body.innerText || '').toLowerCase();
  for (const pattern of limitPatterns) {
    if (bodyText.includes(pattern)) {
      log('Daily limit reached!');
      return true;
    }
  }
  return false;
}

// ─── Blacklist & Experience Filtering ────────────────────────────────

/**
 * Check if a job should be skipped based on blacklist keywords.
 * @param {string} title
 * @param {string} company
 * @param {string} description
 * @param {string} blacklistKeywords — comma-separated
 * @returns {boolean}
 */
function shouldSkipByBlacklist(title, company, description, blacklistKeywords) {
  if (!blacklistKeywords || !blacklistKeywords.trim()) return false;
  const keywords = blacklistKeywords.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  const jobText = (title + ' ' + company + ' ' + description).toLowerCase();
  for (const kw of keywords) {
    if (jobText.includes(kw)) {
      log(`Skip (blacklist "${kw}"): ${title.substring(0, 50)}`);
      return true;
    }
  }
  return false;
}

/**
 * Extract years of experience required from text (multilingual).
 * @param {string} text
 * @returns {number}
 */
function extractYearsRequired(text) {
  if (!text) return 0;
  const patterns = [
    /(\d+)\+?\s*(?:years?|yrs?)/gi,
    /(\d+)\+?\s*(?:ans?|années?)/gi,
    /(\d+)\+?\s*años?/gi,
    /(\d+)\+?\s*jahre?/gi,
    /(\d+)\+?\s*anni?/gi,
  ];
  const years = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const n = parseInt(match[1]);
      if (n > 0 && n <= 20) years.push(n);
    }
  }
  return years.length > 0 ? Math.max(...years) : 0;
}

/**
 * Check if a job should be skipped based on experience years.
 * @param {Element} jobCard
 * @param {number} maxYears
 * @returns {boolean}
 */
function shouldSkipByExperience(jobCard, maxYears) {
  if (!maxYears || maxYears <= 0) return false;
  const title = jobCard.querySelector('.job-card-list__title, .artdeco-entity-lockup__title')?.textContent || '';
  const subtitle = jobCard.querySelector('.job-card-container__metadata-item')?.textContent || '';
  const required = extractYearsRequired(title + ' ' + subtitle);
  if (required > 0 && required > maxYears) {
    log(`Skip: ${required}+ years required (max: ${maxYears})`);
    return true;
  }
  return false;
}

// ─── Task 8.2: Multi-Step Form Loop ──────────────────────────────────

/**
 * Fill the current step of the Easy Apply modal and navigate to the next step.
 * Uses autofill() to fill fields, then finds and clicks Next/Submit.
 * @param {Object} profile
 * @param {Object} settings
 * @param {Object} prefilledAnswers
 * @returns {Promise<{status: string, jobTitle?: string, jobCompany?: string}>}
 *   status: 'submitted' | 'discarded' | 'timeout' | 'no-modal' | 'error'
 */
async function fillAndNavigateSteps(profile, settings, prefilledAnswers) {
  const applicationStartTime = Date.now();

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (!isRunning) return { status: 'stopped' };

    // Timeout check
    if (Date.now() - applicationStartTime > APPLICATION_TIMEOUT) {
      log('Timeout 3min — discarding application');
      await discardApplication();
      return { status: 'timeout' };
    }

    // Loading screen detection
    if (isPageLoading()) {
      log('Loading screen detected, waiting...');
      const loadStart = Date.now();
      while (isPageLoading()) {
        if (Date.now() - loadStart > LOADING_SCREEN_TIMEOUT) {
          log('Loading timeout 20s — discarding');
          await discardApplication();
          return { status: 'discarded' };
        }
        await wait(1000);
      }
    }

    const modal = document.querySelector('.jobs-easy-apply-modal');
    if (!modal) { log('Modal closed unexpectedly'); return { status: 'no-modal' }; }

    // Check for validation errors before filling
    const errors = modal.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, .fb-form-element-label__error');
    let hasValidationError = false;
    for (const error of errors) {
      if (error.offsetParent !== null) {
        const errorText = error.textContent.toLowerCase();
        if (errorText.includes('please enter') || errorText.includes('valid answer') ||
            errorText.includes('required') || errorText.includes('must be') ||
            errorText.includes('invalid') || errorText.includes('veuillez') ||
            errorText.includes('requis')) {
          log(`Validation error: ${error.textContent.substring(0, 60)}`);
          hasValidationError = true;
          break;
        }
      }
    }
    if (hasValidationError) {
      log('Discarding due to validation error');
      await discardApplication();
      return { status: 'discarded' };
    }

    log(`Step ${step}`);

    // Fill fields on this step
    await autofill(profile, settings, prefilledAnswers);
    await wait(1500);
    updateActivity();

    // Find Next or Submit button
    const { button: nextBtn, isSubmit } = findNextOrSubmitButton(modal);
    if (!nextBtn) { log('No next/submit button found'); break; }

    // Before submit: unfollow company
    if (isSubmit) {
      nextBtn.scrollIntoView({ block: 'end', behavior: 'smooth' });
      await wait(800);
      await handleUnfollowBeforeSubmit(modal);
    }

    // Check disabled state
    if (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
      log('Button disabled — possible stuck scenario');
      if (step > 2) {
        log('Discarding: button remains disabled');
        await discardApplication();
        return { status: 'discarded' };
      }
      await wait(1000);
      continue;
    }

    // Click the button
    nextBtn.click();
    updateActivity();
    await wait(1000);

    // After clicking, check for validation errors
    if (!isSubmit) {
      const modalAfter = document.querySelector('.jobs-easy-apply-modal');
      if (modalAfter) {
        const postErrors = modalAfter.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error');
        let postValidationError = false;
        for (const error of postErrors) {
          if (error.offsetParent !== null) {
            const errorText = error.textContent.toLowerCase();
            if (errorText.includes('please enter') || errorText.includes('valid answer') ||
                errorText.includes('required') || errorText.includes('must be') ||
                errorText.includes('invalid') || errorText.includes('veuillez') ||
                errorText.includes('requis')) {
              log(`Post-click validation error: ${error.textContent.substring(0, 60)}`);
              postValidationError = true;
              break;
            }
          }
        }
        if (postValidationError) {
          log('Discarding due to post-click validation error');
          await discardApplication();
          return { status: 'discarded' };
        }
      }
    }

    // If submit was clicked, handle post-submit flow
    if (isSubmit) {
      log('Submit clicked!');
      await wait(1000);

      // Check if modal already closed
      if (!isModalOpen()) {
        log('Modal closed after submit — application complete');
        return { status: 'submitted' };
      }

      // Try to find and click Done button
      const result = await findAndClickDoneButton(document, 15);
      if (!result.clicked) {
        if (isModalOpen()) {
          log('Done button not found, trying discard...');
          await discardApplication();
        }
      }

      // Handle "Application sent" confirmation modal
      await wait(1500);
      const sentModal = document.querySelector('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal');
      if (sentModal && sentModal.offsetParent !== null) {
        log('Application sent modal detected, clicking Done...');
        const sentResult = await findAndClickDoneButton(sentModal, 8);
        if (!sentResult.clicked) await discardApplication();
      }

      return { status: 'submitted' };
    }
  }

  // Exceeded max steps without submitting
  log('Max steps reached without submit — discarding');
  await discardApplication();
  return { status: 'discarded' };
}

// ─── Task 8.5: Main Autoapply Loop ───────────────────────────────────

/**
 * Full autoapply loop: iterate job cards, open Easy Apply modals,
 * fill multi-step forms, and submit applications.
 * @param {Object} profile
 * @param {Object} settings
 * @param {Object} prefilledAnswers
 * @returns {Promise<void>}
 */
async function autoapply(profile, settings, prefilledAnswers) {
  log('Autoapply started');
  updateActivity();

  // Load counters from storage
  const stored = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs']);
  appliedCount = stored.appliedCount || 0;
  skippedCount = stored.skippedCount || 0;
  appliedJobs = stored.appliedJobs || [];

  const isCollectionsPage = window.location.href.includes('/jobs/collections/');
  log(isCollectionsPage ? 'Page type: COLLECTIONS (infinite scroll)' : 'Page type: SEARCH (pagination)');

  while (isRunning) {
    try {
      // Daily limit check
      if (checkDailyLimit()) {
        log(`Stopping: daily limit. Applied: ${appliedCount}, Skipped: ${skippedCount}`);
        isRunning = false;
        break;
      }

      // Stuck detection
      if (isStuck()) {
        log('Stuck detected (2min no activity) — refreshing page');
        location.reload();
        await wait(2500);
        updateActivity();
        continue;
      }

      // Find job cards
      let jobCards = document.querySelectorAll('li[data-occludable-job-id]');
      if (jobCards.length === 0 && isCollectionsPage) {
        jobCards = document.querySelectorAll('.jobs-search-results__list-item, .scaffold-layout__list-item');
      }

      if (jobCards.length === 0) {
        log('No jobs found, waiting 5s...');
        await wait(5000);
        if (isStuck()) {
          log('No jobs + stuck — refreshing');
          location.reload();
          await wait(2500);
          updateActivity();
        }
        continue;
      }

      log(`${jobCards.length} jobs found`);
      updateActivity();

      // Iterate job cards
      for (let i = 0; i < jobCards.length; i++) {
        if (!isRunning) break;

        const job = jobCards[i];
        const jobId = job.getAttribute('data-occludable-job-id');
        log(`\n--- Job ${i + 1}/${jobCards.length} (ID: ${jobId}) ---`);

        // Clean up leftover modal from previous job
        if (isModalOpen()) {
          log('Leftover modal detected, cleaning up...');
          await discardApplication();
          await wait(1000);
          if (isModalOpen()) {
            log('Could not close leftover modal, skipping');
            skippedCount++; updateSkippedCount();
            continue;
          }
        }

        // Extract job info for filtering
        const jobTitle = job.querySelector('.job-card-list__title, .artdeco-entity-lockup__title')?.textContent.trim() || '';
        const jobCompany = job.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle')?.textContent.trim() || '';
        const jobDescription = job.querySelector('.job-card-container__metadata-item, .job-card-list__insight')?.textContent.trim() || '';
        const jobLink = job.querySelector('a')?.href || window.location.href;

        // Blacklist filtering
        if (shouldSkipByBlacklist(jobTitle, jobCompany, jobDescription, settings.blacklistKeywords || '')) {
          skippedCount++; updateSkippedCount();
          continue;
        }

        // Experience filtering
        if (shouldSkipByExperience(job, parseInt(settings.maxYearsRequired) || 0)) {
          skippedCount++; updateSkippedCount();
          continue;
        }

        // Scroll to job card and click
        job.scrollIntoView({ block: 'start', behavior: 'smooth' });
        await wait(500);
        const link = job.querySelector('a');
        if (link) { link.click(); await wait(600); }

        // Find Easy Apply button
        let easyApplyBtn = document.querySelector('button.jobs-apply-button[aria-label*="Easy"]');
        if (!easyApplyBtn) {
          easyApplyBtn = document.querySelector('button[aria-label*="Easy Apply"]');
        }
        if (!easyApplyBtn) {
          log('Not Easy Apply, skip');
          skippedCount++; updateSkippedCount();
          continue;
        }

        easyApplyBtn.click();
        updateActivity();
        await wait(800);

        // Handle safety reminder modal
        const safetyModal = document.querySelector('[role="dialog"], .artdeco-modal');
        if (safetyModal && safetyModal.offsetParent !== null) {
          const safetyText = safetyModal.textContent.toLowerCase();
          if (safetyText.includes('safety reminder') || safetyText.includes('rappel de sécurité') ||
              safetyText.includes('continue applying') || safetyText.includes('continuer à postuler')) {
            const continueBtn = Array.from(safetyModal.querySelectorAll('button')).find(btn => {
              const t = btn.textContent.trim().toLowerCase();
              return t.includes('continue applying') || t.includes('continuer à postuler') ||
                     t.includes('continue') || t.includes('continuer');
            });
            if (continueBtn) { continueBtn.click(); log('Safety reminder dismissed'); await wait(1000); }
          }
        }

        // Check daily limit after clicking Easy Apply
        if (checkDailyLimit()) {
          log(`Daily limit reached. Applied: ${appliedCount}, Skipped: ${skippedCount}`);
          isRunning = false;
          break;
        }

        // Verify modal appeared
        if (!isModalOpen()) {
          log('Easy Apply modal did not appear');
          await wait(1000);
          if (checkDailyLimit()) { isRunning = false; break; }
          log('Modal not found, skipping job');
          skippedCount++; updateSkippedCount();
          continue;
        }

        // Fill and navigate the multi-step form
        const result = await fillAndNavigateSteps(profile, settings, prefilledAnswers);

        if (result.status === 'submitted') {
          appliedCount++;
          const appliedJob = {
            title: jobTitle,
            company: jobCompany,
            url: jobLink,
            timestamp: new Date().toISOString(),
            status: 'filled',
            atsType: 'linkedin',
            fieldsFilled: result.filled || 0,
            fieldsSkipped: result.skipped || 0,
            fieldsFailed: result.failed || 0,
          };
          appliedJobs.push(appliedJob);
          updateAppliedCount();
          saveAppliedJobsToStorage();
          reportAppliedJobToBackend(appliedJob);
          log(`Applied: ${jobTitle} @ ${jobCompany}`);
        } else {
          skippedCount++;
          updateSkippedCount();
          log(`Skipped (${result.status}): ${jobTitle}`);
        }

        await wait(500);
      }

      // Exit if stopped during job processing
      if (!isRunning) break;

      // ── Page navigation ──
      log('Looking for next page...');
      let nextPageClicked = false;

      // Collections page: infinite scroll
      if (isCollectionsPage) {
        const container = document.querySelector('.jobs-search-results-list, .scaffold-layout__list-container, .jobs-search-results__list');
        if (container) {
          const currentCount = jobCards.length;
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          await wait(2000);
          const newCount = document.querySelectorAll('li[data-occludable-job-id], .jobs-search-results__list-item').length;
          if (newCount > currentCount) {
            log(`Loaded ${newCount - currentCount} more jobs`);
            nextPageClicked = true;
          }
        }
      }

      // Search page: pagination
      if (!nextPageClicked) {
        const pagination = document.querySelector('.jobs-search-pagination__pages');
        if (pagination) {
          const activeBtn = pagination.querySelector('button.active, button[aria-current="true"], li.active button');
          if (activeBtn) {
            const currentPage = parseInt(activeBtn.textContent);
            const nextPageBtn = pagination.querySelector(`button[aria-label="Page ${currentPage + 1}"]`) ||
              pagination.querySelector(`button[data-test-pagination-page-btn="${currentPage + 1}"]`);
            if (nextPageBtn && nextPageBtn.offsetParent !== null) {
              nextPageBtn.click(); await wait(1000);
              nextPageClicked = true;
              log(`Navigated to page ${currentPage + 1}`);
            }
          }
        }
      }

      // Fallback: Next button in pagination
      if (!nextPageClicked) {
        const nextButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of nextButtons) {
          if (!btn.offsetParent) continue;
          const btnText = btn.textContent.trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if ((btnText === 'next' || btnText === 'suivant' || ariaLabel.includes('next')) &&
              (btn.closest('.jobs-search-pagination') || btn.closest('[class*="pagination"]'))) {
            btn.click(); await wait(1000);
            nextPageClicked = true;
            log('Navigated via Next button');
            break;
          }
        }
      }

      if (!nextPageClicked) {
        log('No more pages — autoapply complete');
        break;
      }

    } catch (error) {
      log(`Autoapply error: ${error.message}`);
      await wait(1500);
    }
  }

  log(`Autoapply finished. Applied: ${appliedCount}, Skipped: ${skippedCount}`);
  isRunning = false;
}

// ─── Apply Button Detection Helpers ──────────────────────────────────

/**
 * Find Easy Apply button (LinkedIn native applications).
 * @returns {HTMLElement|null}
 */
function findEasyApplyButton() {
  // Strategy 1: Standard Easy Apply button with aria-label
  let btn = document.querySelector('button.jobs-apply-button[aria-label*="Easy"]');
  if (btn && btn.offsetParent !== null) return btn;
  
  // Strategy 2: Any button with "Easy Apply" in aria-label
  btn = document.querySelector('button[aria-label*="Easy Apply"]');
  if (btn && btn.offsetParent !== null) return btn;
  
  // Strategy 3: Find by text content
  const allButtons = document.querySelectorAll('button');
  for (const b of allButtons) {
    if (b.offsetParent === null) continue;
    const btnText = b.textContent.trim();
    if (btnText.includes('Easy Apply') || btnText.includes('Postuler facilement')) {
      log(`Found Easy Apply button by text: "${btnText}"`);
      return b;
    }
  }

  // Strategy 4: Find span with "Easy Apply" text and walk up to button
  const spans = document.querySelectorAll('span');
  for (const span of spans) {
    const text = span.textContent.trim();
    if (text === 'Easy Apply' || text === 'Postuler facilement') {
      let el = span;
      for (let i = 0; i < 10; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.tagName === 'BUTTON' && el.offsetParent !== null) {
          log('Found Easy Apply button via span parent');
          return el;
        }
      }
    }
  }

  return null;
}

/**
 * Find External Apply button (redirects to company ATS).
 * These buttons say "Apply" (not "Easy Apply") and open external sites.
 * @returns {HTMLElement|null}
 */
function findExternalApplyButton() {
  console.log('[AutoApplyBot] Searching for External Apply button...');
  
  // Strategy 0: Rippling-specific - look for their Apply button with data-testid
  const ripplingBtn = document.querySelector('button[data-testid="Apply now"], button[data-testid*="Apply"]');
  if (ripplingBtn && ripplingBtn.offsetParent !== null) {
    log('Found Rippling Apply button via data-testid');
    return ripplingBtn;
  }
  
  // Strategy 1: jobs-apply-button class (LinkedIn's standard apply button)
  let btn = document.querySelector('button.jobs-apply-button');
  if (btn && btn.offsetParent !== null) {
    const text = btn.textContent.trim().toLowerCase();
    console.log('[AutoApplyBot] Found jobs-apply-button, text:', text);
    // Make sure it's not Easy Apply
    if (!text.includes('easy')) {
      log('Found external Apply button via jobs-apply-button class');
      return btn;
    }
  }

  // Strategy 2: Button with aria-label containing "Apply" but not "Easy"
  const ariaButtons = document.querySelectorAll('button[aria-label*="Apply"]');
  for (const b of ariaButtons) {
    if (b.offsetParent === null) continue;
    const ariaLabel = b.getAttribute('aria-label') || '';
    console.log('[AutoApplyBot] Found button with aria-label:', ariaLabel);
    if (!ariaLabel.toLowerCase().includes('easy')) {
      log(`Found external Apply button via aria-label: "${ariaLabel}"`);
      return b;
    }
  }

  // Strategy 3: Find by text content - "Apply" but NOT "Easy Apply"
  const allButtons = document.querySelectorAll('button, a[role="button"], a.btn, a.button');
  console.log('[AutoApplyBot] Checking', allButtons.length, 'buttons for Apply text...');
  for (const b of allButtons) {
    if (b.offsetParent === null) continue;
    const btnText = b.textContent.trim();
    const btnTextLower = btnText.toLowerCase();
    // Match "Apply", "Apply now", "Apply for this job", "Postuler", etc. but NOT "Easy Apply"
    if ((btnTextLower === 'apply' || btnTextLower === 'apply now' || 
         btnTextLower === 'apply for this job' || btnTextLower === 'apply to this job' ||
         btnTextLower === 'postuler' || btnTextLower === 'postuler maintenant' ||
         btnTextLower.startsWith('apply ')) && 
        !btnTextLower.includes('easy')) {
      log(`Found external Apply button by text: "${btnText}"`);
      return b;
    }
  }

  // Strategy 4: Find span with "Apply" text and walk up to button
  const spans = document.querySelectorAll('span');
  for (const span of spans) {
    const text = span.textContent.trim().toLowerCase();
    if ((text === 'apply' || text === 'apply now' || text === 'postuler') && 
        !text.includes('easy')) {
      let el = span;
      for (let i = 0; i < 10; i++) {
        el = el.parentElement;
        if (!el) break;
        if ((el.tagName === 'BUTTON' || el.tagName === 'A') && el.offsetParent !== null) {
          log('Found external Apply button via span parent');
          return el;
        }
      }
    }
  }

  // Strategy 5: Look for any clickable element with Apply text (links, divs with role=button)
  const clickables = document.querySelectorAll('a, [role="button"]');
  for (const el of clickables) {
    if (el.offsetParent === null) continue;
    const text = el.textContent.trim().toLowerCase();
    if ((text === 'apply' || text === 'apply now' || text.includes('apply to') ||
         text.includes('apply for')) && 
        !text.includes('easy')) {
      log(`Found external Apply element: ${el.tagName}`);
      return el;
    }
  }

  console.log('[AutoApplyBot] No external Apply button found');
  return null;
}

/**
 * Find ANY Apply button (fallback for both Easy Apply and External).
 * @returns {HTMLElement|null}
 */
function findAnyApplyButton() {
  console.log('[AutoApplyBot] findAnyApplyButton() - searching for ANY apply button...');
  
  // Try jobs-apply-button class first
  let btn = document.querySelector('button.jobs-apply-button');
  if (btn && btn.offsetParent !== null) {
    console.log('[AutoApplyBot] Found via jobs-apply-button class:', btn.textContent.trim());
    log('Found Apply button via jobs-apply-button class');
    return btn;
  }

  // Try any button with "Apply" in text
  const allButtons = document.querySelectorAll('button');
  console.log('[AutoApplyBot] Checking', allButtons.length, 'buttons...');
  for (const b of allButtons) {
    if (b.offsetParent === null) continue;
    const btnText = b.textContent.trim().toLowerCase();
    if (btnText.includes('apply') || btnText.includes('postuler')) {
      console.log('[AutoApplyBot] Found button with apply text:', b.textContent.trim());
      log(`Found Apply button by text: "${b.textContent.trim()}"`);
      return b;
    }
  }

  // Try links that look like apply buttons (some external jobs use <a> tags)
  const links = document.querySelectorAll('a.jobs-apply-button, a[href*="apply"]');
  console.log('[AutoApplyBot] Checking', links.length, 'apply links...');
  for (const link of links) {
    if (link.offsetParent !== null) {
      console.log('[AutoApplyBot] Found apply link:', link.textContent.trim());
      log('Found Apply link');
      return link;
    }
  }

  // Last resort: look for any element with "Apply" that's clickable
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    if (el.offsetParent === null) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    const text = el.textContent.trim();
    if (text.length > 0 && text.length < 30 && 
        (text.toLowerCase() === 'apply' || text.toLowerCase() === 'apply now')) {
      // Check if this element or its parent is clickable
      const clickable = el.closest('button, a, [role="button"]');
      if (clickable && clickable.offsetParent !== null) {
        console.log('[AutoApplyBot] Found clickable apply element:', clickable.tagName, text);
        return clickable;
      }
    }
  }

  console.log('[AutoApplyBot] findAnyApplyButton() - NO BUTTON FOUND');
  return null;
}

// ─── Job Queue Processing ────────────────────────────────────────────

/**
 * Process jobs from the backend queue.
 * Called when the page loads on a LinkedIn job URL that's in the pending queue.
 * Handles BOTH Easy Apply (LinkedIn native) AND external Apply buttons.
 */
async function processJobQueue(profile, settings, prefilledAnswers) {
  // Prevent duplicate processing
  if (isProcessingQueue) {
    console.log('[AutoApplyBot] Already processing queue, skipping duplicate call');
    return;
  }
  isProcessingQueue = true;
  
  console.log('[AutoApplyBot] ========================================');
  console.log('[AutoApplyBot] processJobQueue() STARTING');
  console.log('[AutoApplyBot] ========================================');
  log('Processing job from queue...');
  updateActivity();

  // Load queue from storage
  const stored = await chrome.storage.local.get(['pendingJobs', 'currentJobIndex', 'appliedCount', 'skippedCount', 'appliedJobs']);
  const pendingJobs = stored.pendingJobs || [];
  let currentIndex = stored.currentJobIndex || 0;
  appliedCount = stored.appliedCount || 0;
  skippedCount = stored.skippedCount || 0;
  appliedJobs = stored.appliedJobs || [];

  console.log('[AutoApplyBot] Queue status:', {
    totalJobs: pendingJobs.length,
    currentIndex: currentIndex,
    appliedCount: appliedCount,
    skippedCount: skippedCount
  });

  if (pendingJobs.length === 0) {
    log('No pending jobs in queue');
    return;
  }

  const currentJob = pendingJobs[currentIndex];
  if (!currentJob) {
    log('No more jobs in queue');
    await chrome.storage.local.remove(['pendingJobs', 'currentJobIndex']);
    return;
  }

  console.log('[AutoApplyBot] Current job:', currentJob);
  log(`Processing job ${currentIndex + 1}/${pendingJobs.length}: ${currentJob.title} at ${currentJob.company}`);
  log(`Job ATS type: ${currentJob.atsType}`);

  // Wait for page to fully load and job details to render
  console.log('[AutoApplyBot] Waiting for page to load...');
  await wait(3000);

  // Check for "Already applied" indicator first
  const alreadyAppliedIndicators = document.querySelectorAll(
    '.jobs-s-apply__application-link, [class*="applied"], .artdeco-inline-feedback'
  );
  for (const indicator of alreadyAppliedIndicators) {
    const text = indicator.textContent.toLowerCase();
    if (text.includes('applied') || text.includes('postulé') || text.includes('application submitted')) {
      log('Already applied to this job, skipping');
      skippedCount++;
      updateSkippedCount();
      await moveToNextJob(pendingJobs, currentIndex);
      return;
    }
  }

  // Determine if this is Easy Apply or External Apply
  // atsType can be: 'easy_apply', 'external', 'greenhouse', 'lever', 'workday', etc.
  // Easy Apply = atsType is 'easy_apply', empty, null, or 'linkedin'
  // External = anything else (greenhouse, lever, workday, etc.)
  const isEasyApply = !currentJob.atsType || 
                      currentJob.atsType === '' || 
                      currentJob.atsType === 'easy_apply' || 
                      currentJob.atsType === 'linkedin';
  console.log('[AutoApplyBot] isEasyApply:', isEasyApply, 'atsType:', currentJob.atsType);
  log(`Looking for ${isEasyApply ? 'Easy Apply' : 'External Apply'} button...`);

  let applyBtn = null;

  // First, let's log all visible buttons on the page for debugging
  const allVisibleButtons = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
  console.log('[AutoApplyBot] Visible buttons on page:', allVisibleButtons.length);
  allVisibleButtons.slice(0, 10).forEach((btn, i) => {
    console.log(`[AutoApplyBot] Button ${i}: "${btn.textContent.trim().substring(0, 50)}" class="${btn.className}"`);
  });

  if (isEasyApply) {
    // ─── EASY APPLY BUTTON DETECTION ───
    applyBtn = findEasyApplyButton();
  } else {
    // ─── EXTERNAL APPLY BUTTON DETECTION ───
    applyBtn = findExternalApplyButton();
  }

  // If specific search failed, try generic Apply button search
  if (!applyBtn) {
    console.log('[AutoApplyBot] Specific button not found, trying generic search...');
    log('Specific button not found, trying generic Apply button search...');
    applyBtn = findAnyApplyButton();
  }

  if (!applyBtn) {
    console.log('[AutoApplyBot] NO APPLY BUTTON FOUND - skipping job');
    log('No Apply button found, moving to next job');
    skippedCount++;
    updateSkippedCount();
    await moveToNextJob(pendingJobs, currentIndex);
    return;
  }

  // Scroll button into view and click
  console.log('[AutoApplyBot] FOUND Apply button:', applyBtn.textContent.trim().substring(0, 50));
  log(`Found Apply button: "${applyBtn.textContent.trim().substring(0, 30)}"`);
  applyBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await wait(500);
  
  console.log('[AutoApplyBot] CLICKING Apply button...');
  log('Clicking Apply button...');
  applyBtn.click();
  updateActivity();
  await wait(2000);

  // For EXTERNAL jobs, the click opens a new tab/window to the ATS site
  // We need to detect if this happened and handle it
  if (!isEasyApply) {
    log('External job - checking if new tab opened...');
    
    // The external apply button typically opens a new tab
    // We'll mark this job as "redirected" and move to next
    // The user will need to complete the application on the external site
    
    // Check if we're still on LinkedIn (button might have opened new tab)
    await wait(1500);
    
    // Record that we clicked apply (even though it's external)
    const appliedJob = {
      title: currentJob.title,
      company: currentJob.company,
      url: currentJob.url,
      timestamp: new Date().toISOString(),
      status: 'redirected',
      atsType: currentJob.atsType || 'external',
      fieldsFilled: 0,
      fieldsSkipped: 0,
      fieldsFailed: 0,
    };
    appliedJobs.push(appliedJob);
    appliedCount++;
    updateAppliedCount();
    saveAppliedJobsToStorage();
    reportAppliedJobToBackend(appliedJob);
    log(`Redirected to external ATS: ${currentJob.title} @ ${currentJob.company}`);
    
    // Move to next job
    await moveToNextJob(pendingJobs, currentIndex);
    return;
  }

  // ─── EASY APPLY FLOW ───
  // Handle safety reminder modal
  const safetyModal = document.querySelector('[role="dialog"], .artdeco-modal');
  if (safetyModal && safetyModal.offsetParent !== null) {
    const safetyText = safetyModal.textContent.toLowerCase();
    if (safetyText.includes('safety reminder') || safetyText.includes('continue applying')) {
      const continueBtn = Array.from(safetyModal.querySelectorAll('button')).find(btn => {
        const t = btn.textContent.trim().toLowerCase();
        return t.includes('continue') || t.includes('continuer');
      });
      if (continueBtn) {
        continueBtn.click();
        log('Safety reminder dismissed');
        await wait(1000);
      }
    }
  }

  // Wait a bit more for modal to appear
  await wait(1000);

  // Verify modal appeared
  if (!isModalOpen()) {
    log('Easy Apply modal did not appear, waiting longer...');
    await wait(2000);
    
    // Try clicking the button again
    if (!isModalOpen() && applyBtn) {
      log('Retrying Apply button click...');
      applyBtn.click();
      await wait(2000);
    }
    
    if (!isModalOpen()) {
      log('Modal still not open after retry, skipping job');
      skippedCount++;
      updateSkippedCount();
      await moveToNextJob(pendingJobs, currentIndex);
      return;
    }
  }

  log('Easy Apply modal is open, filling form...');

  // Fill and navigate the multi-step form
  const result = await fillAndNavigateSteps(profile, settings, prefilledAnswers);

  if (result.status === 'submitted') {
    appliedCount++;
    const appliedJob = {
      title: currentJob.title,
      company: currentJob.company,
      url: currentJob.url,
      timestamp: new Date().toISOString(),
      status: 'filled',
      atsType: currentJob.atsType || 'linkedin',
      fieldsFilled: result.filled || 0,
      fieldsSkipped: result.skipped || 0,
      fieldsFailed: result.failed || 0,
    };
    appliedJobs.push(appliedJob);
    updateAppliedCount();
    saveAppliedJobsToStorage();
    reportAppliedJobToBackend(appliedJob);
    log(`Applied: ${currentJob.title} @ ${currentJob.company}`);
  } else {
    skippedCount++;
    updateSkippedCount();
    log(`Skipped (${result.status}): ${currentJob.title}`);
  }

  // Move to next job
  await moveToNextJob(pendingJobs, currentIndex);
}

/**
 * Navigate to the next job in the queue.
 */
async function moveToNextJob(pendingJobs, currentIndex) {
  // Reset processing flag before navigation
  isProcessingQueue = false;
  
  const nextIndex = currentIndex + 1;

  if (nextIndex >= pendingJobs.length) {
    log('All jobs in queue processed!');
    await chrome.storage.local.remove(['pendingJobs', 'currentJobIndex']);
    await chrome.storage.local.set({ isRunning: false });
    chrome.runtime.sendMessage({ type: 'queueComplete' });
    return;
  }

  // Save next index and navigate
  await chrome.storage.local.set({ currentJobIndex: nextIndex });
  const nextJob = pendingJobs[nextIndex];
  log(`Moving to next job: ${nextJob.title}`);

  // Delay before navigation (5 seconds to allow page to settle)
  await wait(5000);
  window.location.href = nextJob.url;
}

// ─── Auto-start queue processing on LinkedIn job pages ───────────────

console.log('[AutoApplyBot] Setting up queue check...');

(async function checkAndProcessQueue() {
  console.log('[AutoApplyBot] checkAndProcessQueue() called');
  console.log('[AutoApplyBot] Current URL:', window.location.href);
  
  // Prevent duplicate processing
  if (isProcessingQueue) {
    console.log('[AutoApplyBot] Already processing, skipping');
    return;
  }
  
  // Only run on LinkedIn job pages
  if (!window.location.href.includes('linkedin.com/jobs/')) {
    console.log('[AutoApplyBot] Not a LinkedIn jobs page, skipping queue check');
    return;
  }

  console.log('[AutoApplyBot] This is a LinkedIn jobs page, checking storage...');

  // Check if we have a pending queue
  const stored = await chrome.storage.local.get(['pendingJobs', 'currentJobIndex', 'isRunning', 'profile', 'settings']);
  const pendingJobs = stored.pendingJobs || [];
  const currentIndex = stored.currentJobIndex || 0;

  console.log('[AutoApplyBot] Storage data:', {
    pendingJobsCount: pendingJobs.length,
    currentIndex: currentIndex,
    isRunning: stored.isRunning,
    hasProfile: !!stored.profile,
    hasSettings: !!stored.settings
  });

  log(`Queue check: ${pendingJobs.length} jobs, index ${currentIndex}, isRunning: ${stored.isRunning}`);

  if (pendingJobs.length === 0 || !stored.isRunning) {
    log('No queue to process or not running');
    return;
  }

  // Check if current URL matches the expected job (extract job ID from URL)
  const currentJob = pendingJobs[currentIndex];
  if (!currentJob) {
    log('No current job at index ' + currentIndex);
    return;
  }

  console.log('[AutoApplyBot] Current job from queue:', currentJob);

  // Extract job ID from both URLs for comparison
  const currentUrlJobId = extractJobIdFromUrl(window.location.href);
  const expectedJobId = extractJobIdFromUrl(currentJob.url);

  log(`Current URL job ID: ${currentUrlJobId}, Expected: ${expectedJobId}`);

  // Only process if we're on the right job page
  if (currentUrlJobId && expectedJobId && currentUrlJobId === expectedJobId) {
    log('Queue job detected, auto-starting...');
    const profile = stored.profile || {};
    const settings = stored.settings || {};
    const prefilledAnswers = settings.prefilledAnswers || {};

    // Set isRunning flag
    isRunning = true;

    // Wait for page to stabilize
    await wait(3000);
    await processJobQueue(profile, settings, prefilledAnswers);
  } else {
    log(`URL mismatch - waiting for correct page to load`);
  }
})();

/**
 * Extract job ID from a LinkedIn job URL.
 * Handles various URL formats like /jobs/view/123456789 or /jobs/collections/recommended/?currentJobId=123456789
 */
function extractJobIdFromUrl(url) {
  if (!url) return null;
  
  // Try /jobs/view/ID format
  const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) return viewMatch[1];
  
  // Try currentJobId query param
  const paramMatch = url.match(/currentJobId=(\d+)/);
  if (paramMatch) return paramMatch[1];
  
  // Try any numeric ID at the end of the path
  const pathMatch = url.match(/\/(\d{8,})(?:[/?]|$)/);
  if (pathMatch) return pathMatch[1];
  
  return null;
}

// ─── Message Listener ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, profile, settings, prefilledAnswers } = message;

  if (action === 'autofill') {
    log('Received autofill request');
    isRunning = true;
    autofill(profile, settings, prefilledAnswers).then(result => {
      isRunning = false;
      sendResponse({ success: true, data: result });
    }).catch(err => {
      isRunning = false;
      log(`Autofill error: ${err.message}`);
      sendResponse({ success: false, error: err.message });
    });
    return true; // keep message channel open for async response
  }

  if (action === 'autoapply') {
    log('Received autoapply request');
    isRunning = true;
    autoapply(profile, settings, prefilledAnswers).then(() => {
      isRunning = false;
      sendResponse({ success: true });
    }).catch(err => {
      isRunning = false;
      log(`Autoapply error: ${err.message}`);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (action === 'detect') {
    const atsType = detectATS(window.location.href);
    log(`ATS detected: ${atsType}`);
    sendResponse({ success: true, data: { atsType } });
  }

  if (action === 'getStatus') {
    sendResponse({ success: true, data: { isRunning } });
  }

  if (action === 'stop') {
    log('Stop requested');
    isRunning = false;
    sendResponse({ success: true });
  }

  if (action === 'processQueue') {
    log('Received processQueue request');
    isRunning = true;
    processJobQueue(profile, settings, prefilledAnswers).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      log(`Queue processing error: ${err.message}`);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

log('Content script loaded on ' + window.location.hostname);

// ─── Auto-detect and fill external ATS pages ─────────────────────────

/**
 * Try multiple click strategies on an element.
 * Some frameworks (React, Angular) need specific event dispatching.
 * @param {HTMLElement} element
 * @returns {Promise<boolean>}
 */
async function multiClickStrategy(element) {
  log(`Trying multi-click strategy on: ${element.tagName} "${(element.textContent || element.value || '').substring(0, 30)}"`);
  
  // Strategy 1: Standard click
  try {
    element.click();
    log('Strategy 1: Standard click executed');
    await wait(500);
  } catch (e) {
    log('Strategy 1 failed: ' + e.message);
  }
  
  // Strategy 2: MouseEvent dispatch (more realistic)
  try {
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
    const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
    element.dispatchEvent(mouseDown);
    await wait(50);
    element.dispatchEvent(mouseUp);
    await wait(50);
    element.dispatchEvent(click);
    log('Strategy 2: MouseEvent dispatch executed');
    await wait(500);
  } catch (e) {
    log('Strategy 2 failed: ' + e.message);
  }
  
  // Strategy 3: Focus + Enter key (for keyboard-accessible buttons)
  try {
    element.focus();
    await wait(100);
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
    element.dispatchEvent(enterEvent);
    const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
    element.dispatchEvent(enterUp);
    log('Strategy 3: Focus + Enter executed');
    await wait(500);
  } catch (e) {
    log('Strategy 3 failed: ' + e.message);
  }
  
  // Strategy 4: If button is inside a form, try form.submit()
  try {
    const form = element.closest('form');
    if (form) {
      // Check if form has a submit handler - try requestSubmit first (triggers validation)
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit(element.type === 'submit' ? element : null);
        log('Strategy 4: form.requestSubmit() executed');
      } else {
        form.submit();
        log('Strategy 4: form.submit() executed');
      }
      await wait(500);
    }
  } catch (e) {
    log('Strategy 4 failed: ' + e.message);
  }
  
  return true;
}

/**
 * Check if there's a reCAPTCHA or Cloudflare Turnstile on the page that needs solving.
 * Returns true only if there's a VISIBLE captcha that needs user interaction.
 * Invisible reCAPTCHA (enterprise) doesn't need user action - it runs automatically.
 * @returns {boolean}
 */
function hasUnsolvedRecaptcha() {
  // Check for Cloudflare Turnstile
  const turnstileFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
  if (turnstileFrame) {
    log('Cloudflare Turnstile detected on page');
    // Check if it's been solved (look for response token)
    const turnstileResponse = document.querySelector('[name="cf-turnstile-response"]');
    if (turnstileResponse && turnstileResponse.value) {
      log('Cloudflare Turnstile appears to be solved');
      return false;
    }
    // Also check for success indicator
    const turnstileSuccess = document.querySelector('[data-turnstile-success="true"], .cf-turnstile-success');
    if (turnstileSuccess) {
      log('Cloudflare Turnstile success indicator found');
      return false;
    }
    return true;
  }
  
  // Check for "Verify you are human" button/text
  const verifyHumanBtn = document.querySelector('button[data-action="verify"], [class*="turnstile"], [id*="turnstile"]');
  if (verifyHumanBtn && verifyHumanBtn.offsetParent !== null) {
    const text = verifyHumanBtn.textContent.toLowerCase();
    if (text.includes('verify') || text.includes('human')) {
      log('Verify human button detected');
      return true;
    }
  }
  
  // Check for reCAPTCHA iframe
  const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]');
  if (recaptchaFrame) {
    const src = recaptchaFrame.src || '';
    
    // Check if it's an INVISIBLE reCAPTCHA (enterprise or size=invisible)
    // These don't require user interaction - they run automatically
    if (src.includes('size=invisible') || src.includes('enterprise')) {
      log('Invisible reCAPTCHA detected (no user action needed)');
      return false; // Don't wait for invisible captcha
    }
    
    log('Visible reCAPTCHA detected on page');
    // Check if it's been solved (look for checkmark or response token)
    const recaptchaResponse = document.querySelector('[name="g-recaptcha-response"]');
    if (recaptchaResponse && recaptchaResponse.value) {
      log('reCAPTCHA appears to be solved');
      return false;
    }
    return true;
  }
  
  // Check for hCaptcha
  const hcaptchaFrame = document.querySelector('iframe[src*="hcaptcha"]');
  if (hcaptchaFrame) {
    log('hCaptcha detected on page');
    const hcaptchaResponse = document.querySelector('[name="h-captcha-response"]');
    if (hcaptchaResponse && hcaptchaResponse.value) {
      log('hCaptcha appears to be solved');
      return false;
    }
    return true;
  }
  
  return false;
}

/**
 * Find and click submit/apply button on external ATS pages.
 * Uses multiple click strategies for better compatibility with React/Angular forms.
 * @returns {Promise<boolean>}
 */
async function findAndClickSubmitButton() {
  // Check for unsolved CAPTCHA first
  if (hasUnsolvedRecaptcha()) {
    log('⚠️ CAPTCHA detected - waiting for user to solve it...');
    // Wait up to 60 seconds for user to solve CAPTCHA
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      if (!hasUnsolvedRecaptcha()) {
        log('CAPTCHA solved! Continuing with submission...');
        break;
      }
      if (i === 59) {
        log('CAPTCHA timeout - user may need to solve manually');
        return false;
      }
    }
  }
  
  // Priority order for submit button text (most specific first)
  const submitTexts = [
    'submit application', 'submit my application', 'soumettre ma candidature',
    'submit', 'soumettre', 'apply now', 'apply', 'postuler',
    'send application', 'send', 'envoyer',
    'complete application', 'finish', 'terminer'
  ];
  
  // BambooHR: Don't treat "Apply for This Job" as submit if the actual form isn't visible
  const isBambooPreForm = detectATS(window.location.href) === 'bamboohr' && 
    !document.querySelector('#job-application-form, form[id*="application"]') &&
    document.querySelectorAll('input[name="firstName"], input[id="firstName"]').length === 0;
  
  // Secondary texts (less specific, might match non-submit buttons)
  const secondaryTexts = ['continue', 'next', 'suivant'];
  
  // Rippling-specific: Look for submit button by data-testid
  const ripplingSubmit = document.querySelector('button[data-testid="Apply"], button[data-testid="Submit"], button[data-testid="submit"]');
  if (ripplingSubmit && ripplingSubmit.offsetParent !== null && !ripplingSubmit.disabled) {
    log(`Found Rippling submit button: ${ripplingSubmit.getAttribute('data-testid')}`);
    ripplingSubmit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(300);
    await multiClickStrategy(ripplingSubmit);
    return true;
  }
  
  // Rippling: Also look for Apply now button by span text (job description page)
  const ripplingApplyNow = document.querySelector('button[data-testid="Apply now"]') ||
                           document.querySelector('button:has(span.css-1d5eng1)') ||
                           Array.from(document.querySelectorAll('button')).find(b => {
                             const span = b.querySelector('span');
                             return span && span.textContent.trim() === 'Apply now';
                           });
  if (ripplingApplyNow && ripplingApplyNow.offsetParent !== null && !ripplingApplyNow.disabled) {
    log(`Found Rippling Apply now button: "${ripplingApplyNow.textContent.trim()}"`);
    ripplingApplyNow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(300);
    await multiClickStrategy(ripplingApplyNow);
    return true;
  }
  
  // Greenhouse-specific: Look for the main submit button by ID or data attributes
  const greenhouseSubmit = document.querySelector('#submit_app, [data-qa="submit-application"], button[type="submit"]');
  if (greenhouseSubmit && greenhouseSubmit.offsetParent !== null) {
    log(`Found Greenhouse submit button: ${greenhouseSubmit.id || greenhouseSubmit.className}`);
    greenhouseSubmit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(300);
    await multiClickStrategy(greenhouseSubmit);
    return true;
  }
  
  // Try primary submit texts first
  const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
  for (const submitText of submitTexts) {
    for (const btn of buttons) {
      if (btn.offsetParent === null) continue;
      if (btn.disabled) continue; // Skip disabled buttons
      
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      
      // Skip "Apply for This Job" on BambooHR pre-form page
      if (isBambooPreForm && (text.includes('apply for this job') || text.includes('apply to this job'))) {
        continue;
      }
      
      if (text.includes(submitText) || ariaLabel.includes(submitText)) {
        log(`Found submit button: "${text || ariaLabel}"`);
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await wait(300);
        await multiClickStrategy(btn);
        return true;
      }
    }
  }
  
  // Try secondary texts (continue/next) only if no primary found
  for (const submitText of secondaryTexts) {
    for (const btn of buttons) {
      if (btn.offsetParent === null) continue;
      if (btn.disabled) continue;
      
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      
      if (text.includes(submitText) || ariaLabel.includes(submitText)) {
        log(`Found secondary button: "${text || ariaLabel}"`);
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await wait(300);
        await multiClickStrategy(btn);
        return true;
      }
    }
  }
  
  // Try links that look like submit buttons
  const links = document.querySelectorAll('a[role="button"], a.btn, a.button');
  for (const link of links) {
    if (link.offsetParent === null) continue;
    const text = link.textContent.trim().toLowerCase();
    for (const submitText of [...submitTexts, ...secondaryTexts]) {
      if (text.includes(submitText)) {
        log(`Found submit link: "${text}"`);
        link.click();
        return true;
      }
    }
  }
  
  // Last resort: Find any visible submit-type input
  const submitInputs = document.querySelectorAll('input[type="submit"]');
  for (const input of submitInputs) {
    if (input.offsetParent !== null && !input.disabled) {
      log(`Found submit input: "${input.value}"`);
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await wait(300);
      await multiClickStrategy(input);
      return true;
    }
  }
  
  return false;
}

/**
 * Handle file upload on external ATS pages.
 * Looks for resume upload fields and fills them.
 */
async function handleExternalResumeUpload(settings) {
  console.log('[AutoApplyBot] handleExternalResumeUpload() starting...');
  
  // First, look for any upload button/link that might trigger a file dialog
  const uploadButtons = document.querySelectorAll('button, a, [role="button"], label');
  for (const btn of uploadButtons) {
    if (btn.offsetParent === null) continue;
    const text = (btn.textContent || '').toLowerCase();
    if (text.includes('upload') || text.includes('attach') || text.includes('choose file') || 
        text.includes('select file') || text.includes('add resume') || text.includes('add cv')) {
      console.log('[AutoApplyBot] Found upload button:', text.substring(0, 30));
      // Check if there's a hidden file input nearby
      const nearbyInput = btn.querySelector('input[type="file"]') || 
                          btn.parentElement?.querySelector('input[type="file"]') ||
                          document.querySelector('input[type="file"]');
      if (nearbyInput) {
        console.log('[AutoApplyBot] Found associated file input');
      }
    }
  }
  
  const fileInputs = document.querySelectorAll('input[type="file"]');
  console.log('[AutoApplyBot] Found', fileInputs.length, 'file inputs');
  
  // Sort file inputs: resume/cv inputs first, then others
  const sortedInputs = Array.from(fileInputs).sort((a, b) => {
    const aLabel = (getLabel(a) + ' ' + (a.name || '') + ' ' + (a.id || '') + ' ' + (a.parentElement?.textContent || '')).toLowerCase();
    const bLabel = (getLabel(b) + ' ' + (b.name || '') + ' ' + (b.id || '') + ' ' + (b.parentElement?.textContent || '')).toLowerCase();
    const aIsResume = aLabel.includes('resume') || aLabel.includes('cv ') || aLabel.includes('cv*') || aLabel.match(/\bcv\b/);
    const bIsResume = bLabel.includes('resume') || bLabel.includes('cv ') || bLabel.includes('cv*') || bLabel.match(/\bcv\b/);
    const aIsCover = aLabel.includes('cover') || aLabel.includes('letter');
    const bIsCover = bLabel.includes('cover') || bLabel.includes('letter');
    // Resume inputs first, cover letter inputs last
    if (aIsResume && !bIsResume) return -1;
    if (!aIsResume && bIsResume) return 1;
    if (aIsCover && !bIsCover) return 1;
    if (!aIsCover && bIsCover) return -1;
    return 0;
  });
  
  let resumeUploaded = false;
  
  for (const input of sortedInputs) {
    // Check if this looks like a resume upload vs cover letter
    const label = getLabel(input).toLowerCase();
    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const accept = (input.accept || '').toLowerCase();
    const parentText = (input.parentElement?.textContent || '').toLowerCase();
    const allText = label + ' ' + name + ' ' + id + ' ' + parentText;
    
    console.log('[AutoApplyBot] File input - label:', label, 'name:', name, 'id:', id);
    
    // Skip cover letter inputs — only upload to resume/cv inputs
    const isCoverLetter = allText.includes('cover') || allText.includes('letter');
    if (isCoverLetter) {
      console.log('[AutoApplyBot] Skipping cover letter file input');
      continue;
    }
    
    const isResume = allText.includes('resume') || allText.includes('cv') ||
                     accept.includes('pdf') || accept.includes('doc');
    
    // If we already uploaded to a resume input, skip remaining inputs
    if (resumeUploaded) {
      console.log('[AutoApplyBot] Resume already uploaded, skipping additional file input');
      continue;
    }
    
    // Check if already has a file
    if (input.files && input.files.length > 0) {
      log('Resume already uploaded');
      continue;
    }
    
    // Get resume from storage
    if (!settings || !settings.resumeFile) {
      log('No resume in settings to upload');
      // Try to get from chrome storage directly
      const stored = await chrome.storage.local.get(['resumeFile', 'resumeFileName', 'resumeFileType']);
      if (stored.resumeFile) {
        settings = { ...settings, ...stored };
      } else {
        continue;
      }
    }
    
    try {
      const base64Data = settings.resumeFile;
      const fileName = settings.resumeFileName || 'resume.pdf';
      const fileType = settings.resumeFileType || 'application/pdf';
      
      console.log('[AutoApplyBot] Uploading resume:', fileName);
      
      // Remove data URL prefix if present
      const rawBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
      const binaryString = atob(rawBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const file = new File([bytes], fileName, { type: fileType });
      
      // Use DataTransfer API
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      
      log(`Resume uploaded to external ATS: ${fileName}`);
      
      // Wait for any upload processing
      await wait(1000);
      resumeUploaded = true;
      continue; // Continue to check if there are more inputs but skip them
    } catch (e) {
      log(`Resume upload error: ${e.message}`);
      console.error('[AutoApplyBot] Resume upload error:', e);
    }
  }
  
  return resumeUploaded;
}

/**
 * Handle multiple choice / radio button questions on external ATS.
 * Uses smart answer logic with AI fallback.
 */
async function handleExternalRadioButtons(settings, profile) {
  console.log('[AutoApplyBot] handleExternalRadioButtons() starting...');
  
  const radioGroups = {};
  
  // Standard HTML radio buttons
  const radios = document.querySelectorAll('input[type="radio"]');
  console.log('[AutoApplyBot] Found', radios.length, 'standard radio buttons');
  
  radios.forEach(radio => {
    if (radio.offsetParent === null) return;
    const name = radio.name;
    if (!radioGroups[name]) {
      radioGroups[name] = [];
    }
    radioGroups[name].push(radio);
  });
  
  // Rippling uses role="radio" for custom radio buttons
  const ripplingRadios = document.querySelectorAll('[role="radio"]');
  console.log('[AutoApplyBot] Found', ripplingRadios.length, 'Rippling role="radio" elements');
  
  // Group Rippling radios by their parent container
  const ripplingGroups = {};
  ripplingRadios.forEach(radio => {
    if (radio.offsetParent === null) return;
    // Find the parent group (usually a fieldset or div with role="radiogroup")
    const group = radio.closest('[role="radiogroup"]') || radio.closest('fieldset') || radio.parentElement;
    const groupId = group ? (group.id || group.getAttribute('aria-labelledby') || 'rippling-group-' + Object.keys(ripplingGroups).length) : 'default';
    if (!ripplingGroups[groupId]) {
      ripplingGroups[groupId] = { radios: [], group };
    }
    ripplingGroups[groupId].radios.push(radio);
  });
  
  let handled = 0;
  
  // Handle standard radio groups
  for (const [name, radios] of Object.entries(radioGroups)) {
    // Skip if already answered
    if (radios.some(r => r.checked)) {
      console.log('[AutoApplyBot] Radio group already answered:', name);
      continue;
    }
    
    // Get the question text from multiple sources
    const fieldset = radios[0].closest('fieldset');
    const legend = fieldset ? fieldset.querySelector('legend') : null;
    const formGroup = radios[0].closest('[class*="form"], [class*="field"], [class*="question"], [class*="group"]');
    const nearbyLabel = formGroup ? formGroup.querySelector('label, .label, h3, h4, p, span[class*="label"]') : null;
    
    let questionText = '';
    if (legend) questionText = legend.textContent;
    else if (nearbyLabel) questionText = nearbyLabel.textContent;
    else questionText = getLabel(radios[0]);
    
    questionText = questionText.trim();
    console.log('[AutoApplyBot] Radio question:', questionText.substring(0, 60));
    
    // Get available options
    const options = radios.map(r => {
      const label = getLabel(r);
      return label || r.value;
    }).filter(Boolean);
    
    console.log('[AutoApplyBot] Radio options:', options);
    
    // Get smart answer (rules + AI fallback)
    const answer = await getSmartAnswer(questionText, options, settings, profile);
    console.log('[AutoApplyBot] Smart answer:', answer);
    
    if (!answer) {
      // Click first option as last resort
      radios[0].click();
      radios[0].dispatchEvent(new Event('change', { bubbles: true }));
      handled++;
      continue;
    }
    
    // Find and click the matching radio
    const answerLower = answer.toLowerCase().trim();
    let clicked = false;
    
    for (const radio of radios) {
      const radioLabel = getLabel(radio).toLowerCase().trim();
      const radioValue = (radio.value || '').toLowerCase().trim();
      
      // Check for match
      if (radioLabel === answerLower || radioValue === answerLower ||
          radioLabel.includes(answerLower) || answerLower.includes(radioLabel)) {
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Radio answered: ${questionText.substring(0, 40)} = ${answer}`);
        console.log('[AutoApplyBot] Clicked radio:', radioLabel);
        handled++;
        clicked = true;
        break;
      }
      
      // Yes/No matching
      const yesPattern = /^(yes|oui|sí|si|ja|y|true)$/i;
      const noPattern = /^(no|non|nein|n|false)$/i;
      
      if ((yesPattern.test(answerLower) && yesPattern.test(radioLabel)) ||
          (noPattern.test(answerLower) && noPattern.test(radioLabel))) {
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Radio answered: ${questionText.substring(0, 40)} = ${answer}`);
        handled++;
        clicked = true;
        break;
      }
    }
    
    // If no match, click first option as fallback
    if (!clicked && radios.length > 0) {
      radios[0].click();
      radios[0].dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[AutoApplyBot] Clicked first radio option as fallback');
      handled++;
    }
  }
  
  // Handle Rippling role="radio" groups
  for (const [groupId, groupData] of Object.entries(ripplingGroups)) {
    const { radios, group } = groupData;
    
    // Skip if already answered (check aria-checked)
    if (radios.some(r => r.getAttribute('aria-checked') === 'true')) {
      console.log('[AutoApplyBot] Rippling radio group already answered:', groupId);
      continue;
    }
    
    // Get the question text
    let questionText = '';
    if (group) {
      const labelledBy = group.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) questionText = labelEl.textContent;
      }
      if (!questionText) {
        const legend = group.querySelector('legend');
        if (legend) questionText = legend.textContent;
      }
      if (!questionText) {
        const nearbyLabel = group.previousElementSibling;
        if (nearbyLabel && (nearbyLabel.tagName === 'LABEL' || nearbyLabel.tagName === 'P' || nearbyLabel.tagName === 'SPAN')) {
          questionText = nearbyLabel.textContent;
        }
      }
    }
    
    questionText = questionText.trim();
    console.log('[AutoApplyBot] Rippling radio question:', questionText.substring(0, 60));
    
    // Get available options from the radio labels
    const options = radios.map(r => {
      // Rippling radios have the label text inside them
      return r.textContent.trim() || r.getAttribute('aria-label') || '';
    }).filter(Boolean);
    
    console.log('[AutoApplyBot] Rippling radio options:', options);
    
    // Get smart answer
    const answer = await getSmartAnswer(questionText, options, settings, profile);
    console.log('[AutoApplyBot] Smart answer for Rippling radio:', answer);
    
    if (!answer) {
      // Click first option as fallback
      radios[0].click();
      handled++;
      continue;
    }
    
    // Find and click the matching radio
    const answerLower = answer.toLowerCase().trim();
    let clicked = false;
    
    for (const radio of radios) {
      const radioLabel = (radio.textContent || radio.getAttribute('aria-label') || '').toLowerCase().trim();
      
      // Check for match
      if (radioLabel === answerLower || radioLabel.includes(answerLower) || answerLower.includes(radioLabel)) {
        radio.click();
        log(`Rippling radio answered: ${questionText.substring(0, 40)} = ${answer}`);
        console.log('[AutoApplyBot] Clicked Rippling radio:', radioLabel);
        handled++;
        clicked = true;
        break;
      }
      
      // Yes/No matching
      const yesPattern = /^(yes|oui|sí|si|ja|y|true)$/i;
      const noPattern = /^(no|non|nein|n|false)$/i;
      
      if ((yesPattern.test(answerLower) && yesPattern.test(radioLabel)) ||
          (noPattern.test(answerLower) && noPattern.test(radioLabel))) {
        radio.click();
        log(`Rippling radio answered: ${questionText.substring(0, 40)} = ${answer}`);
        handled++;
        clicked = true;
        break;
      }
    }
    
    // If no match, click first option as fallback
    if (!clicked && radios.length > 0) {
      radios[0].click();
      console.log('[AutoApplyBot] Clicked first Rippling radio option as fallback');
      handled++;
    }
  }
  
  return handled;
}

/**
 * Handle select dropdowns on external ATS with AI support.
 * Handles both native <select> and custom dropdowns (Greenhouse, Lever, etc.)
 */
async function handleExternalSelects(profile, settings) {
  let handled = 0;
  
  console.log('[AutoApplyBot] handleExternalSelects() starting...');
  
  // ─── Handle native <select> elements ───
  const selects = document.querySelectorAll('select');
  console.log('[AutoApplyBot] Found', selects.length, 'native selects');
  
  for (const select of selects) {
    if (select.offsetParent === null) continue;
    if (select.selectedIndex > 0) {
      console.log('[AutoApplyBot] Select already has value:', select.options[select.selectedIndex]?.text);
      continue;
    }
    
    const label = getLabel(select);
    const options = Array.from(select.options).map(o => o.text.trim()).filter(Boolean);
    
    if (options.length <= 1) continue;
    
    console.log('[AutoApplyBot] Native select:', label.substring(0, 50), 'options:', options.slice(0, 5));
    
    // Get smart answer (rules + AI)
    const answer = await getSmartAnswer(label, options, settings, profile);
    console.log('[AutoApplyBot] Smart answer for select:', answer);
    
    if (answer) {
      const answerLower = answer.toLowerCase();
      const matchingOption = Array.from(select.options).find(o => {
        const optText = o.text.toLowerCase().trim();
        return optText === answerLower || optText.includes(answerLower) || answerLower.includes(optText);
      });
      
      if (matchingOption) {
        select.value = matchingOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Select filled: ${label.substring(0, 30)} = ${matchingOption.text.substring(0, 20)}`);
        handled++;
        continue;
      }
    }
    
    // Fallback: first non-placeholder option
    const validOption = Array.from(select.options).find(o => {
      const t = o.text.trim().toLowerCase();
      return t && !t.includes('select') && !t.includes('choose') && !t.includes('--') && o.value !== '';
    });
    
    if (validOption) {
      select.value = validOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Select filled (fallback): ${label.substring(0, 30)} = ${validOption.text.substring(0, 20)}`);
      handled++;
    }
  }
  
  // ─── Handle BambooHR fab-Select dropdowns ───
  const fabSelectToggles = document.querySelectorAll('.fab-SelectToggle');
  if (fabSelectToggles.length > 0) {
    console.log('[AutoApplyBot] Found', fabSelectToggles.length, 'BambooHR fab-Select dropdowns');
    
    for (const toggle of fabSelectToggles) {
      if (toggle.offsetParent === null) continue;
      
      // Skip if already has a value (showing content, not placeholder)
      const content = toggle.querySelector('.fab-SelectToggle__content');
      if (content && content.textContent.trim()) continue;
      
      // Get label
      const ariaLabel = toggle.getAttribute('aria-label') || '';
      let label = ariaLabel.replace(/–Select–/g, '').replace(/\s+$/, '').trim();
      if (!label) {
        const wrapper = toggle.closest('[data-fabric-component*="SelectField"], [data-fabric-component*="InputWrapper"]');
        if (wrapper) {
          const labelEl = wrapper.querySelector('label');
          if (labelEl) label = labelEl.textContent.replace(/\s*\*\s*$/, '').trim();
        }
      }
      if (!label) continue;
      
      console.log('[AutoApplyBot] BambooHR dropdown:', label);
      
      // Get smart answer first (rules-based, no options since we can't read them yet)
      const answer = await getSmartAnswer(label, [], settings, profile);
      if (!answer) {
        console.log('[AutoApplyBot] No answer for BambooHR dropdown:', label, '- skipping');
        continue;
      }
      
      console.log('[AutoApplyBot] BambooHR using MAIN world for:', label, '→', answer);
      
      // Scroll into view first
      toggle.scrollIntoView({ block: 'center' });
      await wait(300);
      
      // Use MAIN world execution — content script isolated world clicks don't trigger
      // BambooHR's Fabric UI React event handlers
      try {
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'executeInMainWorld',
            label: label,
            answer: answer
          }, (resp) => {
            resolve(resp);
          });
        });
        
        await wait(1000);
        
        if (resp && resp.success) {
          log(`BambooHR select: ${label} = ${resp.result?.selected || answer}`);
          handled++;
        } else {
          console.log('[AutoApplyBot] MAIN world result for', label + ':', resp?.result?.error || 'unknown error');
          
          // If menu opened but no match, try with options from the result
          if (resp?.result?.options && resp.result.options.length > 0) {
            console.log('[AutoApplyBot] Retrying with actual options:', resp.result.options.slice(0, 5));
            const betterAnswer = await getSmartAnswer(label, resp.result.options, settings, profile);
            if (betterAnswer && betterAnswer !== answer) {
              console.log('[AutoApplyBot] Got better answer:', betterAnswer, '- retrying MAIN world');
              const resp2 = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                  action: 'executeInMainWorld',
                  label: label,
                  answer: betterAnswer
                }, (resp) => {
                  resolve(resp);
                });
              });
              await wait(1000);
              if (resp2 && resp2.success) {
                log(`BambooHR select (retry): ${label} = ${resp2.result?.selected || betterAnswer}`);
                handled++;
              }
            }
          }
        }
      } catch (e) {
        console.log('[AutoApplyBot] MAIN world execution failed:', e.message);
      }
      
      // Clean up any stale state
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
    }
  }
  
  // ─── Handle Greenhouse React-Select dropdowns ───
  
  // ─── Handle Greenhouse React-Select dropdowns ───
  // Greenhouse uses React-Select which creates custom dropdown components
  // The structure is: container > control (clickable) > menu (appears on click)
  
  // Helper function to find any visible dropdown menu
  function findVisibleMenu() {
    const menuSelectors = [
      '[class*="select__menu"]',
      '[class*="Select__menu"]', 
      '[class*="menu-list"]',
      '[class*="MenuList"]',
      '[role="listbox"]',
      '[class*="dropdown-menu"]',
      '[class*="options"]',
      '[class*="css-"][class*="-menu"]'
    ];
    
    for (const selector of menuSelectors) {
      const menus = document.querySelectorAll(selector);
      for (const m of menus) {
        if (m.offsetParent !== null && m.children.length > 0) {
          console.log('[AutoApplyBot] Found menu with selector:', selector);
          return m;
        }
      }
    }
    return null;
  }
  
  // Strategy 0: Find ALL elements showing "Select..." text - these are dropdown triggers
  // This is the most direct approach for Greenhouse
  const allElements = document.querySelectorAll('*');
  const selectTriggers = [];
  const processedLabels = new Set(); // Track which labels we've already processed
  
  for (const el of allElements) {
    if (el.offsetParent === null) continue;
    if (el.children.length > 3) continue; // Skip containers with many children
    
    const text = el.textContent?.trim();
    if (text === 'Select...' || text === 'Select' || text === 'Select...Select...') {
      // Find the actual clickable control - look for React-Select control pattern
      let clickable = el.closest('[class*="control"], [class*="-control"]');
      
      // If not found, try other patterns
      if (!clickable) {
        clickable = el.closest('[class*="trigger"], [role="combobox"], [role="button"], [class*="select__"]');
      }
      
      // If still not found, use the element itself if it's a div/span
      if (!clickable && (el.tagName === 'DIV' || el.tagName === 'SPAN')) {
        clickable = el;
      }
      
      if (clickable && !selectTriggers.includes(clickable)) {
        selectTriggers.push(clickable);
      }
    }
  }
  
  console.log('[AutoApplyBot] Found', selectTriggers.length, 'Select... triggers');
  
  for (const trigger of selectTriggers) {
    if (trigger.dataset.autoApplyProcessed) continue;
    trigger.dataset.autoApplyProcessed = 'true';
    
    // Find the label by looking at parent/sibling elements
    let label = '';
    let searchEl = trigger.parentElement;
    for (let i = 0; i < 8 && searchEl; i++) {
      // Look for label in this container
      const labelEl = searchEl.querySelector('label, legend, [class*="label"]:not([class*="select"]):not([class*="value"]):not([class*="placeholder"])');
      if (labelEl) {
        const labelText = labelEl.textContent.trim().replace(/\*$/, '').trim();
        if (labelText && labelText !== 'Select...' && labelText !== 'Select' && labelText.length > 2) {
          label = labelText;
          break;
        }
      }
      // Also check for preceding sibling with label-like content
      const prevSibling = searchEl.previousElementSibling;
      if (prevSibling) {
        const sibText = prevSibling.textContent.trim().replace(/\*$/, '').trim();
        if (sibText && sibText !== 'Select...' && sibText.length > 2 && sibText.length < 100) {
          label = sibText;
          break;
        }
      }
      searchEl = searchEl.parentElement;
    }
    
    if (!label) {
      console.log('[AutoApplyBot] No label found for Select... trigger, skipping');
      continue;
    }
    
    // Skip if we already processed this label (deduplication)
    if (processedLabels.has(label)) {
      console.log('[AutoApplyBot] Already processed label:', label, '- skipping duplicate');
      continue;
    }
    processedLabels.add(label);
    
    console.log('[AutoApplyBot] Select... trigger found for:', label);
    
    // Try multiple methods to open the dropdown
    // Method 1: Direct click
    trigger.click();
    await wait(500);
    
    // Check if menu appeared
    let menu = findVisibleMenu();
    
    // Method 2: If no menu, try focusing and clicking
    if (!menu) {
      trigger.focus();
      await wait(200);
      trigger.click();
      await wait(500);
      menu = findVisibleMenu();
    }
    
    // Method 3: Try mousedown/mouseup events
    if (!menu) {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await wait(100);
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await wait(500);
      menu = findVisibleMenu();
    }
    
    // Method 4: Try clicking the input inside if there is one
    if (!menu) {
      const innerInput = trigger.querySelector('input');
      if (innerInput) {
        innerInput.focus();
        innerInput.click();
        await wait(500);
        menu = findVisibleMenu();
      }
    }
    
    if (!menu) {
      console.log('[AutoApplyBot] No menu appeared for:', label, '- trying more click methods');
      
      // Method 5: Try clicking different parts of the control
      const container = trigger.closest('[class*="container"], [class*="select"]');
      if (container) {
        // Click the container itself
        container.click();
        await wait(500);
        menu = findVisibleMenu();
        
        if (!menu) {
          // Try clicking any clickable-looking element inside
          const clickables = container.querySelectorAll('[class*="control"], [class*="indicator"], [class*="dropdown"]');
          for (const el of clickables) {
            el.click();
            await wait(400);
            menu = findVisibleMenu();
            if (menu) break;
          }
        }
      }
    }
    
    if (!menu) {
      // Method 6: Try keyboard - ArrowDown to open
      trigger.focus();
      await wait(100);
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
      await wait(500);
      menu = findVisibleMenu();
    }
    
    if (!menu) {
      // Method 7: Try Space key to open
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', keyCode: 32, bubbles: true }));
      await wait(500);
      menu = findVisibleMenu();
    }
    
    if (!menu) {
      console.log('[AutoApplyBot] Could not open menu for:', label, '- skipping');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
    
    // Get options from the menu
    const optionEls = menu.querySelectorAll(
      '[class*="option"], [role="option"], li, [class*="Option"]'
    );
    
    const options = Array.from(optionEls)
      .map(o => o.textContent.trim())
      .filter(t => t && t.length > 0 && t.length < 200 && t.toLowerCase() !== 'select...');
    
    console.log('[AutoApplyBot] Options for "' + label + '":', options);
    
    if (options.length === 0) {
      // Rippling-specific: Try to find options with different selectors
      console.log('[AutoApplyBot] No options found, trying Rippling-specific selectors...');
      
      // Wait a bit more for options to render
      await wait(500);
      
      // Try to find options in the menu with more selectors
      const ripplingOptions = menu.querySelectorAll(
        '[data-testid*="option"], [class*="option"], [role="option"], ' +
        'div[tabindex], li, [class*="menu-item"], [class*="MenuItem"]'
      );
      
      console.log('[AutoApplyBot] Rippling options found:', ripplingOptions.length);
      
      // Also try to find options by looking at all children of the menu
      if (ripplingOptions.length === 0) {
        const allChildren = menu.querySelectorAll('*');
        console.log('[AutoApplyBot] Menu has', allChildren.length, 'total children');
        
        // Log the menu HTML for debugging
        console.log('[AutoApplyBot] Menu HTML preview:', menu.innerHTML.substring(0, 500));
      }
      
      const ripplingOptionTexts = Array.from(ripplingOptions)
        .map(o => o.textContent.trim())
        .filter(t => t && t.length > 0 && t.length < 200 && t.toLowerCase() !== 'select...');
      
      if (ripplingOptionTexts.length > 0) {
        console.log('[AutoApplyBot] Found Rippling options:', ripplingOptionTexts);
        options.push(...ripplingOptionTexts);
      }
    }
    
    if (options.length === 0) {
      console.log('[AutoApplyBot] No options found in menu for:', label);
      
      // For work authorization and sponsorship questions, try to answer directly
      // by typing in the input and pressing Enter
      const labelLower = label.toLowerCase();
      if (labelLower.includes('authorized') || labelLower.includes('sponsorship')) {
        console.log('[AutoApplyBot] Trying direct input for:', label);
        
        // Find the input inside the trigger
        const input = trigger.querySelector('input') || trigger.closest('[class*="select"]')?.querySelector('input');
        if (input) {
          const answer = labelLower.includes('authorized') ? 'Yes' : 'No';
          input.focus();
          await wait(100);
          input.value = answer;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(300);
          
          // Press Enter to select
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          await wait(300);
          
          // Check if it worked
          const newMenu = findVisibleMenu();
          if (!newMenu) {
            console.log('[AutoApplyBot] Direct input worked for:', label);
            handled++;
            continue;
          }
        }
      }
      
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
    
    // Get smart answer
    const answer = await getSmartAnswer(label, options, settings, profile);
    console.log('[AutoApplyBot] Answer for "' + label + '":', answer);
    
    // Find and click matching option
    let clicked = false;
    if (answer) {
      const answerLower = answer.toLowerCase();
      for (const optEl of optionEls) {
        const optText = optEl.textContent.trim();
        const optTextLower = optText.toLowerCase();
        
        // Skip if this is the "Select..." placeholder
        if (optTextLower === 'select...' || optTextLower === 'select') continue;
        
        if (optTextLower === answerLower || 
            optTextLower.includes(answerLower) || 
            answerLower.includes(optTextLower)) {
          optEl.click();
          log(`Dropdown filled: ${label} = ${optText.substring(0, 40)}`);
          handled++;
          clicked = true;
          await wait(400);
          break;
        }
      }
    }
    
    // Check if this is a personal info field - NEVER use fallback for these
    const labelLower = label.toLowerCase();
    const isPersonalInfoField = /school|university|college|degree|major|discipline|graduation|website|portfolio|linkedin|start.*year|end.*year/i.test(labelLower);
    
    // Fallback: click first valid option - BUT NOT for personal info fields
    if (!clicked && optionEls.length > 0 && !isPersonalInfoField) {
      // Only use fallback for EEO/demographic questions where "decline" is acceptable
      const isEEOField = /gender|race|ethnicity|veteran|disability|hispanic|latino/i.test(labelLower);
      
      if (isEEOField) {
        // For EEO, try to find "decline" or "prefer not to answer" option
        for (const optEl of optionEls) {
          const optText = optEl.textContent.trim().toLowerCase();
          if (optText.includes('decline') || optText.includes('not want to answer') || optText.includes('prefer not')) {
            optEl.click();
            log(`Dropdown filled (decline): ${label}`);
            handled++;
            clicked = true;
            await wait(400);
            break;
          }
        }
      }
    }
    
    // If still not clicked and it's a personal info field, log that user needs to fill manually
    if (!clicked && isPersonalInfoField) {
      console.log('[AutoApplyBot] SKIPPED - Personal info field needs manual input:', label);
      log(`⚠️ MANUAL INPUT NEEDED: ${label}`);
    }
    
    // Close menu if still open
    if (!clicked) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
    }
  }
  
  // Strategy 1: Find all React-Select containers by class patterns
  const reactSelectContainers = document.querySelectorAll(
    '[class*="select__container"], [class*="Select__container"], ' +
    '[class*="select-container"], [class*="SelectContainer"], ' +
    '[class*="css-"][class*="-container"]'
  );
  
  console.log('[AutoApplyBot] Found', reactSelectContainers.length, 'React-Select containers');
  
  const processedReactSelectLabels = new Set();
  
  for (const container of reactSelectContainers) {
    if (container.offsetParent === null) continue;
    
    // Find the control element (the clickable part)
    const control = container.querySelector(
      '[class*="select__control"], [class*="Select__control"], ' +
      '[class*="css-"][class*="-control"]'
    );
    
    if (!control || control.offsetParent === null) continue;
    
    // Check if already has a value (single-value element with text)
    const singleValue = control.querySelector('[class*="single-value"], [class*="singleValue"]');
    if (singleValue && singleValue.textContent.trim() && 
        !singleValue.textContent.toLowerCase().includes('select')) {
      console.log('[AutoApplyBot] React-Select already has value:', singleValue.textContent.trim());
      continue;
    }
    
    // Get label - look in parent elements
    let label = '';
    let parent = container.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const labelEl = parent.querySelector('label, legend, [class*="label"]:not([class*="select"])');
      if (labelEl && labelEl.textContent.trim()) {
        label = labelEl.textContent.trim().replace(/\*$/, '').trim();
        break;
      }
      parent = parent.parentElement;
    }
    
    if (!label) {
      // Try aria-label on the control
      label = control.getAttribute('aria-label') || container.getAttribute('aria-label') || '';
    }
    
    if (!label || label.length < 2) {
      console.log('[AutoApplyBot] No label found for React-Select, skipping');
      continue;
    }
    
    // Skip if already processed this label
    if (processedReactSelectLabels.has(label)) {
      continue;
    }
    processedReactSelectLabels.add(label);
    
    console.log('[AutoApplyBot] React-Select field:', label);
    
    // Click the control to open the dropdown
    control.click();
    await wait(600);
    
    // Look for the menu - it might be inside the container or in a portal
    let menu = container.querySelector('[class*="select__menu"], [class*="menu-list"]');
    
    // If not in container, check for portal (React-Select often uses portals)
    if (!menu) {
      menu = document.querySelector(
        '[class*="select__menu"]:not([style*="display: none"]), ' +
        '[class*="Select__menu"]:not([style*="display: none"]), ' +
        '[class*="css-"][class*="-menu"]:not([style*="display: none"])'
      );
    }
    
    // Also try role="listbox"
    if (!menu) {
      const listboxes = document.querySelectorAll('[role="listbox"]');
      for (const lb of listboxes) {
        if (lb.offsetParent !== null && lb.children.length > 0) {
          menu = lb;
          break;
        }
      }
    }
    
    // If menu didn't open, try more aggressive click-based strategies
    if (!menu) {
      console.log('[AutoApplyBot] No menu found for React-Select:', label, '- trying more click strategies');
      
      // Find input inside the control
      let input = control.querySelector('input');
      if (!input) {
        input = container.querySelector('input');
      }
      
      // Strategy 1: Focus input and press ArrowDown
      if (input && !menu) {
        input.focus();
        await wait(200);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
        await wait(500);
        menu = findVisibleMenu();
      }
      
      // Strategy 2: Click the dropdown indicator (arrow icon)
      if (!menu) {
        const indicator = container.querySelector('[class*="indicator"], [class*="dropdown"], [class*="arrow"]');
        if (indicator) {
          indicator.click();
          await wait(500);
          menu = findVisibleMenu();
        }
      }
      
      // Strategy 3: Click the value container
      if (!menu) {
        const valueContainer = container.querySelector('[class*="value-container"], [class*="ValueContainer"]');
        if (valueContainer) {
          valueContainer.click();
          await wait(500);
          menu = findVisibleMenu();
        }
      }
      
      // Strategy 4: Try Space key to open
      if (!menu && input) {
        input.focus();
        await wait(100);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', keyCode: 32, bubbles: true }));
        await wait(500);
        menu = findVisibleMenu();
      }
      
      // Strategy 5: Try mousedown/mouseup on control
      if (!menu) {
        control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(100);
        control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await wait(500);
        menu = findVisibleMenu();
      }
      
      // Strategy 6: Click container with force
      if (!menu) {
        container.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await wait(500);
        menu = findVisibleMenu();
      }
      
      // If still no menu, skip this field - don't type
      if (!menu) {
        console.log('[AutoApplyBot] Could not open React-Select menu for:', label, '- skipping (no typing fallback)');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(200);
        continue;
      }
    }
    
    // Menu is now open - read options and use AI to pick the best one
    if (menu) {
      const labelLower = label.toLowerCase();
      let optionEls = menu.querySelectorAll('[class*="option"], [role="option"]');
      let options = Array.from(optionEls)
        .map(o => o.textContent.trim())
        .filter(t => t && t.length < 200 && !t.toLowerCase().includes('select'));
      
      console.log('[AutoApplyBot] React-Select options for', label + ':', options.slice(0, 10));
      
      // For searchable dropdowns with many options (School, Country, City), we need to type to filter
      // then click the filtered result
      // IMPORTANT: Only match exact field names, not questions that happen to contain these words
      const isSearchableField = (labelLower === 'school' || labelLower === 'university' || 
                                  labelLower === 'country' || labelLower === 'country code' ||
                                  labelLower === 'location' || labelLower === 'city' ||
                                  labelLower === 'phone country code' ||
                                  (labelLower.includes('country code') && labelLower.length < 30));
      
      // Get the value we want to search for
      let searchValue = '';
      if (labelLower === 'school' || labelLower === 'university') {
        searchValue = profile.school || settings.school || '';
        if (!searchValue) {
          console.log('[AutoApplyBot] ⚠️ School not set - skipping');
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(200);
          continue;
        }
      } else if (labelLower.includes('location') || labelLower === 'city') {
        // For city/location dropdown, use user's city
        searchValue = profile.city || settings.city || 'Ottawa';
        console.log('[AutoApplyBot] Location/City field - searching for:', searchValue);
      } else if (labelLower === 'country' || labelLower.includes('country code')) {
        // For phone country code dropdown, use user's country
        searchValue = profile.country || settings.country || 'Canada';
      }
      
      // If this is a searchable field and we have a search value, type to filter
      if (isSearchableField && searchValue) {
        console.log('[AutoApplyBot] Searchable dropdown - typing to filter:', searchValue);
        
        // Find the input inside the container
        let input = control.querySelector('input');
        if (!input) {
          input = container.querySelector('input');
        }
        
        if (input) {
          // Clear and type the search value
          input.focus();
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(100);
          
          // Type the search value
          for (const char of searchValue) {
            input.value += char;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(30);
          }
          await wait(600);
          
          // Re-read the filtered options
          menu = findVisibleMenu();
          let searchClicked = false;
          
          if (menu) {
            optionEls = menu.querySelectorAll('[class*="option"], [role="option"]');
            options = Array.from(optionEls)
              .map(o => o.textContent.trim())
              .filter(t => t && t.length < 200 && !t.toLowerCase().includes('select') && !t.toLowerCase().includes('no options'));
            
            console.log('[AutoApplyBot] Filtered options for', label + ':', options.slice(0, 5));
            
            // For country dropdown, look for exact match with country name
            if ((labelLower === 'country' || labelLower.includes('country code')) && !searchClicked) {
              const countryLower = searchValue.toLowerCase();
              for (const optEl of optionEls) {
                const optText = optEl.textContent.trim();
                const optTextLower = optText.toLowerCase();
                // Match "Canada +1" when searching for "Canada"
                if (optTextLower.startsWith(countryLower) || optTextLower.includes(countryLower + ' +')) {
                  optEl.click();
                  log(`React-Select: ${label} = ${optText.substring(0, 30)}`);
                  handled++;
                  searchClicked = true;
                  await wait(300);
                  break;
                }
              }
            }
            
            // For location/city dropdown, look for match with city name
            if ((labelLower.includes('location') || labelLower.includes('city')) && !searchClicked) {
              const cityLower = searchValue.toLowerCase();
              for (const optEl of optionEls) {
                const optText = optEl.textContent.trim();
                const optTextLower = optText.toLowerCase();
                // Match city name - could be "Ottawa", "Ottawa, ON", "Ottawa, Ontario, Canada", etc.
                if (optTextLower.includes(cityLower) || cityLower.includes(optTextLower.split(',')[0].trim())) {
                  optEl.click();
                  log(`React-Select: ${label} = ${optText.substring(0, 30)}`);
                  handled++;
                  searchClicked = true;
                  await wait(300);
                  break;
                }
              }
              // If no match found, click first option if available
              if (!searchClicked && options.length > 0) {
                optionEls[0].click();
                log(`React-Select (first option): ${label} = ${options[0].substring(0, 30)}`);
                handled++;
                searchClicked = true;
                await wait(300);
              }
            }
            
            // For school, look for best match
            if ((labelLower === 'school' || labelLower === 'university') && !searchClicked) {
              const schoolLower = searchValue.toLowerCase();
              // Try exact match first
              for (const optEl of optionEls) {
                const optText = optEl.textContent.trim();
                const optTextLower = optText.toLowerCase();
                if (optTextLower === schoolLower) {
                  optEl.click();
                  log(`React-Select: ${label} = ${optText.substring(0, 30)}`);
                  handled++;
                  searchClicked = true;
                  await wait(300);
                  break;
                }
              }
              // Try partial match if no exact match
              if (!searchClicked) {
                for (const optEl of optionEls) {
                  const optText = optEl.textContent.trim();
                  const optTextLower = optText.toLowerCase();
                  if (optTextLower.includes(schoolLower) || schoolLower.includes(optTextLower)) {
                    optEl.click();
                    log(`React-Select: ${label} = ${optText.substring(0, 30)}`);
                    handled++;
                    searchClicked = true;
                    await wait(300);
                    break;
                  }
                }
              }
              // If still no match, click first option if it looks reasonable
              if (!searchClicked && options.length > 0 && options[0].toLowerCase().includes('ottawa')) {
                optionEls[0].click();
                log(`React-Select: ${label} = ${options[0].substring(0, 30)}`);
                handled++;
                searchClicked = true;
                await wait(300);
              }
            }
          }
          
          // Close menu if still open
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(200);
          
          if (searchClicked) {
            continue; // Move to next container
          }
        }
        
        // Close menu and continue to next field
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(200);
        continue;
      }
      
      // For non-searchable fields, use AI to pick from available options
      if (options.length > 0) {
        // Get the best answer - AI will pick from available options
        const answer = await getSmartAnswer(label, options, settings, profile);
        console.log('[AutoApplyBot] AI picked option for', label + ':', answer);
        
        if (answer) {
          // Re-read the menu fresh to avoid stale DOM references
          const freshMenu = findVisibleMenu();
          const freshOptionEls = freshMenu ? freshMenu.querySelectorAll('[class*="option"], [role="option"]') : optionEls;
          
          // Find and click the matching option
          const answerLower = answer.toLowerCase().trim();
          let clicked = false;
          for (const optEl of freshOptionEls) {
            const optText = optEl.textContent.trim().toLowerCase();
            if (optText === answerLower) {
              optEl.click();
              log(`React-Select: ${label} = ${optEl.textContent.trim().substring(0, 30)}`);
              handled++;
              clicked = true;
              await wait(300);
              break;
            }
          }
          // Partial match fallback
          if (!clicked) {
            for (const optEl of freshOptionEls) {
              const optText = optEl.textContent.trim().toLowerCase();
              if (optText.includes(answerLower) || answerLower.includes(optText)) {
                optEl.click();
                log(`React-Select: ${label} = ${optEl.textContent.trim().substring(0, 30)}`);
                handled++;
                clicked = true;
                await wait(300);
                break;
              }
            }
          }
          
          if (clicked) {
            continue;
          }
        }
      }
      
      // Close menu if we couldn't select anything
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
  }
  
  // ─── Strategy 2: Find fields by field wrapper pattern ───
  // Greenhouse wraps fields in divs with specific patterns
  // This handles BOTH dropdowns AND plain text inputs
  const fieldWrappers = document.querySelectorAll(
    '[class*="field-wrapper"], [class*="FieldWrapper"], ' +
    '[class*="form-field"], [class*="FormField"], ' +
    '[data-qa], [class*="application-question"]'
  );
  
  console.log('[AutoApplyBot] Found', fieldWrappers.length, 'field wrappers to check');
  
  for (const wrapper of fieldWrappers) {
    if (wrapper.offsetParent === null) continue;
    
    // Skip if we already handled this (has a React-Select we processed with a value)
    const existingSingleValue = wrapper.querySelector('[class*="single-value"]');
    if (existingSingleValue?.textContent?.trim() && 
        !existingSingleValue.textContent.toLowerCase().includes('select')) {
      continue;
    }
    
    // Get label first - we need it for both dropdown and text input handling
    const labelEl = wrapper.querySelector('label, legend, [class*="label"]:not([class*="select"])');
    let label = labelEl ? labelEl.textContent.trim().replace(/\*$/, '').trim() : '';
    
    if (!label || label.length < 2) continue;
    
    const labelLower = label.toLowerCase();
    
    // Look for any clickable dropdown trigger INSIDE this wrapper only
    const trigger = wrapper.querySelector(
      '[aria-haspopup="listbox"], [aria-haspopup="true"], ' +
      '[role="combobox"], [role="button"][aria-expanded], ' +
      '[class*="select__control"], [class*="dropdown-toggle"], ' +
      '[class*="select-trigger"], button[class*="select"]'
    );
    
    // ─── Case A: Plain text input (no dropdown trigger) ───
    if (!trigger || trigger.offsetParent === null) {
      // Check if there's a plain text input in this wrapper
      const textInput = wrapper.querySelector('input[type="text"], input:not([type]), textarea');
      
      if (textInput && textInput.offsetParent !== null && !textInput.dataset.autoApplyProcessed) {
        // Skip if already has value
        if (textInput.value && textInput.value.trim()) continue;
        
        // Skip if it's part of a React-Select (has select classes in parent)
        if (textInput.closest('[class*="select__"]')) continue;
        
        textInput.dataset.autoApplyProcessed = 'true';
        
        console.log('[AutoApplyBot] Field wrapper text input:', label);
        
        // Get answer for this field
        const answer = await getSmartAnswer(label, [], settings, profile);
        
        if (answer) {
          try {
            textInput.focus();
            await wait(100);
            
            // Use correct native setter based on element type
            let nativeSetter;
            if (textInput.tagName === 'TEXTAREA') {
              nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            } else {
              nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            }
            
            if (nativeSetter) {
              nativeSetter.call(textInput, answer);
            } else {
              textInput.value = answer;
            }
            textInput.dispatchEvent(new Event('input', { bubbles: true }));
            textInput.dispatchEvent(new Event('change', { bubbles: true }));
            textInput.dispatchEvent(new Event('blur', { bubbles: true }));
          } catch (e) {
            // Fallback
            try { textInput.value = answer; } catch (_) {}
          }
          
          log(`Field wrapper filled: ${label} = ${answer.substring(0, 30)}`);
          handled++;
          await wait(300);
        }
      }
      continue;
    }
    
    // ─── Case B: Dropdown trigger found ───
    
    // Check if already has value
    const hasValue = trigger.querySelector('[class*="single-value"], [class*="value"]');
    if (hasValue && hasValue.textContent.trim() && !hasValue.textContent.toLowerCase().includes('select')) {
      continue;
    }
    
    if (!label) {
      label = trigger.getAttribute('aria-label') || '';
    }
    
    // Skip if already processed
    if (trigger.dataset.autoApplyProcessed) continue;
    trigger.dataset.autoApplyProcessed = 'true';
    
    console.log('[AutoApplyBot] Field wrapper dropdown:', label);
    
    // Click to open
    trigger.click();
    await wait(600);
    
    // Find menu - IMPORTANT: Look inside the wrapper first, then check for portals
    // But make sure we're getting the RIGHT menu for THIS field
    let menu = wrapper.querySelector('[role="listbox"], [class*="menu"]');
    
    // If not in wrapper, look for a portal menu that appeared after our click
    // But be careful not to grab a menu from a different field
    if (!menu) {
      // Get all visible menus
      const allMenus = document.querySelectorAll(
        '[role="listbox"]:not([hidden]), ' +
        '[class*="select__menu"]:not([style*="display: none"]), ' +
        '[class*="dropdown-menu"]:not([hidden]), ' +
        '[class*="menu-list"]:not([hidden])'
      );
      
      // Find the menu that's closest to our trigger (likely the one we just opened)
      for (const m of allMenus) {
        if (m.offsetParent !== null) {
          // Check if this menu is related to our wrapper by checking position
          const triggerRect = trigger.getBoundingClientRect();
          const menuRect = m.getBoundingClientRect();
          
          // Menu should be near the trigger (within 300px vertically)
          if (Math.abs(menuRect.top - triggerRect.bottom) < 300 ||
              Math.abs(menuRect.bottom - triggerRect.top) < 300) {
            menu = m;
            break;
          }
        }
      }
    }
    
    if (!menu) {
      console.log('[AutoApplyBot] No menu for field wrapper:', label);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
    
    const optionEls = menu.querySelectorAll('[role="option"], [class*="option"], li');
    let options = Array.from(optionEls)
      .map(o => o.textContent.trim())
      .filter(t => t && t.length < 200 && !t.toLowerCase().includes('no options'));
    
    console.log('[AutoApplyBot] Field wrapper options:', options.slice(0, 5));
    
    // Validate that options make sense for this field
    // If we're looking for a city but got country codes, skip this
    if ((labelLower.includes('city') || labelLower.includes('location')) && 
        options.length > 0 && options[0].includes('+')) {
      console.log('[AutoApplyBot] Got country codes for city field - wrong menu, skipping');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
    
    if (options.length === 0) {
      // For searchable fields like city, try typing to get options
      if (labelLower.includes('city') || labelLower.includes('location')) {
        const cityValue = profile.city || settings.city || 'Ottawa';
        const input = wrapper.querySelector('input');
        if (input) {
          console.log('[AutoApplyBot] Typing city to search:', cityValue);
          input.focus();
          input.value = '';
          for (const char of cityValue) {
            input.value += char;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(30);
          }
          await wait(800);
          
          // Check for options again
          menu = wrapper.querySelector('[role="listbox"], [class*="menu"]') ||
                 document.querySelector('[class*="select__menu"]:not([style*="display: none"])');
          
          if (menu) {
            const newOptionEls = menu.querySelectorAll('[role="option"], [class*="option"], li');
            if (newOptionEls.length > 0) {
              // Click first matching option
              for (const optEl of newOptionEls) {
                const optText = optEl.textContent.trim().toLowerCase();
                if (optText.includes(cityValue.toLowerCase()) || cityValue.toLowerCase().includes(optText.split(',')[0])) {
                  optEl.click();
                  log(`Field dropdown (city): ${label} = ${optEl.textContent.trim().substring(0, 30)}`);
                  handled++;
                  await wait(400);
                  break;
                }
              }
            }
          }
        }
      }
      
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
    
    const answer = await getSmartAnswer(label, options, settings, profile);
    console.log('[AutoApplyBot] Answer for field wrapper:', answer);
    
    let clicked = false;
    if (answer) {
      const answerLower = answer.toLowerCase();
      for (const optEl of optionEls) {
        const optText = optEl.textContent.trim().toLowerCase();
        if (optText === answerLower || optText.includes(answerLower) || answerLower.includes(optText)) {
          optEl.click();
          log(`Field dropdown: ${label} = ${optEl.textContent.trim().substring(0, 30)}`);
          handled++;
          clicked = true;
          await wait(400);
          break;
        }
      }
    }
    
    if (!clicked && optionEls.length > 0) {
      optionEls[0].click();
      log(`Field dropdown (fallback): ${label}`);
      handled++;
      await wait(400);
    }
  }
  
  // ─── Strategy 3: Handle "Select..." placeholder inputs ───
  // Some Greenhouse fields show as text inputs with "Select..." placeholder
  const selectInputs = document.querySelectorAll('input[type="text"], input:not([type])');
  
  for (const input of selectInputs) {
    if (input.offsetParent === null) continue;
    
    const placeholder = (input.placeholder || '').toLowerCase();
    const value = (input.value || '').toLowerCase();
    
    // Only process if it looks like a select placeholder
    if (!placeholder.includes('select') && value !== 'select...') continue;
    if (value && !value.includes('select')) continue; // Already has real value
    
    // Skip if already processed
    if (input.dataset.autoApplyProcessed) continue;
    input.dataset.autoApplyProcessed = 'true';
    
    // Find label
    const container = input.closest('[class*="field"], fieldset, [class*="form-group"]');
    const labelEl = container ? container.querySelector('label, [class*="label"]') : null;
    const label = labelEl ? labelEl.textContent.trim().replace(/\*$/, '').trim() : '';
    
    if (!label) continue;
    
    console.log('[AutoApplyBot] Select placeholder input:', label);
    
    // Click to open
    input.click();
    input.focus();
    await wait(600);
    
    // Find menu
    const menu = document.querySelector(
      '[role="listbox"]:not([hidden]), ' +
      '[class*="select__menu"]:not([style*="display: none"]), ' +
      '[class*="menu"]:not([hidden])'
    );
    
    if (!menu) {
      console.log('[AutoApplyBot] No menu for select input:', label);
      continue;
    }
    
    const optionEls = menu.querySelectorAll('[role="option"], [class*="option"], li');
    const options = Array.from(optionEls).map(o => o.textContent.trim()).filter(Boolean);
    
    if (options.length === 0) continue;
    
    const answer = await getSmartAnswer(label, options, settings, profile);
    
    if (answer) {
      const answerLower = answer.toLowerCase();
      for (const optEl of optionEls) {
        const optText = optEl.textContent.toLowerCase();
        if (optText.includes(answerLower) || answerLower.includes(optText)) {
          optEl.click();
          log(`Select input: ${label} = ${optEl.textContent.trim().substring(0, 20)}`);
          handled++;
          await wait(400);
          break;
        }
      }
    }
  }
  
  console.log('[AutoApplyBot] handleExternalSelects() completed, handled:', handled);
  return handled;
}

/**
 * Handle unfilled text/textarea fields using AI.
 */
async function handleUnfilledTextFieldsWithAI(profile, settings) {
  let filled = 0;
  
  console.log('[AutoApplyBot] handleUnfilledTextFieldsWithAI() starting...');
  
  // Find all unfilled required text inputs and textareas
  const textFields = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea');
  
  console.log('[AutoApplyBot] Found', textFields.length, 'text fields to check');
  
  for (const field of textFields) {
    if (field.offsetParent === null) continue;
    if (field.value && field.value.trim()) {
      console.log('[AutoApplyBot] Field already filled:', getLabel(field).substring(0, 30));
      continue;
    }
    
    // Skip hidden, file, checkbox, radio, submit, button types
    const fieldType = (field.type || 'text').toLowerCase();
    if (['hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(fieldType)) continue;
    
    // Skip inputs that are part of React-Select components
    const isReactSelectInput = field.closest('[class*="select__"], [class*="Select__"], [class*="-container"]');
    if (isReactSelectInput) {
      const parentClasses = isReactSelectInput.className || '';
      if (parentClasses.includes('select__') || parentClasses.includes('Select__') || 
          (parentClasses.includes('css-') && parentClasses.includes('-container'))) {
        console.log('[AutoApplyBot] Skipping React-Select input for:', getLabel(field).substring(0, 30));
        continue;
      }
    }
    
    // Check if field is required or has validation error
    const isRequired = field.required || 
                       field.getAttribute('aria-required') === 'true' ||
                       field.closest('[class*="required"]') ||
                       field.closest('[class*="error"]') ||
                       field.closest('[class*="invalid"]');
    
    const label = getLabel(field);
    if (!label) {
      console.log('[AutoApplyBot] No label for text field, skipping');
      continue;
    }
    
    // Skip internal React component field names
    const labelLower = label.toLowerCase().trim();
    const skipLabels = [
      'select-search-input',
      'undefined',
      'input-undefined',
      'input-select-search-input',
      'input-externalplaceid',
      'externalplaceid',
      'please leave this field blank',
    ];
    if (skipLabels.includes(labelLower) || labelLower.startsWith('input-select-') || labelLower.includes('leave this field blank') || labelLower.includes('nickname')) {
      console.log('[AutoApplyBot] Skipping internal field:', label);
      continue;
    }
    
    // Skip fields with internal ID patterns (UUIDs, etc.) but NOT customQuestions
    // customQuestions are real questions that need answers
    const skipPatterns = [
      /^[a-f0-9]{8}-[a-f0-9]{4}-/i,  // UUID-like patterns
      /^[a-f0-9]{24,}$/i,  // MongoDB-like IDs (only if ENTIRE label is the ID)
      /^input-[a-f0-9]{8,}/i,  // Input with hash ID
    ];
    if (skipPatterns.some(pattern => pattern.test(label))) {
      console.log('[AutoApplyBot] Skipping internal ID field:', label);
      continue;
    }
    
    console.log('[AutoApplyBot] Unfilled text field:', label.substring(0, 50), 'required:', isRequired, 'type:', fieldType);
    
    // First try profile mapping
    const profileValue = getProfileValue(label, profile);
    if (profileValue) {
      fill(field, profileValue);
      setReactValue(field, profileValue);
      log(`Profile filled text: ${label.substring(0, 30)} = ${profileValue.substring(0, 20)}`);
      filled++;
      continue;
    }
    
    // Try to get answer from AI
    const answer = await getSmartAnswer(label, [], settings, profile);
    
    if (answer) {
      fill(field, answer);
      setReactValue(field, answer);
      log(`AI filled text: ${label.substring(0, 30)} = ${answer.substring(0, 20)}`);
      filled++;
    } else {
      console.log('[AutoApplyBot] No answer for field:', label.substring(0, 30));
    }
  }
  
  console.log('[AutoApplyBot] handleUnfilledTextFieldsWithAI() completed, filled:', filled);
  return filled;
}

/**
 * Handle Rippling-specific dropdown components.
 * Rippling uses custom select components that don't respond to standard click events.
 * This function specifically handles work authorization and sponsorship dropdowns.
 */
async function handleRipplingDropdowns(settings, profile) {
  let handled = 0;
  
  console.log('[AutoApplyBot] handleRipplingDropdowns() starting...');
  
  // Rippling dropdowns have a specific structure:
  // - The label is in a parent container
  // - The dropdown trigger shows "Select" text
  // - Clicking opens a listbox with options
  
  // Find all elements that show "Select" text - these are dropdown triggers
  const allElements = document.querySelectorAll('*');
  const dropdownTriggers = [];
  
  for (const el of allElements) {
    if (el.offsetParent === null) continue;
    if (el.children.length > 5) continue; // Skip containers with many children
    
    const text = el.textContent?.trim();
    if (text === 'Select' || text === 'Select...') {
      // Find the clickable parent
      let clickable = el.closest('[role="combobox"], [class*="select"], [class*="Select"], button, [tabindex]');
      if (clickable && !dropdownTriggers.includes(clickable)) {
        dropdownTriggers.push({ trigger: clickable, textEl: el });
      }
    }
  }
  
  console.log('[AutoApplyBot] Rippling: Found', dropdownTriggers.length, 'dropdown triggers with Select text');
  
  for (const { trigger, textEl } of dropdownTriggers) {
    if (trigger.dataset.ripplingProcessed) continue;
    trigger.dataset.ripplingProcessed = 'true';
    
    // Find the label by looking at parent containers
    let label = '';
    let searchEl = trigger.parentElement;
    for (let i = 0; i < 10 && searchEl; i++) {
      // Look for label text in this container
      const labelEl = searchEl.querySelector('label, legend, [class*="label"], [class*="Label"], h3, h4, p');
      if (labelEl) {
        const labelText = labelEl.textContent.trim().replace(/\*$/, '').replace(/Select$/, '').trim();
        if (labelText && labelText !== 'Select' && labelText.length > 5 && labelText.length < 100) {
          label = labelText;
          break;
        }
      }
      
      // Also check the container's own text (excluding child elements)
      const containerText = Array.from(searchEl.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ')
        .trim();
      if (containerText && containerText.length > 5 && containerText.length < 100 && !containerText.includes('Select')) {
        label = containerText;
        break;
      }
      
      searchEl = searchEl.parentElement;
    }
    
    if (!label) {
      console.log('[AutoApplyBot] Rippling: No label found for dropdown trigger');
      continue;
    }
    
    const labelLower = label.toLowerCase();
    console.log('[AutoApplyBot] Rippling dropdown found:', label.substring(0, 60));
    
    // Check if this is a work authorization or sponsorship question
    const isWorkAuth = labelLower.includes('authorized') || 
                       labelLower.includes('legally') ||
                       labelLower.includes('eligible to work') ||
                       labelLower.includes('right to work');
    const isSponsorship = labelLower.includes('sponsorship') || 
                          labelLower.includes('sponsor') ||
                          labelLower.includes('visa');
    
    // Determine the answer
    let desiredAnswer;
    if (isSponsorship) {
      desiredAnswer = settings.visaSponsorship || 'no';
      console.log('[AutoApplyBot] Rippling: Sponsorship question, answering:', desiredAnswer);
    } else if (isWorkAuth) {
      desiredAnswer = settings.legallyAuthorized || 'yes';
      console.log('[AutoApplyBot] Rippling: Work auth question, answering:', desiredAnswer);
    } else {
      // For other dropdowns, use AI
      console.log('[AutoApplyBot] Rippling: Non-auth dropdown, will use AI');
      continue; // Let handleExternalSelects handle it
    }
    
    // Try to open the dropdown
    console.log('[AutoApplyBot] Rippling: Attempting to open dropdown...');
    
    // Method 1: Click the trigger
    trigger.click();
    await wait(600);
    
    // Look for the menu
    let menu = document.querySelector('[role="listbox"]:not([hidden])');
    if (!menu || menu.offsetParent === null) {
      // Method 2: Focus and click
      trigger.focus();
      await wait(100);
      trigger.click();
      await wait(600);
      menu = document.querySelector('[role="listbox"]:not([hidden])');
    }
    
    if (!menu || menu.offsetParent === null) {
      // Method 3: Click the text element directly
      textEl.click();
      await wait(600);
      menu = document.querySelector('[role="listbox"]:not([hidden])');
    }
    
    if (!menu || menu.offsetParent === null) {
      // Method 4: Try keyboard
      trigger.focus();
      await wait(100);
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
      await wait(600);
      menu = document.querySelector('[role="listbox"]:not([hidden])');
    }
    
    if (!menu || menu.offsetParent === null) {
      // Method 5: Try Space key
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', keyCode: 32, bubbles: true }));
      await wait(600);
      menu = document.querySelector('[role="listbox"]:not([hidden])');
    }
    
    if (!menu || menu.offsetParent === null) {
      // Method 6: Try mousedown/mouseup
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await wait(100);
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await wait(600);
      menu = document.querySelector('[role="listbox"]:not([hidden])');
    }
    
    if (!menu || menu.offsetParent === null) {
      console.log('[AutoApplyBot] Rippling: Could not open dropdown menu for:', label.substring(0, 40));
      
      // Fallback: Try typing directly into any input in the container
      const container = trigger.closest('[class*="field"], [class*="Field"], [class*="question"], [class*="Question"]') || trigger.parentElement?.parentElement;
      const input = container?.querySelector('input:not([type="hidden"])');
      if (input) {
        console.log('[AutoApplyBot] Rippling: Trying direct input fallback');
        input.focus();
        await wait(100);
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, desiredAnswer);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(300);
        
        // Press Enter to confirm
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        await wait(500);
        
        // Check if a menu appeared after typing
        menu = document.querySelector('[role="listbox"]:not([hidden])');
        if (menu && menu.offsetParent !== null) {
          // Find and click the matching option
          const options = menu.querySelectorAll('[role="option"]');
          for (const opt of options) {
            const optText = opt.textContent.trim().toLowerCase();
            if (optText === desiredAnswer.toLowerCase() || optText.includes(desiredAnswer.toLowerCase())) {
              opt.click();
              console.log('[AutoApplyBot] Rippling: Selected option after typing:', optText);
              log(`Rippling dropdown: ${label.substring(0, 40)} = ${desiredAnswer}`);
              handled++;
              await wait(400);
              break;
            }
          }
        } else {
          // No menu, but input might have worked
          console.log('[AutoApplyBot] Rippling: Direct input may have worked for:', label.substring(0, 40));
          handled++;
        }
      }
      
      // Close any open menu
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
      continue;
    }
    
    // Menu is open - find and click the correct option
    console.log('[AutoApplyBot] Rippling: Menu opened, looking for options...');
    const options = menu.querySelectorAll('[role="option"]');
    console.log('[AutoApplyBot] Rippling: Found', options.length, 'options');
    
    let clicked = false;
    const desiredLower = desiredAnswer.toLowerCase();
    
    for (const opt of options) {
      const optText = opt.textContent.trim().toLowerCase();
      console.log('[AutoApplyBot] Rippling: Checking option:', optText);
      
      if (optText === desiredLower || optText.includes(desiredLower) || desiredLower.includes(optText)) {
        opt.click();
        console.log('[AutoApplyBot] Rippling: Clicked option:', optText);
        log(`Rippling dropdown: ${label.substring(0, 40)} = ${desiredAnswer}`);
        handled++;
        clicked = true;
        await wait(400);
        break;
      }
    }
    
    if (!clicked) {
      console.log('[AutoApplyBot] Rippling: Could not find matching option for:', desiredAnswer);
      // Close the menu
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
    }
  }
  
  console.log('[AutoApplyBot] handleRipplingDropdowns() completed, handled:', handled);
  return handled;
}

/**
 * Main function to auto-fill and submit external ATS application forms.
 */
(async function autoFillExternalATS() {
  const url = window.location.href;
  const atsType = detectATS(url);
  
  console.log('[AutoApplyBot] autoFillExternalATS() - ATS type:', atsType);
  
  // Skip confirmation/success pages - application already submitted
  if (url.includes('/confirmation') || url.includes('/success') || url.includes('/thank') || 
      url.includes('/applied') || url.includes('/complete')) {
    console.log('[AutoApplyBot] On confirmation/success page, skipping auto-fill');
    return;
  }
  
  // Only auto-fill on external ATS pages (not LinkedIn)
  if (atsType === 'linkedin' || atsType === 'generic') {
    console.log('[AutoApplyBot] Not an external ATS page, skipping');
    return;
  }
  
  log(`External ATS detected: ${atsType}`);
  
  // Rippling-specific: Check if we're on job description page vs application form
  if (atsType === 'rippling') {
    // Check for Apply now button (job description page)
    const applyNowBtn = document.querySelector('button[data-testid="Apply now"]') ||
                        document.querySelector('button:has(span.css-1d5eng1)') ||
                        Array.from(document.querySelectorAll('button')).find(b => 
                          b.textContent.trim() === 'Apply now' || 
                          b.querySelector('span')?.textContent.trim() === 'Apply now'
                        );
    
    // Check if form is already loaded
    let formLoaded = document.querySelector('input[data-testid="input-first_name"]') ||
                     document.querySelector('input[data-testid="input-email"]');
    
    if (!formLoaded && applyNowBtn) {
      console.log('[AutoApplyBot] Rippling: On job description page, clicking Apply now...');
      applyNowBtn.click();
      
      // Rippling is a SPA - wait for form to appear after clicking Apply now
      // Poll for form to load (up to 15 seconds)
      console.log('[AutoApplyBot] Rippling: Waiting for application form to load after click...');
      for (let i = 0; i < 30; i++) {
        await wait(500);
        formLoaded = document.querySelector('input[data-testid="input-first_name"]') ||
                     document.querySelector('input[data-testid="input-email"]');
        if (formLoaded) {
          console.log('[AutoApplyBot] Rippling: Form loaded after', (i + 1) * 500, 'ms');
          break;
        }
      }
      
      if (!formLoaded) {
        console.log('[AutoApplyBot] Rippling: Form did not load after 15s, may need manual intervention');
        log('Rippling form did not load - please click Apply now manually');
        return;
      }
    }
    
    // If we're on the form page, wait a bit more for all fields to render
    if (formLoaded) {
      console.log('[AutoApplyBot] Rippling: Form detected, waiting for all fields to render...');
      await wait(2000);
    } else {
      console.log('[AutoApplyBot] Rippling: No form and no Apply button found');
      return;
    }
  }
  
  // Check if we should auto-fill
  const stored = await chrome.storage.local.get(['isRunning', 'profile', 'settings', 'pendingJobs']);
  
  console.log('[AutoApplyBot] External ATS - isRunning:', stored.isRunning, 'hasPendingJobs:', (stored.pendingJobs || []).length > 0);
  
  // For external ATS pages, we can auto-fill even if not "running" from queue
  // This allows manual testing and one-off applications
  // Only skip if explicitly disabled
  const shouldAutoFill = stored.isRunning || 
                         (stored.pendingJobs && stored.pendingJobs.length > 0) ||
                         (stored.settings && stored.settings.autoFillExternal !== false);
  
  if (!shouldAutoFill) {
    log('Auto-fill disabled for external ATS');
    return;
  }
  
  // Check for Cloudflare Turnstile or other CAPTCHA before filling
  if (hasUnsolvedRecaptcha()) {
    log('⚠️ CAPTCHA/Turnstile detected - waiting for user to solve it...');
    // Wait up to 60 seconds for user to solve CAPTCHA
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      if (!hasUnsolvedRecaptcha()) {
        log('CAPTCHA/Turnstile solved! Continuing with form fill...');
        await wait(1000); // Extra wait after solving
        break;
      }
      if (i === 59) {
        log('CAPTCHA timeout - please solve manually and click Autofill again');
        return;
      }
    }
  }
  
  log(`Auto-filling ${atsType} application form...`);
  
  // Wait for page to fully load (shorter wait since we already waited for Rippling form)
  if (atsType !== 'rippling') {
    await wait(3000);
  } else {
    await wait(1000); // Shorter wait for Rippling since we already waited for form
  }
  
  const profile = stored.profile || {};
  const settings = stored.settings || {};
  const prefilledAnswers = settings.prefilledAnswers || {};
  
  // Merge education/settings fields into profile for field mapping
  // Settings fields take precedence over profile fields
  const mergedProfile = {
    ...profile,
    school: settings.school || profile.school || '',
    degree: settings.degree || profile.degree || '',
    discipline: settings.discipline || profile.discipline || '',
    yearsOfExperience: settings.yearsOfExperience || profile.yearsOfExperience || '',
    educationStartYear: settings.educationStartYear || profile.educationStartYear || '',
    graduationYear: settings.graduationYear || profile.graduationYear || '',
    linkedinUrl: profile.linkedinUrl || settings.linkedinUrl || '',
    website: profile.website || settings.website || '',
    city: profile.city || settings.city || 'Ottawa',
    country: profile.country || settings.country || 'Canada',
  };
  
  console.log('[AutoApplyBot] Merged profile - school:', mergedProfile.school, 'degree:', mergedProfile.degree, 'city:', mergedProfile.city);
  console.log('[AutoApplyBot] Merged profile - firstName:', mergedProfile.firstName, 'lastName:', mergedProfile.lastName, 'email:', mergedProfile.email);
  
  // Rippling-specific: Fill fields by data-testid directly
  if (atsType === 'rippling') {
    console.log('[AutoApplyBot] Rippling: Using direct data-testid field filling...');
    
    // Log all inputs with data-testid for debugging
    const allTestIdInputs = document.querySelectorAll('input[data-testid]');
    console.log('[AutoApplyBot] Rippling: Found', allTestIdInputs.length, 'inputs with data-testid');
    allTestIdInputs.forEach(inp => {
      console.log('[AutoApplyBot] Rippling input:', inp.getAttribute('data-testid'), 'value:', inp.value || '(empty)');
    });
    
    const ripplingFieldMap = {
      'input-first_name': mergedProfile.firstName,
      'input-last_name': mergedProfile.lastName,
      'input-email': mergedProfile.email,
      'input-phone_number': mergedProfile.phone,
      'input-current_company': mergedProfile.currentCompany || '',
    };
    
    let ripplingFilled = 0;
    for (const [testId, value] of Object.entries(ripplingFieldMap)) {
      if (!value) {
        console.log(`[AutoApplyBot] Rippling: Skipping ${testId} - no value in profile`);
        continue;
      }
      const input = document.querySelector(`input[data-testid="${testId}"]`);
      if (!input) {
        console.log(`[AutoApplyBot] Rippling: Field ${testId} not found on page`);
        continue;
      }
      if (input.value && input.value.trim()) {
        console.log(`[AutoApplyBot] Rippling: Field ${testId} already has value: ${input.value}`);
        continue;
      }
      console.log(`[AutoApplyBot] Rippling: Filling ${testId} with "${value.substring(0, 20)}..."`);
      input.focus();
      await wait(100);
      // Use React-compatible value setting
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      ripplingFilled++;
      await wait(200);
    }
    console.log(`[AutoApplyBot] Rippling: Direct field filling complete - ${ripplingFilled} fields filled`);
    
    // Handle Location field (typeahead)
    const locationInput = document.querySelector('input[aria-labelledby*="Location"], input[id*="location"]');
    if (locationInput && !locationInput.value && mergedProfile.city) {
      console.log('[AutoApplyBot] Rippling: Filling location with', mergedProfile.city);
      locationInput.focus();
      await wait(100);
      locationInput.value = `${mergedProfile.city}, ${mergedProfile.country || 'Canada'}`;
      locationInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      // Try to select first suggestion
      const suggestion = document.querySelector('[role="option"], [class*="suggestion"], [class*="option"]');
      if (suggestion) {
        suggestion.click();
        await wait(200);
      }
    }
    
    // Handle Rippling-specific dropdowns (work authorization, sponsorship, etc.)
    // These use custom components with role="combobox" or custom select elements
    console.log('[AutoApplyBot] Rippling: Handling custom dropdowns...');
    const ripplingDropdownsHandled = await handleRipplingDropdowns(settings, mergedProfile);
    console.log(`[AutoApplyBot] Rippling: Custom dropdowns handled: ${ripplingDropdownsHandled}`);
  }
  
  // Step 1: Fill text fields using autofill
  const result = await autofill(mergedProfile, settings, prefilledAnswers);
  log(`Text fields: ${result.filled} filled, ${result.skipped} skipped, ${result.failed} failed`);
  
  // Step 2: Handle resume upload
  await handleExternalResumeUpload(settings);
  
  // Step 3: Handle radio buttons / multiple choice (with AI support)
  const radiosHandled = await handleExternalRadioButtons(settings, mergedProfile);
  log(`Radio buttons handled: ${radiosHandled}`);
  
  // Step 4: Handle select dropdowns (with AI support)
  const selectsHandled = await handleExternalSelects(mergedProfile, settings);
  log(`Selects handled: ${selectsHandled}`);
  
  // Step 5: Handle any remaining unfilled text fields with AI
  const unfilledTextFields = await handleUnfilledTextFieldsWithAI(mergedProfile, settings);
  log(`AI filled text fields: ${unfilledTextFields}`);
  
  // Step 6: Handle checkboxes (consent, terms, etc.)
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  for (const cb of checkboxes) {
    if (cb.offsetParent === null) continue;
    const label = getLabel(cb).toLowerCase();
    if (CONSENT_PATTERNS.test(label) && !cb.checked) {
      cb.click();
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Checkbox checked: ${label.substring(0, 30)}`);
    }
  }
  
  // Wait a moment for any dynamic validation
  await wait(1000);
  
  // Check for unfilled required fields before submitting
  // NOTE: This is informational only - React-Select fields often show as "unfilled" 
  // because the hidden input doesn't get the value, but the UI shows the selection
  const unfilledRequired = [];
  const requiredFields = document.querySelectorAll('[required], [aria-required="true"]');
  for (const field of requiredFields) {
    if (field.offsetParent === null) continue;
    
    // Check if field has a value
    let hasValue = false;
    if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
      hasValue = field.value && field.value.trim();
    } else if (field.tagName === 'SELECT') {
      hasValue = field.value && field.selectedIndex > 0;
    }
    
    // For React-Select fields, check the visible UI instead of hidden input
    // React-Select uses a hidden input but displays value in a separate element
    if (!hasValue && field.tagName === 'INPUT') {
      // Look for React-Select container - could be parent or ancestor
      const reactSelectContainer = field.closest('[class*="select__"], [class*="Select"], [class*="-container"]');
      if (reactSelectContainer) {
        // Check for single-value element which shows the selected value
        const singleValue = reactSelectContainer.querySelector('[class*="single-value"], [class*="singleValue"]');
        if (singleValue) {
          const valueText = singleValue.textContent.trim().toLowerCase();
          // Has value if there's text and it's not a placeholder
          hasValue = valueText && 
                     !valueText.includes('select') && 
                     !valueText.includes('choose') &&
                     !valueText.includes('pick');
        }
        
        // Also check if there's a multi-value (for multi-select)
        const multiValue = reactSelectContainer.querySelector('[class*="multi-value"], [class*="multiValue"]');
        if (multiValue) {
          hasValue = true;
        }
      }
    }
    
    if (!hasValue) {
      const label = getLabel(field) || field.name || field.id || 'Unknown';
      unfilledRequired.push(label);
    }
  }
  
  if (unfilledRequired.length > 0) {
    // Only log as warning, don't block submission
    // React-Select validation can have false positives
    log(`ℹ️ Potentially unfilled fields (may be false positive): ${unfilledRequired.join(', ')}`);
  } else {
    log('✓ All required fields appear to be filled');
  }
  
  // Step 7: BambooHR pre-form check - if we're on the job description page,
  // click "Apply for This Job" to reveal the actual form, then re-run autofill
  if (atsType === 'bamboohr') {
    const applyBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const t = b.textContent.trim().toLowerCase();
      return t === 'apply for this job' || t === 'apply to this job';
    });
    const hasForm = document.querySelector('#job-application-form, form[id*="application"]');
    const formFields = document.querySelectorAll('input[name="firstName"], input[name="email"], input[id="firstName"]');
    
    if (applyBtn && !hasForm && formFields.length === 0) {
      log('BambooHR: On job description page, clicking "Apply for This Job" to reveal form...');
      applyBtn.click();
      
      // Wait for the form to appear (BambooHR renders it dynamically)
      log('BambooHR: Waiting for application form to load...');
      for (let i = 0; i < 15; i++) {
        await wait(1000);
        const formNow = document.querySelector('#job-application-form, form[id*="application"]');
        const fieldsNow = document.querySelectorAll('input[name="firstName"], input[id="firstName"]');
        if (formNow || fieldsNow.length > 0) {
          log('BambooHR: Application form detected! Re-running autofill...');
          // Re-run the entire autofill on the now-visible form
          await autoFillExternalATS();
          return;
        }
      }
      log('BambooHR: Form did not appear after 15s - page may need manual interaction');
      return;
    }
  }
  
  // Step 8: Try to submit the form
  log('Looking for submit button...');
  const submitted = await findAndClickSubmitButton();
  
  if (submitted) {
    log('Submit button clicked!');
    
    // Wait for submission to process
    await wait(3000);
    
    // Check if we need to move to next job
    const queueData = await chrome.storage.local.get(['pendingJobs', 'currentJobIndex', 'settings']);
    const settings = queueData.settings || {};
    
    // For external ATS, wait longer to allow manual review/completion
    // Default: 30 seconds for external ATS, can be configured in settings
    const externalAtsDelay = settings.externalAtsDelay || 30000; // 30 seconds default
    
    if (queueData.pendingJobs && queueData.pendingJobs.length > 0) {
      const currentIndex = queueData.currentJobIndex || 0;
      const currentJob = queueData.pendingJobs[currentIndex];
      
      // Record the application
      const appliedJob = {
        title: currentJob?.title || 'Unknown',
        company: currentJob?.company || 'Unknown',
        url: url,
        timestamp: new Date().toISOString(),
        status: 'applied',
        atsType: atsType,
        fieldsFilled: result.filled + radiosHandled + selectsHandled,
        fieldsSkipped: result.skipped,
        fieldsFailed: result.failed,
      };
      
      // Save to applied jobs
      const appliedData = await chrome.storage.local.get(['appliedJobs', 'appliedCount']);
      const appliedJobs = appliedData.appliedJobs || [];
      appliedJobs.push(appliedJob);
      const newCount = (appliedData.appliedCount || 0) + 1;
      await chrome.storage.local.set({ appliedJobs, appliedCount: newCount });
      
      // Report to backend
      try {
        const settingsData = await chrome.storage.local.get(['settings']);
        const backendUrl = (settingsData.settings && settingsData.settings.backendUrl) || 'http://localhost:8000';
        await fetch(`${backendUrl}/api/extension/applied`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company: appliedJob.company,
            role: appliedJob.title,
            url: appliedJob.url,
            atsType: appliedJob.atsType,
            status: 'applied',
            fieldsFilled: appliedJob.fieldsFilled,
            fieldsSkipped: appliedJob.fieldsSkipped,
            fieldsFailed: appliedJob.fieldsFailed,
          }),
        });
      } catch (e) {
        log('Backend report failed: ' + e.message);
      }
      
      // Wait before moving to next job - give user time to review/complete
      log(`Waiting ${externalAtsDelay/1000}s before moving to next job (allows manual review)...`);
      await wait(externalAtsDelay);
      
      // Move to next job
      log('Moving to next job in queue...');
      await moveToNextJob(queueData.pendingJobs, currentIndex);
    }
  } else {
    log('No submit button found - form may need manual review');
    
    // Even if no submit button, wait before moving to next job
    // This gives user time to manually complete the application
    const queueData = await chrome.storage.local.get(['pendingJobs', 'currentJobIndex', 'settings']);
    const settings = queueData.settings || {};
    const manualReviewDelay = settings.manualReviewDelay || 60000; // 60 seconds default for manual review
    
    if (queueData.pendingJobs && queueData.pendingJobs.length > 0) {
      log(`Waiting ${manualReviewDelay/1000}s for manual review before moving to next job...`);
      await wait(manualReviewDelay);
      
      const currentIndex = queueData.currentJobIndex || 0;
      await moveToNextJob(queueData.pendingJobs, currentIndex);
    }
  }
  
  // Notify popup
  try {
    chrome.runtime.sendMessage({ 
      type: 'fillResult', 
      filled: result.filled + radiosHandled + selectsHandled,
      skipped: result.skipped,
      failed: result.failed,
      unfilled: result.unfilled,
      atsType: atsType
    });
  } catch (e) {
    // Popup may not be open
  }
})();

} // End of double-injection guard