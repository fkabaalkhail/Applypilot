/**
 * In-page autofill overlay.
 *
 * Injected by the content script (top frame only) when a job application form is
 * detected. It auto-expands the first time so the user never has to hunt for the
 * toolbar icon — Manifest V3 can't reliably open the action popup itself, so this
 * is the in-page equivalent.
 *
 * Everything lives inside a Shadow DOM so the host page's CSS can't touch it and
 * ours can't leak out. It runs in the content-script context, so it fills the
 * page directly via the registry the form scanner already built — no messaging
 * round-trip needed for the fill itself.
 */
import { CATEGORY_LABELS } from "../shared/constants";
import { defaultSelectedIds } from "../shared/selection";
import type { DetectedField } from "../shared/types";

const HOST_ID = "applypilot-overlay-host";

export type OverlayStatus = "connected" | "mock" | "signedOut" | "offline";

export interface OverlayViewState {
  status: OverlayStatus;
  profileName: string;
  fields: DetectedField[];
}

export interface OverlayCallbacks {
  /** Fill the given field ids; resolves with a fill summary. */
  onAutofill: (fieldIds: string[]) => Promise<{ ok: number; fail: number; total: number }>;
  onOpenDashboard: () => void;
  onRescan: () => void;
}

interface OverlayRefs {
  root: HTMLDivElement;
  fab: HTMLButtonElement;
  fabBadge: HTMLSpanElement;
  panel: HTMLElement;
  body: HTMLDivElement;
  foot: HTMLDivElement;
  statusLine: HTMLDivElement;
}

let refs: OverlayRefs | null = null;
let callbacks: OverlayCallbacks | null = null;
let lastState: OverlayViewState | null = null;
let expanded = false;
let autoExpandedOnce = false;
let busy = false;

// ---------------------------------------------------------------------------
// Icons (inline SVG strings — Shadow DOM, so no external assets)
// ---------------------------------------------------------------------------

const ICON_ZAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.ap-root {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  color: #1f1b3a;
}

/* ---- Floating action button ---- */
.ap-fab {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  box-shadow: 0 8px 24px rgba(124, 108, 255, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
}
.ap-fab:hover { transform: scale(1.06); }
.ap-fab svg { width: 24px; height: 24px; color: #fff; }
.ap-fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: #fff;
  color: #6a5ae0;
  font-size: 11px;
  font-weight: 800;
  line-height: 20px;
  text-align: center;
  box-shadow: 0 2px 6px rgba(0,0,0,0.18);
}
.ap-root.ap-has-fields .ap-fab { animation: ap-pulse 2s ease-in-out infinite; }
@keyframes ap-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(124, 108, 255, 0.45); }
  50% { box-shadow: 0 8px 28px rgba(124, 108, 255, 0.45), 0 0 0 10px rgba(124, 108, 255, 0.12); }
}

/* ---- Panel ---- */
.ap-panel {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 340px;
  max-height: min(520px, 80vh);
  background: #ffffff;
  border: 1px solid #e3e0ff;
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(60, 40, 120, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: bottom right;
  animation: ap-pop 0.18s ease-out;
}
@keyframes ap-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* Collapsed: hide panel, show FAB. Expanded: hide FAB, show panel. */
.ap-root.ap-collapsed .ap-panel { display: none; }
.ap-root.ap-expanded .ap-fab { display: none; }

/* ---- Header ---- */
.ap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff;
  flex-shrink: 0;
}
.ap-brand { display: flex; align-items: center; gap: 9px; }
.ap-logo {
  width: 28px; height: 28px;
  border-radius: 9px;
  background: rgba(255,255,255,0.2);
  display: flex; align-items: center; justify-content: center;
}
.ap-logo svg { width: 16px; height: 16px; color: #fff; }
.ap-title { font-weight: 700; font-size: 14px; line-height: 1.1; }
.ap-sub { font-size: 10.5px; color: rgba(255,255,255,0.8); }
.ap-head-actions { display: flex; gap: 4px; }
.ap-icon {
  width: 26px; height: 26px;
  border: none;
  border-radius: 7px;
  background: rgba(255,255,255,0.14);
  color: #fff;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.ap-icon:hover { background: rgba(255,255,255,0.28); }

/* ---- Body ---- */
.ap-body { padding: 12px 14px; overflow-y: auto; flex: 1; min-height: 0; }
.ap-status {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 600; color: #1f1b3a;
  margin-bottom: 10px;
}
.ap-status .ap-counts { font-weight: 500; font-size: 11px; color: #6b678a; }
.ap-dot { width: 8px; height: 8px; border-radius: 50%; background: #1e9e6a; display: inline-block; margin-right: 6px; vertical-align: middle; }

.ap-fields {
  border: 1px solid #ece9ff;
  border-radius: 10px;
  overflow: hidden;
}
.ap-field {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid #f1eeff;
}
.ap-field:last-child { border-bottom: none; }
.ap-field .ap-fi { width: 14px; height: 14px; flex-shrink: 0; }
.ap-field .ap-fi.ok { color: #1e9e6a; }
.ap-field .ap-fi.warn { color: #b97d10; }
.ap-flabel { width: 104px; flex-shrink: 0; color: #6b678a; font-size: 11.5px; }
.ap-fvalue {
  flex: 1; min-width: 0;
  font-size: 11.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #1f1b3a;
}
.ap-fvalue.empty { color: #9b97b5; font-style: italic; font-family: inherit; }

.ap-empty { text-align: center; color: #6b678a; font-size: 12px; padding: 16px 8px; }
.ap-signin { text-align: center; padding: 8px 4px 4px; }
.ap-signin p { margin: 0 0 10px; color: #6b678a; font-size: 12.5px; }

.ap-banner {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  background: #e7f7ef; border: 1px solid #bfe8d4; color: #1e9e6a;
}
.ap-banner.warn { background: #fdf3e0; border-color: #f3ddb0; color: #b97d10; }

/* ---- Footer ---- */
.ap-foot { padding: 10px 14px 12px; border-top: 1px solid #f1eeff; flex-shrink: 0; }
.ap-btn {
  width: 100%;
  border: none;
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 8px;
}
.ap-btn svg { width: 16px; height: 16px; }
.ap-primary { background: #7c6cff; color: #fff; box-shadow: 0 6px 16px rgba(124,108,255,0.3); }
.ap-primary:hover:not(:disabled) { background: #6a5ae0; }
.ap-primary:disabled { opacity: 0.6; cursor: default; }
.ap-primary.ap-done { background: #1e9e6a; box-shadow: none; }
.ap-secondary { background: #f0eeff; color: #6a5ae0; }
.ap-secondary:hover { background: #e6e2ff; }
.ap-note { text-align: center; font-size: 10px; color: #9b97b5; margin-top: 7px; }
.ap-spin {
  width: 15px; height: 15px;
  border: 2px solid rgba(255,255,255,0.45);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ap-spin 0.8s linear infinite;
}
@keyframes ap-spin { to { transform: rotate(360deg); } }
`;

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

function ensureMounted(cb: OverlayCallbacks): OverlayRefs {
  callbacks = cb;
  if (refs && document.getElementById(HOST_ID)) return refs;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // The host is just an anchor; all visuals live in the shadow root.
  host.style.cssText = "all: initial;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "ap-root ap-collapsed";
  root.innerHTML = `
    <button class="ap-fab" type="button" title="ApplyPilot — autofill this form" aria-label="ApplyPilot autofill">
      ${ICON_ZAP}
      <span class="ap-fab-badge" hidden></span>
    </button>
    <section class="ap-panel" role="dialog" aria-label="ApplyPilot autofill">
      <header class="ap-head">
        <div class="ap-brand">
          <span class="ap-logo">${ICON_ZAP}</span>
          <div>
            <div class="ap-title">ApplyPilot</div>
            <div class="ap-sub">Job Application Autofill</div>
          </div>
        </div>
        <div class="ap-head-actions">
          <button class="ap-icon ap-min" type="button" title="Minimize" aria-label="Minimize">&minus;</button>
          <button class="ap-icon ap-close" type="button" title="Close" aria-label="Close">&times;</button>
        </div>
      </header>
      <div class="ap-body">
        <div class="ap-status"></div>
        <div class="ap-fields-wrap"></div>
        <div class="ap-banner" hidden></div>
      </div>
      <div class="ap-foot"></div>
    </section>
  `;
  shadow.appendChild(root);
  (document.documentElement || document.body).appendChild(host);

  const fab = root.querySelector(".ap-fab") as HTMLButtonElement;
  const panel = root.querySelector(".ap-panel") as HTMLElement;
  const body = root.querySelector(".ap-body") as HTMLDivElement;
  const foot = root.querySelector(".ap-foot") as HTMLDivElement;
  const statusLine = root.querySelector(".ap-status") as HTMLDivElement;
  const fabBadge = root.querySelector(".ap-fab-badge") as HTMLSpanElement;

  fab.addEventListener("click", () => setExpanded(true));
  (root.querySelector(".ap-min") as HTMLButtonElement).addEventListener("click", () => setExpanded(false));
  (root.querySelector(".ap-close") as HTMLButtonElement).addEventListener("click", () => setExpanded(false));

  refs = { root, fab, fabBadge, panel, body, foot, statusLine };
  return refs;
}

function setExpanded(value: boolean): void {
  expanded = value;
  if (!refs) return;
  refs.root.classList.toggle("ap-expanded", value);
  refs.root.classList.toggle("ap-collapsed", !value);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function recognized(fields: DetectedField[]): DetectedField[] {
  return fields.filter((f) => f.category !== "unknown");
}

export function showOverlay(state: OverlayViewState, cb: OverlayCallbacks): void {
  ensureMounted(cb);
  lastState = state;
  render();

  const hasFields = recognized(state.fields).length > 0;
  refs!.root.classList.toggle("ap-has-fields", hasFields && !expanded);

  // Auto-expand once per page load when we first detect a form.
  if (hasFields && !autoExpandedOnce) {
    autoExpandedOnce = true;
    setExpanded(true);
  }
}

export function updateOverlay(state: OverlayViewState): void {
  if (!refs) return;
  lastState = state;
  render();
  const hasFields = recognized(state.fields).length > 0;
  refs.root.classList.toggle("ap-has-fields", hasFields && !expanded);
}

export function removeOverlay(): void {
  document.getElementById(HOST_ID)?.remove();
  refs = null;
}

function render(): void {
  if (!refs || !lastState) return;
  const { fields, status, profileName } = lastState;
  const known = recognized(fields);
  const selected = defaultSelectedIds(fields);

  // Badge on the FAB.
  if (known.length > 0) {
    refs.fabBadge.hidden = false;
    refs.fabBadge.textContent = String(known.length);
  } else {
    refs.fabBadge.hidden = true;
  }

  if (status === "signedOut") {
    renderSignedOut();
    return;
  }

  // Status line.
  const ready = known.filter((f) => selected.has(f.id)).length;
  const review = known.length - ready;
  refs.statusLine.innerHTML = "";
  const left = document.createElement("span");
  left.innerHTML = `<span class="ap-dot"></span>${known.length} field${known.length === 1 ? "" : "s"} detected`;
  const right = document.createElement("span");
  right.className = "ap-counts";
  right.textContent =
    status === "mock"
      ? "Sample data"
      : `${ready} ready${review > 0 ? ` · ${review} to review` : ""}`;
  refs.statusLine.appendChild(left);
  refs.statusLine.appendChild(right);

  // Field list.
  const wrap = refs.body.querySelector(".ap-fields-wrap") as HTMLDivElement;
  wrap.innerHTML = "";
  if (known.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ap-empty";
    empty.textContent = "No recognizable fields here yet. Open a job application form.";
    wrap.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "ap-fields";
    for (const f of known.slice(0, 14)) list.appendChild(fieldRow(f, selected.has(f.id)));
    wrap.appendChild(list);
  }

  // Footer / action.
  renderFooter(selected, status, profileName);
}

function fieldRow(field: DetectedField, isReady: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "ap-field";

  const icon = document.createElement("span");
  icon.className = "ap-fi " + (isReady ? "ok" : "warn");
  icon.innerHTML = isReady ? ICON_CHECK : ICON_ALERT;
  row.appendChild(icon);

  const label = document.createElement("span");
  label.className = "ap-flabel";
  label.textContent = CATEGORY_LABELS[field.category] ?? field.label;
  row.appendChild(label);

  const value = document.createElement("span");
  if (field.proposedValue) {
    value.className = "ap-fvalue";
    value.textContent = field.proposedValue;
    value.title = field.proposedValue;
  } else {
    value.className = "ap-fvalue empty";
    value.textContent = field.sensitive ? "Skipped (EEO)" : "No data";
  }
  row.appendChild(value);
  return row;
}

function renderFooter(selected: Set<string>, status: OverlayStatus, profileName: string): void {
  if (!refs) return;
  refs.foot.innerHTML = "";

  const btn = document.createElement("button");
  btn.className = "ap-btn ap-primary ap-fill";
  btn.type = "button";
  const count = selected.size;
  btn.disabled = count === 0 || busy;
  btn.innerHTML = `${ICON_ZAP}<span>Autofill ${count > 0 ? `${count} field${count === 1 ? "" : "s"}` : "this form"}</span>`;
  btn.addEventListener("click", () => void doFill([...selected]));
  refs.foot.appendChild(btn);

  const note = document.createElement("div");
  note.className = "ap-note";
  note.textContent =
    status === "mock"
      ? "Sample data — sign in for your real profile · never submits for you"
      : `${profileName ? profileName + " · " : ""}Fills only — never submits for you`;
  refs.foot.appendChild(note);
}

function renderSignedOut(): void {
  if (!refs) return;
  refs.statusLine.innerHTML = "";
  const wrap = refs.body.querySelector(".ap-fields-wrap") as HTMLDivElement;
  wrap.innerHTML = `
    <div class="ap-signin">
      <p>Sign in to autofill with your ApplyPilot profile, or use sample data from the toolbar icon.</p>
    </div>`;
  (refs.body.querySelector(".ap-banner") as HTMLDivElement).hidden = true;

  refs.foot.innerHTML = "";
  const btn = document.createElement("button");
  btn.className = "ap-btn ap-secondary";
  btn.type = "button";
  btn.textContent = "Open ApplyPilot";
  btn.addEventListener("click", () => callbacks?.onOpenDashboard());
  refs.foot.appendChild(btn);
}

async function doFill(ids: string[]): Promise<void> {
  if (!refs || !callbacks || busy || ids.length === 0) return;
  busy = true;
  const btn = refs.foot.querySelector(".ap-fill") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="ap-spin"></span><span>Filling…</span>`;
  }
  try {
    const { ok, fail, total } = await callbacks.onAutofill(ids);
    const banner = refs.body.querySelector(".ap-banner") as HTMLDivElement;
    banner.hidden = false;
    banner.className = "ap-banner" + (fail > 0 ? " warn" : "");
    banner.textContent =
      `Filled ${ok} of ${total} field${total === 1 ? "" : "s"}` +
      (fail > 0 ? ` (${fail} need attention)` : "") +
      ". Review before submitting.";
    if (btn) {
      btn.classList.add("ap-done");
      btn.innerHTML = `${ICON_CHECK}<span>Filled ${ok} field${ok === 1 ? "" : "s"}</span>`;
    }
  } catch {
    const banner = refs.body.querySelector(".ap-banner") as HTMLDivElement;
    banner.hidden = false;
    banner.className = "ap-banner warn";
    banner.textContent = "Autofill failed — try the toolbar popup.";
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${ICON_ZAP}<span>Try again</span>`;
    }
  } finally {
    busy = false;
  }
}
