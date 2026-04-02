// Popup script for Auto Apply Bot UI management
let isRunning = false;

// --- Toast Notification System ---

/**
 * Show a toast notification.
 * @param {string} message - Text to display
 * @param {'success'|'error'|'warning'|'info'} type - Toast type
 * @param {number} duration - Auto-dismiss in ms (default 3000)
 */
function showToast(message, type, duration) {
  if (typeof type === 'undefined') type = 'info';
  if (typeof duration === 'undefined') duration = 3000;

  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.setAttribute('aria-label', 'Close notification');
  closeBtn.addEventListener('click', function() {
    dismissToast(toast);
  });
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  // Auto-dismiss
  if (duration > 0) {
    toast._dismissTimer = setTimeout(function() {
      dismissToast(toast);
    }, duration);
  }

  return toast;
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  if (toast._dismissTimer) {
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = null;
  }
  toast.classList.add('removing');
  setTimeout(function() {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 200);
}

// --- Field Validation ---

const validators = {
  email: function(value) {
    if (!value) return 'Email is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Invalid email address';
    return '';
  },
  phone: function(value) {
    if (!value) return '';
    if (!/^\d{7,15}$/.test(value.replace(/[\s\-().]/g, ''))) return 'Invalid phone number';
    return '';
  },
  firstName: function(value) {
    if (!value || !value.trim()) return 'First name is required';
    return '';
  },
  lastName: function(value) {
    if (!value || !value.trim()) return 'Last name is required';
    return '';
  },
  yearsOfExperience: function(value) {
    if (!value) return '';
    var n = Number(value);
    if (isNaN(n) || n < 0 || n > 50) return 'Must be 0–50';
    return '';
  }
};

/**
 * Validate a single field and show/hide inline error.
 * @param {HTMLElement} field
 * @returns {string} error message or ''
 */
function validateField(field) {
  var fieldName = field.getAttribute('data-field') || field.id;
  var validator = validators[fieldName];
  if (!validator) return '';

  var error = validator(field.value);
  var errorEl = field.parentNode.querySelector('.field-error');

  if (error) {
    field.classList.add('invalid');
    if (errorEl) {
      errorEl.textContent = error;
      errorEl.classList.add('visible');
    }
  } else {
    field.classList.remove('invalid');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.remove('visible');
    }
  }
  return error;
}

/**
 * Validate all profile fields. Returns true if valid.
 */
function validateAllFields() {
  var hasError = false;
  var fieldsToValidate = ['firstName', 'lastName', 'email', 'phone'];
  fieldsToValidate.forEach(function(name) {
    var field = document.querySelector('[data-field="' + name + '"]') || document.getElementById(name);
    if (field) {
      var error = validateField(field);
      if (error) hasError = true;
    }
  });
  return !hasError;
}

/**
 * Setup blur/focus validation listeners on profile fields.
 */
function setupValidation() {
  var fieldNames = ['firstName', 'lastName', 'email', 'phone'];
  fieldNames.forEach(function(name) {
    var field = document.querySelector('[data-field="' + name + '"]') || document.getElementById(name);
    if (!field) return;

    // Create error element if not present
    if (!field.parentNode.querySelector('.field-error')) {
      var errorEl = document.createElement('span');
      errorEl.className = 'field-error';
      field.parentNode.appendChild(errorEl);
    }

    field.addEventListener('blur', function() {
      validateField(field);
    });

    field.addEventListener('focus', function() {
      field.classList.remove('invalid');
      var errorEl = field.parentNode.querySelector('.field-error');
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.remove('visible');
      }
    });
  });
}

// --- Initialization ---

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  setupTabs();
  setupAutoSave();
  setupResumeUpload();
  setupQAEditor();
  setupValidation();
  await loadRunningState();
});

// --- Tab Switching ---

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active from all tab buttons and content panels
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));

      // Add active to clicked tab and its content panel
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      const panel = document.getElementById(`${tabName}-tab`);
      if (panel) {
        panel.classList.add('active');
      }
    });
  });
}

// --- Config Loading ---

async function loadConfig() {
  try {
    const data = await chrome.storage.local.get([
      'profile', 'settings', 'appliedJobs',
      'isRunning', 'appliedCount', 'skippedCount'
    ]);

    // Populate form fields from stored profile (to be wired in task 3.3)
    if (data.profile) {
      populateProfileFields(data.profile);
    }

    // Populate settings fields (to be wired in task 3.4)
    if (data.settings) {
      populateSettingsFields(data.settings);
    }

    // Render applied jobs list
    renderAppliedJobs(data.appliedJobs || []);
  } catch (err) {
    console.error('Error loading config:', err);
  }
}

function populateProfileFields(profile) {
  // Populate text/email/tel/url inputs using data-field attributes
  const fields = document.querySelectorAll('#personal-tab [data-field]');
  fields.forEach(field => {
    const key = field.getAttribute('data-field');
    if (profile[key] !== undefined && profile[key] !== null) {
      field.value = profile[key];
    }
  });

  // Restore resume filename if previously uploaded
  chrome.storage.local.get(['resumeFileName'], (data) => {
    if (data.resumeFileName) {
      const nameEl = document.getElementById('resumeFileName');
      const removeBtn = document.getElementById('removeResumeBtn');
      if (nameEl) {
        nameEl.textContent = data.resumeFileName;
        nameEl.classList.add('has-file');
      }
      if (removeBtn) removeBtn.style.display = 'inline-flex';
    }
  });
}

function populateSettingsFields(settings) {
  // Populate simple data-setting fields
  const fields = document.querySelectorAll('#settings-tab [data-setting]');
  fields.forEach(field => {
    const key = field.getAttribute('data-setting');
    if (settings[key] === undefined || settings[key] === null) return;

    if (field.type === 'checkbox') {
      field.checked = !!settings[key];
    } else {
      field.value = settings[key];
    }
  });

  // Populate prefilled Q&A pairs
  if (settings.prefilledAnswers && typeof settings.prefilledAnswers === 'object') {
    const qaList = document.getElementById('qa-list');
    if (qaList) {
      qaList.innerHTML = '';
      Object.entries(settings.prefilledAnswers).forEach(([question, answer]) => {
        addQAPair(question, answer);
      });
    }
  }
}

// --- Running State ---

async function loadRunningState() {
  try {
    const data = await chrome.storage.local.get(['isRunning', 'appliedCount', 'skippedCount']);
    isRunning = data.isRunning || false;
    updateDashboard();

    // Populate counters from storage
    const appliedEl = document.getElementById('applied-count');
    const skippedEl = document.getElementById('skipped-count');
    if (appliedEl) appliedEl.textContent = data.appliedCount || 0;
    if (skippedEl) skippedEl.textContent = data.skippedCount || 0;
  } catch (err) {
    console.error('Error loading running state:', err);
  }
}

function updateDashboard() {
  const autofillBtn = document.getElementById('autofill-btn');
  const autoapplyBtn = document.getElementById('autoapply-btn');
  const stopBtn = document.getElementById('stop-btn');
  const statusEl = document.getElementById('running-status');

  if (autofillBtn) autofillBtn.disabled = isRunning;
  if (autoapplyBtn) autoapplyBtn.disabled = isRunning;
  if (stopBtn) stopBtn.disabled = !isRunning;

  if (statusEl) {
    statusEl.textContent = isRunning ? 'Running' : 'Stopped';
    statusEl.className = isRunning ? 'status-value running' : 'status-value stopped';
  }
}

// --- Start / Stop Handlers ---

/**
 * Inject content script on-demand and send autofill or autoapply message.
 * Follows the AutoApplyMax pattern: inject only when user clicks Start.
 * @param {'autofill' | 'autoapply'} mode
 */
async function handleStart(mode) {
  try {
    // Validate fields before starting
    if (!validateAllFields()) {
      showToast('Please fix validation errors before starting', 'error');
      // Switch to Personal Info tab to show errors
      var personalTab = document.querySelector('[data-tab="personal"]');
      if (personalTab) personalTab.click();
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      console.error('No active tab found');
      return;
    }

    // Inject content script on-demand (may already be loaded via manifest)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      // Brief pause for script initialization
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (injectErr) {
      // Script may already be injected — safe to continue
      console.log('Content script may already be injected:', injectErr.message);
    }

    // Read profile and settings from storage to send along
    const data = await chrome.storage.local.get(['profile', 'settings']);
    const profile = data.profile || {};
    const settings = data.settings || {};
    const prefilledAnswers = (settings && settings.prefilledAnswers) || {};

    // Send the action message to the content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: mode,
      profile,
      settings,
      prefilledAnswers
    });

    if (response && response.success) {
      console.log(`${mode} started:`, response);
    }

    // Update running state
    isRunning = true;
    await chrome.storage.local.set({ isRunning: true, mode });
    updateDashboard();
  } catch (err) {
    console.error(`Error starting ${mode}:`, err);
  }
}

async function handleStop() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab && tab.url) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'stop' });
      } catch (e) {
        console.log('Content script not reachable, stopping via storage');
      }
    }

    // Always update local state
    isRunning = false;
    await chrome.storage.local.set({ isRunning: false });
    updateDashboard();
  } catch (err) {
    console.error('Error stopping bot:', err);
    // Fallback: force stop via storage
    isRunning = false;
    await chrome.storage.local.set({ isRunning: false });
    updateDashboard();
  }
}

// Bind dashboard action buttons
document.addEventListener('DOMContentLoaded', () => {
  const autofillBtn = document.getElementById('autofill-btn');
  const autoapplyBtn = document.getElementById('autoapply-btn');
  const stopBtn = document.getElementById('stop-btn');

  if (autofillBtn) autofillBtn.addEventListener('click', () => handleStart('autofill'));
  if (autoapplyBtn) autoapplyBtn.addEventListener('click', () => handleStart('autoapply'));
  if (stopBtn) stopBtn.addEventListener('click', handleStop);
});

// --- Resume Upload ---

function setupResumeUpload() {
  const fileInput = document.getElementById('resumeFile');
  const uploadBtn = document.getElementById('uploadResumeBtn');
  const fileNameEl = document.getElementById('resumeFileName');
  const removeBtn = document.getElementById('removeResumeBtn');

  if (!fileInput || !uploadBtn) return;

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      console.warn('Resume file too large (max 5MB)');
      return;
    }

    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (!allowedTypes.includes(file.type)) {
      console.warn('Invalid resume file type');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        await chrome.storage.local.set({
          resumeFile: event.target.result,
          resumeFileName: file.name,
          resumeFileType: file.type
        });
        if (fileNameEl) {
          fileNameEl.textContent = file.name;
          fileNameEl.classList.add('has-file');
        }
        if (removeBtn) removeBtn.style.display = 'inline-flex';
        console.log('Resume uploaded:', file.name);
      } catch (err) {
        console.error('Error saving resume:', err);
      }
    };
    reader.readAsDataURL(file);
  });

  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      try {
        await chrome.storage.local.remove(['resumeFile', 'resumeFileName', 'resumeFileType']);
        if (fileNameEl) {
          fileNameEl.textContent = 'No file chosen';
          fileNameEl.classList.remove('has-file');
        }
        removeBtn.style.display = 'none';
        fileInput.value = '';
        console.log('Resume removed');
      } catch (err) {
        console.error('Error removing resume:', err);
      }
    });
  }
}

// --- Auto-Save ---

let saveTimeout;

function setupAutoSave() {
  // Create the "Saved" indicator element
  const indicator = document.createElement('span');
  indicator.className = 'save-indicator';
  indicator.textContent = '✓ Saved';
  document.body.appendChild(indicator);

  // Debounced save helper for text inputs (500ms)
  function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveConfig(), 500);
  }

  // Attach debounced input listeners to text/email/tel/url/number inputs in both tabs
  const textInputs = document.querySelectorAll(
    '#personal-tab input[type="text"], #personal-tab input[type="email"], ' +
    '#personal-tab input[type="tel"], #personal-tab input[type="url"], ' +
    '#settings-tab input[type="text"], #settings-tab input[type="url"], ' +
    '#settings-tab input[type="number"]'
  );
  textInputs.forEach(input => {
    input.addEventListener('input', debouncedSave);
  });

  // Attach immediate change listeners to selects and checkboxes
  const selectsAndCheckboxes = document.querySelectorAll(
    '#personal-tab select, #settings-tab select, #settings-tab input[type="checkbox"]'
  );
  selectsAndCheckboxes.forEach(el => {
    el.addEventListener('change', () => saveConfig());
  });

  // Delegated listeners on #qa-list for dynamically added Q&A inputs
  const qaList = document.getElementById('qa-list');
  if (qaList) {
    qaList.addEventListener('input', debouncedSave);
    // Also save when a Q&A pair is removed (DOM mutation)
    const observer = new MutationObserver(debouncedSave);
    observer.observe(qaList, { childList: true });
  }
}

async function saveConfig() {
  try {
    // Collect profile fields
    const profile = {};
    const profileFields = document.querySelectorAll('#personal-tab [data-field]');
    profileFields.forEach(field => {
      profile[field.getAttribute('data-field')] = field.value;
    });

    // Collect settings fields
    const settings = {};
    const settingsFields = document.querySelectorAll('#settings-tab [data-setting]');
    settingsFields.forEach(field => {
      const key = field.getAttribute('data-setting');
      if (field.type === 'checkbox') {
        settings[key] = field.checked;
      } else {
        settings[key] = field.value;
      }
    });

    // Collect Q&A pairs
    settings.prefilledAnswers = getPrefilledAnswers();

    // Save to chrome.storage.local
    await chrome.storage.local.set({ profile, settings });

    // Show "Saved" indicator
    showSaveIndicator();
  } catch (err) {
    console.error('Error saving config:', err);
  }
}

function showSaveIndicator() {
  const indicator = document.querySelector('.save-indicator');
  if (!indicator) return;
  indicator.classList.add('visible');
  // Clear any existing hide timeout
  if (indicator._hideTimeout) clearTimeout(indicator._hideTimeout);
  indicator._hideTimeout = setTimeout(() => {
    indicator.classList.remove('visible');
  }, 1500);
}

// --- Q&A Editor ---

function addQAPair(question, answer) {
  const qaList = document.getElementById('qa-list');
  if (!qaList) return;

  const pair = document.createElement('div');
  pair.className = 'qa-pair';
  pair.innerHTML =
    '<input type="text" class="qa-question" placeholder="Question" value="' + escapeAttr(question || '') + '">' +
    '<input type="text" class="qa-answer" placeholder="Answer" value="' + escapeAttr(answer || '') + '">' +
    '<button type="button" class="btn-remove qa-remove-btn">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>' +
    '</button>';

  // Wire remove button
  pair.querySelector('.qa-remove-btn').addEventListener('click', () => {
    pair.remove();
  });

  qaList.appendChild(pair);
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getPrefilledAnswers() {
  const pairs = document.querySelectorAll('#qa-list .qa-pair');
  const answers = {};
  pairs.forEach(pair => {
    const q = pair.querySelector('.qa-question').value.trim();
    const a = pair.querySelector('.qa-answer').value.trim();
    if (q) answers[q] = a;
  });
  return answers;
}

function setupQAEditor() {
  const addBtn = document.getElementById('add-qa-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => addQAPair('', ''));
  }
}

// --- Applied Jobs ---

function renderAppliedJobs(jobs) {
  const listEl = document.getElementById('applied-jobs-list');
  const emptyEl = document.getElementById('applied-empty-state');
  const exportBtn = document.getElementById('export-csv-btn');
  const clearBtn = document.getElementById('clear-all-btn');

  if (!listEl || !emptyEl) return;

  listEl.innerHTML = '';

  if (!jobs || jobs.length === 0) {
    emptyEl.style.display = 'flex';
    listEl.style.display = 'none';
    if (exportBtn) exportBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    return;
  }

  emptyEl.style.display = 'none';
  listEl.style.display = 'flex';
  if (exportBtn) exportBtn.disabled = false;
  if (clearBtn) clearBtn.disabled = false;

  // Show newest first
  const sorted = [...jobs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  sorted.forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';

    const ts = job.timestamp ? formatTimestamp(job.timestamp) : '';
    const statusClass = 'status-' + (job.status || 'filled');

    card.innerHTML =
      '<div class="job-card-header">' +
        '<div>' +
          '<div class="job-card-title">' + escapeHtml(job.role || 'Unknown Role') + '</div>' +
          '<div class="job-card-company">' + escapeHtml(job.company || 'Unknown Company') + '</div>' +
        '</div>' +
        (job.url ? '<a href="' + escapeAttr(job.url) + '" target="_blank" rel="noopener" class="job-card-link">Open ↗</a>' : '') +
      '</div>' +
      '<div class="job-card-meta">' +
        '<span class="status-badge ' + statusClass + '">' + escapeHtml(job.status || 'filled') + '</span>' +
        '<span class="job-card-fields">' +
          '<span class="field-count filled" title="Filled">' + (job.fieldsFilled || 0) + ' filled</span>' +
          '<span class="field-count skipped" title="Skipped">' + (job.fieldsSkipped || 0) + ' skipped</span>' +
          '<span class="field-count failed" title="Failed">' + (job.fieldsFailed || 0) + ' failed</span>' +
        '</span>' +
        '<span class="job-card-timestamp">' + escapeHtml(ts) + '</span>' +
      '</div>';

    listEl.appendChild(card);
  });
}

function formatTimestamp(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + 'm ago';
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return diffHrs + 'h ago';
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return diffDays + 'd ago';
    return d.toLocaleDateString();
  } catch (e) {
    return isoStr;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function clearAllAppliedJobs() {
  try {
    await chrome.storage.local.set({ appliedJobs: [] });
    renderAppliedJobs([]);
  } catch (err) {
    console.error('Error clearing applied jobs:', err);
  }
}

/**
 * Clear ALL data - extension storage AND backend database.
 * This gives a fresh start with no old jobs.
 */
async function clearAllData() {
  if (!confirm('This will clear ALL data including:\n- Pending jobs queue\n- Applied jobs history\n- Backend database jobs\n\nAre you sure?')) {
    return;
  }
  
  try {
    // Clear extension storage
    await chrome.storage.local.remove([
      'pendingJobs', 
      'currentJobIndex', 
      'appliedJobs', 
      'appliedCount', 
      'skippedCount',
      'isRunning'
    ]);
    
    // Clear backend database
    const settings = await chrome.storage.local.get(['settings']);
    const backendUrl = (settings.settings && settings.settings.backendUrl) || 'http://localhost:8000';
    
    try {
      await fetch(`${backendUrl}/api/jobs/clear`, {
        method: 'DELETE',
      });
      console.log('[AutoApplyBot] Backend jobs cleared');
    } catch (e) {
      console.log('[AutoApplyBot] Backend clear failed (may not have endpoint):', e.message);
    }
    
    // Update UI
    renderAppliedJobs([]);
    alert('All data cleared! Refresh the page to see changes.');
    
  } catch (err) {
    console.error('Error clearing all data:', err);
    alert('Error clearing data: ' + err.message);
  }
}

function exportAppliedJobsCSV() {
  chrome.storage.local.get(['appliedJobs'], (data) => {
    const jobs = data.appliedJobs || [];
    if (jobs.length === 0) return;

    const headers = ['Role', 'Company', 'URL', 'Timestamp', 'Status', 'ATS Type', 'Fields Filled', 'Fields Skipped', 'Fields Failed'];
    const rows = jobs.map(j => [
      csvEscape(j.role || ''),
      csvEscape(j.company || ''),
      csvEscape(j.url || ''),
      csvEscape(j.timestamp || ''),
      csvEscape(j.status || ''),
      csvEscape(j.atsType || ''),
      j.fieldsFilled || 0,
      j.fieldsSkipped || 0,
      j.fieldsFailed || 0
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'applied_jobs_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

function csvEscape(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Wire Applied Jobs buttons
document.addEventListener('DOMContentLoaded', () => {
  const clearBtn = document.getElementById('clear-all-btn');
  const exportBtn = document.getElementById('export-csv-btn');

  if (clearBtn) clearBtn.addEventListener('click', clearAllData);
  if (exportBtn) exportBtn.addEventListener('click', exportAppliedJobsCSV);
});

// --- Fill Result Display ---

function displayFillResult(result) {
  var container = document.getElementById('fill-result');
  if (!container) return;

  container.style.display = 'block';

  var filledEl = document.getElementById('fill-filled');
  var skippedEl = document.getElementById('fill-skipped');
  var failedEl = document.getElementById('fill-failed');
  var unfilledEl = document.getElementById('fill-unfilled');

  if (filledEl) filledEl.textContent = result.filled || 0;
  if (skippedEl) skippedEl.textContent = result.skipped || 0;
  if (failedEl) failedEl.textContent = result.failed || 0;

  if (unfilledEl) {
    if (result.unfilled && result.unfilled.length > 0) {
      unfilledEl.textContent = 'Unfilled: ' + result.unfilled.map(function(f) {
        return f.label || f.type || 'unknown';
      }).join(', ');
    } else {
      unfilledEl.textContent = '';
    }
  }
}

// --- Message Listener (content script updates) ---

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request) => {
    if (request.type === 'updateCount') {
      const el = document.getElementById('applied-count');
      if (el) el.textContent = request.count;
    } else if (request.type === 'updateSkippedCount') {
      const el = document.getElementById('skipped-count');
      if (el) el.textContent = request.count;
    } else if (request.type === 'botStarted') {
      isRunning = true;
      updateDashboard();
    } else if (request.type === 'botStopped') {
      isRunning = false;
      updateDashboard();
    } else if (request.type === 'atsDetected') {
      const badge = document.getElementById('ats-badge');
      if (badge && request.atsType) {
        badge.textContent = request.atsType;
        badge.className = 'ats-badge ats-' + request.atsType;
      }
    } else if (request.type === 'fillResult') {
      displayFillResult(request);
    }
  });
}

// Poll storage every 2s as fallback (popup may reopen after close)
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  setInterval(async () => {
    try {
      const data = await chrome.storage.local.get(['appliedCount', 'skippedCount']);
      const appliedEl = document.getElementById('applied-count');
      const skippedEl = document.getElementById('skipped-count');
      if (appliedEl) appliedEl.textContent = data.appliedCount || 0;
      if (skippedEl) skippedEl.textContent = data.skippedCount || 0;
    } catch (e) {
      // Ignore — popup may be closing
    }
  }, 2000);
}

// --- Module exports for testing ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    showToast,
    dismissToast,
    validators,
    validateField,
    validateAllFields,
    displayFillResult
  };
}

// --- Backend Sync ---

/**
 * Sync profile and settings from the backend API.
 */
async function syncFromBackend() {
  const syncBtn = document.getElementById('sync-backend-btn');
  if (syncBtn) syncBtn.disabled = true;

  try {
    const data = await chrome.storage.local.get(['settings']);
    const backendUrl = (data.settings && data.settings.backendUrl) || 'http://localhost:8000';

    showToast('Syncing from backend...', 'info', 2000);

    const response = await fetch(`${backendUrl}/api/extension/profile`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const profile = await response.json();

    // Map backend profile to extension profile format
    const extensionProfile = {
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      email: profile.email || '',
      phone: profile.phone || '',
      phoneCountryCode: profile.phoneCountryCode || '+1',
      city: profile.city || '',
      state: profile.state || '',
      postal: profile.postal || '',
      country: profile.country || '',
      linkedinUrl: profile.linkedinUrl || '',
      website: profile.website || '',
    };

    // Map backend settings
    const extensionSettings = {
      ...(data.settings || {}),
      prefilledAnswers: profile.prefilledAnswers || {},
      visaSponsorship: profile.visaSponsorship || 'no',
      legallyAuthorized: profile.legallyAuthorized || 'yes',
      willingToRelocate: profile.willingToRelocate || 'yes',
      driversLicense: profile.driversLicense || 'yes',
    };

    // Save resume if provided
    if (profile.resumeBase64 && profile.resumeFileName) {
      await chrome.storage.local.set({
        resumeFile: 'data:application/pdf;base64,' + profile.resumeBase64,
        resumeFileName: profile.resumeFileName,
        resumeFileType: 'application/pdf',
      });
      const nameEl = document.getElementById('resumeFileName');
      const removeBtn = document.getElementById('removeResumeBtn');
      if (nameEl) {
        nameEl.textContent = profile.resumeFileName;
        nameEl.classList.add('has-file');
      }
      if (removeBtn) removeBtn.style.display = 'inline-flex';
    }

    // Save to storage
    await chrome.storage.local.set({
      profile: extensionProfile,
      settings: extensionSettings,
    });

    // Update UI
    populateProfileFields(extensionProfile);
    populateSettingsFields(extensionSettings);

    showToast('Profile synced from backend!', 'success');
  } catch (err) {
    console.error('Sync error:', err);
    showToast('Sync failed: ' + err.message, 'error');
  } finally {
    if (syncBtn) syncBtn.disabled = false;
  }
}

/**
 * Fetch pending jobs from the backend and open them in new tabs.
 */
async function fetchPendingJobs() {
  const fetchBtn = document.getElementById('fetch-jobs-btn');
  if (fetchBtn) fetchBtn.disabled = true;

  try {
    const data = await chrome.storage.local.get(['settings']);
    const backendUrl = (data.settings && data.settings.backendUrl) || 'http://localhost:8000';
    const jobTypeFilter = (data.settings && data.settings.jobTypeFilter) || 'easy_apply';

    showToast('Fetching pending jobs...', 'info', 2000);

    // Build URL with job type filter
    let url = `${backendUrl}/api/extension/jobs?limit=10`;
    if (jobTypeFilter === 'easy_apply') {
      url += '&easy_apply_only=true';
    } else if (jobTypeFilter === 'external') {
      url += '&easy_apply_only=false&external_only=true';
    } else {
      url += '&easy_apply_only=false';
    }

    console.log('[AutoApplyBot] Fetching jobs from:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const jobs = await response.json();
    console.log('[AutoApplyBot] Fetched jobs:', jobs);

    if (!jobs || jobs.length === 0) {
      showToast('No pending jobs found. Try scraping first or change filter.', 'warning');
      return;
    }

    // Log job details for debugging
    jobs.forEach((job, i) => {
      console.log(`[AutoApplyBot] Job ${i + 1}: ${job.title} at ${job.company}, ATS: ${job.atsType}, URL: ${job.url}`);
    });

    // Get profile and settings to store for content script
    const storageData = await chrome.storage.local.get(['profile', 'settings']);
    const profile = storageData.profile || {};
    const settings = storageData.settings || {};

    // Store jobs for the content script to iterate, set isRunning to trigger auto-processing
    await chrome.storage.local.set({ 
      pendingJobs: jobs, 
      currentJobIndex: 0,
      isRunning: true,
      profile: profile,
      settings: settings
    });

    console.log('[AutoApplyBot] Stored in chrome.storage:', {
      pendingJobsCount: jobs.length,
      currentJobIndex: 0,
      isRunning: true,
      hasProfile: !!profile,
      hasSettings: !!settings
    });

    // Update dashboard state
    isRunning = true;
    updateDashboard();

    // Open the first job in the current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && jobs[0]) {
      console.log('[AutoApplyBot] Opening first job:', jobs[0].url);
      await chrome.tabs.update(tab.id, { url: jobs[0].url });
      
      // Wait for page to load then inject content script
      setTimeout(async () => {
        try {
          console.log('[AutoApplyBot] Injecting content script...');
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          console.log('[AutoApplyBot] Content script injected');
        } catch (e) {
          console.log('[AutoApplyBot] Content script injection:', e.message);
        }
      }, 3000);
      
      const filterLabel = jobTypeFilter === 'easy_apply' ? 'Easy Apply' : 
                          jobTypeFilter === 'external' ? 'External' : 'All';
      showToast(`Starting auto-apply for ${jobs.length} ${filterLabel} jobs...`, 'success');
    }
  } catch (err) {
    console.error('Fetch jobs error:', err);
    showToast('Failed to fetch jobs: ' + err.message, 'error');
  } finally {
    if (fetchBtn) fetchBtn.disabled = false;
  }
}

/**
 * Report an applied job to the backend.
 */
async function reportAppliedJob(job) {
  try {
    const data = await chrome.storage.local.get(['settings']);
    const backendUrl = (data.settings && data.settings.backendUrl) || 'http://localhost:8000';

    await fetch(`${backendUrl}/api/extension/applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: job.company || '',
        role: job.role || '',
        url: job.url || '',
        atsType: job.atsType || 'linkedin',
        status: job.status || 'applied',
        fieldsFilled: job.fieldsFilled || 0,
        fieldsSkipped: job.fieldsSkipped || 0,
        fieldsFailed: job.fieldsFailed || 0,
      }),
    });
  } catch (err) {
    console.error('Failed to report applied job to backend:', err);
  }
}

// Wire sync buttons
document.addEventListener('DOMContentLoaded', () => {
  const syncBtn = document.getElementById('sync-backend-btn');
  const scrapeBtn = document.getElementById('scrape-jobs-btn');
  const fetchBtn = document.getElementById('fetch-jobs-btn');

  if (syncBtn) syncBtn.addEventListener('click', syncFromBackend);
  if (scrapeBtn) scrapeBtn.addEventListener('click', scrapeJobsFromBackend);
  if (fetchBtn) fetchBtn.addEventListener('click', fetchPendingJobs);
});

/**
 * Trigger job scraping on the backend.
 */
async function scrapeJobsFromBackend() {
  const scrapeBtn = document.getElementById('scrape-jobs-btn');
  if (scrapeBtn) scrapeBtn.disabled = true;

  try {
    const data = await chrome.storage.local.get(['settings']);
    const backendUrl = (data.settings && data.settings.backendUrl) || 'http://localhost:8000';

    showToast('Scraping jobs from LinkedIn...', 'info', 5000);

    const response = await fetch(`${backendUrl}/jobs/scrape?sync=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const result = await response.json();
    showToast(`Scrape complete! Task: ${result.task_id}`, 'success');
  } catch (err) {
    console.error('Scrape error:', err);
    showToast('Scrape failed: ' + err.message, 'error');
  } finally {
    if (scrapeBtn) scrapeBtn.disabled = false;
  }
}
