/**
 * In-page overlay — Tailrd side panel UI embedded in a Shadow DOM.
 *
 * The panel docks to the right edge of the viewport at full height.
 * When collapsed, a small branded tab sits on the right edge to reopen.
 *
 * Simplified layout inspired by Jobright:
 *  - Big "Autofill" button at top
 *  - "Your Autofill Information" expands into a categorized form editor
 *  - "Upload Resume" section with "Generate Custom Resume" (coming soon)
 *  - "Upload Cover Letter" section with "Generate Cover Letter" (coming soon)
 */

import { defaultSelectedIds } from "../shared/selection";
import { getConfig, saveConfig, type ExtensionConfig } from "../shared/storage";
import type {
  BackgroundRequest,
  DetectedField,
  FillOutcome,
  LoginResponse,
  ProfileResponse,
  ProfileSource,
  ResumeSummary,
  SimpleResponse,
  StatusResponse,
  UserApplicationProfile,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Public API (called from contentScript.ts)
// ---------------------------------------------------------------------------

export interface OverlayCallbacks {
  onAutofill: (fieldIds: string[]) => Promise<{ ok: number; fail: number; total: number }>;
  onRescan: () => void;
  /** List the user's resumes for the picker / auto-upload. */
  onListResumes: () => Promise<ResumeSummary[]>;
  /** Inject the chosen resume's file into the page's upload control. */
  onUploadResume: (resumeId: number) => Promise<{ ok: boolean; reason?: string }>;
}

export interface OverlayViewState {
  fields: DetectedField[];
  tabUrl: string;
}

export function showOverlay(state: OverlayViewState, cb: OverlayCallbacks): void {
  callbacks = cb;
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  ensureMounted();
  if (!panelExpanded) setExpanded(true);
  if (!initialized) void initPanel();
  else refreshMainView();
}

export function updateOverlay(state: OverlayViewState): void {
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  if (panelExpanded) refreshMainView();
}

export function removeOverlay(): void {
  document.getElementById(HOST_ID)?.remove();
  shadow = null;
  refs = null;
}

/**
 * Toggle the side panel open/closed. Called when the user clicks the
 * extension icon in the Chrome toolbar.
 */
export function toggleOverlay(state: OverlayViewState, cb: OverlayCallbacks): void {
  callbacks = cb;
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  ensureMounted();
  if (panelExpanded) {
    setExpanded(false);
  } else {
    setExpanded(true);
    if (!initialized) void initPanel();
    else refreshMainView();
  }
}

// ---------------------------------------------------------------------------
// Icons (minimal set)
// ---------------------------------------------------------------------------

const I_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const I_CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const I_CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const I_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function icon(paths: string, w = 24): string {
  return `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}


// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.ap-root {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  z-index: 2147483647;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  color: #1a1a2e;
  pointer-events: none;
}
.ap-root * { pointer-events: auto; }

/* ---- Edge tab ---- */
.ap-edge-tab {
  position: fixed;
  top: 50%; right: 0;
  transform: translateY(-50%);
  width: 28px; height: 64px;
  border-radius: 10px 0 0 10px;
  border: none; cursor: pointer;
  background: linear-gradient(180deg, #7c6cff 0%, #9f6bff 100%);
  box-shadow: -2px 0 10px rgba(124,108,255,0.3);
  display: flex; align-items: center; justify-content: center;
  color: #fff; padding: 0;
  transition: width 0.15s;
}
.ap-edge-tab:hover { width: 32px; }
.ap-edge-tab svg { width: 14px; height: 14px; transform: rotate(180deg); }
.ap-root.ap-expanded .ap-edge-tab { display: none; }
.ap-root.ap-collapsed .ap-panel { display: none; }

/* ---- Panel ---- */
.ap-panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 380px;
  background: #fff;
  border-left: 1px solid #eee;
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  display: flex; flex-direction: column;
  overflow: hidden;
  animation: ap-slide-in 0.2s ease-out;
}
@keyframes ap-slide-in {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}

/* ---- Header ---- */
.ap-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}
.ap-brand { display: flex; align-items: center; gap: 10px; }
.ap-brand-logo {
  width: 34px; height: 34px; border-radius: 10px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-weight: 800; font-size: 14px;
}
.ap-brand-name { font-weight: 800; font-size: 18px; color: #1a1a2e; letter-spacing: -0.3px; }
.ap-header-right { display: flex; align-items: center; gap: 6px; }
.ap-icon-btn {
  border: none; background: #f5f5f5;
  width: 30px; height: 30px; border-radius: 8px;
  cursor: pointer; color: #666;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.ap-icon-btn svg { width: 15px; height: 15px; }
.ap-icon-btn:hover { background: #eee; }

/* ---- Main content ---- */
.ap-content {
  flex: 1; overflow-y: auto; padding: 0;
  display: flex; flex-direction: column;
}

/* ---- Autofill button section ---- */
.ap-autofill-section {
  padding: 20px 16px;
  border-bottom: 1px solid #f0f0f0;
}
.ap-btn-autofill {
  width: 100%;
  padding: 16px;
  border: none;
  border-radius: 12px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(124,108,255,0.3);
  transition: transform 0.1s, box-shadow 0.1s;
}
.ap-btn-autofill:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(124,108,255,0.4);
}
.ap-btn-autofill:disabled { opacity: 0.5; cursor: default; transform: none; }
.ap-field-count {
  text-align: center;
  margin-top: 10px;
  font-size: 12px;
  color: #888;
}

/* ---- Banner ---- */
.ap-banner {
  margin: 12px 16px 0;
  border-radius: 10px; padding: 10px 12px; font-size: 12.5px;
  background: #e7f7ef; border: 1px solid #bfe8d4; color: #1e9e6a;
}
.ap-banner.warn { background: #fdf3e0; border-color: #f3ddb0; color: #b97d10; }
.ap-banner.error { background: #fdecea; border-color: #f5c6c0; color: #c0392b; }

/* ---- Section rows (accordion style) ---- */
.ap-section {
  border-bottom: 1px solid #f0f0f0;
}
.ap-section-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px; cursor: pointer;
  transition: background 0.1s;
}
.ap-section-header:hover { background: #fafafa; }
.ap-section-left { display: flex; align-items: center; gap: 10px; }
.ap-section-icon {
  width: 20px; height: 20px; color: #666;
  display: flex; align-items: center; justify-content: center;
}
.ap-section-icon svg { width: 18px; height: 18px; }
.ap-section-title { font-weight: 600; font-size: 14px; color: #1a1a2e; }
.ap-section-arrow { color: #999; display: flex; align-items: center; }
.ap-section-arrow svg { width: 16px; height: 16px; }
.ap-section-sub { padding: 0 16px 14px; font-size: 13px; color: #666; }
.ap-section-sub .ap-file-name { font-size: 12.5px; color: #444; margin-bottom: 8px; }
.ap-section-action {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 14px;
  background: #f9f8ff;
  border: 1px solid #e7e4ff;
  border-radius: 8px;
  font-size: 13px; font-weight: 600;
  color: #7c6cff;
  cursor: not-allowed;
  opacity: 0.6;
  margin-top: 6px;
}
.ap-section-action svg { width: 14px; height: 14px; }
.ap-coming-soon {
  font-size: 10px; font-weight: 500;
  color: #999; margin-left: auto;
  text-transform: uppercase; letter-spacing: 0.5px;
}

/* ---- Resume picker + upload ---- */
.ap-resume-select {
  width: 100%; padding: 9px 10px; margin-bottom: 8px;
  border: 1px solid #e0e0e0; border-radius: 8px;
  font-size: 13px; color: #1a1a2e; background: #fff;
}
.ap-resume-select:focus { outline: none; border-color: #7c6cff; box-shadow: 0 0 0 2px rgba(124,108,255,0.1); }
.ap-btn-upload {
  width: 100%; padding: 11px; border: none; border-radius: 9px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff; font-size: 13.5px; font-weight: 700; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 7px;
}
.ap-btn-upload:hover:not(:disabled) { box-shadow: 0 4px 14px rgba(124,108,255,0.3); }
.ap-btn-upload:disabled { opacity: 0.5; cursor: default; }
.ap-upload-status { margin-top: 8px; font-size: 12px; min-height: 16px; }
.ap-upload-status.ok { color: #1e9e6a; }
.ap-upload-status.warn { color: #b97d10; }
.ap-upload-status.error { color: #c0392b; }

/* ---- Autofill Info MODAL (centered on page) ---- */
.ap-modal-backdrop {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 2147483647;
}
.ap-modal-backdrop.visible { display: flex; }
.ap-modal {
  background: #fff;
  border-radius: 14px;
  width: 900px;
  max-width: 92vw;
  height: 85vh;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px rgba(0,0,0,0.25);
  animation: ap-modal-in 0.2s ease-out;
}
@keyframes ap-modal-in {
  from { opacity: 0; transform: scale(0.95) translateY(10px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.ap-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}
.ap-modal-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: #1a1a2e; }
.ap-modal-close {
  border: none; background: none; cursor: pointer;
  color: #666; padding: 4px;
}
.ap-modal-close svg { width: 22px; height: 22px; }
.ap-modal-close:hover { color: #333; }
.ap-modal-notice {
  padding: 12px 24px;
  background: #f8f9fa;
  border-bottom: 1px solid #f0f0f0;
  font-size: 12.5px; color: #555;
  display: flex; align-items: flex-start; gap: 8px;
}
.ap-modal-notice-icon { color: #7c6cff; flex-shrink: 0; margin-top: 1px; }
.ap-modal-body {
  flex: 1; display: flex; overflow: hidden; min-height: 0;
}
.ap-modal-sidebar {
  width: 160px;
  border-right: 1px solid #f0f0f0;
  padding: 16px 0;
  overflow-y: auto;
  flex-shrink: 0;
}
.ap-modal-sidebar-item {
  display: block;
  width: 100%;
  padding: 11px 20px;
  border: none; background: none;
  text-align: left;
  font-size: 13.5px; font-weight: 500;
  color: #555; cursor: pointer;
  border-left: 3px solid transparent;
  transition: all 0.1s;
}
.ap-modal-sidebar-item:hover { color: #1a1a2e; background: #fafafa; }
.ap-modal-sidebar-item.active {
  color: #1a1a2e; font-weight: 600;
  border-left-color: #7c6cff;
  background: #f9f8ff;
}
.ap-modal-form {
  flex: 1; padding: 20px 28px;
  overflow-y: auto;
}
.ap-form-row { margin-bottom: 16px; }
.ap-form-row label {
  display: block; font-size: 12.5px; font-weight: 600;
  color: #444; margin-bottom: 5px;
}
.ap-form-row label .ap-required { color: #e53e3e; font-weight: 700; }
.ap-form-row input, .ap-form-row select {
  width: 100%; padding: 10px 12px;
  border: 1px solid #e0e0e0; border-radius: 6px;
  font-size: 13.5px; color: #1a1a2e; background: #fff;
}
.ap-form-row input:focus, .ap-form-row select:focus {
  outline: none; border-color: #7c6cff;
  box-shadow: 0 0 0 2px rgba(124,108,255,0.1);
}
.ap-form-row input::placeholder { color: #bbb; }
.ap-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ap-form-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.ap-modal-footer {
  padding: 14px 24px;
  border-top: 1px solid #f0f0f0;
  display: flex; justify-content: center;
  flex-shrink: 0;
}
.ap-btn-update {
  padding: 12px 48px;
  border: none; border-radius: 999px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff; font-size: 14px; font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(124,108,255,0.25);
  transition: box-shadow 0.15s;
}
.ap-btn-update:hover { box-shadow: 0 6px 16px rgba(124,108,255,0.35); }

/* ---- Login view ---- */
.ap-login-view {
  flex: 1; padding: 20px 16px;
  display: none; flex-direction: column;
}
.ap-login-view.visible { display: flex; }
.ap-login-card {
  background: #fff; border: 1px solid #eee;
  border-radius: 12px; padding: 20px;
}
.ap-login-card h2 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
.ap-login-card .ap-muted { color: #888; font-size: 13px; margin-bottom: 14px; }
.ap-form-label { display: block; font-size: 12px; font-weight: 600; color: #666; margin: 12px 0 4px; }
.ap-form-label:first-of-type { margin-top: 0; }
.ap-input {
  width: 100%; border: 1px solid #e0e0e0; border-radius: 8px;
  padding: 10px 12px; font-size: 13px; background: #fff; color: #1a1a2e;
}
.ap-input:focus { outline: none; border-color: #7c6cff; box-shadow: 0 0 0 2px rgba(124,108,255,0.1); }
.ap-error { margin-top: 10px; font-size: 12px; color: #e53e3e; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 8px 10px; }
.ap-btn-login {
  width: 100%; margin-top: 14px; padding: 12px;
  border: none; border-radius: 10px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff; font-size: 14px; font-weight: 700; cursor: pointer;
}
.ap-btn-login:disabled { opacity: 0.5; cursor: default; }
.ap-login-divider { display: flex; align-items: center; margin: 14px 0; gap: 8px; }
.ap-login-divider::before, .ap-login-divider::after { content: ""; flex: 1; height: 1px; background: #eee; }
.ap-login-divider span { font-size: 11px; color: #999; text-transform: uppercase; }
.ap-google-btn {
  width: 100%; padding: 11px;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: #fff; border: 1px solid #e0e0e0; border-radius: 10px;
  font-size: 13px; font-weight: 600; color: #1a1a2e; cursor: pointer;
}
.ap-google-btn:hover { background: #fafafa; }
.ap-btn-mock {
  width: 100%; margin-top: 10px; padding: 10px;
  border: none; background: none;
  color: #7c6cff; font-size: 13px; font-weight: 600; cursor: pointer;
}
.ap-btn-mock:hover { text-decoration: underline; }

/* ---- Footer ---- */
.ap-footer {
  display: flex; align-items: center; justify-content: center;
  padding: 10px 16px;
  border-top: 1px solid #f0f0f0;
  background: #fafafa;
  flex-shrink: 0;
}
.ap-footer-link {
  border: none; background: none;
  color: #7c6cff; font-size: 12px; font-weight: 600;
  cursor: pointer; text-decoration: underline;
}

/* ---- Misc ---- */
.ap-spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid #f0eeff; border-top-color: #7c6cff;
  border-radius: 50%; animation: ap-spin 0.8s linear infinite;
  vertical-align: -2px; margin-right: 6px;
}
@keyframes ap-spin { to { transform: rotate(360deg); } }
`;


// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const HOST_ID = "applypilot-overlay-host";

type View = "main" | "login" | "info";

interface PanelState {
  config: ExtensionConfig | null;
  status: StatusResponse | null;
  profile: UserApplicationProfile | null;
  source: ProfileSource | null;
  resumes: ResumeSummary[];
  fields: DetectedField[];
  tabUrl: string;
  selected: Set<string>;
  outcomes: Map<string, FillOutcome>;
  busy: boolean;
  scanned: boolean;
  view: View;
  infoCategory: string;
}

let shadow: ShadowRoot | null = null;
let callbacks: OverlayCallbacks | null = null;
let panelExpanded = false;
let initialized = false;

const overlayState: PanelState = {
  config: null,
  status: null,
  profile: null,
  source: null,
  resumes: [],
  fields: [],
  tabUrl: "",
  selected: new Set(),
  outcomes: new Map(),
  busy: false,
  scanned: false,
  view: "main",
  infoCategory: "personal",
};

interface Refs {
  root: HTMLDivElement;
  edgeTab: HTMLButtonElement;
  panel: HTMLDivElement;
  content: HTMLDivElement;
  btnAutofill: HTMLButtonElement;
  fieldCount: HTMLDivElement;
  banner: HTMLDivElement;
  resumeName: HTMLDivElement;
  resumeSelect: HTMLSelectElement;
  btnUploadResume: HTMLButtonElement;
  uploadStatus: HTMLDivElement;
  modalBackdrop: HTMLDivElement;
  infoSidebar: HTMLDivElement;
  infoForm: HTMLDivElement;
  loginView: HTMLDivElement;
  loginEmail: HTMLInputElement;
  loginPassword: HTMLInputElement;
  loginError: HTMLDivElement;
  btnLogin: HTMLButtonElement;
  btnGoogleLogin: HTMLButtonElement;
}

let refs: Refs | null = null;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function bg<T>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

function ensureMounted(): void {
  if (shadow && document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all: initial;";
  shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  const root = document.createElement("div");
  root.className = "ap-root ap-collapsed";
  root.innerHTML = buildHTML();
  shadow.appendChild(root);
  (document.documentElement || document.body).appendChild(host);

  wireEvents(root);
  refs = collectRefs(root);
}

function buildHTML(): string {
  return `
    <button class="ap-edge-tab" type="button" title="Open Tailrd" aria-label="Open Tailrd">
      ${I_CHEVRON_RIGHT}
    </button>
    <div class="ap-panel">
      <!-- Header -->
      <header class="ap-header">
        <div class="ap-brand">
          <span class="ap-brand-logo">T</span>
          <span class="ap-brand-name">Tailrd</span>
        </div>
        <div class="ap-header-right">
          <button class="ap-icon-btn" id="ap-btn-settings" title="Settings">${I_GEAR}</button>
          <button class="ap-icon-btn" id="ap-btn-close" title="Close">${I_CLOSE}</button>
        </div>
      </header>

      <!-- Main content -->
      <div class="ap-content" id="ap-content">
        <!-- Autofill button -->
        <div class="ap-autofill-section">
          <button class="ap-btn-autofill" id="ap-btn-autofill" disabled>Autofill</button>
          <div class="ap-field-count" id="ap-field-count"></div>
        </div>

        <!-- Banner -->
        <div class="ap-banner" id="ap-banner" style="display:none"></div>

        <!-- Your Autofill Information -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-info">
            <div class="ap-section-left">
              <span class="ap-section-icon">${icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>', 18)}</span>
              <span class="ap-section-title">Your Autofill Information</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_RIGHT}</span>
          </div>
        </div>

        <!-- Upload Resume -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-resume">
            <div class="ap-section-left">
              <span class="ap-section-icon">${icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', 18)}</span>
              <span class="ap-section-title">Upload Resume</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_DOWN}</span>
          </div>
          <div class="ap-section-sub" id="ap-resume-sub" style="display:none">
            <div class="ap-file-name" id="ap-resume-name">No resume uploaded</div>
            <select class="ap-resume-select" id="ap-resume-select" style="display:none"></select>
            <button class="ap-btn-upload" id="ap-btn-upload-resume" type="button" disabled>
              ${icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', 14)}
              Upload résumé to this form
            </button>
            <div class="ap-upload-status" id="ap-upload-status"></div>
          </div>
        </div>

        <!-- Upload Cover Letter -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-cover">
            <div class="ap-section-left">
              <span class="ap-section-icon">${icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>', 18)}</span>
              <span class="ap-section-title">Upload Cover Letter</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_DOWN}</span>
          </div>
          <div class="ap-section-sub" id="ap-cover-sub" style="display:none">
            <div class="ap-file-name" id="ap-cover-name">No cover letter uploaded</div>
            <div class="ap-section-action">
              ${icon('<polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/>', 14)}
              Generate Cover Letter
              <span class="ap-coming-soon">Coming soon</span>
            </div>
          </div>
        </div>

        <!-- Login view (shown when signed out) -->
        <div class="ap-login-view" id="ap-login-view">
          <div class="ap-login-card">
            <h2>Connect your account</h2>
            <p class="ap-muted">Sign in to Tailrd to autofill with your profile.</p>
            <label class="ap-form-label" for="ap-login-email">Email</label>
            <input id="ap-login-email" class="ap-input" type="email" autocomplete="username" />
            <label class="ap-form-label" for="ap-login-password">Password</label>
            <input id="ap-login-password" class="ap-input" type="password" autocomplete="current-password" />
            <div id="ap-login-error" class="ap-error" style="display:none"></div>
            <button id="ap-btn-login" class="ap-btn-login" type="button">Sign in</button>
            <div class="ap-login-divider"><span>or</span></div>
            <button id="ap-btn-google-login" class="ap-google-btn" type="button">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
            <button id="ap-btn-use-mock" class="ap-btn-mock" type="button">Continue with sample data</button>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <footer class="ap-footer">
        <button class="ap-footer-link" id="ap-btn-dashboard">Open Dashboard</button>
      </footer>
    </div>

    <!-- Autofill Information MODAL (page-level, outside the side panel) -->
    <div class="ap-modal-backdrop" id="ap-modal-backdrop">
      <div class="ap-modal">
        <div class="ap-modal-header">
          <h2>Your Autofill information</h2>
          <button class="ap-modal-close" id="ap-info-close">${I_CLOSE}</button>
        </div>
        <div class="ap-modal-notice">
          <span class="ap-modal-notice-icon">${icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', 14)}</span>
          <span>Your autofill information updates automatically when you <b>change your upload resume</b> or <b>update information</b> in an application form.</span>
        </div>
        <div class="ap-modal-body">
          <div class="ap-modal-sidebar" id="ap-info-sidebar">
            <button class="ap-modal-sidebar-item active" data-cat="personal">Personal</button>
            <button class="ap-modal-sidebar-item" data-cat="education">Education</button>
            <button class="ap-modal-sidebar-item" data-cat="experience">Work Experience</button>
            <button class="ap-modal-sidebar-item" data-cat="skill">Skill</button>
            <button class="ap-modal-sidebar-item" data-cat="preference">Preference</button>
          </div>
          <div class="ap-modal-form" id="ap-info-form"></div>
        </div>
        <div class="ap-modal-footer">
          <button class="ap-btn-update" id="ap-btn-update">Update</button>
        </div>
      </div>
    </div>
  `;
}


function collectRefs(root: HTMLDivElement): Refs {
  function q<T extends HTMLElement>(sel: string): T {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`Missing ${sel}`);
    return el;
  }
  return {
    root,
    edgeTab: q(".ap-edge-tab"),
    panel: q(".ap-panel"),
    content: q("#ap-content"),
    btnAutofill: q("#ap-btn-autofill"),
    fieldCount: q("#ap-field-count"),
    banner: q("#ap-banner"),
    resumeName: q("#ap-resume-name"),
    resumeSelect: q("#ap-resume-select"),
    btnUploadResume: q("#ap-btn-upload-resume"),
    uploadStatus: q("#ap-upload-status"),
    modalBackdrop: q("#ap-modal-backdrop"),
    infoSidebar: q("#ap-info-sidebar"),
    infoForm: q("#ap-info-form"),
    loginView: q("#ap-login-view"),
    loginEmail: q("#ap-login-email"),
    loginPassword: q("#ap-login-password"),
    loginError: q("#ap-login-error"),
    btnLogin: q("#ap-btn-login"),
    btnGoogleLogin: q("#ap-btn-google-login"),
  };
}

function wireEvents(root: HTMLDivElement): void {
  // Edge tab -> open panel
  root.querySelector(".ap-edge-tab")!.addEventListener("click", () => {
    setExpanded(true);
    if (!initialized) void initPanel();
  });

  // Close button
  root.querySelector("#ap-btn-close")!.addEventListener("click", () => setExpanded(false));

  // Settings -> open dashboard (simplified: no in-panel settings for now)
  root.querySelector("#ap-btn-settings")!.addEventListener("click", () => {
    void bg<SimpleResponse>({ type: "OPEN_DASHBOARD" });
  });

  // Dashboard footer link
  root.querySelector("#ap-btn-dashboard")!.addEventListener("click", () => {
    void bg<SimpleResponse>({ type: "OPEN_DASHBOARD" });
  });

  // Autofill button
  root.querySelector("#ap-btn-autofill")!.addEventListener("click", () => void doAutofill());

  // "Your Autofill Information" section -> open info view
  root.querySelector("#ap-section-info")!.addEventListener("click", () => {
    showInfoView();
  });

  // Resume section toggle
  root.querySelector("#ap-section-resume")!.addEventListener("click", () => {
    const sub = root.querySelector<HTMLElement>("#ap-resume-sub")!;
    const opening = sub.style.display === "none";
    sub.style.display = opening ? "block" : "none";
    if (opening) renderResumeSection();
  });

  // Upload résumé to the current form
  root.querySelector("#ap-btn-upload-resume")!.addEventListener("click", () => void doUploadResume());

  // Cover letter section toggle
  root.querySelector("#ap-section-cover")!.addEventListener("click", () => {
    const sub = root.querySelector<HTMLElement>("#ap-cover-sub")!;
    sub.style.display = sub.style.display === "none" ? "block" : "none";
  });

  // Info view close
  root.querySelector("#ap-info-close")!.addEventListener("click", () => {
    hideInfoView();
  });

  // Close modal when clicking backdrop
  root.querySelector("#ap-modal-backdrop")!.addEventListener("click", (e) => {
    if (e.target === root.querySelector("#ap-modal-backdrop")) {
      hideInfoView();
    }
  });

  // Info sidebar category clicks
  root.querySelectorAll<HTMLButtonElement>(".ap-modal-sidebar-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlayState.infoCategory = btn.dataset.cat!;
      root.querySelectorAll<HTMLButtonElement>(".ap-modal-sidebar-item").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
      renderInfoForm();
    });
  });

  // Update button (save profile edits back to state)
  root.querySelector("#ap-btn-update")!.addEventListener("click", () => {
    // For now just close the info view; actual save will be wired later
    hideInfoView();
  });

  // Login
  root.querySelector("#ap-btn-login")!.addEventListener("click", () => void doEmailLogin());
  root.querySelector("#ap-login-email")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void doEmailLogin();
  });
  root.querySelector("#ap-login-password")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void doEmailLogin();
  });
  root.querySelector("#ap-btn-google-login")!.addEventListener("click", () => void doGoogleLogin());
  root.querySelector("#ap-btn-use-mock")!.addEventListener("click", () => {
    void saveConfig({ useMockData: true }).then(() => void initPanel());
  });
}

// ---------------------------------------------------------------------------
// Panel init
// ---------------------------------------------------------------------------

async function initPanel(): Promise<void> {
  initialized = true;
  overlayState.config = await getConfig();

  const status = await bg<StatusResponse>({ type: "GET_STATUS" }).catch(() => null);
  overlayState.status = status;

  if (status && status.mode === "signedOut") {
    showLoginView();
    return;
  }

  hideLoginView();
  await loadProfile();
}

async function loadProfile(): Promise<void> {
  const resp = await bg<ProfileResponse>({ type: "GET_PROFILE" }).catch(() => null);
  if (!resp || !resp.ok) {
    if (resp?.needsLogin) { showLoginView(); return; }
  } else {
    overlayState.profile = resp.profile ?? null;
    overlayState.source = resp.source ?? null;
  }
  overlayState.scanned = true;
  applyDefaultSelection();
  refreshMainView();
  void loadResumes();
}

async function loadResumes(): Promise<void> {
  if (!callbacks) return;
  try {
    overlayState.resumes = await callbacks.onListResumes();
  } catch {
    overlayState.resumes = [];
  }
  renderResumeSection();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function setExpanded(val: boolean): void {
  panelExpanded = val;
  if (!refs) return;
  refs.root.classList.toggle("ap-expanded", val);
  refs.root.classList.toggle("ap-collapsed", !val);
}

function showLoginView(): void {
  if (!refs) return;
  refs.loginView.classList.add("visible");
}

function hideLoginView(): void {
  if (!refs) return;
  refs.loginView.classList.remove("visible");
}

function showInfoView(): void {
  if (!refs) return;
  refs.modalBackdrop.classList.add("visible");
  overlayState.infoCategory = "personal";
  refs.infoSidebar.querySelectorAll<HTMLButtonElement>(".ap-modal-sidebar-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.cat === "personal")
  );
  renderInfoForm();
}

function hideInfoView(): void {
  if (!refs) return;
  refs.modalBackdrop.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Main view rendering
// ---------------------------------------------------------------------------

function refreshMainView(): void {
  if (!refs) return;
  const { fields, selected } = overlayState;
  const count = selected.size;

  refs.btnAutofill.disabled = overlayState.busy || count === 0;
  refs.btnAutofill.textContent = overlayState.busy ? "Working\u2026" : "Autofill";

  if (fields.length > 0) {
    refs.fieldCount.textContent = `${count} of ${fields.length} fields ready to fill`;
  } else {
    refs.fieldCount.textContent = overlayState.scanned
      ? "No form fields detected on this page"
      : "Scanning page\u2026";
  }

  // Keep the r\u00e9sum\u00e9-upload button in sync as the form is (re)scanned.
  updateUploadButtonState();
}

// ---------------------------------------------------------------------------
// Resume sync + auto-upload
// ---------------------------------------------------------------------------

/** True when the current page exposes a r\u00e9sum\u00e9 file-upload control. */
function hasResumeField(): boolean {
  return overlayState.fields.some(
    (f) => f.category === "resumeUpload" && f.controlType === "file"
  );
}

function updateUploadButtonState(): void {
  if (!refs) return;
  const canUpload =
    hasResumeField() && overlayState.resumes.some((r) => r.hasFile) && !overlayState.busy;
  refs.btnUploadResume.disabled = !canUpload;
}

function setUploadStatus(text: string, kind: "ok" | "warn" | "error" | ""): void {
  if (!refs) return;
  refs.uploadStatus.textContent = text;
  refs.uploadStatus.className = "ap-upload-status" + (kind ? ` ${kind}` : "");
}

/** Render the r\u00e9sum\u00e9 picker + header + hint (called on section open / load). */
function renderResumeSection(): void {
  if (!refs) return;
  const { resumes } = overlayState;
  const withFile = resumes.filter((r) => r.hasFile);

  if (resumes.length === 0) {
    refs.resumeName.textContent = "No resume uploaded yet \u2014 add one in the dashboard.";
  } else {
    const primary = resumes.find((r) => r.isPrimary) ?? resumes[0];
    refs.resumeName.textContent = `Active resume: ${primary.name}`;
  }

  // Only show the picker when there's an actual choice of downloadable files.
  if (withFile.length > 1) {
    refs.resumeSelect.style.display = "block";
    refs.resumeSelect.innerHTML = withFile
      .map(
        (r) =>
          `<option value="${r.id}">${esc(r.name)}${r.isPrimary ? " (active)" : ""}</option>`
      )
      .join("");
    const primary = withFile.find((r) => r.isPrimary) ?? withFile[0];
    refs.resumeSelect.value = String(primary.id);
  } else {
    refs.resumeSelect.style.display = "none";
  }

  updateUploadButtonState();

  if (resumes.length > 0 && withFile.length === 0) {
    setUploadStatus(
      "Your resume has no stored file \u2014 re-upload it in the dashboard to enable auto-upload.",
      "warn"
    );
  } else if (!hasResumeField()) {
    setUploadStatus("No r\u00e9sum\u00e9 field detected on this page.", "");
  } else {
    setUploadStatus("", "");
  }
}

async function doUploadResume(): Promise<void> {
  if (!refs || !callbacks || overlayState.busy) return;
  const withFile = overlayState.resumes.filter((r) => r.hasFile);
  if (withFile.length === 0) return;

  const picked =
    refs.resumeSelect.style.display !== "none" && refs.resumeSelect.value
      ? Number(refs.resumeSelect.value)
      : (withFile.find((r) => r.isPrimary) ?? withFile[0]).id;

  overlayState.busy = true;
  refs.btnUploadResume.disabled = true;
  setUploadStatus("Uploading r\u00e9sum\u00e9\u2026", "");
  try {
    const res = await callbacks.onUploadResume(picked);
    if (res.ok) {
      setUploadStatus("R\u00e9sum\u00e9 attached. Review before submitting.", "ok");
    } else {
      setUploadStatus(res.reason ?? "Upload failed \u2014 attach manually.", "error");
    }
  } catch (err) {
    setUploadStatus(err instanceof Error ? err.message : "Upload failed.", "error");
  } finally {
    overlayState.busy = false;
    updateUploadButtonState();
  }
}

function applyDefaultSelection(): void {
  overlayState.selected = defaultSelectedIds(overlayState.fields);
}

// ---------------------------------------------------------------------------
// Autofill
// ---------------------------------------------------------------------------

async function doAutofill(): Promise<void> {
  if (!callbacks || overlayState.busy) return;
  const ids = [...overlayState.selected];
  if (ids.length === 0) return;

  overlayState.busy = true;
  refreshMainView();
  showBanner("", "ok", true);

  try {
    const { ok, fail, total } = await callbacks.onAutofill(ids);
    const txt =
      `Filled ${ok} of ${total} field${total === 1 ? "" : "s"}` +
      (fail > 0 ? ` (${fail} need attention)` : "") +
      ". Review before submitting.";
    showBanner(txt, fail > 0 ? "warn" : "ok");
  } catch (err) {
    showBanner(`Autofill failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  } finally {
    overlayState.busy = false;
    refreshMainView();
  }
}

function showBanner(text: string, kind: "ok" | "warn" | "error", hide = false): void {
  if (!refs) return;
  if (hide || !text) { refs.banner.style.display = "none"; return; }
  refs.banner.style.display = "block";
  refs.banner.className = "ap-banner" + (kind === "ok" ? "" : ` ${kind}`);
  refs.banner.textContent = text;
}

// ---------------------------------------------------------------------------
// Autofill Information form
// ---------------------------------------------------------------------------

function renderInfoForm(): void {
  if (!refs) return;
  const p = overlayState.profile;
  const cat = overlayState.infoCategory;
  const form = refs.infoForm;
  form.innerHTML = "";

  if (!p) {
    form.innerHTML = '<div style="padding:20px;text-align:center;color:#888">Sign in and upload a resume to see your information.</div>';
    return;
  }

  switch (cat) {
    case "personal":
      form.innerHTML = `
        <div class="ap-form-grid-3">
          <div class="ap-form-row"><label><span class="ap-required">*</span>First Name</label><input value="${esc(p.firstName)}" readonly /></div>
          <div class="ap-form-row"><label>Middle Name</label><input placeholder="Enter your middle name" readonly /></div>
          <div class="ap-form-row"><label><span class="ap-required">*</span>Last Name</label><input value="${esc(p.lastName)}" readonly /></div>
        </div>
        <div class="ap-form-row"><label><span class="ap-required">*</span>Email Address</label><input value="${esc(p.email)}" readonly /></div>
        <div class="ap-form-row"><label><span class="ap-required">*</span>Phone</label><input value="${esc(p.phone)}" readonly /></div>
        <div class="ap-form-row"><label>Location</label><input value="${esc(p.location)}" readonly /></div>
        <div class="ap-form-grid">
          <div class="ap-form-row"><label>LinkedIn</label><input value="${esc(p.linkedin)}" readonly /></div>
          <div class="ap-form-row"><label>GitHub</label><input value="${esc(p.github)}" readonly /></div>
        </div>
        <div class="ap-form-row"><label>Portfolio</label><input value="${esc(p.portfolio)}" readonly /></div>
      `;
      break;
    case "education":
      if (p.education.length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:#888">No education entries yet.</div>';
      } else {
        let html = "";
        for (const e of p.education) {
          html += `
            <div class="ap-form-row"><label>School</label><input value="${esc(e.school)}" readonly /></div>
            <div class="ap-form-grid">
              <div class="ap-form-row"><label>Degree</label><input value="${esc(e.degree)}" readonly /></div>
              <div class="ap-form-row"><label>Graduation Year</label><input value="${esc(e.graduationYear)}" readonly /></div>
            </div>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:14px 0" />
          `;
        }
        form.innerHTML = html;
      }
      break;
    case "experience":
      if (p.experience.length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:#888">No work experience entries yet.</div>';
      } else {
        let html = "";
        for (const e of p.experience) {
          html += `
            <div class="ap-form-grid">
              <div class="ap-form-row"><label>Company</label><input value="${esc(e.company)}" readonly /></div>
              <div class="ap-form-row"><label>Title</label><input value="${esc(e.title)}" readonly /></div>
            </div>
            <div class="ap-form-grid">
              <div class="ap-form-row"><label>Start Date</label><input value="${esc(e.startDate)}" readonly /></div>
              <div class="ap-form-row"><label>End Date</label><input value="${esc(e.endDate || "Present")}" readonly /></div>
            </div>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:14px 0" />
          `;
        }
        form.innerHTML = html;
      }
      break;
    case "skill":
      if (p.skills.length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:#888">No skills on file yet.</div>';
      } else {
        form.innerHTML = `<div class="ap-form-row"><label>Skills</label><input value="${esc(p.skills.join(", "))}" readonly /></div>`;
      }
      break;
    case "preference":
      form.innerHTML = `
        <div class="ap-form-row"><label>Work Authorization</label><input value="${esc(p.workAuthorization)}" readonly /></div>
        <div class="ap-form-row"><label>Requires Sponsorship</label><input value="${esc(p.requiresSponsorship)}" readonly /></div>
        ${p.salaryExpectation ? `<div class="ap-form-row"><label>Salary Expectation</label><input value="${esc(p.salaryExpectation)}" readonly /></div>` : ""}
      `;
      break;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function doEmailLogin(): Promise<void> {
  if (!refs) return;
  const email = refs.loginEmail.value.trim();
  const password = refs.loginPassword.value;
  refs.loginError.style.display = "none";

  refs.btnLogin.disabled = true;
  refs.btnLogin.textContent = "Signing in\u2026";
  try {
    const resp = await bg<LoginResponse>({ type: "LOGIN", email, password });
    if (!resp.ok) {
      refs.loginError.style.display = "block";
      refs.loginError.textContent = resp.error ?? "Login failed";
      return;
    }
    await saveConfig({ useMockData: false });
    await reInit();
  } finally {
    if (refs) {
      refs.btnLogin.disabled = false;
      refs.btnLogin.textContent = "Sign in";
    }
  }
}

async function doGoogleLogin(): Promise<void> {
  if (!refs) return;
  refs.loginError.style.display = "none";
  refs.btnGoogleLogin.disabled = true;
  refs.btnGoogleLogin.textContent = "Signing in\u2026";
  try {
    const resp = await bg<LoginResponse>({ type: "GOOGLE_LOGIN" });
    if (!resp.ok) {
      refs.loginError.style.display = "block";
      refs.loginError.textContent = resp.error ?? "Google sign-in failed";
      return;
    }
    await saveConfig({ useMockData: false });
    await reInit();
  } finally {
    if (refs) {
      refs.btnGoogleLogin.disabled = false;
      refs.btnGoogleLogin.textContent = "Sign in with Google";
    }
  }
}

async function reInit(): Promise<void> {
  overlayState.config = null;
  overlayState.status = null;
  overlayState.profile = null;
  overlayState.source = null;
  overlayState.resumes = [];
  overlayState.selected = new Set();
  overlayState.outcomes = new Map();
  overlayState.busy = false;
  overlayState.scanned = false;
  initialized = false;
  hideInfoView();
  await initPanel();
}
