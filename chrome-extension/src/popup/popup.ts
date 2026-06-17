/**
 * Popup controller.
 *
 * Layout: a gradient header, a tab bar (Autofill / Profile / Experience /
 * Education / Skills / Settings), and a footer status bar — the structure from
 * the Chrome Extension UI Figma, in the app's lavender brand color.
 *
 * Flow on open:
 *   1. Load config + auth status (background) and the active tab in parallel.
 *   2. If signed out and not in mock mode → show the login view.
 *   3. Otherwise fetch the profile, render the data tabs, make sure the content
 *      script is in the tab, scan, and render the detected fields for review.
 *   4. "Autofill" sends only the user-approved fields to the content script.
 *
 * The popup never writes to the page itself and never triggers submission.
 */
import { CATEGORY_LABELS, detectAtsName } from "../shared/constants";
import { defaultSelectedIds } from "../shared/selection";
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

const SVG = {
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  linkedin:
    '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>',
  github:
    '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
};

function svgIcon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Tab = "autofill" | "profile" | "experience" | "education" | "skills" | "settings";
type View = "main" | "login";

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
  scanned: boolean;
  tab: Tab;
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
  scanned: false,
  tab: "autofill",
};

function showView(view: View): void {
  $("view-main").hidden = view !== "main";
  $("view-login").hidden = view !== "login";
  $("tabbar").hidden = view !== "main";
}

function selectTab(tab: Tab): void {
  state.tab = tab;
  const tabs: Tab[] = ["autofill", "profile", "experience", "education", "skills", "settings"];
  for (const t of tabs) {
    $(`tab-${t}`).hidden = t !== tab;
  }
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  if (tab === "profile") renderProfileTab();
  else if (tab === "experience") renderExperienceTab();
  else if (tab === "education") renderEducationTab();
  else if (tab === "skills") renderSkillsTab();
  else if (tab === "settings") fillSettingsForm();
  else if (tab === "autofill" && !state.scanned && !state.busy) void scanActiveTab();
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
  selectTab("autofill");
  await loadProfileAndScan();
}

async function loadProfileAndScan(): Promise<void> {
  const resp = await sendToBackground<ProfileResponse>({ type: "GET_PROFILE" }).catch(() => null);
  if (!resp || !resp.ok) {
    if (resp?.needsLogin) {
      showView("login");
      return;
    }
    showBanner(`Could not load profile: ${resp?.error ?? "background unavailable"}`, "error");
  } else {
    state.profile = resp.profile ?? null;
    state.source = resp.source ?? null;
  }
  renderHeader();
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
    state.scanned = true;
    fieldsEl.innerHTML = "";
    fieldsEl.appendChild(
      pageMessage("This page can't be scanned. Open a job application page and try again.")
    );
    renderSiteLine();
    renderCounts();
    renderActions();
    return;
  }

  state.busy = true;
  renderActions();
  fieldsEl.innerHTML = "";
  fieldsEl.appendChild(pageMessage("Scanning page…", true));
  $("counts-headline").textContent = "Scanning…";

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
    state.scanned = true;
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
  state.selected = defaultSelectedIds(state.fields);
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
// Header / footer
// ---------------------------------------------------------------------------

/** First/last name from the profile, falling back to the signed-in account. */
function accountName(): { first: string; last: string } {
  const p = state.profile;
  let first = p?.firstName?.trim() ?? "";
  let last = p?.lastName?.trim() ?? "";
  if (!first && !last) {
    first = state.status?.firstName?.trim() ?? "";
    last = state.status?.lastName?.trim() ?? "";
  }
  return { first, last };
}

function profileInitials(): string {
  const { first, last } = accountName();
  const initials = ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
  if (initials) return initials;
  // No name yet — use the email's first letter rather than a generic fallback.
  const email = state.status?.email ?? state.profile?.email ?? "";
  return email ? email[0].toUpperCase() : "AP";
}

function renderHeader(): void {
  const chip = $("status-chip");
  chip.classList.remove("connected", "warn");
  const footerStatus = $("footer-status");

  if (!state.status || !state.status.ok) {
    chip.textContent = "Offline";
    chip.classList.add("warn");
    footerStatus.innerHTML = `<span class="live-dot"></span>Offline`;
  } else if (state.status.mode === "connected") {
    chip.textContent = "Connected";
    chip.classList.add("connected");
    footerStatus.innerHTML = `<span class="live-dot"></span>Ready to fill`;
  } else if (state.status.mode === "mock") {
    chip.textContent = "Sample data";
    chip.classList.add("warn");
    footerStatus.innerHTML = `<span class="live-dot"></span>Sample data`;
  } else {
    chip.textContent = "Signed out";
    footerStatus.innerHTML = `<span class="live-dot"></span>Sign in to fill`;
  }

  // Show "Sign in" until connected with a real account; then show the avatar.
  const connected = Boolean(state.status?.ok && state.status.mode === "connected");
  $("btn-signin").hidden = connected;
  const avatar = $("avatar");
  avatar.hidden = !connected;
  avatar.textContent = profileInitials();
}

// ---------------------------------------------------------------------------
// Autofill tab rendering
// ---------------------------------------------------------------------------

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
  const headline = $("counts-headline");
  if (state.fields.length === 0) {
    counts.textContent = "";
    headline.textContent = state.scanned ? "No fields detected" : "Scanning…";
    return;
  }
  const known = state.fields.filter((f) => f.category !== "unknown");
  const ready = known.filter((f) => state.selected.has(f.id)).length;
  const review = known.length - ready;
  const ignored = state.fields.length - known.length;
  headline.textContent = `${state.fields.length} field${state.fields.length === 1 ? "" : "s"} detected`;
  counts.textContent =
    `${ready} ready · ${review} to review` + (ignored > 0 ? ` · ${ignored} skipped` : "");
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
  scanBtn.textContent = state.busy ? "Working…" : "Rescan";
  const count = state.selected.size;
  fillBtn.disabled = state.busy || count === 0;
  fillBtn.textContent = count > 0 ? `Autofill ${count} field${count === 1 ? "" : "s"}` : "Autofill";
}

// ---------------------------------------------------------------------------
// Profile / Experience / Education / Skills tabs
// ---------------------------------------------------------------------------

function emptyTab(message: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "empty-tab";
  div.textContent = message;
  return div;
}

function needsProfileMessage(): string {
  return state.source === "mock"
    ? "Showing sample data. Sign in to load your real profile."
    : "Sign in and upload a resume to populate your profile.";
}

function renderProfileTab(): void {
  const head = $("profile-head");
  const info = $("profile-info");
  head.innerHTML = "";
  info.innerHTML = "";
  const p = state.profile;
  if (!p) {
    info.appendChild(emptyTab(needsProfileMessage()));
    return;
  }

  const avatar = document.createElement("div");
  avatar.className = "avatar-lg";
  avatar.textContent = profileInitials();
  const meta = document.createElement("div");
  const name = document.createElement("div");
  name.className = "profile-name-lg";
  const { first, last } = accountName();
  name.textContent = [first, last].filter(Boolean).join(" ") || p.email || "Your profile";
  const title = document.createElement("div");
  title.className = "profile-title";
  title.textContent = [p.currentTitle, p.currentCompany].filter(Boolean).join(" · ") || "—";
  const pill = document.createElement("span");
  const complete = Boolean(p.firstName && p.email && p.phone);
  pill.className = "profile-pill" + (complete ? "" : " warn");
  pill.innerHTML = `<span class="live-dot"></span>${
    state.source === "mock" ? "Sample profile" : complete ? "Profile complete" : "Needs details"
  }`;
  meta.appendChild(name);
  meta.appendChild(title);
  meta.appendChild(pill);
  if (state.source === "mock") {
    const signin = document.createElement("button");
    signin.className = "btn link profile-signin";
    signin.textContent = "Sign in to use your real profile";
    signin.addEventListener("click", () => showView("login"));
    meta.appendChild(signin);
  }
  head.appendChild(avatar);
  head.appendChild(meta);

  const rows: Array<[string, string, string, boolean]> = [
    ["Email", p.email, SVG.mail, true],
    ["Phone", p.phone, SVG.phone, true],
    ["Location", p.location, SVG.pin, false],
    ["Portfolio", p.portfolio, SVG.globe, true],
    ["LinkedIn", p.linkedin, SVG.linkedin, true],
    ["GitHub", p.github, SVG.github, true],
  ];
  for (const [label, value, icon, mono] of rows) {
    if (!value) continue;
    info.appendChild(infoRow(label, value, icon, mono));
  }
  if (!info.children.length) info.appendChild(emptyTab("No contact details on file yet."));
}

function infoRow(label: string, value: string, icon: string, mono: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "info-row";
  const ico = document.createElement("span");
  ico.className = "info-ico";
  ico.innerHTML = svgIcon(icon);
  const body = document.createElement("div");
  body.className = "info-body";
  const lab = document.createElement("div");
  lab.className = "info-label";
  lab.textContent = label;
  const val = document.createElement("div");
  val.className = "info-val" + (mono ? " mono" : "");
  val.textContent = value;
  val.title = value;
  body.appendChild(lab);
  body.appendChild(val);
  row.appendChild(ico);
  row.appendChild(body);
  return row;
}

function renderExperienceTab(): void {
  const list = $("experience-list");
  list.innerHTML = "";
  const exp = state.profile?.experience ?? [];
  if (exp.length === 0) {
    list.appendChild(emptyTab(state.profile ? "No experience on file yet." : needsProfileMessage()));
    return;
  }
  for (const e of exp) {
    const item = document.createElement("div");
    item.className = "timeline-item";
    const dates = [e.startDate, e.endDate || "Present"].filter(Boolean).join(" → ");
    if (dates) {
      const d = document.createElement("div");
      d.className = "timeline-date";
      d.textContent = dates;
      item.appendChild(d);
    }
    const t = document.createElement("div");
    t.className = "timeline-title";
    t.textContent = e.title || e.company || "Role";
    item.appendChild(t);
    if (e.company && e.title) {
      const s = document.createElement("div");
      s.className = "timeline-sub";
      s.textContent = e.company;
      item.appendChild(s);
    }
    if (e.description) {
      const desc = document.createElement("div");
      desc.className = "timeline-desc";
      desc.textContent = e.description;
      item.appendChild(desc);
    }
    list.appendChild(item);
  }
}

function renderEducationTab(): void {
  const list = $("education-list");
  list.innerHTML = "";
  const edu = state.profile?.education ?? [];
  if (edu.length === 0) {
    list.appendChild(emptyTab(state.profile ? "No education on file yet." : needsProfileMessage()));
    return;
  }
  for (const e of edu) {
    const item = document.createElement("div");
    item.className = "timeline-item";
    if (e.graduationYear) {
      const d = document.createElement("div");
      d.className = "timeline-date";
      d.textContent = e.graduationYear;
      item.appendChild(d);
    }
    const t = document.createElement("div");
    t.className = "timeline-title";
    t.textContent = e.school || "School";
    item.appendChild(t);
    if (e.degree) {
      const s = document.createElement("div");
      s.className = "timeline-sub";
      s.textContent = e.degree;
      item.appendChild(s);
    }
    list.appendChild(item);
  }
}

function renderSkillsTab(): void {
  const list = $("skills-list");
  list.innerHTML = "";
  const skills = state.profile?.skills ?? [];
  if (skills.length === 0) {
    list.appendChild(emptyTab(state.profile ? "No skills on file yet." : needsProfileMessage()));
    return;
  }
  for (const s of skills) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = s;
    list.appendChild(tag);
  }
}

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

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
// Login & settings
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

async function handleGoogleLogin(): Promise<void> {
  const errorEl = $("login-error");
  const btn = $<HTMLButtonElement>("btn-google-login");
  errorEl.hidden = true;

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
    const resp = await sendToBackground<LoginResponse>({ type: "GOOGLE_LOGIN" });
    if (!resp.ok) {
      errorEl.hidden = false;
      errorEl.textContent = resp.error ?? "Google sign-in failed";
      return;
    }
    await saveConfig({ useMockData: false });
    await restart();
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in with Google";
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
  state.scanned = false;
  state.tab = "autofill";
  $("banner").hidden = true;
  await init();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.busy && btn.dataset.tab !== state.tab) return;
      selectTab(btn.dataset.tab as Tab);
    });
  });

  $("btn-scan").addEventListener("click", () => void scanActiveTab());
  $("btn-fill").addEventListener("click", () => void autofill());
  $("btn-dashboard").addEventListener("click", () => {
    void sendToBackground<SimpleResponse>({ type: "OPEN_DASHBOARD" });
  });
  $("btn-signin").addEventListener("click", () => showView("login"));
  $("btn-settings").addEventListener("click", () => {
    showView("main");
    selectTab("settings");
  });
  $("btn-settings-save").addEventListener("click", () => void handleSettingsSave());
  $("btn-logout").addEventListener("click", () => void handleLogout());
  $("login-form").addEventListener("submit", (e) => void handleLogin(e));
  $("btn-google-login").addEventListener("click", () => void handleGoogleLogin());
  $("btn-use-mock").addEventListener("click", () => {
    void saveConfig({ useMockData: true }).then(restart);
  });

  // Content script tells us when a dynamic page re-rendered its form.
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (
      message?.type === "FIELDS_UPDATED" &&
      !state.busy &&
      !$("view-main").hidden &&
      state.tab === "autofill"
    ) {
      void scanActiveTab();
    }
    return false;
  });

  void init().catch((err) => {
    showBanner(`Something went wrong: ${err instanceof Error ? err.message : err}`, "error");
  });
});
