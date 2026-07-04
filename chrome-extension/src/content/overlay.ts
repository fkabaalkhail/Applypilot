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
import { resolveCompanyLogo } from "./companyLogo";
import { buildTailorCardHtml } from "./tailorCard";
import { buildCoverLetterCardHtml } from "./coverLetterCard";
import {
  deleteCredential,
  getDefaultCredential,
  listCredentials,
  saveDefaultCredential,
  type DefaultCredential,
} from "./credentialStore";
import { defaultSelectedIds } from "../shared/selection";
import { getConfig, saveConfig, type ExtensionConfig } from "../shared/storage";
import type {
  BackgroundRequest,
  CoverLetterGenOpts,
  DetectedField,
  EeoAnswers,
  FillOutcome,
  FlowPauseReason,
  FlowProgress,
  LoginResponse,
  ProfileResponse,
  AnswersResponse,
  SavedAnswerItem,
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
    ids: string[],
    uploadResumeId?: number | null
  ) => Promise<{ ok: number; fail: number; total: number }>;
  /** Stop the running multi-page flow (panel Stop button). */
  onFlowStop: () => void;
  /** Advance the running multi-page flow to the next page (panel Next page button). */
  onFlowAdvance: () => void;
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
  /** Label of the page's apply-entry button ("Apply", "Apply Manually"…) when
   *  one exists — lets Autofill start a flow from a field-less job posting. */
  applyEntry?: string | null;
  /** Company + job title scraped from the page, for the job-card header. */
  company?: string;
  jobTitle?: string;
}

export function showOverlay(state: OverlayViewState, cb: OverlayCallbacks): void {
  callbacks = cb;
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  overlayState.applyEntry = state.applyEntry ?? null;
  overlayState.company = state.company ?? "";
  overlayState.jobTitle = state.jobTitle ?? "";
  ensureMounted();
  if (!panelExpanded) setExpanded(true);
  if (!initialized) void initPanel();
  else refreshMainView();
}

export function updateOverlay(state: OverlayViewState): void {
  if (host) reattachIfDetached(host, document.documentElement || document.body);
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  overlayState.applyEntry = state.applyEntry ?? null;
  overlayState.company = state.company ?? "";
  overlayState.jobTitle = state.jobTitle ?? "";
  // Re-derive the default selection so the Autofill button reflects the latest
  // scan. Selection is purely computed from the fields (there is no per-field
  // toggle UI), so recomputing it on every update is safe — and necessary, since
  // proposed values only appear after the profile reaches the scanner.
  applyDefaultSelection();
  if (panelExpanded) refreshMainView();
}

const PAUSE_TEXT: Record<FlowPauseReason, string> = {
  captcha: "solve the captcha to continue",
  "resume-upload": "attach your résumé to continue",
  validation: "fix the highlighted errors to continue",
  account: "add account credentials in Autofill Information → Account creation, or sign in manually",
  verification: "enter the emailed code to continue",
  "unfilled-required": "fill the required fields, or Next page to continue",
};

/** One-line, user-facing description of a flow beat. Pure — unit-tested. */
export function formatFlowProgress(p: FlowProgress): string {
  const step = `Step ${p.step + 1}`;
  switch (p.phase) {
    case "filling":
      // Account walls narrate what they're doing ("creating account…").
      return `${step} · ${p.detail ?? "filling…"}`;
    case "advancing":
      // Entry/wall clicks narrate their target ('opening "Apply"…').
      return `${step} · ${p.detail ?? "next page…"}`;
    case "paused":
      return `${step} · paused — ${PAUSE_TEXT[p.pauseReason ?? "validation"]}`;
    case "ready":
      return `${step} filled — review this page, then Next page`;
    case "done": {
      const steps = p.step + 1;
      const attention = p.filledFail > 0 ? `, ${p.filledFail} need attention` : "";
      return `Done — ${steps} step${steps === 1 ? "" : "s"} filled (${p.filledOk} ok${attention}). Review and submit.`;
    }
    case "stopped":
      return p.detail ?? "Autofill flow stopped.";
  }
}

/** The manual advance gate's label — mirrors the button the flow will click
 *  ("Create Account →", "Sign In →"), defaulting to Next page. Pure. */
export function formatNextLabel(p: FlowProgress): string {
  const label = (p.nextLabel ?? "").trim();
  return `${label || "Next page"} →`;
}

/** Render a flow beat: status line + Stop button, plus the bottom Next page gate. */
export function updateFlowProgress(p: FlowProgress): void {
  if (!refs) return;
  const running =
    p.phase === "filling" || p.phase === "advancing" || p.phase === "paused" || p.phase === "ready";
  refs.flow.style.display = running ? "flex" : "none";
  refs.flowText.textContent = formatFlowProgress(p);
  // The advance gate is pinned at the panel bottom. The flow parks on every
  // filled page — at a "ready" beat, or a "paused" beat when a required field is
  // still empty — and turns the page only when the user presses this button. Its
  // label mirrors the real button the flow will click (Next / Create Account / Sign In).
  refs.flowNextBtn.textContent = formatNextLabel(p);
  refs.flowNext.style.display =
    p.phase === "ready" || (p.phase === "paused" && p.pauseReason === "unfilled-required") ? "flex" : "none";
  if (p.phase === "done") showBanner(formatFlowProgress(p), "ok");
  if (p.phase === "stopped") showBanner(formatFlowProgress(p), "warn");
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
  overlayState.applyEntry = state.applyEntry ?? null;
  overlayState.company = state.company ?? "";
  overlayState.jobTitle = state.jobTitle ?? "";
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

// The Tailrd brand mark, drawn as inline SVG to match the front-page logo:
// an outlined paper-plane with trailing motion lines inside a closed ring.
// Inline SVG is immune to the page's img-src CSP, which blocks data:-URI <img>.
const I_BRAND =
  '<svg viewBox="0 0 256 256" fill="none" aria-hidden="true">' +
  '<circle cx="128" cy="128" r="112" stroke="currentColor" stroke-width="13"/>' +
  '<g transform="translate(40 42) scale(0.66)"><path fill="currentColor" d="M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z"/></g>' +
  // Motion lines (speed dashes) trailing the tail, matching the front-page mark.
  '<g stroke="currentColor" stroke-width="13" stroke-linecap="round">' +
  '<line x1="74" y1="180" x2="92" y2="162"/>' +
  '<line x1="63" y1="193" x2="81" y2="175"/>' +
  '<line x1="54" y1="204" x2="72" y2="186"/>' +
  "</g>" +
  "</svg>";


// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export const STYLES = `
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
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.1px;
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

/* ---- Job card (company logo + name + title) ---- */
.ap-jobcard {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--stripe-hairline-soft);
}
.ap-jobcard-logo {
  width: 42px; height: 42px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; background: #fff;
  border: 1px solid var(--stripe-hairline-soft);
  font-weight: 700; font-size: 17px; color: #fff; line-height: 1;
}
.ap-jobcard-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
.ap-jobcard-logo.is-mono { border: none; }
.ap-jobcard-text { min-width: 0; flex: 1; }
.ap-jobcard-company {
  font-weight: 700; font-size: 14.5px; color: var(--stripe-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ap-jobcard-title {
  font-size: 12.5px; color: var(--stripe-ink-mute); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---- Compact resume / cover blocks (no accordion) ---- */
.ap-rc {
  padding: 14px 16px;
  border-bottom: 1px solid var(--stripe-hairline-soft);
}
.ap-rc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ap-rc-resume { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ap-rc-resume .ap-file-name {
  flex: 1; min-width: 0; margin: 0;
  font-size: 12.5px; color: var(--stripe-ink-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ap-btn-attach {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 13px; border-radius: 9999px;
  border: 1px solid var(--stripe-hairline); background: #fff;
  color: var(--stripe-ink); font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: background 0.12s;
}
.ap-btn-attach:hover:not(:disabled) { background: var(--stripe-canvas-soft); }
.ap-btn-attach:disabled { opacity: 0.5; cursor: default; }
.ap-btn-attach > svg { width: 14px; height: 14px; flex-shrink: 0; }
.ap-btn-generate {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--stripe-accent-soft); background: var(--stripe-accent-light);
  color: var(--stripe-primary); font-size: 13px; font-weight: 600; cursor: pointer;
  transition: filter 0.12s;
}
.ap-btn-generate:hover:not(:disabled) { filter: brightness(0.97); }
.ap-btn-generate:disabled { opacity: 0.5; cursor: default; }
.ap-btn-generate > svg { width: 15px; height: 15px; flex-shrink: 0; }
.ap-rc .ap-cover-tone {
  width: 100%; margin-bottom: 8px; padding: 9px 10px;
  border: 1px solid var(--stripe-hairline); border-radius: 8px;
  font-size: 13px; background: #fff; color: var(--stripe-ink);
}
.ap-rc .ap-resume-select { margin-bottom: 8px; }
.ap-rc .ap-upload-status { margin-top: 8px; }

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
/* Constrain the inline SVG icons inside the pill buttons — without this the
   256-viewBox Phosphor icons expand to fill the button. */
.ap-btn-upload > svg, .ap-btn-tailor > svg { width: 16px; height: 16px; flex-shrink: 0; }
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
.ap-form-row input[readonly] {
  background: var(--stripe-canvas-soft);
  color: var(--stripe-ink-secondary);
  cursor: default;
}
.ap-form-hint {
  font-size: 12px; line-height: 1.45; color: var(--stripe-ink-mute);
  background: var(--stripe-canvas-soft);
  border: 1px solid var(--stripe-hairline-soft);
  border-radius: 6px; padding: 8px 10px; margin-bottom: 14px;
}
.ap-modal-footer {
  padding: 14px 24px;
  border-top: 1px solid var(--stripe-hairline-soft);
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  flex-shrink: 0;
}
.ap-modal-error {
  width: 100%; box-sizing: border-box;
  font-size: 12.5px; color: #b42318;
  background: #fef3f2; border: 1px solid #fecdca;
  border-radius: 6px; padding: 8px 10px; text-align: center;
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
.ap-btn-update:disabled { opacity: 0.6; cursor: default; box-shadow: none; }
.ap-answer-row { padding: 12px 0; border-bottom: 1px solid var(--stripe-hairline-soft); }
.ap-answer-q { font-size: 12.5px; font-weight: 600; color: var(--stripe-ink); margin-bottom: 6px; }
.ap-answer-a { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid var(--stripe-hairline-soft); border-radius: 8px; resize: vertical; font-family: inherit; color: var(--stripe-ink); background: #fff; box-sizing: border-box; }
.ap-answer-del { margin-top: 6px; background: none; border: none; color: #b4232a; font-size: 12px; font-weight: 600; cursor: pointer; padding: 2px 0; }
.ap-answer-del:hover { text-decoration: underline; }
/* Account-creation credentials (password + reveal toggle) */
.ap-signup-pass-row { display: flex; gap: 8px; align-items: center; }
.ap-signup-pass-row input { flex: 1; }
.ap-mini-btn {
  flex: 0 0 auto; border: 1px solid var(--stripe-hairline); background: #fff;
  border-radius: 6px; padding: 9px 12px; font-size: 12px; cursor: pointer;
  color: var(--stripe-ink-secondary);
}
.ap-mini-btn:hover { background: var(--stripe-canvas-soft); }

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
.ap-flow { display: flex; align-items: center; gap: 8px; margin: 6px 16px; font-size: 12px; }
.ap-flow-text { flex: 1; }
.ap-flow-stop { flex: 0 0 auto; }
/* Next-page gate — pinned at the panel bottom, shown only in the "ready" phase. */
.ap-flow-next-wrap {
  display: flex; padding: 10px 16px; flex-shrink: 0;
  border-top: 1px solid var(--stripe-hairline-soft);
  background: var(--stripe-canvas-soft);
}
.ap-flow-next {
  width: 100%; padding: 11px; border: none; border-radius: 9999px;
  background: var(--stripe-primary); color: #fff;
  font-size: 13.5px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.ap-flow-next:hover { background: var(--stripe-primary-press); }
.ap-signins { margin: 6px 16px; font-size: 12px; }
.ap-signins summary { cursor: pointer; color: var(--stripe-ink-secondary); font-weight: 600; padding: 4px 0; }
.ap-signins-empty { color: var(--stripe-ink-mute); padding: 4px 0; }
.ap-signin-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
.ap-signin-meta { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.ap-signin-site { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-signin-email { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-signin-pass { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-signins button { border: 1px solid var(--stripe-hairline); background: #fff; border-radius: 6px; padding: 3px 7px; font-size: 11px; cursor: pointer; color: var(--stripe-ink-secondary); }
.ap-signins button:hover { background: var(--stripe-canvas-soft); }
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
  /** Apply-entry button label when the page has one (job posting / chooser). */
  applyEntry: string | null;
  /** Company + job title for the job-card header (scraped from the page). */
  company: string;
  jobTitle: string;
  selected: Set<string>;
  outcomes: Map<string, FillOutcome>;
  busy: boolean;
  scanned: boolean;
  view: View;
  infoCategory: string;
  /** Remembered answers (Question Memory) shown in the Autofill Information modal. */
  rememberedAnswers: SavedAnswerItem[];
  rememberedLoaded: boolean;
  /** Working copy of the editable profile fields while the info modal is open. */
  profileDraft: EditableProfileDraft | null;
  /** Account-creation credentials draft (device-local; Account creation tab). */
  signupDraft: DefaultCredential | null;
  signupLoaded: boolean;
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
  applyEntry: null,
  company: "",
  jobTitle: "",
  selected: new Set(),
  outcomes: new Map(),
  busy: false,
  scanned: false,
  view: "main",
  infoCategory: "personal",
  rememberedAnswers: [],
  rememberedLoaded: false,
  profileDraft: null,
  signupDraft: null,
  signupLoaded: false,
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
  jobcard: HTMLDivElement;
  jobcardLogo: HTMLDivElement;
  jobcardCompany: HTMLDivElement;
  jobcardTitle: HTMLDivElement;
  btnAutofill: HTMLButtonElement;
  fieldCount: HTMLDivElement;
  banner: HTMLDivElement;
  flow: HTMLDivElement;
  flowText: HTMLSpanElement;
  flowNext: HTMLDivElement;
  flowNextBtn: HTMLButtonElement;
  signins: HTMLDetailsElement;
  signinsBody: HTMLDivElement;
  checklist: HTMLDivElement;
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

  // collectRefs MUST run before wireEvents: wireEvents attaches delegated
  // listeners to refs.infoForm, so refs has to be populated first. (Reversed,
  // wireEvents dereferenced a null refs and threw, aborting overlay mount — the
  // panel then never opened on any form page.)
  refs = collectRefs(root);
  wireEvents(root);
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

export function buildHTML(): string {
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
        <!-- Job card: company logo + name + title -->
        <div class="ap-jobcard" id="ap-jobcard" style="display:none">
          <div class="ap-jobcard-logo is-mono" id="ap-jobcard-logo"></div>
          <div class="ap-jobcard-text">
            <div class="ap-jobcard-company" id="ap-jobcard-company"></div>
            <div class="ap-jobcard-title" id="ap-jobcard-title" style="display:none"></div>
          </div>
        </div>

        <!-- Account Creation & Autofill button -->
        <div class="ap-autofill-section">
          <button class="ap-btn-autofill" id="ap-btn-autofill" disabled>Account Creation &amp; Autofill</button>
          <div class="ap-field-count" id="ap-field-count"></div>
        </div>

        <!-- Banner -->
        <div class="ap-banner" id="ap-banner" style="display:none"></div>

        <!-- Multi-page flow status line -->
        <div class="ap-flow" id="ap-flow" style="display:none">
          <span class="ap-flow-text" id="ap-flow-text"></span>
        </div>

        <!-- Saved sign-ins (device-local signup-wall credentials) -->
        <details class="ap-signins" id="ap-signins">
          <summary>Saved sign-ins</summary>
          <div class="ap-signins-body" id="ap-signins-body"></div>
        </details>

        <!-- Per-field detection checklist (name / email / university … → ✓ or –) -->
        <div class="ap-checklist" id="ap-checklist" style="display:none"></div>

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

        <!-- Upload Resume (compact: attach current résumé + generate custom) -->
        <div class="ap-rc">
          <div class="ap-rc-head">
            <span class="ap-section-icon">${I_UPLOAD}</span>
            <span class="ap-section-title">Upload Resume</span>
          </div>
          <div class="ap-rc-resume">
            <span class="ap-file-name" id="ap-resume-name">No resume uploaded</span>
            <button class="ap-btn-attach" id="ap-btn-upload-resume" type="button" disabled>
              ${I_UPLOAD}
              Attach
            </button>
          </div>
          <select class="ap-resume-select" id="ap-resume-select" style="display:none"></select>
          <button class="ap-btn-generate" id="ap-btn-tailor" type="button" disabled>
            ${I_STAR}
            Generate Custom Resume
          </button>
          <div class="ap-upload-status" id="ap-upload-status"></div>
          <div id="ap-tailor-result"></div>
        </div>

        <!-- Upload Cover Letter (compact) -->
        <div class="ap-rc">
          <div class="ap-rc-head">
            <span class="ap-section-icon">${I_ENVELOPE}</span>
            <span class="ap-section-title">Upload Cover Letter</span>
          </div>
          <select id="ap-cover-tone" class="ap-cover-tone" aria-label="Cover letter tone">
            <option value="">Default tone</option>
            <option value="professional">Professional</option>
            <option value="formal">Formal</option>
            <option value="enthusiastic">Enthusiastic</option>
            <option value="concise">Concise</option>
            <option value="technical">Technical</option>
          </select>
          <button class="ap-btn-generate" id="ap-btn-cover" type="button" disabled>
            ${I_STAR}
            Generate Cover Letter
          </button>
          <div id="ap-cover-result"></div>
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

      <!-- Next-page gate — pinned at the panel bottom, shown only while a
           multi-page flow is parked at "ready" (see updateFlowProgress). -->
      <div class="ap-flow-next-wrap" style="display:none">
        <button class="ap-flow-next" id="ap-flow-next" type="button">Next page →</button>
      </div>
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
            <button class="ap-modal-sidebar-item" data-cat="address">Address</button>
            <button class="ap-modal-sidebar-item" data-cat="education">Education</button>
            <button class="ap-modal-sidebar-item" data-cat="experience">Work Experience</button>
            <button class="ap-modal-sidebar-item" data-cat="skill">Skill</button>
            <button class="ap-modal-sidebar-item" data-cat="preference">Preference</button>
            <button class="ap-modal-sidebar-item" data-cat="eeo">Equal Employment</button>
            <button class="ap-modal-sidebar-item" data-cat="signup">Account creation</button>
            <button class="ap-modal-sidebar-item" data-cat="answers">Remembered answers</button>
          </div>
          <div class="ap-modal-form" id="ap-info-form"></div>
        </div>
        <div class="ap-modal-footer">
          <div class="ap-modal-error" id="ap-info-error" style="display:none"></div>
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
    jobcard: q("#ap-jobcard"),
    jobcardLogo: q("#ap-jobcard-logo"),
    jobcardCompany: q("#ap-jobcard-company"),
    jobcardTitle: q("#ap-jobcard-title"),
    btnAutofill: q("#ap-btn-autofill"),
    fieldCount: q("#ap-field-count"),
    banner: q("#ap-banner"),
    flow: q("#ap-flow"),
    flowText: q("#ap-flow-text"),
    flowNext: q(".ap-flow-next-wrap"),
    flowNextBtn: q("#ap-flow-next"),
    signins: q("#ap-signins"),
    signinsBody: q("#ap-signins-body"),
    checklist: q("#ap-checklist"),
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

  // Flow Next page button -> advance to the next page; hide the button now so
  // it can't be double-clicked (the next "ready" beat re-shows it if needed).
  root.querySelector("#ap-flow-next")!.addEventListener("click", () => {
    if (refs) refs.flowNext.style.display = "none";
    callbacks?.onFlowAdvance();
  });

  // Saved sign-ins -> render device-local credentials when the section opens.
  const signins = root.querySelector<HTMLDetailsElement>("#ap-signins")!;
  signins.addEventListener("toggle", () => {
    if (signins.open) void renderSavedSignins();
  });

  // "Your Autofill Information" section -> open info view
  root.querySelector("#ap-section-info")!.addEventListener("click", () => {
    void showInfoView();
  });

  // Upload résumé to the current form
  root.querySelector("#ap-btn-upload-resume")!.addEventListener("click", () => void doUploadResume());

  // Tailor button
  root.querySelector("#ap-btn-tailor")!.addEventListener("click", () => void doTailor());

  // Generate Cover Letter button
  root.querySelector("#ap-btn-cover")!.addEventListener("click", () => void doGenerateCoverLetter());

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

  // Mirror every edit in the info form into the working draft. Delegated on the
  // form container so it survives category re-renders (innerHTML swaps).
  refs!.infoForm.addEventListener("input", onInfoInput);
  refs!.infoForm.addEventListener("change", onInfoInput);
  refs!.infoForm.addEventListener("click", onInfoFormClick);

  // Update button — persist the draft to the shared profile, then re-sync.
  root.querySelector("#ap-btn-update")!.addEventListener("click", () => void saveInfoEdits());

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

async function showInfoView(): Promise<void> {
  if (!refs) return;
  refs.modalBackdrop.classList.add("visible");
  overlayState.infoCategory = "personal";
  overlayState.rememberedAnswers = [];
  overlayState.rememberedLoaded = false;
  overlayState.signupDraft = null;
  overlayState.signupLoaded = false;
  signupOriginal = null;
  setInfoError("");
  refs.infoSidebar.querySelectorAll<HTMLButtonElement>(".ap-modal-sidebar-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.cat === "personal")
  );
  // Render immediately from what we already have so the modal opens instantly.
  overlayState.profileDraft = overlayState.profile ? draftFromProfile(overlayState.profile) : null;
  renderInfoForm();

  // Then pull the latest profile from the server (a cheap sync-version check;
  // re-downloads only if the web app changed something) so this panel always
  // reflects the current web-app profile — the two stay in sync, and demographic
  // / address / other answers edited on the web app show up here without a
  // reload. Skip the rebuild if the user already started editing (draft changed)
  // or closed the modal in the meantime, so we never clobber their input.
  const snapshot = JSON.stringify(overlayState.profileDraft);
  const resp = await bg<ProfileResponse>({ type: "GET_PROFILE" }).catch(() => null);
  if (
    resp?.ok &&
    resp.profile &&
    refs.modalBackdrop.classList.contains("visible") &&
    JSON.stringify(overlayState.profileDraft) === snapshot
  ) {
    overlayState.profile = resp.profile;
    overlayState.source = resp.source ?? overlayState.source;
    overlayState.profileDraft = draftFromProfile(resp.profile);
    renderInfoForm();
  }
}

function hideInfoView(): void {
  if (!refs) return;
  refs.modalBackdrop.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Main view rendering
// ---------------------------------------------------------------------------

/** Paint the job-card header (company logo + name + title) from the scraped
 *  job context. Hidden when the page yields neither company nor title. The logo
 *  is on-device (favicon / og:image) with a colored-monogram fallback when the
 *  image is missing or blocked by the page CSP. */
function renderJobCard(): void {
  if (!refs) return;
  const company = overlayState.company.trim();
  const title = overlayState.jobTitle.trim();
  if (!company && !title) {
    refs.jobcard.style.display = "none";
    return;
  }
  refs.jobcard.style.display = "flex";
  refs.jobcardCompany.textContent = company || "This job";
  refs.jobcardTitle.textContent = title;
  refs.jobcardTitle.style.display = title ? "block" : "none";

  const box = refs.jobcardLogo;
  if (box.dataset.company === company) return; // logo already resolved for this company
  box.dataset.company = company;
  const logo = resolveCompanyLogo(document, company);
  const showMono = (): void => {
    box.classList.add("is-mono");
    box.style.background = logo.color;
    box.textContent = logo.monogram;
  };
  if (logo.src) {
    box.classList.remove("is-mono");
    box.style.background = "#fff";
    box.textContent = "";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.onerror = showMono;
    img.src = logo.src;
    box.appendChild(img);
  } else {
    showMono();
  }
}

function refreshMainView(): void {
  if (!refs) return;
  renderJobCard();
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

  // A job posting / apply-method chooser has no (recognized) fields but does
  // have an apply-entry button \u2014 Autofill starts the flow by clicking it.
  const entryStart = canStartFromEntry();
  // The primary action always runs the full flow (click Apply, create account,
  // fill, advance), so it stays live whenever a profile is loaded -- even on a
  // bare job posting with no form fields. entryStart only tunes the hint below.
  const canRun = Boolean(overlayState.profile) && !overlayState.busy;
  refs.btnAutofill.disabled = !canRun;
  refs.btnAutofill.textContent = overlayState.busy ? "Working\u2026" : "Account Creation & Autofill";

  if (entryStart) {
    refs.fieldCount.textContent = `Autofill will click \u201c${overlayState.applyEntry}\u201d and continue with the application`;
  } else if (fields.length > 0) {
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
  addressStreet: "Street address",
  addressCity: "City",
  addressState: "Province or state",
  postalCode: "Postal code",
  country: "Country",
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
  const fields = overlayState.fields.filter(
    (f) =>
      (f.fillable || f.category !== "unknown") &&
      f.category !== "accountPassword" &&
      // Show sensitive (EEO) rows only when we actually have the user's answer to
      // fill; a sensitive field with no stored value stays hidden (never guessed).
      !(f.sensitive && f.proposedValue === null)
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
// Saved sign-ins (device-local signup-wall credentials)
// ---------------------------------------------------------------------------

/**
 * Render the signup-wall credentials the account flow saved on this device.
 * Passwords stay masked until the user reveals one — and a revealed password is
 * only ever written into `textContent` (never innerHTML, never logged). Reveal /
 * copy / delete are wired per row; a delete re-renders the shortened list.
 */
async function renderSavedSignins(): Promise<void> {
  if (!refs) return;
  const host = refs.signinsBody;
  const creds = await listCredentials();
  if (creds.length === 0) {
    host.innerHTML = `<div class="ap-signins-empty">No saved sign-ins yet. Signup walls passed by autofill appear here.</div>`;
    return;
  }
  host.innerHTML = creds
    .map(
      (c, i) => `
    <div class="ap-signin-row" data-origin="${esc(c.origin)}">
      <div class="ap-signin-meta">
        <span class="ap-signin-site">${esc(c.origin.replace(/^https?:\/\//, ""))}</span>
        <span class="ap-signin-email">${esc(c.email)}</span>
      </div>
      <code class="ap-signin-pass" id="ap-pass-${i}" data-hidden="1">••••••••</code>
      <button class="ap-signin-reveal" data-i="${i}" type="button">Show</button>
      <button class="ap-signin-copy" data-i="${i}" type="button">Copy</button>
      <button class="ap-signin-del" data-i="${i}" type="button">Delete</button>
    </div>`
    )
    .join("");
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-reveal").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      const code = host.querySelector<HTMLElement>(`#ap-pass-${i}`);
      if (!code) return;
      const hidden = code.dataset.hidden === "1";
      code.textContent = hidden ? creds[i].password : "••••••••";
      code.dataset.hidden = hidden ? "0" : "1";
      btn.textContent = hidden ? "Hide" : "Show";
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(creds[Number(btn.dataset.i)].password).catch(() => {});
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      void deleteCredential(creds[Number(btn.dataset.i)].origin).then(renderSavedSignins);
    });
  });
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

/** True when Autofill should start by clicking the page's apply-entry button —
 *  mirrors the flow controller's gate (no recognized fields + an entry). */
function canStartFromEntry(): boolean {
  const recognized = overlayState.fields.filter((f) => f.category !== "unknown").length;
  return recognized === 0 && Boolean(overlayState.applyEntry);
}

// ---------------------------------------------------------------------------
// Autofill
// ---------------------------------------------------------------------------

/** The résumé currently picked in the upload section, if the user picked one. */
function currentUploadResumeId(): number | null {
  // Mirror the résumé-picker read the upload handler uses (see doUploadResume):
  // only an explicitly chosen, visible selection counts — otherwise null, so the
  // flow keeps its own auto-attach default instead of us forcing a résumé here.
  const sel = refs?.resumeSelect;
  if (!sel || sel.style.display === "none" || !sel.value) return null;
  const v = Number(sel.value);
  return Number.isFinite(v) ? v : null;
}

async function doAutofill(): Promise<void> {
  if (!callbacks || overlayState.busy) return;
  const ids = [...overlayState.selected];
  const entryStart = canStartFromEntry();
  if (ids.length === 0 && !entryStart) return;

  overlayState.busy = true;
  refreshMainView();
  showBanner("", "ok", true);

  try {
    await callbacks.onAutofill(ids, currentUploadResumeId());
    // No per-click "Filled X of Y — review before submitting" banner: one click
    // now runs the whole multi-page flow, so the flow status line and its final
    // "done" beat own the feedback. (A mid-flow "review before submitting" read
    // as if the application were already finished, which was confusing.)
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

// Editable profile draft — the working copy the info modal binds to so edits
// survive switching categories. Only the fields the application-profile endpoint
// accepts are editable; résumé-derived sections (education/experience/skills,
// GitHub) stay read-only and are managed from the web-app profile.
interface EditableProfileDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  portfolio: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  postalCode: string;
  country: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
  eeo: {
    gender: string;
    race: string;
    hispanicLatino: string;
    veteranStatus: string;
    disabilityStatus: string;
  };
}

const EEO_CHOICES: Record<keyof EditableProfileDraft["eeo"], string[]> = {
  gender: ["Male", "Female", "Non-binary", "Prefer not to say"],
  race: [
    "American Indian or Alaska Native", "Asian", "Black or African American",
    "Hispanic or Latino", "Native Hawaiian or Other Pacific Islander", "White",
    "Two or More Races", "Prefer not to say",
  ],
  hispanicLatino: ["Yes", "No", "Prefer not to say"],
  veteranStatus: [
    "I am not a protected veteran",
    "I identify as one or more of the classifications of a protected veteran",
    "Prefer not to say",
  ],
  disabilityStatus: [
    "Yes, I have a disability", "No, I do not have a disability", "Prefer not to say",
  ],
};

function draftFromProfile(p: UserApplicationProfile): EditableProfileDraft {
  return {
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    location: p.location ?? "",
    linkedin: p.linkedin ?? "",
    portfolio: p.portfolio ?? "",
    addressStreet: p.addressStreet ?? "",
    addressCity: p.addressCity ?? "",
    addressState: p.addressState ?? "",
    postalCode: p.postalCode ?? "",
    country: p.country ?? "",
    workAuthorization: p.workAuthorization ?? "",
    requiresSponsorship: p.requiresSponsorship ?? "",
    salaryExpectation: p.salaryExpectation ?? "",
    eeo: {
      gender: p.eeo?.gender ?? "",
      race: p.eeo?.race ?? "",
      hispanicLatino: p.eeo?.hispanicLatino ?? "",
      veteranStatus: p.eeo?.veteranStatus ?? "",
      disabilityStatus: p.eeo?.disabilityStatus ?? "",
    },
  };
}

/** One editable text field bound to a draft key via data-field. */
function apField(
  field: keyof EditableProfileDraft,
  label: string,
  value: string,
  opts: { required?: boolean; type?: string } = {}
): string {
  const req = opts.required ? '<span class="ap-required">*</span>' : "";
  return `<div class="ap-form-row"><label>${req}${label}</label><input data-field="${field}" type="${opts.type ?? "text"}" value="${esc(value)}" /></div>`;
}

/** One read-only field (résumé-derived; managed on the web app). */
function apReadonly(label: string, value: string): string {
  return `<div class="ap-form-row"><label>${label}</label><input value="${esc(value)}" readonly /></div>`;
}

/** One EEO select bound to draft.eeo via data-eeo. */
function apEeoSelect(field: keyof EditableProfileDraft["eeo"], label: string, value: string): string {
  const opts = ['<option value="">Select…</option>']
    .concat(EEO_CHOICES[field].map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`))
    .join("");
  return `<div class="ap-form-row"><label>${label}</label><select data-eeo="${field}">${opts}</select></div>`;
}

const RESUME_HINT = '<div class="ap-form-hint">Synced from your résumé — edit it on your Tailrd profile.</div>';

function renderInfoForm(): void {
  if (!refs) return;
  const p = overlayState.profile;
  const d = overlayState.profileDraft;
  const cat = overlayState.infoCategory;
  const form = refs.infoForm;
  form.innerHTML = "";

  if (!p || !d) {
    form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">Sign in and upload a resume to see your information.</div>';
    return;
  }

  switch (cat) {
    case "personal":
      form.innerHTML = `
        <div class="ap-form-grid">
          ${apField("firstName", "First Name", d.firstName, { required: true })}
          ${apField("lastName", "Last Name", d.lastName, { required: true })}
        </div>
        ${apField("email", "Email Address", d.email, { required: true, type: "email" })}
        ${apField("phone", "Phone", d.phone, { required: true, type: "tel" })}
        ${apField("location", "Location", d.location)}
        <div class="ap-form-grid">
          ${apField("linkedin", "LinkedIn", d.linkedin, { type: "url" })}
          ${apReadonly("GitHub", p.github)}
        </div>
        ${apField("portfolio", "Portfolio", d.portfolio, { type: "url" })}
      `;
      break;
    case "address":
      form.innerHTML = `
        ${apField("addressStreet", "Street Address", d.addressStreet)}
        <div class="ap-form-grid">
          ${apField("addressCity", "City", d.addressCity)}
          ${apField("addressState", "Province / State", d.addressState)}
        </div>
        <div class="ap-form-grid">
          ${apField("postalCode", "Postal Code", d.postalCode)}
          ${apField("country", "Country", d.country)}
        </div>
      `;
      break;
    case "education":
      if ((p.education ?? []).length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No education entries yet.</div>';
      } else {
        let html = RESUME_HINT;
        for (const e of p.education ?? []) {
          html += `
            ${apReadonly("School", e.school)}
            <div class="ap-form-grid">
              ${apReadonly("Degree", e.degree)}
              ${apReadonly("Graduation Year", e.graduationYear)}
            </div>
            <hr style="border:none;border-top:1px solid var(--stripe-hairline-soft);margin:14px 0" />
          `;
        }
        form.innerHTML = html;
      }
      break;
    case "experience":
      if ((p.experience ?? []).length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No work experience entries yet.</div>';
      } else {
        let html = RESUME_HINT;
        for (const e of p.experience ?? []) {
          html += `
            <div class="ap-form-grid">
              ${apReadonly("Company", e.company)}
              ${apReadonly("Title", e.title)}
            </div>
            <div class="ap-form-grid">
              ${apReadonly("Start Date", e.startDate)}
              ${apReadonly("End Date", e.endDate || "Present")}
            </div>
            <hr style="border:none;border-top:1px solid var(--stripe-hairline-soft);margin:14px 0" />
          `;
        }
        form.innerHTML = html;
      }
      break;
    case "skill":
      if ((p.skills ?? []).length === 0) {
        form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No skills on file yet.</div>';
      } else {
        form.innerHTML = RESUME_HINT + apReadonly("Skills", (p.skills ?? []).join(", "));
      }
      break;
    case "preference":
      form.innerHTML = `
        ${apField("workAuthorization", "Work Authorization", d.workAuthorization)}
        ${apField("requiresSponsorship", "Requires Sponsorship", d.requiresSponsorship)}
        ${apField("salaryExpectation", "Salary Expectation", d.salaryExpectation)}
      `;
      break;
    case "eeo":
      form.innerHTML = `
        <div class="ap-form-hint">Optional self-identification. Only filled when EEO autofill is enabled. Kept private.</div>
        ${apEeoSelect("gender", "Gender", d.eeo.gender)}
        ${apEeoSelect("race", "Race / Ethnicity", d.eeo.race)}
        ${apEeoSelect("hispanicLatino", "Hispanic or Latino", d.eeo.hispanicLatino)}
        ${apEeoSelect("veteranStatus", "Veteran Status", d.eeo.veteranStatus)}
        ${apEeoSelect("disabilityStatus", "Disability Status", d.eeo.disabilityStatus)}
      `;
      break;
    case "signup":
      renderSignupForm(form, p);
      break;
    case "answers":
      renderAnswersForm(form);
      break;
  }
}

/**
 * Render the "Account creation" section: the email + password autofill uses on
 * signup/sign-in walls (Workday-style ATSs that gate the application behind an
 * account). Device-local only — saved to chrome.storage.local, never sent to
 * the Tailrd backend or the AI. The password input stays type="password"; a
 * Show/Hide toggle flips it (never rendered into markup).
 */
function renderSignupForm(form: HTMLElement, p: UserApplicationProfile): void {
  if (!overlayState.signupLoaded) {
    form.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">Loading…</div>';
    void loadSignupDefaults();
    return;
  }
  const s = overlayState.signupDraft ?? { email: "", password: "" };
  form.innerHTML = `
    <div class="ap-form-hint">Some sites (Workday and similar) require an account before you can apply. Autofill creates or signs in to those accounts with the details below, then continues filling. Stored only on this device — never sent to Tailrd or the AI.</div>
    <div class="ap-form-row">
      <label>Account email</label>
      <input data-signup="email" type="email" value="${esc(s.email)}" placeholder="${esc(p.email || "you@example.com")}" />
    </div>
    <div class="ap-form-row">
      <label>Account password</label>
      <div class="ap-signup-pass-row">
        <input data-signup="password" type="password" value="${esc(s.password)}" placeholder="Leave blank to auto-generate per site" autocomplete="new-password" />
        <button type="button" class="ap-mini-btn" data-signup-reveal="1">Show</button>
      </div>
    </div>
    <div class="ap-form-hint">Blank email falls back to your profile email. The exact pair used on each site appears under “Saved sign-ins” in the panel, so you can always look a password up later.</div>
  `;
}

/** Load the device-local account-creation credentials into the modal draft. */
async function loadSignupDefaults(): Promise<void> {
  try {
    const d = await getDefaultCredential();
    overlayState.signupDraft = { ...d };
    signupOriginal = { ...d };
  } catch {
    overlayState.signupDraft = { email: "", password: "" };
    signupOriginal = { email: "", password: "" };
  }
  overlayState.signupLoaded = true;
  if (overlayState.infoCategory === "signup") renderInfoForm();
}

/** Snapshot of the stored defaults, for change detection on Update. */
let signupOriginal: DefaultCredential | null = null;

/**
 * Render the "Remembered answers" list — every free-form question the user has
 * answered in an application pop-up, editable and removable here. Built with DOM
 * APIs (not innerHTML) so saved answer text can never inject markup.
 */
function renderAnswersForm(form: HTMLElement): void {
  form.innerHTML = "";
  if (!overlayState.rememberedLoaded) {
    form.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">Loading…</div>';
    void loadRememberedAnswers();
    return;
  }
  const answers = overlayState.rememberedAnswers;
  if (answers.length === 0) {
    form.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">No remembered answers yet. Answers you give in application pop-ups appear here.</div>';
    return;
  }
  const hint = document.createElement("div");
  hint.className = "ap-form-hint";
  hint.textContent = "Answers Tailrd remembered from application questions. Edit or remove any — changes save automatically.";
  form.appendChild(hint);
  for (const a of answers) {
    const row = document.createElement("div");
    row.className = "ap-answer-row";
    const q = document.createElement("div");
    q.className = "ap-answer-q";
    q.textContent = a.question;
    const ta = document.createElement("textarea");
    ta.className = "ap-answer-a";
    ta.rows = 2;
    ta.value = a.answer;
    ta.dataset.answerId = String(a.id);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ap-answer-del";
    del.dataset.delId = String(a.id);
    del.textContent = "Remove";
    row.append(q, ta, del);
    form.appendChild(row);
  }
}

/** Fetch remembered answers, then re-render if the user is still on that tab. */
async function loadRememberedAnswers(): Promise<void> {
  try {
    const resp = await bg<AnswersResponse>({ type: "GET_ANSWERS" });
    overlayState.rememberedAnswers = resp?.ok ? resp.answers : [];
  } catch {
    overlayState.rememberedAnswers = [];
  }
  overlayState.rememberedLoaded = true;
  if (overlayState.infoCategory === "answers") renderInfoForm();
}

/** Delegated input handler: mirror form edits into the draft (survives re-render). */
function onInfoInput(e: Event): void {
  const t = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  // Remembered-answer edit: persist on change/blur, not on every keystroke.
  const answerId = t.dataset.answerId;
  if (answerId) {
    if (e.type === "change") {
      const item = overlayState.rememberedAnswers.find((a) => String(a.id) === answerId);
      if (item) item.answer = t.value;
      void bg<SimpleResponse>({ type: "UPDATE_ANSWER", id: Number(answerId), answer: t.value });
    }
    return;
  }
  // Account-creation credentials (device-local; not part of the profile draft).
  const signupField = t.dataset.signup;
  if (signupField === "email" || signupField === "password") {
    if (overlayState.signupDraft) overlayState.signupDraft[signupField] = t.value;
    return;
  }
  const d = overlayState.profileDraft;
  if (!d) return;
  const field = t.dataset.field;
  const eeoField = t.dataset.eeo;
  if (field && field !== "eeo" && field in d) {
    (d as unknown as Record<string, string>)[field] = t.value;
  } else if (eeoField && eeoField in d.eeo) {
    (d.eeo as unknown as Record<string, string>)[eeoField] = t.value;
  }
}

/** Delegated click handler on the info form: "Remove" a remembered answer,
 *  or the account-password Show/Hide toggle. */
function onInfoFormClick(e: Event): void {
  const target = e.target as HTMLElement;
  const reveal = target.closest<HTMLButtonElement>("[data-signup-reveal]");
  if (reveal) {
    const input = refs?.infoForm.querySelector<HTMLInputElement>('input[data-signup="password"]');
    if (input) {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      reveal.textContent = show ? "Hide" : "Show";
    }
    return;
  }
  const btn = target.closest<HTMLElement>("[data-del-id]");
  if (!btn) return;
  const id = Number(btn.dataset.delId);
  overlayState.rememberedAnswers = overlayState.rememberedAnswers.filter((a) => a.id !== id);
  void bg<SimpleResponse>({ type: "DELETE_ANSWER", id });
  if (overlayState.infoCategory === "answers") renderInfoForm();
}

function setInfoError(msg: string): void {
  const el = refs?.root.querySelector<HTMLDivElement>("#ap-info-error");
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

/** Persist the info-modal edits to the profile the extension + web app share. */
async function saveInfoEdits(): Promise<void> {
  if (!refs) return;
  const d = overlayState.profileDraft;
  const btn = refs.root.querySelector<HTMLButtonElement>("#ap-btn-update");
  if (!d) { hideInfoView(); return; }
  setInfoError("");

  // Account-creation credentials save device-locally, independent of the
  // profile round-trip below — they must never reach the backend.
  const s = overlayState.signupDraft;
  if (s && signupOriginal && (s.email !== signupOriginal.email || s.password !== signupOriginal.password)) {
    const next = { email: s.email.trim(), password: s.password };
    try {
      await saveDefaultCredential(next);
      signupOriginal = { ...next };
    } catch {
      // Storage unavailable — leave the draft in place so a retry can save it.
    }
  }

  // Send only what changed so we don't bump the sync version (and force a
  // re-download) when the user opens the modal and clicks Update without edits.
  const orig = overlayState.profile ?? ({} as UserApplicationProfile);
  const update: Partial<UserApplicationProfile> = {};
  const scalarKeys: (keyof EditableProfileDraft)[] = [
    "firstName", "lastName", "email", "phone", "location", "linkedin", "portfolio",
    "addressStreet", "addressCity", "addressState", "postalCode", "country",
    "workAuthorization", "requiresSponsorship", "salaryExpectation",
  ];
  for (const k of scalarKeys) {
    const next = (d as unknown as Record<string, string>)[k];
    const prev = (orig as unknown as Record<string, string>)[k] ?? "";
    if (next !== prev) (update as Record<string, string>)[k] = next;
  }
  const eeoOrig = orig.eeo ?? {};
  const eeoDiff: EeoAnswers = {};
  (Object.keys(d.eeo) as (keyof EditableProfileDraft["eeo"])[]).forEach((k) => {
    if (d.eeo[k] !== ((eeoOrig as Record<string, string>)[k] ?? "")) eeoDiff[k] = d.eeo[k];
  });
  if (Object.keys(eeoDiff).length > 0) update.eeo = eeoDiff;

  if (Object.keys(update).length === 0) { hideInfoView(); return; }

  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const resp = await bg<ProfileResponse>({ type: "UPDATE_PROFILE", update });
    if (resp?.ok && resp.profile) {
      overlayState.profile = resp.profile;
      overlayState.source = resp.source ?? overlayState.source;
      // Re-feed the scanner so the just-edited values immediately propose fills.
      callbacks?.onProfileResolved(overlayState.profile);
      refreshMainView();
      hideInfoView();
    } else if (resp?.needsLogin) {
      hideInfoView();
      showLoginView(true);
    } else {
      setInfoError(resp?.error ?? "Couldn't save your changes. Please try again.");
    }
  } catch (err) {
    setInfoError(err instanceof Error ? err.message : "Couldn't save your changes. Please try again.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Update"; }
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
