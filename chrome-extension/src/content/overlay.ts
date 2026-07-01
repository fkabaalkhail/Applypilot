/**
 * In-page overlay — Tailrd side panel UI embedded in a Shadow DOM.
 *
 * The panel docks to the right edge of the viewport at full height.
 * When collapsed, a small branded tab sits on the right edge to reopen.
 *
 * Simplified layout inspired by Jobright:
 *  - Big "Autofill" button at top
 *  - "Your Autofill Information" expands into a categorized form editor
 *  - "Upload Resume" section with "Generate Custom Resume"
 *  - "Upload Cover Letter" section with "Generate Cover Letter"
 */

import { reattachIfDetached } from "./domUtils";
import { base64ToFile } from "./fileUpload";
import { buildTailorCardHtml } from "./tailorCard";
import { buildCoverLetterCardHtml } from "./coverLetterCard";
import { defaultSelectedIds } from "../shared/selection";
import { getConfig, saveConfig, type ExtensionConfig } from "../shared/storage";
import type {
  AiDraft,
  BackgroundRequest,
  CoverLetterGenOpts,
  DetectedField,
  FillOutcome,
  LoginResponse,
  ProfileResponse,
  ProfileSource,
  RenderResumeResponse,
  ResumeDoc,
  ResumeSummary,
  SimpleResponse,
  StatusResponse,
  TailorResult,
  TailorResumeOpts,
  UserApplicationProfile,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Public API (called from contentScript.ts)
// ---------------------------------------------------------------------------

export interface OverlayCallbacks {
  onAutofill: (
    fieldIds: string[]
  ) => Promise<{ ok: number; fail: number; total: number; drafts: AiDraft[] }>;
  onInsertAnswer: (fieldId: string, value: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Persist an accepted/edited answer to the Question Memory (best-effort). */
  onSaveAnswer: (question: string, answer: string) => Promise<{ ok: boolean }>;
  onRescan: () => void;
  /** List the user's resumes for the picker / auto-upload. */
  onListResumes: () => Promise<ResumeSummary[]>;
  /** Inject the chosen resume's file into the page's upload control. */
  onUploadResume: (resumeId: number) => Promise<{ ok: boolean; reason?: string }>;
  /** Tailor the active résumé to this page's job; returns scores + keywords. */
  onTailorResume: (
    opts: TailorResumeOpts
  ) => Promise<{ ok: boolean; needsLogin?: boolean; reason?: string; result?: TailorResult }>;
  /** Render the tailored document to PDF and attach it to the upload field. */
  onAttachTailored: (document: ResumeDoc) => Promise<{ ok: boolean; reason?: string }>;
  /** Render the tailored document to PDF and download it. */
  onDownloadTailored: (document: ResumeDoc) => Promise<{ ok: boolean; reason?: string }>;
  /** Generate (or rewrite) a cover letter for this page's job. */
  onGenerateCoverLetter: (
    opts: CoverLetterGenOpts
  ) => Promise<{ ok: boolean; needsLogin?: boolean; reason?: string; text?: string }>;
  /** Insert the cover letter into the page (textarea, else attach a PDF). */
  onInsertCoverLetter: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Render the cover letter to PDF and download it. */
  onDownloadCoverLetter: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Copy the cover letter to the clipboard. */
  onCopyCoverLetter: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Hand the resolved account profile to the content script so it can compute
   * each field's proposed value. Without this the scanner has no data, every
   * field's `proposedValue` is null, nothing is pre-selected, and the Autofill
   * button stays disabled. The content script re-scans and pushes the enriched
   * fields back via `updateOverlay`.
   */
  onProfileResolved: (profile: UserApplicationProfile | null) => void;
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
  if (host) reattachIfDetached(host, document.documentElement || document.body);
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  // Re-derive the default selection so the Autofill button reflects the latest
  // scan. Selection is purely computed from the fields (there is no per-field
  // toggle UI), so recomputing it on every update is safe — and necessary, since
  // proposed values only appear after the profile reaches the scanner.
  applyDefaultSelection();
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

// Phosphor (regular weight) icons. Sized by CSS (viewBox 0 0 256 256, fill
// currentColor) so every icon shares one minimalist visual language.
function ph(pathData: string): string {
  return `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${pathData}</svg>`;
}

const P_X = '<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>';
const P_CARET_RIGHT = '<path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/>';
const P_CARET_DOWN = '<path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>';
const P_GEAR = '<path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z"/>';
const P_FILE = '<path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z"/>';
const P_UPLOAD = '<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z"/>';
const P_STAR = '<path d="M239.18,97.26A16.38,16.38,0,0,0,224.92,86l-59-4.76L143.14,26.15a16.36,16.36,0,0,0-30.27,0L90.11,81.23,31.08,86a16.46,16.46,0,0,0-9.37,28.86l45,38.83L53,211.75a16.38,16.38,0,0,0,24.5,17.82L128,198.49l50.53,31.08A16.4,16.4,0,0,0,203,211.75l-13.76-58.07,45-38.83A16.43,16.43,0,0,0,239.18,97.26Z"/>';
const P_ENVELOPE = '<path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48Zm-96,85.15L52.57,64H203.43ZM98.71,128,40,181.81V74.19Zm11.84,10.85,12,11.05a8,8,0,0,0,10.82,0l12-11.05,58,53.15H52.57ZM157.29,128,216,74.18V181.82Z"/>';
const P_REGEN = '<path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"/>';
const P_DOWNLOAD = '<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"/>';
const P_PAPERCLIP = '<path d="M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z"/>';
const P_CHECK = '<path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/>';
const P_DASH = '<path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"/>';
const P_INFO = '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z"/>';

const I_CLOSE = ph(P_X);
const I_CHEVRON_RIGHT = ph(P_CARET_RIGHT);
const I_CHEVRON_DOWN = ph(P_CARET_DOWN);
const I_GEAR = ph(P_GEAR);
const I_FILE = ph(P_FILE);
const I_UPLOAD = ph(P_UPLOAD);
const I_STAR = ph(P_STAR);
const I_ENVELOPE = ph(P_ENVELOPE);
const I_REGEN = ph(P_REGEN);
const I_DOWNLOAD = ph(P_DOWNLOAD);
const I_PAPERCLIP = ph(P_PAPERCLIP);
const I_CHECK = ph(P_CHECK);
const I_DASH = ph(P_DASH);
const I_INFO = ph(P_INFO);

// The Tailrd brand mark, drawn as inline SVG (a purple paper-plane in a ring).
// Inline SVG is immune to the page's img-src CSP, which blocks data:-URI <img>.
const I_BRAND =
  '<svg viewBox="0 0 256 256" fill="none" aria-hidden="true">' +
  '<circle cx="128" cy="128" r="112" stroke="currentColor" stroke-width="13"/>' +
  '<g transform="translate(40 42) scale(0.66)"><path fill="currentColor" d="M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z"/></g>' +
  "</svg>";


// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.ap-root {
  /* ===== Stripe design system tokens — mirrors the web app's index.css ===== */
  --stripe-primary: #533afd;
  --stripe-primary-deep: #4434d4;
  --stripe-primary-press: #2e2b8c;
  --stripe-primary-soft: #665efd;
  --stripe-primary-rgb: 83, 58, 253;
  --stripe-ink: #0d253d;
  --stripe-ink-secondary: #273951;
  --stripe-ink-mute: #64748d;
  --stripe-canvas: #ffffff;
  --stripe-canvas-soft: #f6f9fc;
  --stripe-hairline: #e3e8ee;
  --stripe-hairline-soft: #eef2f6;
  --stripe-accent-light: var(--stripe-accent-light);
  --stripe-accent-soft: #d8d4ff;
  --stripe-shadow-rgb: 0, 55, 112;

  position: fixed;
  top: 0; right: 0; bottom: 0;
  z-index: 2147483647;
  font-family: 'Inter', 'SF Pro Display', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-feature-settings: "ss01";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-size: 14px;
  color: var(--stripe-ink);
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
  background: linear-gradient(180deg, var(--stripe-primary) 0%, var(--stripe-primary-deep) 100%);
  box-shadow: -2px 0 10px rgba(var(--stripe-primary-rgb),0.3);
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
  border-left: 1px solid var(--stripe-hairline);
  box-shadow: -4px 0 24px rgba(var(--stripe-shadow-rgb), 0.12);
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
  border-bottom: 1px solid var(--stripe-hairline-soft);
  flex-shrink: 0;
}
.ap-brand { display: flex; align-items: center; gap: 10px; }
.ap-brand-logo {
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  color: var(--stripe-primary);
}
.ap-brand-logo svg { width: 28px; height: 28px; }
.ap-brand-name { font-weight: 800; font-size: 18px; color: var(--stripe-ink); letter-spacing: -0.3px; }
.ap-header-right { display: flex; align-items: center; gap: 6px; }
.ap-icon-btn {
  border: none; background: var(--stripe-canvas-soft);
  width: 30px; height: 30px; border-radius: 8px;
  cursor: pointer; color: var(--stripe-ink-mute);
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.ap-icon-btn svg { width: 15px; height: 15px; }
.ap-icon-btn:hover { background: var(--stripe-hairline); }

/* ---- Main content ---- */
.ap-content {
  flex: 1; overflow-y: auto; padding: 0;
  display: flex; flex-direction: column;
}

/* ---- Autofill button section ---- */
.ap-autofill-section {
  padding: 20px 16px;
  border-bottom: 1px solid var(--stripe-hairline-soft);
}
.ap-btn-autofill {
  width: 100%;
  padding: 16px;
  border: none;
  border-radius: 9999px;
  background: var(--stripe-primary);
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(var(--stripe-primary-rgb),0.28);
  transition: background 0.15s, transform 0.1s, box-shadow 0.1s;
}
.ap-btn-autofill:hover:not(:disabled) {
  background: var(--stripe-primary-press);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(var(--stripe-primary-rgb),0.32);
}
.ap-btn-autofill:disabled { opacity: 0.5; cursor: default; transform: none; }
.ap-field-count {
  text-align: center;
  margin-top: 10px;
  font-size: 12px;
  color: var(--stripe-ink-mute);
}

/* ---- Banner ---- */
.ap-banner {
  margin: 12px 16px 0;
  border-radius: 10px; padding: 10px 12px; font-size: 12.5px;
  background: #e7f7ef; border: 1px solid #bfe8d4; color: #1e9e6a;
}
.ap-banner.warn { background: #fdf3e0; border-color: #f3ddb0; color: #b97d10; }
.ap-banner.error { background: #fdecea; border-color: #f5c6c0; color: #c0392b; }

/* ---- Detection checklist (field name → ✓ filled / – empty) ---- */
.ap-checklist { margin: 14px 16px 2px; }
.ap-chk-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--stripe-ink-mute); margin-bottom: 8px;
}
.ap-chk-count { text-transform: none; letter-spacing: 0; font-weight: 600; }
.ap-chk-row { display: flex; align-items: center; gap: 9px; padding: 4px 0; font-size: 13px; }
.ap-chk-ic { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.ap-chk-ic svg { width: 16px; height: 16px; }
.ap-chk-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-chk-row.is-filled .ap-chk-ic { color: #16a34a; }
.ap-chk-row.is-filled .ap-chk-label { color: var(--stripe-ink); }
.ap-chk-row.is-empty .ap-chk-ic { color: var(--stripe-ink-mute); opacity: 0.55; }
.ap-chk-row.is-empty .ap-chk-label { color: var(--stripe-ink-mute); }

/* ---- Tailored résumé PDF preview (covers the side panel) ---- */
.ap-pdf-modal {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 380px; max-width: 100vw;
  background: var(--stripe-canvas);
  z-index: 2147483646;
  flex-direction: column;
  box-shadow: -8px 0 30px rgba(var(--stripe-shadow-rgb), 0.18);
  animation: ap-slide-in 0.18s ease-out;
}
.ap-pdf-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--stripe-hairline-soft); flex-shrink: 0;
}
.ap-pdf-title { font-weight: 700; font-size: 15px; color: var(--stripe-ink); }
.ap-pdf-frame { flex: 1; width: 100%; border: none; background: #f1f3f6; }
.ap-pdf-status { padding: 8px 16px; font-size: 12.5px; color: var(--stripe-ink-mute); }
.ap-pdf-status.ok { color: #1e9e6a; }
.ap-pdf-status.error { color: #c0392b; }
.ap-pdf-actions {
  display: flex; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--stripe-hairline-soft); flex-shrink: 0;
}
.ap-pdf-actions button { flex: 1; padding: 10px; font-size: 12.5px; }
.ap-btn-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.ap-btn-icon svg { width: 16px; height: 16px; flex-shrink: 0; }

/* ---- Section rows (accordion style) ---- */
.ap-section {
  border-bottom: 1px solid var(--stripe-hairline-soft);
}
.ap-section-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px; cursor: pointer;
  transition: background 0.1s;
}
.ap-section-header:hover { background: var(--stripe-canvas-soft); }
.ap-section-left { display: flex; align-items: center; gap: 10px; }
.ap-section-icon {
  width: 20px; height: 20px; color: var(--stripe-ink-mute);
  display: flex; align-items: center; justify-content: center;
}
.ap-section-icon svg { width: 18px; height: 18px; }
.ap-section-title { font-weight: 600; font-size: 14px; color: var(--stripe-ink); }
.ap-section-arrow { color: var(--stripe-ink-mute); display: flex; align-items: center; }
.ap-section-arrow svg { width: 16px; height: 16px; }
.ap-section-sub { padding: 0 16px 14px; font-size: 13px; color: var(--stripe-ink-mute); }
.ap-section-sub .ap-file-name { font-size: 12.5px; color: var(--stripe-ink-secondary); margin-bottom: 8px; }
.ap-section-action {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 14px;
  background: var(--stripe-accent-light);
  border: 1px solid var(--stripe-accent-soft);
  border-radius: 8px;
  font-size: 13px; font-weight: 600;
  color: var(--stripe-primary);
  cursor: not-allowed;
  opacity: 0.6;
  margin-top: 6px;
}
.ap-section-action svg { width: 14px; height: 14px; }
.ap-coming-soon {
  font-size: 10px; font-weight: 500;
  color: var(--stripe-ink-mute); margin-left: auto;
  text-transform: uppercase; letter-spacing: 0.5px;
}

/* ---- Resume picker + upload ---- */
.ap-resume-select {
  width: 100%; padding: 9px 10px; margin-bottom: 8px;
  border: 1px solid var(--stripe-hairline); border-radius: 8px;
  font-size: 13px; color: var(--stripe-ink); background: #fff;
}
.ap-resume-select:focus { outline: none; border-color: var(--stripe-primary); box-shadow: 0 0 0 2px rgba(var(--stripe-primary-rgb),0.1); }
.ap-btn-upload {
  width: 100%; padding: 11px; border: none; border-radius: 9999px;
  background: var(--stripe-primary);
  color: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  transition: background 0.15s, box-shadow 0.15s;
}
.ap-btn-upload:hover:not(:disabled) { background: var(--stripe-primary-press); box-shadow: 0 4px 14px rgba(var(--stripe-primary-rgb),0.3); }
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
  border-bottom: 1px solid var(--stripe-hairline-soft);
  flex-shrink: 0;
}
.ap-modal-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: var(--stripe-ink); }
.ap-modal-close {
  border: none; background: none; cursor: pointer;
  color: var(--stripe-ink-mute); padding: 4px;
}
.ap-modal-close svg { width: 22px; height: 22px; }
.ap-modal-close:hover { color: var(--stripe-ink-secondary); }
.ap-modal-notice {
  padding: 12px 24px;
  background: var(--stripe-canvas-soft);
  border-bottom: 1px solid var(--stripe-hairline-soft);
  font-size: 12.5px; color: var(--stripe-ink-secondary);
  display: flex; align-items: flex-start; gap: 8px;
}
.ap-modal-notice-icon { color: var(--stripe-primary); flex-shrink: 0; margin-top: 1px; }
.ap-modal-body {
  flex: 1; display: flex; overflow: hidden; min-height: 0;
}
.ap-modal-sidebar {
  width: 160px;
  border-right: 1px solid var(--stripe-hairline-soft);
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
  color: var(--stripe-ink-secondary); cursor: pointer;
  border-left: 3px solid transparent;
  transition: all 0.1s;
}
.ap-modal-sidebar-item:hover { color: var(--stripe-ink); background: var(--stripe-canvas-soft); }
.ap-modal-sidebar-item.active {
  color: var(--stripe-ink); font-weight: 600;
  border-left-color: var(--stripe-primary);
  background: var(--stripe-accent-light);
}
.ap-modal-form {
  flex: 1; padding: 20px 28px;
  overflow-y: auto;
}
.ap-form-row { margin-bottom: 16px; }
.ap-form-row label {
  display: block; font-size: 12.5px; font-weight: 600;
  color: var(--stripe-ink-secondary); margin-bottom: 5px;
}
.ap-form-row label .ap-required { color: #e53e3e; font-weight: 700; }
.ap-form-row input, .ap-form-row select {
  width: 100%; padding: 10px 12px;
  border: 1px solid var(--stripe-hairline); border-radius: 6px;
  font-size: 13.5px; color: var(--stripe-ink); background: #fff;
}
.ap-form-row input:focus, .ap-form-row select:focus {
  outline: none; border-color: var(--stripe-primary);
  box-shadow: 0 0 0 2px rgba(var(--stripe-primary-rgb),0.1);
}
.ap-form-row input::placeholder { color: var(--stripe-ink-mute); }
.ap-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ap-form-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.ap-modal-footer {
  padding: 14px 24px;
  border-top: 1px solid var(--stripe-hairline-soft);
  display: flex; justify-content: center;
  flex-shrink: 0;
}
.ap-btn-update {
  padding: 12px 48px;
  border: none; border-radius: 999px;
  background: linear-gradient(135deg, var(--stripe-primary) 0%, var(--stripe-primary-deep) 100%);
  color: #fff; font-size: 14px; font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(var(--stripe-primary-rgb),0.25);
  transition: box-shadow 0.15s;
}
.ap-btn-update:hover { box-shadow: 0 6px 16px rgba(var(--stripe-primary-rgb),0.35); }

/* ---- Login view ---- */
.ap-login-view {
  flex: 1; padding: 20px 16px;
  display: none; flex-direction: column;
}
.ap-login-view.visible { display: flex; }
.ap-login-card {
  background: #fff; border: 1px solid var(--stripe-hairline);
  border-radius: 12px; padding: 20px;
}
.ap-login-card h2 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
.ap-login-card .ap-muted { color: var(--stripe-ink-mute); font-size: 13px; margin-bottom: 14px; }
.ap-form-label { display: block; font-size: 12px; font-weight: 600; color: var(--stripe-ink-mute); margin: 12px 0 4px; }
.ap-form-label:first-of-type { margin-top: 0; }
.ap-input {
  width: 100%; border: 1px solid var(--stripe-hairline); border-radius: 8px;
  padding: 10px 12px; font-size: 13px; background: #fff; color: var(--stripe-ink);
}
.ap-input:focus { outline: none; border-color: var(--stripe-primary); box-shadow: 0 0 0 2px rgba(var(--stripe-primary-rgb),0.1); }
.ap-error { margin-top: 10px; font-size: 12px; color: #e53e3e; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 8px 10px; }
.ap-btn-login {
  width: 100%; margin-top: 14px; padding: 12px;
  border: none; border-radius: 10px;
  background: linear-gradient(135deg, var(--stripe-primary) 0%, var(--stripe-primary-deep) 100%);
  color: #fff; font-size: 14px; font-weight: 700; cursor: pointer;
}
.ap-btn-login:disabled { opacity: 0.5; cursor: default; }
.ap-login-divider { display: flex; align-items: center; margin: 14px 0; gap: 8px; }
.ap-login-divider::before, .ap-login-divider::after { content: ""; flex: 1; height: 1px; background: var(--stripe-hairline); }
.ap-login-divider span { font-size: 11px; color: var(--stripe-ink-mute); text-transform: uppercase; }
.ap-google-btn {
  width: 100%; padding: 11px;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: #fff; border: 1px solid var(--stripe-hairline); border-radius: 10px;
  font-size: 13px; font-weight: 600; color: var(--stripe-ink); cursor: pointer;
}
.ap-google-btn:hover { background: var(--stripe-canvas-soft); }
.ap-btn-mock {
  width: 100%; margin-top: 10px; padding: 10px;
  border: none; background: none;
  color: var(--stripe-primary); font-size: 13px; font-weight: 600; cursor: pointer;
}
.ap-btn-mock:hover { text-decoration: underline; }

/* ---- Footer ---- */
.ap-footer {
  display: flex; align-items: center; justify-content: center;
  padding: 10px 16px;
  border-top: 1px solid var(--stripe-hairline-soft);
  background: var(--stripe-canvas-soft);
  flex-shrink: 0;
}
.ap-footer-link {
  border: none; background: none;
  color: var(--stripe-primary); font-size: 12px; font-weight: 600;
  cursor: pointer; text-decoration: underline;
}

/* ---- Misc ---- */
.ap-spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid var(--stripe-accent-light); border-top-color: var(--stripe-primary);
  border-radius: 50%; animation: ap-spin 0.8s linear infinite;
  vertical-align: -2px; margin-right: 6px;
}
@keyframes ap-spin { to { transform: rotate(360deg); } }
.ap-review { margin: 0 16px 12px; }
.ap-review-head { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; font-weight: 600; color: var(--stripe-ink-secondary); margin-bottom: 8px; }
.ap-review-all { font-size: 12px; color: var(--stripe-primary); background: none; border: none; cursor: pointer; padding: 2px 4px; }
.ap-review-card { border: 1px solid var(--stripe-hairline); border-radius: 10px; padding: 10px; margin-bottom: 8px; background: var(--stripe-canvas-soft); }
.ap-review-label { font-size: 12.5px; color: var(--stripe-ink-secondary); margin-bottom: 6px; font-weight: 500; }
.ap-review-badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-bottom: 6px; font-weight: 600; }
.ap-review-badge.mem { background: var(--stripe-accent-light); color: var(--stripe-primary-deep); }
.ap-review-badge.ai { background: #fff4e6; color: #b9690b; }
.ap-review-text { width: 100%; box-sizing: border-box; font-size: 12.5px; padding: 8px; border: 1px solid var(--stripe-hairline); border-radius: 8px; resize: vertical; font-family: inherit; }
.ap-review-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ap-review-insert, .ap-review-skip { font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer; border: 1px solid var(--stripe-hairline); background: #fff; }
.ap-review-insert { background: var(--stripe-primary); color: #fff; border-color: var(--stripe-primary); }
.ap-review-status { font-size: 12px; color: var(--stripe-ink-mute); }
.ap-review-status.ok { color: #1a7f37; }
.ap-review-status.error { color: #c0392b; }
.ap-btn-soft { padding: 9px 12px; border: 1px solid var(--stripe-accent-soft); border-radius: 8px;
  background: var(--stripe-accent-light); color: var(--stripe-primary); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.ap-btn-soft:hover:not(:disabled) { background: var(--stripe-accent-light); }
.ap-btn-soft:disabled { opacity: 0.5; cursor: default; }
.ap-btn-tailor { width: 100%; padding: 11px; border: none; border-radius: 9999px;
  background: var(--stripe-primary); color: #fff;
  font-size: 13.5px; font-weight: 600; cursor: pointer; display: flex;
  align-items: center; justify-content: center; gap: 7px; transition: background 0.15s; }
.ap-btn-tailor:hover:not(:disabled) { background: var(--stripe-primary-press); }
.ap-btn-tailor:disabled { opacity: 0.5; cursor: default; }
.ap-tailor-scores { display: flex; justify-content: space-between; align-items: baseline;
  margin-top: 10px; }
.ap-tailor-jump { font-weight: 700; font-size: 14px; color: var(--stripe-ink); }
.ap-tailor-stats { font-size: 11.5px; color: var(--stripe-ink-mute); }
.ap-kw-label { font-size: 11.5px; color: var(--stripe-ink-mute); margin: 10px 0 5px; }
.ap-kw-row { display: flex; flex-wrap: wrap; gap: 6px; }
.ap-kw { font-size: 11.5px; padding: 4px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--stripe-hairline); background: #fff; color: var(--stripe-ink-secondary); }
.ap-kw.on { background: var(--stripe-primary); border-color: var(--stripe-primary); color: #fff; }
.ap-tailor-actions { display: flex; gap: 8px; margin-top: 12px; }
.ap-tailor-actions .ap-btn-upload { width: auto; flex: 1; }
.ap-cover-controls { display: flex; gap: 8px; align-items: center; }
.ap-cover-tone { flex: 0 0 auto; padding: 8px; border: 1px solid var(--stripe-accent-soft); border-radius: 8px;
  font-size: 12px; background: #fff; color: var(--stripe-ink); }
.ap-cover-controls .ap-btn-tailor { flex: 1; }
.ap-cover-text { width: 100%; box-sizing: border-box; margin-top: 10px; min-height: 160px;
  padding: 10px; border: 1px solid var(--stripe-accent-soft); border-radius: 8px; font-size: 12.5px;
  line-height: 1.5; resize: vertical; color: var(--stripe-ink); font-family: inherit; }
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
  tailorResult: TailorResult | null;
  tailorKeywords: Set<string>;
  tailorBusy: boolean;
  coverLetterText: string | null;
  coverLetterBusy: boolean;
}

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let mountObserver: MutationObserver | null = null;
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
  tailorResult: null,
  tailorKeywords: new Set(),
  tailorBusy: false,
  coverLetterText: null,
  coverLetterBusy: false,
};

interface Refs {
  root: HTMLDivElement;
  edgeTab: HTMLButtonElement;
  panel: HTMLDivElement;
  content: HTMLDivElement;
  btnAutofill: HTMLButtonElement;
  fieldCount: HTMLDivElement;
  banner: HTMLDivElement;
  checklist: HTMLDivElement;
  review: HTMLDivElement;
  resumeName: HTMLDivElement;
  resumeSelect: HTMLSelectElement;
  btnUploadResume: HTMLButtonElement;
  uploadStatus: HTMLDivElement;
  btnTailor: HTMLButtonElement;
  tailorResult: HTMLDivElement;
  btnCover: HTMLButtonElement;
  coverTone: HTMLSelectElement;
  coverResult: HTMLDivElement;
  modalBackdrop: HTMLDivElement;
  infoSidebar: HTMLDivElement;
  infoForm: HTMLDivElement;
  loginView: HTMLDivElement;
  loginError: HTMLDivElement;
  btnConnect: HTMLButtonElement;
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
  if (host && host.isConnected && shadow) return;

  host = document.createElement("div");
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
  installMountWatchdog();
}

/**
 * SPA frameworks (React/Angular on Greenhouse, Workday…) rebuild the DOM and
 * tear our host out of it. The shadow root, rendered views and refs all survive
 * inside the detached host, so we just re-append it — instantly restoring the
 * panel without re-rendering. Without this the overlay silently dies after the
 * first client-side render: a frozen/blank panel updating elements no longer on
 * the page.
 */
function installMountWatchdog(): void {
  if (mountObserver) mountObserver.disconnect();
  mountObserver = new MutationObserver(() => {
    if (host) reattachIfDetached(host, document.documentElement || document.body);
  });
  mountObserver.observe(document.documentElement, { childList: true });
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
          <span class="ap-brand-logo">${I_BRAND}</span>
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

        <!-- Per-field detection checklist (name / email / university … → ✓ or –) -->
        <div class="ap-checklist" id="ap-checklist" style="display:none"></div>

        <!-- AI long-form answers to review -->
        <div class="ap-review" id="ap-review" style="display:none"></div>

        <!-- Your Autofill Information -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-info">
            <div class="ap-section-left">
              <span class="ap-section-icon">${I_FILE}</span>
              <span class="ap-section-title">Your Autofill Information</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_RIGHT}</span>
          </div>
        </div>

        <!-- Upload Resume -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-resume">
            <div class="ap-section-left">
              <span class="ap-section-icon">${I_UPLOAD}</span>
              <span class="ap-section-title">Upload Resume</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_DOWN}</span>
          </div>
          <div class="ap-section-sub" id="ap-resume-sub" style="display:none">
            <div class="ap-file-name" id="ap-resume-name">No resume uploaded</div>
            <select class="ap-resume-select" id="ap-resume-select" style="display:none"></select>
            <button class="ap-btn-upload" id="ap-btn-upload-resume" type="button" disabled>
              ${I_UPLOAD}
              Upload résumé to this form
            </button>
            <div class="ap-upload-status" id="ap-upload-status"></div>
          </div>
        </div>

        <!-- Generate Custom Resume -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-tailor">
            <div class="ap-section-left">
              <span class="ap-section-icon">${I_STAR}</span>
              <span class="ap-section-title">Generate Custom Resume</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_DOWN}</span>
          </div>
          <div class="ap-section-sub" id="ap-tailor-sub" style="display:none">
            <button class="ap-btn-tailor" id="ap-btn-tailor" type="button" disabled>
              ${I_STAR}
              Tailor my résumé for this job
            </button>
            <div id="ap-tailor-result"></div>
          </div>
        </div>

        <!-- Upload Cover Letter -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-cover">
            <div class="ap-section-left">
              <span class="ap-section-icon">${I_ENVELOPE}</span>
              <span class="ap-section-title">Upload Cover Letter</span>
            </div>
            <span class="ap-section-arrow">${I_CHEVRON_DOWN}</span>
          </div>
          <div class="ap-section-sub" id="ap-cover-sub" style="display:none">
            <div class="ap-cover-controls">
              <select id="ap-cover-tone" class="ap-cover-tone" aria-label="Cover letter tone">
                <option value="">Default tone</option>
                <option value="professional">Professional</option>
                <option value="formal">Formal</option>
                <option value="enthusiastic">Enthusiastic</option>
                <option value="concise">Concise</option>
                <option value="technical">Technical</option>
              </select>
              <button class="ap-btn-tailor" id="ap-btn-cover" type="button" disabled>
                ${I_STAR}
                Generate Cover Letter
              </button>
            </div>
            <div id="ap-cover-result"></div>
          </div>
        </div>

        <!-- Onboarding / connect view (shown when signed out) -->
        <div class="ap-login-view" id="ap-login-view">
          <div class="ap-login-card">
            <h2 class="ap-login-title">Connect your Tailrd account</h2>
            <p class="ap-muted ap-login-sub">Sign in once on tailrd.ca and the extension fills applications from your real profile, resumes, and cover letters — kept in sync automatically.</p>
            <div id="ap-login-error" class="ap-error" style="display:none"></div>
            <button id="ap-btn-connect" class="ap-btn-login" type="button">Connect your Tailrd account</button>
            <button id="ap-btn-use-mock" class="ap-btn-mock" type="button">Try with sample data</button>
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
          <span class="ap-modal-notice-icon">${I_INFO}</span>
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

    <!-- Tailored résumé PDF preview (covers the side panel) -->
    <div class="ap-pdf-modal" id="ap-pdf-modal" style="display:none">
      <div class="ap-pdf-head">
        <span class="ap-pdf-title">Résumé preview</span>
        <button class="ap-icon-btn" id="ap-pdf-close" title="Close preview">${I_CLOSE}</button>
      </div>
      <div class="ap-pdf-status" id="ap-pdf-status"></div>
      <iframe class="ap-pdf-frame" id="ap-pdf-frame" title="Résumé preview"></iframe>
      <div class="ap-pdf-actions">
        <button class="ap-btn-soft ap-btn-icon" id="ap-pdf-regen" type="button">${I_REGEN}Regenerate</button>
        <button class="ap-btn-soft ap-btn-icon" id="ap-pdf-download" type="button">${I_DOWNLOAD}Download PDF</button>
        <button class="ap-btn-upload ap-btn-icon" id="ap-pdf-attach" type="button">${I_PAPERCLIP}Attach to form</button>
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
    checklist: q("#ap-checklist"),
    review: q("#ap-review"),
    resumeName: q("#ap-resume-name"),
    resumeSelect: q("#ap-resume-select"),
    btnUploadResume: q("#ap-btn-upload-resume"),
    uploadStatus: q("#ap-upload-status"),
    btnTailor: q("#ap-btn-tailor"),
    tailorResult: q("#ap-tailor-result"),
    btnCover: q("#ap-btn-cover"),
    coverTone: q("#ap-cover-tone"),
    coverResult: q("#ap-cover-result"),
    modalBackdrop: q("#ap-modal-backdrop"),
    infoSidebar: q("#ap-info-sidebar"),
    infoForm: q("#ap-info-form"),
    loginView: q("#ap-login-view"),
    loginError: q("#ap-login-error"),
    btnConnect: q("#ap-btn-connect"),
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

  // Generate Custom Resume section toggle
  root.querySelector("#ap-section-tailor")!.addEventListener("click", () => {
    const sub = root.querySelector<HTMLElement>("#ap-tailor-sub")!;
    sub.style.display = sub.style.display === "none" ? "block" : "none";
  });

  // Tailor button
  root.querySelector("#ap-btn-tailor")!.addEventListener("click", () => void doTailor());

  // Generate Cover Letter button
  root.querySelector("#ap-btn-cover")!.addEventListener("click", () => void doGenerateCoverLetter());

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

  // Connect (web handshake) + sample-data fallback
  root.querySelector("#ap-btn-connect")!.addEventListener("click", () => void doConnect());
  root.querySelector("#ap-btn-use-mock")!.addEventListener("click", () => {
    void saveConfig({ useMockData: true }).then(() => void reInit());
  });

  // Tailored résumé PDF preview controls
  root.querySelector("#ap-pdf-close")!.addEventListener("click", () => closeTailorPreview());
  root.querySelector("#ap-pdf-regen")!.addEventListener("click", () => void regenFromPreview());
  root.querySelector("#ap-pdf-download")!.addEventListener("click", () => void downloadFromPreview());
  root.querySelector("#ap-pdf-attach")!.addEventListener("click", () => void attachFromPreview());
}

// ---------------------------------------------------------------------------
// Panel init
// ---------------------------------------------------------------------------

async function initPanel(): Promise<void> {
  initialized = true;
  overlayState.config = await getConfig();

  // Paint the current scan immediately so the panel always shows a real status
  // (field count / "No form fields detected") instead of a blank, greyed shell.
  // Without this, a slow or unanswered background call — e.g. on a login-gated
  // SPA like Greenhouse's candidate portal — leaves the panel stuck on its
  // pristine pre-render state with no feedback.
  refreshMainView();

  const status = await bg<StatusResponse>({ type: "GET_STATUS" }).catch((e) => {
    console.log("[Tailrd overlay] GET_STATUS failed:", (e as Error)?.message);
    return null;
  });
  overlayState.status = status;
  console.log("[Tailrd overlay] initPanel: status mode =", status?.mode ?? "NULL (request failed)");

  if (status && status.mode === "signedOut") {
    showLoginView(false);
    return;
  }
  if (status && status.mode === "sessionExpired") {
    // Keep the scanned-page view usable; prompt a reconnect. Never show mock.
    showLoginView(true);
    return;
  }

  hideLoginView();
  await loadProfile();
}

async function loadProfile(): Promise<void> {
  const resp = await bg<ProfileResponse>({ type: "GET_PROFILE" }).catch((e) => {
    console.log("[Tailrd overlay] GET_PROFILE failed:", (e as Error)?.message);
    return null;
  });
  console.log(
    "[Tailrd overlay] loadProfile: ok =", resp?.ok,
    "needsLogin =", resp?.needsLogin,
    "hasProfile =", Boolean(resp?.profile)
  );
  if (!resp || !resp.ok) {
    if (resp?.needsLogin) { showLoginView(); return; }
  } else {
    overlayState.profile = resp.profile ?? null;
    overlayState.source = resp.source ?? null;
  }
  // Feed the profile to the scanner so fields get proposed values; it re-scans
  // and calls updateOverlay() (which re-derives the selection). Done before our
  // own applyDefaultSelection() so the button reflects the enriched fields.
  callbacks?.onProfileResolved(overlayState.profile);
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

function showLoginView(expired = false): void {
  if (!refs) {
    console.log("[Tailrd overlay] showLoginView: refs is NULL — cannot render");
    return;
  }
  console.log(
    "[Tailrd overlay] showLoginView called expired=", expired,
    "loginViewConnected=", refs.loginView.isConnected,
    "hostInDoc=", Boolean(document.getElementById(HOST_ID))
  );
  refs.loginView.classList.add("visible");
  refs.loginView.classList.toggle("ap-expired", expired);
  const heading = refs.loginView.querySelector<HTMLElement>(".ap-login-title");
  const sub = refs.loginView.querySelector<HTMLElement>(".ap-login-sub");
  if (heading) heading.textContent = expired ? "Session expired" : "Connect your Tailrd account";
  if (sub) {
    sub.textContent = expired
      ? "Reconnect to keep syncing your profile and résumés. Your data is still here."
      : "Sign in once on tailrd.ca and the extension fills applications from your real profile, resumes, and cover letters — kept in sync automatically.";
  }
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
  console.log(
    "[Tailrd overlay] refreshMainView selected=", count,
    "of fields=", fields.length,
    "withValue=", fields.filter((f) => f.proposedValue !== null).length,
    "busy=", overlayState.busy,
    "btnConnected=", refs.btnAutofill.isConnected,
    "hostInDoc=", Boolean(document.getElementById(HOST_ID))
  );

  refs.btnAutofill.disabled = overlayState.busy || count === 0;
  refs.btnAutofill.textContent = overlayState.busy ? "Working\u2026" : "Autofill";

  if (fields.length > 0) {
    refs.fieldCount.textContent = `${count} of ${fields.length} fields ready to fill`;
  } else {
    refs.fieldCount.textContent = overlayState.scanned
      ? "No form fields detected on this page"
      : "Scanning page\u2026";
  }

  renderChecklist();

  // Keep the r\u00e9sum\u00e9-upload button in sync as the form is (re)scanned.
  updateUploadButtonState();
  updateTailorButtonState();
  updateCoverButtonState();
}

/** Friendly fallback names when a field's own label is missing/too generic. */
const CATEGORY_LABEL: Partial<Record<string, string>> = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  linkedin: "LinkedIn",
  github: "GitHub",
  portfolio: "Portfolio / website",
  school: "University / school",
  degree: "Degree",
  workAuthorization: "Work authorization",
  sponsorship: "Sponsorship",
  coverLetter: "Cover letter",
  resumeUpload: "R\u00e9sum\u00e9",
  eeoGender: "Gender",
  eeoRace: "Race / ethnicity",
  eeoVeteran: "Veteran status",
  eeoDisability: "Disability status",
};

/** Turn a programmatic id ("surveysResponses", "first_name") into "Surveys responses". */
function humanize(raw: string): string {
  const words = raw
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : raw;
}

function fieldDisplayName(f: DetectedField): string {
  // Drop programmatic suffixes like "fields[firstname]" or "name (optional)".
  let label = (f.label || "").trim().replace(/\s+/g, " ").replace(/[\s*:]+$/, "").replace(/\s*[\[(].*$/, "").trim();
  const cat = CATEGORY_LABEL[f.category];
  const looksRaw = !!label && (/[_\[\]]/.test(label) || (/[a-z][A-Z]/.test(label) && !label.includes(" ")));
  if (cat && (looksRaw || !label || label.length > 36)) return cat;
  if (looksRaw) return humanize(label);
  if (label && label.length <= 40) return label;
  return cat ?? (label ? label.slice(0, 38) + "\u2026" : "Field");
}

/**
 * The "did it fill?" checklist: every meaningful detected field, with a green
 * check when it currently holds a value or a muted dash when it is still empty.
 * Driven purely off the (re-scanned) fields' currentValue, so it reflects reality
 * after Autofill without any extra bookkeeping.
 */
function renderChecklist(): void {
  if (!refs) return;
  const host = refs.checklist;
  const fillEEO = overlayState.config?.fillEEO ?? false;
  const fields = overlayState.fields.filter(
    (f) => (f.fillable || f.category !== "unknown") && !(f.sensitive && !fillEEO)
  );
  if (fields.length === 0) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }
  const isFilled = (f: DetectedField): boolean => Boolean(f.currentValue && f.currentValue.trim());
  const filledCount = fields.filter(isFilled).length;
  const rows = fields
    .map((f) => {
      const filled = isFilled(f);
      const ic = filled ? I_CHECK : I_DASH;
      return (
        `<div class="ap-chk-row ${filled ? "is-filled" : "is-empty"}">` +
        `<span class="ap-chk-ic">${ic}</span>` +
        `<span class="ap-chk-label">${esc(fieldDisplayName(f))}</span>` +
        `</div>`
      );
    })
    .join("");
  host.style.display = "block";
  host.innerHTML =
    `<div class="ap-chk-head"><span>Fields detected</span>` +
    `<span class="ap-chk-count">${filledCount}/${fields.length} filled</span></div>` +
    rows;
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

function updateTailorButtonState(): void {
  if (!refs) return;
  refs.btnTailor.disabled = !overlayState.profile || overlayState.tailorBusy;
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
    const { ok, fail, total, drafts } = await callbacks.onAutofill(ids);
    const txt =
      `Filled ${ok} of ${total} field${total === 1 ? "" : "s"}` +
      (fail > 0 ? ` (${fail} need attention)` : "") +
      (drafts.length > 0 ? ` · ${drafts.length} to review below` : "") +
      ". Review before submitting.";
    showBanner(txt, fail > 0 ? "warn" : "ok");
    renderReviewSection(drafts);
    // Re-scan so each field's currentValue reflects what just got written —
    // this drives the ✓ / – checklist to its post-fill state.
    callbacks.onRescan();
  } catch (err) {
    showBanner(`Autofill failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  } finally {
    overlayState.busy = false;
    refreshMainView();
  }
}

function renderReviewSection(drafts: AiDraft[]): void {
  if (!refs) return;
  const host = refs.review;
  if (drafts.length === 0) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }
  host.style.display = "block";
  host.innerHTML =
    `<div class="ap-review-head"><span>Answers to review</span>` +
    `<button class="ap-review-all" id="ap-review-all" type="button">Accept all</button></div>` +
    drafts
      .map((d, i) => {
        const badge =
          d.source === "memory"
            ? `<span class="ap-review-badge mem">↩ From a previous application</span>`
            : `<span class="ap-review-badge ai">✨ AI suggestion</span>`;
        return `
      <div class="ap-review-card" data-field="${esc(d.fieldId)}">
        ${badge}
        <div class="ap-review-label">${esc(d.label)}</div>
        <textarea class="ap-review-text" id="ap-review-text-${i}" rows="4">${esc(d.value)}</textarea>
        <div class="ap-review-actions">
          <button class="ap-review-insert" data-i="${i}" type="button">Accept</button>
          <button class="ap-review-skip" data-i="${i}" type="button">Skip</button>
          <span class="ap-review-status" id="ap-review-status-${i}"></span>
        </div>
      </div>`;
      })
      .join("");

  host.querySelectorAll<HTMLButtonElement>(".ap-review-insert").forEach((btn) => {
    btn.addEventListener("click", () => void insertDraft(Number(btn.dataset.i), drafts));
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-review-skip").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest(".ap-review-card")?.remove());
  });
  host.querySelector("#ap-review-all")?.addEventListener("click", () => void insertAllDrafts(drafts));
}

async function insertDraft(i: number, drafts: AiDraft[]): Promise<void> {
  if (!refs || !callbacks) return;
  const ta = refs.review.querySelector<HTMLTextAreaElement>(`#ap-review-text-${i}`);
  const statusEl = refs.review.querySelector<HTMLSpanElement>(`#ap-review-status-${i}`);
  const insertBtn = refs.review.querySelector<HTMLButtonElement>(`.ap-review-insert[data-i="${i}"]`);
  if (!ta) return;
  const res = await callbacks.onInsertAnswer(drafts[i].fieldId, ta.value);
  if (!res.ok) {
    if (statusEl) {
      statusEl.textContent = res.reason ?? "Could not insert";
      statusEl.className = "ap-review-status error";
    }
    return;
  }
  // Filled — now remember it for next time (best-effort; the field stays filled
  // even if the save fails).
  let saved = false;
  try {
    saved = (await callbacks.onSaveAnswer(drafts[i].label, ta.value)).ok;
  } catch {
    saved = false;
  }
  if (statusEl) {
    statusEl.textContent = saved ? "Accepted ✓" : "Filled (not saved)";
    statusEl.className = "ap-review-status" + (saved ? " ok" : " error");
  }
  if (insertBtn) insertBtn.textContent = "Re-accept";
}

async function insertAllDrafts(drafts: AiDraft[]): Promise<void> {
  for (let i = 0; i < drafts.length; i++) {
    if (refs?.review.querySelector(`#ap-review-text-${i}`)) {
      await insertDraft(i, drafts);
    }
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
    form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">Sign in and upload a resume to see your information.</div>';
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
        form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No education entries yet.</div>';
      } else {
        let html = "";
        for (const e of p.education) {
          html += `
            <div class="ap-form-row"><label>School</label><input value="${esc(e.school)}" readonly /></div>
            <div class="ap-form-grid">
              <div class="ap-form-row"><label>Degree</label><input value="${esc(e.degree)}" readonly /></div>
              <div class="ap-form-row"><label>Graduation Year</label><input value="${esc(e.graduationYear)}" readonly /></div>
            </div>
            <hr style="border:none;border-top:1px solid var(--stripe-hairline-soft);margin:14px 0" />
          `;
        }
        form.innerHTML = html;
      }
      break;
    case "experience":
      if (p.experience.length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No work experience entries yet.</div>';
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
            <hr style="border:none;border-top:1px solid var(--stripe-hairline-soft);margin:14px 0" />
          `;
        }
        form.innerHTML = html;
      }
      break;
    case "skill":
      if (p.skills.length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No skills on file yet.</div>';
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
// Connect (web handshake)
// ---------------------------------------------------------------------------

async function doConnect(): Promise<void> {
  if (!refs) return;
  refs.loginError.style.display = "none";
  refs.btnConnect.disabled = true;
  refs.btnConnect.textContent = "Connecting\u2026";
  try {
    // The background opens the secure web handshake (chrome.identity); this
    // tab's panel stays put and reflects the result.
    const resp = await bg<LoginResponse>({ type: "CONNECT" });
    if (!resp.ok) {
      refs.loginError.style.display = "block";
      refs.loginError.textContent = resp.error ?? "Could not connect your account";
      return;
    }
    await saveConfig({ useMockData: false });
    await reInit();
  } finally {
    if (refs) {
      refs.btnConnect.disabled = false;
      refs.btnConnect.textContent = "Connect your Tailrd account";
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
  overlayState.tailorResult = null;
  overlayState.tailorKeywords = new Set();
  overlayState.tailorBusy = false;
  overlayState.coverLetterText = null;
  overlayState.coverLetterBusy = false;
  initialized = false;
  hideInfoView();
  await initPanel();
}

// ---------------------------------------------------------------------------
// Generate Custom Resume (tailor on the spot + attach)
// ---------------------------------------------------------------------------

function selectedResumeId(): number | null {
  const { resumes } = overlayState;
  if (resumes.length === 0) return null;
  if (refs && refs.resumeSelect.style.display !== "none" && refs.resumeSelect.value) {
    return Number(refs.resumeSelect.value);
  }
  const primary = resumes.find((r) => r.isPrimary) ?? resumes[0];
  return primary.id;
}

async function doTailor(addKeywords?: string[] | null): Promise<void> {
  if (!refs || !callbacks || overlayState.tailorBusy) return;
  if (!overlayState.profile) {
    setTailorStatus("Connect your Tailrd account to tailor your résumé.", "warn");
    return;
  }
  overlayState.tailorBusy = true;
  refs.btnTailor.disabled = true;
  refs.btnTailor.textContent = "Tailoring…";
  try {
    const res = await callbacks.onTailorResume({
      resumeId: selectedResumeId(),
      // First pass: undefined -> server auto-weaves all missing keywords.
      addKeywords: addKeywords,
    });
    if (!res.ok || !res.result) {
      setTailorStatus(res.reason ?? "Couldn't tailor your résumé.", "error");
      return;
    }
    overlayState.tailorResult = res.result;
    // Pre-check the keywords that were actually woven in.
    overlayState.tailorKeywords = new Set(
      addKeywords ?? res.result.missingKeywords
    );
    renderTailorResult();
  } catch (err) {
    setTailorStatus(err instanceof Error ? err.message : "Tailoring failed.", "error");
  } finally {
    overlayState.tailorBusy = false;
    if (refs) {
      updateTailorButtonState();
      refs.btnTailor.textContent = overlayState.tailorResult
        ? "Re-tailor for this job"
        : "Tailor my résumé for this job";
    }
  }
}

function renderTailorResult(): void {
  if (!refs || !overlayState.tailorResult) return;
  refs.tailorResult.innerHTML = buildTailorCardHtml(
    overlayState.tailorResult,
    overlayState.tailorKeywords
  );

  refs.tailorResult.querySelectorAll<HTMLButtonElement>(".ap-kw").forEach((chip) => {
    chip.addEventListener("click", () => {
      const kw = chip.dataset.kw ?? "";
      if (overlayState.tailorKeywords.has(kw)) overlayState.tailorKeywords.delete(kw);
      else overlayState.tailorKeywords.add(kw);
      chip.classList.toggle("on");
    });
  });

  refs.tailorResult
    .querySelector("#ap-tailor-preview")
    ?.addEventListener("click", () => void openTailorPreview());
}

function setTailorStatus(text: string, kind: "ok" | "warn" | "error" | ""): void {
  const el = refs?.tailorResult.querySelector<HTMLDivElement>("#ap-tailor-status");
  if (el) {
    el.textContent = text;
    el.className = "ap-upload-status" + (kind ? ` ${kind}` : "");
  } else if (refs) {
    // No card yet (e.g. not signed in) — fall back to the résumé status line.
    setUploadStatus(text, kind);
  }
}

// ---- Tailored résumé PDF preview ------------------------------------------

let pdfPreviewUrl: string | null = null;

function setPdfStatus(text: string, kind: "ok" | "warn" | "error" | ""): void {
  const el = refs?.root.querySelector<HTMLDivElement>("#ap-pdf-status");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
  el.className = "ap-pdf-status" + (kind ? ` ${kind}` : "");
}

/** Render the tailored résumé to PDF and show it in the in-panel preview. */
async function openTailorPreview(): Promise<void> {
  if (!refs || !overlayState.tailorResult) return;
  const modal = refs.root.querySelector<HTMLDivElement>("#ap-pdf-modal");
  const frame = refs.root.querySelector<HTMLIFrameElement>("#ap-pdf-frame");
  if (!modal || !frame) return;
  modal.style.display = "flex";
  setPdfStatus("Rendering preview…", "");
  const res = await bg<RenderResumeResponse>({
    type: "RENDER_RESUME",
    document: overlayState.tailorResult.document,
    filename: "resume",
  }).catch(() => null);
  if (!res?.ok || !res.dataBase64) {
    setPdfStatus(res?.error ?? "Could not render the résumé preview.", "error");
    return;
  }
  if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
  const file = base64ToFile(res.dataBase64, res.name ?? "resume.pdf", res.contentType ?? "application/pdf");
  pdfPreviewUrl = URL.createObjectURL(file);
  frame.src = pdfPreviewUrl;
  setPdfStatus("", "");
  const attach = refs.root.querySelector<HTMLButtonElement>("#ap-pdf-attach");
  if (attach) {
    attach.disabled = !hasResumeField();
    attach.title = hasResumeField() ? "" : "No résumé upload field on this page — use Download instead.";
  }
}

function closeTailorPreview(): void {
  const modal = refs?.root.querySelector<HTMLDivElement>("#ap-pdf-modal");
  if (modal) modal.style.display = "none";
  const frame = refs?.root.querySelector<HTMLIFrameElement>("#ap-pdf-frame");
  if (frame) frame.removeAttribute("src");
  if (pdfPreviewUrl) {
    URL.revokeObjectURL(pdfPreviewUrl);
    pdfPreviewUrl = null;
  }
}

/** Regenerate from within the preview, then refresh the rendered PDF. */
async function regenFromPreview(): Promise<void> {
  if (overlayState.tailorBusy) return;
  setPdfStatus("Regenerating…", "");
  await doTailor([...overlayState.tailorKeywords]);
  if (overlayState.tailorResult) await openTailorPreview();
}

async function downloadFromPreview(): Promise<void> {
  if (!callbacks || !overlayState.tailorResult) return;
  setPdfStatus("Preparing download…", "");
  const res = await callbacks.onDownloadTailored(overlayState.tailorResult.document);
  setPdfStatus(res.ok ? "Downloaded." : res.reason ?? "Could not download.", res.ok ? "ok" : "error");
}

async function attachFromPreview(): Promise<void> {
  if (!callbacks || !overlayState.tailorResult) return;
  setPdfStatus("Attaching…", "");
  const res = await callbacks.onAttachTailored(overlayState.tailorResult.document);
  setPdfStatus(
    res.ok ? "Attached to the form. Review before submitting." : res.reason ?? "Could not attach.",
    res.ok ? "ok" : "error"
  );
}

// ---------------------------------------------------------------------------
// Generate Cover Letter (on the spot + insert)
// ---------------------------------------------------------------------------

function updateCoverButtonState(): void {
  if (!refs) return;
  refs.btnCover.disabled = !overlayState.profile || overlayState.coverLetterBusy;
}

/** "Insert to form" when a cover-letter textarea exists; "Attach PDF" for a file field. */
function coverInsertLabel(): { label: string; enabled: boolean } {
  const hasText = overlayState.fields.some(
    (f) =>
      f.category === "coverLetter" &&
      (f.controlType === "textarea" || f.controlType === "contenteditable")
  );
  if (hasText) return { label: "Insert to form", enabled: true };
  const hasFile = overlayState.fields.some(
    (f) => f.category === "coverLetter" && f.controlType === "file"
  );
  if (hasFile) return { label: "Attach PDF", enabled: true };
  return { label: "Insert to form", enabled: false };
}

/** The (possibly edited) text in the preview textarea, falling back to state. */
function currentCoverText(): string {
  const ta = refs?.coverResult.querySelector<HTMLTextAreaElement>("#ap-cover-text");
  return ta ? ta.value : overlayState.coverLetterText ?? "";
}

async function doGenerateCoverLetter(baseText?: string): Promise<void> {
  if (!refs || !callbacks || overlayState.coverLetterBusy) return;
  if (!overlayState.profile) {
    setCoverStatus("Connect your Tailrd account to generate a cover letter.", "warn");
    return;
  }
  overlayState.coverLetterBusy = true;
  refs.btnCover.disabled = true;
  refs.btnCover.textContent = baseText ? "Rewriting…" : "Generating…";
  try {
    const res = await callbacks.onGenerateCoverLetter({
      resumeId: selectedResumeId(),
      tone: refs.coverTone.value || null,
      baseText: baseText ?? null,
    });
    if (!res.ok || typeof res.text !== "string") {
      setCoverStatus(res.reason ?? "Couldn't generate a cover letter.", "error");
      return;
    }
    overlayState.coverLetterText = res.text;
    renderCoverLetterResult();
  } catch (err) {
    setCoverStatus(err instanceof Error ? err.message : "Generation failed.", "error");
  } finally {
    overlayState.coverLetterBusy = false;
    if (refs) {
      updateCoverButtonState();
      refs.btnCover.textContent = overlayState.coverLetterText
        ? "Regenerate cover letter"
        : "Generate Cover Letter";
    }
  }
}

function renderCoverLetterResult(): void {
  if (!refs || overlayState.coverLetterText === null) return;
  const { label, enabled } = coverInsertLabel();
  refs.coverResult.innerHTML = buildCoverLetterCardHtml(overlayState.coverLetterText, label);

  refs.coverResult
    .querySelector("#ap-cover-regen")
    ?.addEventListener("click", () => void doGenerateCoverLetter(currentCoverText()));
  refs.coverResult
    .querySelector("#ap-cover-insert")
    ?.addEventListener("click", () => void insertCoverLetter());
  refs.coverResult
    .querySelector("#ap-cover-copy")
    ?.addEventListener("click", () => void copyCoverLetter());
  refs.coverResult
    .querySelector("#ap-cover-download")
    ?.addEventListener("click", () => void downloadCoverLetter());

  const insertBtn = refs.coverResult.querySelector<HTMLButtonElement>("#ap-cover-insert");
  if (insertBtn && !enabled) {
    insertBtn.disabled = true;
    insertBtn.title = "No cover-letter field on this page — use Copy or Download instead.";
  }
}

async function insertCoverLetter(): Promise<void> {
  if (!refs || !callbacks) return;
  setCoverStatus("Inserting…", "");
  const res = await callbacks.onInsertCoverLetter(currentCoverText());
  setCoverStatus(
    res.ok ? "Inserted. Review before submitting." : res.reason ?? "Could not insert.",
    res.ok ? "ok" : "error"
  );
}

async function copyCoverLetter(): Promise<void> {
  if (!refs || !callbacks) return;
  const res = await callbacks.onCopyCoverLetter(currentCoverText());
  setCoverStatus(res.ok ? "Copied to clipboard." : res.reason ?? "Could not copy.", res.ok ? "ok" : "error");
}

async function downloadCoverLetter(): Promise<void> {
  if (!refs || !callbacks) return;
  setCoverStatus("Preparing download…", "");
  const res = await callbacks.onDownloadCoverLetter(currentCoverText());
  setCoverStatus(res.ok ? "Downloaded." : res.reason ?? "Could not download.", res.ok ? "ok" : "error");
}

function setCoverStatus(text: string, kind: "ok" | "warn" | "error" | ""): void {
  const el = refs?.coverResult.querySelector<HTMLDivElement>("#ap-cover-status");
  if (el) {
    el.textContent = text;
    el.className = "ap-upload-status" + (kind ? ` ${kind}` : "");
  } else if (refs) {
    // No card yet (e.g. a first-generation failure) — fall back to the résumé status line.
    setUploadStatus(text, kind);
  }
}
