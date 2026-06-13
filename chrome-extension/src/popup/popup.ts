/**
 * Popup controller.
 *
 * Flow on open:
 *   1. Load config + auth status (background) and the active tab in parallel.
 *   2. If signed out and not in mock mode → show the login view.
 *   3. Otherwise fetch the profile, make sure the content script is in the
 *      tab (injecting it via activeTab+scripting on non-ATS pages), scan,
 *      and render the detected fields for review.
 *   4. "Autofill" sends only the user-approved fields to the content script.
 *
 * The popup never writes to the page itself and never triggers submission.
 */
import { AUTOFILL_CONFIDENCE_THRESHOLD, CATEGORY_LABELS, detectAtsName } from "../shared/constants";
import { getConfig, saveConfig, type ExtensionConfig } from "../shared/storage";
import type {
  BackgroundRequest,
  ContentRequest,
  DetectedField,
  FillInstruction,
  FillOutcome,
  FillResponse,
  LoginResponse,
  ProfileResponse,
  ProfileSource,
  ScanResponse,
  SimpleResponse,
  StatusResponse,
  UserApplicationProfile,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Small DOM + messaging helpers
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function sendToBackground<T>(message: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

function sendToTab<T>(tabId: number, message: ContentRequest, ms: number): Promise<T> {
  return withTimeout(chrome.tabs.sendMessage(tabId, message) as Promise<T>, ms, "Page request");
}

/** "https://api.example.com/x" → "https://api.example.com/*" (for permissions) */
function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PopupState {
  config: ExtensionConfig;
  status: StatusResponse | null;
  tabId: number | null;
  tabUrl: string;
  profile: UserApplicationProfile | null;
  source: ProfileSource | null;
  fields: DetectedField[];
  selected: Set<string>;
  outcomes: Map<string, FillOutcome>;
  busy: boolean;
}

const state: PopupState = {
  config: null as unknown as ExtensionConfig,
  status: null,
  tabId: null,
  tabUrl: "",
  profile: null,
  source: null,
  fields: [],
  selected: new Set(),
  outcomes: new Map(),
  busy: false,
};

type View = "main" | "login" | "settings";

function showView(view: View): void {
  $("view-main").hidden = view !== "main";
  $("view-login").hidden = view !== "login";
  $("view-settings").hidden = view !== "settings";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  state.config = await getConfig();

  const [status, tab] = await Promise.all([
    sendToBackground<StatusResponse>({ type: "GET_STATUS" }).catch(() => null),
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]),
  ]);

  state.status = status;
  state.tabId = tab?.id ?? null;
  state.tabUrl = tab?.url ?? "";
  renderHeader();

  if (status && status.mode === "signedOut") {
    showView("login");
    return;
  }

  showView("main");
  await loadProfileAndScan();
}

async function loadProfileAndScan(): Promise<void> {
  const resp = await sendToBackground<ProfileResponse>({ type: "GET_PROFILE" }).catch(() => null);
  if (!resp || !resp.ok) {
    if (resp?.needsLogin) {
      showView("login");
      return;
    }
    renderProfileCard();
    showBanner(`Could not load profile: ${resp?.error ?? "background unavailable"}`, "error");
    return;
  }
  state.profile = resp.profile ?? null;
  state.source = resp.source ?? null;
  renderProfileCard();
  await scanActiveTab();
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    await sendToTab(tabId, { type: "PING" }, 500);
    return true;
  } catch {
    // Not injected yet (non-ATS page) — inject on demand via activeTab.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["contentScript.js"],
    });
  } catch {
    return false; // chrome://, web store, PDF viewer, etc.
  }
  try {
    await sendToTab(tabId, { type: "PING" }, 1000);
    return true;
  } catch {
    return false;
  }
}

async function scanActiveTab(): Promise<void> {
  const fieldsEl = $("fields");
  if (state.tabId === null || !/^https?:/i.test(state.tabUrl)) {
    fieldsEl.innerHTML = "";
    fieldsEl.appendChild(pageMessage("This page can't be scanned. Open a job application page and try again."));
    renderSiteLine();
    renderCounts();
    renderActions();
    return;
  }

  state.busy = true;
  renderActions();
  fieldsEl.innerHTML = "";
  fieldsEl.appendChild(pageMessage("Scanning page…", true));

  try {
    const injected = await ensureContentScript(state.tabId);
    if (!injected) {
      fieldsEl.innerHTML = "";
      fieldsEl.appendChild(
        pageMessage("Chrome doesn't allow extensions on this page (browser/internal pages).")
      );
      return;
    }
    const resp = await sendToTab<ScanResponse>(
      state.tabId,
      { type: "SCAN_PAGE", profile: state.profile, fillEEO: state.config.fillEEO },
      4000
    );
    state.fields = resp.fields;
    state.outcomes = new Map();
    applyDefaultSelection();
    renderFields();
  } catch (err) {
    fieldsEl.innerHTML = "";
    fieldsEl.appendChild(
      pageMessage(`Scan failed: ${err instanceof Error ? err.message : "unknown error"}`)
    );
  } finally {
    state.busy = false;
    renderSiteLine();
    renderCounts();
    renderActions();
  }
}

/** Pre-select only safe, confident, valued, non-sensitive, empty fields. */
function applyDefaultSelection(): void {
  state.selected = new Set(
    state.fields
      .filter(
        (f) =>
          f.fillable &&
          f.proposedValue !== null &&
          !f.sensitive &&
          f.confidence >= AUTOFILL_CONFIDENCE_THRESHOLD &&
          !f.currentValue
      )
      .map((f) => f.id)
  );
}

// ---------------------------------------------------------------------------
// Autofill
// ---------------------------------------------------------------------------

async function autofill(): Promise<void> {
  if (state.tabId === null) return;
  const instructions: FillInstruction[] = state.fields
    .filter((f) => state.selected.has(f.id) && f.fillable && f.proposedValue !== null)
    .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
  if (instructions.length === 0) return;

  state.busy = true;
  renderActions();
  try {
    const resp = await sendToTab<FillResponse>(
      state.tabId,
      { type: "FILL_FIELDS", instructions },
      6000
    );
    if (!resp.ok && resp.error) {
      showBanner(resp.error, "error");
    }
    state.outcomes = new Map(resp.outcomes.map((o) => [o.fieldId, o]));
    const okCount = resp.outcomes.filter((o) => o.ok).length;
    const failCount = resp.outcomes.length - okCount;
    showBanner(
      `Filled ${okCount} of ${instructions.length} field${instructions.length === 1 ? "" : "s"}` +
        (failCount > 0 ? ` (${failCount} need attention)` : "") +
        ". Review the form before submitting — ApplyPilot never submits for you.",
      failCount > 0 ? "warn" : "ok"
    );
    renderFields();
  } catch (err) {
    showBanner(`Autofill failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  } finally {
    state.busy = false;
    renderActions();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeader(): void {
  const chip = $("status-chip");
  chip.classList.remove("connected", "warn");
  if (!state.status || !state.status.ok) {
    chip.textContent = "Offline";
    chip.classList.add("warn");
    return;
  }
  if (state.status.mode === "connected") {
    chip.textContent = "Connected";
    chip.classList.add("connected");
  } else if (state.status.mode === "mock") {
    chip.textContent = "Sample data";
    chip.classList.add("warn");
  } else {
    chip.textContent = "Signed out";
  }
}

function renderProfileCard(): void {
  const card = $("profile-card");
  card.innerHTML = "";

  const row = document.createElement("div");
  row.className = "profile-row";
  const left = document.createElement("div");

  const name = document.createElement("div");
  name.className = "profile-name";
  const sub = document.createElement("div");
  sub.className = "profile-sub";

  if (state.profile) {
    name.textContent =
      [state.profile.firstName, state.profile.lastName].filter(Boolean).join(" ") || "Your profile";
    sub.textContent =
      state.source === "mock"
        ? "Sample profile — sign in to use your real data"
        : state.profile.email || "";
  } else {
    name.textContent = "No profile loaded";
    sub.textContent = "Sign in or enable sample data in settings";
  }
  left.appendChild(name);
  left.appendChild(sub);
  row.appendChild(left);

  if (state.source === "mock") {
    const connect = document.createElement("button");
    connect.className = "btn link";
    connect.textContent = "Sign in";
    connect.addEventListener("click", () => showView("login"));
    row.appendChild(connect);
  }
  card.appendChild(row);
}

function renderSiteLine(): void {
  const line = $("site-line");
  line.innerHTML = "";
  if (!/^https?:/i.test(state.tabUrl)) return;
  try {
    const host = new URL(state.tabUrl).hostname;
    const hostSpan = document.createElement("span");
    hostSpan.textContent = host;
    line.appendChild(hostSpan);
    const ats = detectAtsName(host);
    if (ats) {
      const badge = document.createElement("span");
      badge.className = "ats-badge";
      badge.textContent = ats;
      line.appendChild(badge);
    }
  } catch {
    // unparsable URL — leave empty
  }
}

function renderCounts(): void {
  const counts = $("counts");
  if (state.fields.length === 0) {
    counts.textContent = "";
    return;
  }
  const known = state.fields.filter((f) => f.category !== "unknown");
  const ready = known.filter((f) => state.selected.has(f.id)).length;
  const review = known.length - ready;
  const ignored = state.fields.length - known.length;
  counts.textContent =
    `${state.fields.length} fields detected · ${ready} selected · ${review} to review` +
    (ignored > 0 ? ` · ${ignored} unrecognized` : "");
}

function confidenceBadge(confidence: number): HTMLElement {
  const span = document.createElement("span");
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.8) {
    span.className = "conf high";
    span.textContent = `High ${pct}%`;
  } else if (confidence >= 0.6) {
    span.className = "conf med";
    span.textContent = `Medium ${pct}%`;
  } else {
    span.className = "conf low";
    span.textContent = `Low ${pct}%`;
  }
  return span;
}

function renderFieldRow(field: DetectedField): HTMLElement {
  const row = document.createElement("div");
  row.className = "field-row" + (field.sensitive ? " sensitive" : "");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selected.has(field.id);
  checkbox.disabled = !field.fillable || field.proposedValue === null;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(field.id);
    else state.selected.delete(field.id);
    renderCounts();
    renderActions();
  });
  row.appendChild(checkbox);

  const main = document.createElement("div");
  main.className = "field-main";

  const label = document.createElement("div");
  label.className = "field-label";
  label.textContent = field.label;
  label.title = field.label;
  if (field.required) {
    const star = document.createElement("span");
    star.className = "req-star";
    star.textContent = " *";
    label.appendChild(star);
  }
  main.appendChild(label);

  const meta = document.createElement("div");
  meta.className = "field-meta";
  const cat = document.createElement("span");
  cat.className = "cat-chip";
  cat.textContent = CATEGORY_LABELS[field.category] ?? field.category;
  meta.appendChild(cat);
  meta.appendChild(confidenceBadge(field.confidence));
  main.appendChild(meta);

  const value = document.createElement("div");
  if (field.proposedValue !== null) {
    value.className = "field-value";
    value.textContent = `→ ${field.proposedValue}`;
    value.title = field.proposedValue;
  } else {
    value.className = "field-value empty";
    value.textContent = field.sensitive ? "Not autofilled (EEO)" : "No profile data";
  }
  main.appendChild(value);

  if (field.currentValue && field.proposedValue !== null) {
    const note = document.createElement("div");
    note.className = "field-note";
    note.textContent = `Already filled: "${field.currentValue}" — check to overwrite`;
    main.appendChild(note);
  }
  if (field.note) {
    const note = document.createElement("div");
    note.className = "field-note";
    note.textContent = field.note;
    main.appendChild(note);
  }

  const outcome = state.outcomes.get(field.id);
  if (outcome && !outcome.ok && outcome.reason) {
    const reason = document.createElement("div");
    reason.className = "outcome-reason";
    reason.textContent = outcome.reason;
    main.appendChild(reason);
  }
  row.appendChild(main);

  if (outcome) {
    const mark = document.createElement("div");
    mark.className = `outcome ${outcome.ok ? "ok" : "fail"}`;
    mark.textContent = outcome.ok ? "✓" : "✗";
    row.appendChild(mark);
  }

  return row;
}

function renderFields(): void {
  const container = $("fields");
  container.innerHTML = "";

  if (state.fields.length === 0) {
    container.appendChild(
      pageMessage("No form fields detected on this page. Open a job application and rescan.")
    );
    renderCounts();
    renderActions();
    return;
  }

  const known = state.fields.filter((f) => f.category !== "unknown");
  const ready = known.filter((f) => state.selected.has(f.id));
  const review = known.filter((f) => !state.selected.has(f.id));

  if (ready.length > 0) {
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = "Will fill";
    container.appendChild(title);
    for (const f of ready) container.appendChild(renderFieldRow(f));
  }
  if (review.length > 0) {
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = "Review — not filled automatically";
    container.appendChild(title);
    for (const f of review) container.appendChild(renderFieldRow(f));
  }

  renderCounts();
  renderActions();
}

function renderActions(): void {
  const scanBtn = $<HTMLButtonElement>("btn-scan");
  const fillBtn = $<HTMLButtonElement>("btn-fill");
  scanBtn.disabled = state.busy;
  scanBtn.textContent = state.busy ? "Working…" : "Rescan page";
  const count = state.selected.size;
  fillBtn.disabled = state.busy || count === 0;
  fillBtn.textContent = count > 0 ? `Autofill ${count} field${count === 1 ? "" : "s"}` : "Autofill";
}

function showBanner(text: string, kind: "ok" | "warn" | "error"): void {
  const banner = $("banner");
  banner.hidden = false;
  banner.className = "banner" + (kind === "ok" ? "" : ` ${kind}`);
  banner.textContent = text;
}

function pageMessage(text: string, spinner = false): HTMLElement {
  const div = document.createElement("div");
  div.className = "page-message";
  if (spinner) {
    const s = document.createElement("span");
    s.className = "spinner";
    div.appendChild(s);
  }
  div.appendChild(document.createTextNode(text));
  return div;
}

// ---------------------------------------------------------------------------
// Login & settings views
// ---------------------------------------------------------------------------

async function handleLogin(event: Event): Promise<void> {
  event.preventDefault();
  const email = $<HTMLInputElement>("login-email").value.trim();
  const password = $<HTMLInputElement>("login-password").value;
  const errorEl = $("login-error");
  const btn = $<HTMLButtonElement>("btn-login");
  errorEl.hidden = true;

  // The backend origin must be granted before the service worker can fetch it.
  const pattern = originPattern(state.config.apiBaseUrl);
  if (pattern) {
    const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
    if (!granted) {
      errorEl.hidden = false;
      errorEl.textContent = "Permission to reach your ApplyPilot server was declined.";
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const resp = await sendToBackground<LoginResponse>({ type: "LOGIN", email, password });
    if (!resp.ok) {
      errorEl.hidden = false;
      errorEl.textContent = resp.error ?? "Login failed";
      return;
    }
    await saveConfig({ useMockData: false });
    await restart();
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

function fillSettingsForm(): void {
  $<HTMLInputElement>("set-api-url").value = state.config.apiBaseUrl;
  $<HTMLInputElement>("set-dash-url").value = state.config.dashboardUrl;
  $<HTMLInputElement>("set-mock").checked = state.config.useMockData;
  $<HTMLInputElement>("set-eeo").checked = state.config.fillEEO;
  $<HTMLButtonElement>("btn-logout").hidden = state.status?.mode !== "connected";
}

async function handleSettingsSave(): Promise<void> {
  const errorEl = $("settings-error");
  errorEl.hidden = true;

  const apiBaseUrl = $<HTMLInputElement>("set-api-url").value.trim().replace(/\/+$/, "");
  const dashboardUrl = $<HTMLInputElement>("set-dash-url").value.trim().replace(/\/+$/, "");
  const useMockData = $<HTMLInputElement>("set-mock").checked;
  const fillEEO = $<HTMLInputElement>("set-eeo").checked;

  if (!useMockData) {
    const pattern = apiBaseUrl ? originPattern(apiBaseUrl) : null;
    if (!pattern) {
      errorEl.hidden = false;
      errorEl.textContent = "Enter a valid http(s) API base URL or enable sample data.";
      return;
    }
    const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
    if (!granted) {
      errorEl.hidden = false;
      errorEl.textContent = "Permission to reach that server was declined.";
      return;
    }
  }

  await saveConfig({ apiBaseUrl, dashboardUrl, useMockData, fillEEO });
  await restart();
}

async function handleLogout(): Promise<void> {
  await sendToBackground<SimpleResponse>({ type: "LOGOUT" });
  await restart();
}

/** Re-run init from scratch (after login/logout/settings changes). */
async function restart(): Promise<void> {
  state.fields = [];
  state.selected = new Set();
  state.outcomes = new Map();
  state.profile = null;
  state.source = null;
  $("banner").hidden = true;
  await init();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  $("btn-scan").addEventListener("click", () => void scanActiveTab());
  $("btn-fill").addEventListener("click", () => void autofill());
  $("btn-dashboard").addEventListener("click", () => {
    void sendToBackground<SimpleResponse>({ type: "OPEN_DASHBOARD" });
  });
  $("btn-settings").addEventListener("click", () => {
    fillSettingsForm();
    showView("settings");
  });
  $("btn-settings-back").addEventListener("click", () => showView("main"));
  $("btn-settings-save").addEventListener("click", () => void handleSettingsSave());
  $("btn-logout").addEventListener("click", () => void handleLogout());
  $("login-form").addEventListener("submit", (e) => void handleLogin(e));
  $("btn-use-mock").addEventListener("click", () => {
    void saveConfig({ useMockData: true }).then(restart);
  });

  // Content script tells us when a dynamic page re-rendered its form.
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === "FIELDS_UPDATED" && !state.busy && !$("view-main").hidden) {
      void scanActiveTab();
    }
    return false;
  });

  void init().catch((err) => {
    showBanner(`Something went wrong: ${err instanceof Error ? err.message : err}`, "error");
  });
});
