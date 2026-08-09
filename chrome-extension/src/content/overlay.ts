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
import { BRAND_LOGO_DATA_URI, BRAND_MARK_DATA_URI } from "./brandLogo";
import {
  cryptoId,
  emptyExtras,
  getExtras,
  mergeProfileWithExtras,
  pruneExtras,
  saveExtras,
  type AutofillExtras,
} from "./autofillExtras";
import { selectAnswerGaps, type AnswerGap } from "./answerGaps";
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
  AnswersResponse,
  BackgroundRequest,
  ControlType,
  CoverLetterGenOpts,
  DetectedField,
  EeoAnswers,
  FillOutcome,
  FlowPauseReason,
  FlowProgress,
  LoginResponse,
  ProfileResponse,
  ProfileSource,
  RenderResumeResponse,
  ResumeDoc,
  ResumeSummary,
  SavedAnswerItem,
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
  /**
   * Write the user's answers to the unanswered questions into the page, then
   * remember them (profile / device-local / answer bank — see planAnswerSaves).
   * Returns the number written, and how many answers were deliberately NOT
   * remembered (answersWorthRemembering), so the panel can report honestly
   * rather than claiming to have saved something it threw away.
   */
  onAnswerGaps: (
    answers: { gap: AnswerGap; value: string }[]
  ) => Promise<{ ok: boolean; filled: number; discarded?: number; reason?: string }>;
  /**
   * Read the REAL options of the given fields' controls, by opening each
   * dropdown on the page and closing it again. Keyed by field id; a widget that
   * yields nothing is simply absent from the result.
   */
  onHarvestGapOptions: (fieldIds: string[]) => Promise<Record<string, string[]>>;
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
  /**
   * Open the real Tailrd app AI modal (résumé rewrite / cover letter) in an
   * iframe overlay — the extension parity path for "exactly like the app".
   * Runs locally in the panel's frame (not proxied cross-frame).
   */
  onOpenAiModal: (kind: "resume" | "cover") => void;
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
  /** Detected ATS label ("Workday", "iCIMS"…), or null on a generic form. */
  siteLabel?: string | null;
}

export function showOverlay(state: OverlayViewState, cb: OverlayCallbacks): void {
  callbacks = cb;
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  overlayState.applyEntry = state.applyEntry ?? null;
  overlayState.company = state.company ?? "";
  overlayState.jobTitle = state.jobTitle ?? "";
  overlayState.siteLabel = state.siteLabel ?? null;
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
  overlayState.siteLabel = state.siteLabel ?? null;
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

/**
 * The bottom gate's label. Default is the plain "Continue To The Next Page".
 *
 * A wall the flow is about to CREATE something on names it instead ("Create
 * Account ▶"): pressing Continue there registers an account, which is not what
 * "next page" leads a user to expect. Ordinary Next / Save-and-Continue
 * buttons keep the generic label — echoing the site's own wording adds nothing
 * and reads as noise. Pure.
 */
const GENERIC_NEXT = "Continue To The Next Page";
const NAMED_ADVANCE_RE = /create (an? )?account|sign ?up|register|sign ?in|log ?in/i;

export function formatNextLabel(p: FlowProgress): string {
  const label = (p.nextLabel ?? "").trim();
  if (label && NAMED_ADVANCE_RE.test(label)) return `${label} ▶`;
  return `${GENERIC_NEXT} ▶`;
}

/** Beats where the bottom gate is offered to the user. Pure — unit-tested.
 *  - ready: the page is filled and waiting to be turned.
 *  - unfilled-required: same, with a caveat the panel explains.
 *  - account: the flow could not pass a signup/sign-in wall on its own; the
 *    button lets the user hand control back once they have dealt with it,
 *    instead of stranding them on a filled form with no next step. */
export function showsAdvanceGate(p: FlowProgress): boolean {
  if (p.phase === "ready") return true;
  return p.phase === "paused" && (p.pauseReason === "unfilled-required" || p.pauseReason === "account");
}

/** Render a flow beat: minimal strip (no narration) + the bottom Next page gate. */
export function updateFlowProgress(p: FlowProgress): void {
  if (!refs) return;
  const running =
    p.phase === "filling" || p.phase === "advancing" || p.phase === "paused" || p.phase === "ready";
  refs.flow.style.display = running ? "flex" : "none";
  // NO step-by-step narration in the panel — "Step 1 · filling…" style chatter
  // reads as clutter. The strip shows one calm word while the flow is actively
  // working (plus Stop), and nothing at all on a parked page: the bottom gate
  // already shows the next action.
  //
  // A PAUSE is the exception, and it has to say why. A paused flow shows no
  // gate and no summary, so an unexplained blank strip is a dead end — the user
  // cannot tell whether it is still working, finished, or waiting on them, and
  // the only thing left to try is clicking Autofill again. The reason is
  // actionable ("add account credentials in Autofill Information → Account
  // creation, or sign in manually"), so it belongs on screen, not just in the
  // console. The unfilled-required pause is excluded: it DOES show the gate,
  // whose label already says what to do.
  const active = p.phase === "filling" || p.phase === "advancing";
  const explainPause = p.phase === "paused" && p.pauseReason !== "unfilled-required";
  refs.flowText.textContent = active
    ? "Autofilling…"
    : explainPause
      ? `Paused — ${PAUSE_TEXT[p.pauseReason ?? "validation"]}`
      : "";
  console.info(`[Tailrd] ${formatFlowProgress(p)}`);
  // The advance gate is pinned at the panel bottom. The flow parks on every
  // filled page — at a "ready" beat, or a "paused" beat when a required field is
  // still empty — and turns the page only when the user presses this button. Its
  // label mirrors the real button the flow will click (Next / Continue).
  refs.flowNextBtn.textContent = formatNextLabel(p);
  refs.flowNext.style.display = showsAdvanceGate(p) ? "flex" : "none";
  // A terminal beat clears any earlier banner so nothing outlives the run.
  if (p.phase === "done" || p.phase === "stopped") showBanner("", "ok", true);
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
const P_FILE = '<path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z"/>';
const P_UPLOAD = '<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z"/>';
const P_STAR = '<path d="M239.18,97.26A16.38,16.38,0,0,0,224.92,86l-59-4.76L143.14,26.15a16.36,16.36,0,0,0-30.27,0L90.11,81.23,31.08,86a16.46,16.46,0,0,0-9.37,28.86l45,38.83L53,211.75a16.38,16.38,0,0,0,24.5,17.82L128,198.49l50.53,31.08A16.4,16.4,0,0,0,203,211.75l-13.76-58.07,45-38.83A16.43,16.43,0,0,0,239.18,97.26Z"/>';
const P_ENVELOPE = '<path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48Zm-96,85.15L52.57,64H203.43ZM98.71,128,40,181.81V74.19Zm11.84,10.85,12,11.05a8,8,0,0,0,10.82,0l12-11.05,58,53.15H52.57ZM157.29,128,216,74.18V181.82Z"/>';
const P_REGEN = '<path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"/>';
const P_DOWNLOAD = '<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"/>';
const P_PAPERCLIP = '<path d="M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z"/>';
const P_INFO = '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z"/>';
// Phosphor "question" — the unanswered-questions card.
const P_QUESTION = '<path d="M140,180a12,12,0,1,1-12-12A12,12,0,0,1,140,180ZM128,72c-22.06,0-40,16.15-40,36v4a8,8,0,0,0,16,0v-4c0-11,10.77-20,24-20s24,9,24,20-10.77,20-24,20a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-.72c18.24-3.35,32-17.9,32-35.28C168,88.15,150.06,72,128,72Zm104,56A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/>';
// Phosphor "key" — the Saved sign-ins section/modal mark.
const P_KEY = '<path d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A80,80,0,0,0,216.57,39.43ZM180,100a16,16,0,1,1,16-16A16,16,0,0,1,180,100Z"/>';

const I_CLOSE = ph(P_X);
const I_CHEVRON_RIGHT = ph(P_CARET_RIGHT);
const I_FILE = ph(P_FILE);
const I_UPLOAD = ph(P_UPLOAD);
const I_STAR = ph(P_STAR);
const I_ENVELOPE = ph(P_ENVELOPE);
const I_REGEN = ph(P_REGEN);
const I_DOWNLOAD = ph(P_DOWNLOAD);
const I_PAPERCLIP = ph(P_PAPERCLIP);
const I_INFO = ph(P_INFO);
const I_KEY = ph(P_KEY);
const I_QUESTION = ph(P_QUESTION);

// The header brand mark is the real Tailrd wing logo, rendered as a data-URI
// <img> (see brandLogo.ts + wireBrandLogo). It is NOT an inline SVG because the
// real logo is a gradient wing that can't be faithfully reproduced as hand-coded
// vector; the <img> shows the true logo where the page CSP allows it and the
// header falls back to the "Tailrd" wordmark where a strict img-src CSP blocks it.


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

/* ---- Edge tab ----
   A white tab carrying the circular Tailrd mark. On strict img-src CSP pages
   the data-URI mark is blocked, and wireBrandLogo() adds .is-fallback — which
   restores the original purple gradient + white chevron so the tab is never
   an empty white sliver. */
.ap-edge-tab {
  position: fixed;
  top: 50%; right: 0;
  transform: translateY(-50%);
  width: 44px; height: 64px;
  border-radius: 14px 0 0 14px;
  border: 1px solid var(--stripe-hairline);
  border-right: none;
  cursor: pointer;
  background: #fff;
  box-shadow: -2px 0 12px rgba(var(--stripe-shadow-rgb),0.18);
  display: flex; align-items: center; justify-content: center;
  color: #fff; padding: 0;
  transition: width 0.15s, box-shadow 0.15s;
}
.ap-edge-tab:hover { width: 48px; box-shadow: -3px 0 16px rgba(var(--stripe-shadow-rgb),0.24); }
.ap-edge-mark { width: 28px; height: 28px; object-fit: contain; display: block; }
.ap-edge-tab svg { display: none; }
.ap-edge-tab.is-fallback {
  width: 28px;
  border: none;
  border-radius: 10px 0 0 10px;
  background: linear-gradient(180deg, var(--stripe-primary) 0%, var(--stripe-primary-deep) 100%);
  box-shadow: -2px 0 10px rgba(var(--stripe-primary-rgb),0.3);
}
.ap-edge-tab.is-fallback:hover { width: 32px; }
.ap-edge-tab.is-fallback .ap-edge-mark { display: none; }
.ap-edge-tab.is-fallback svg { display: block; width: 14px; height: 14px; transform: rotate(180deg); }
.ap-root.ap-expanded .ap-edge-tab { display: none; }
.ap-root.ap-collapsed .ap-panel { display: none; }

/* ---- Panel ---- */
.ap-panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  /* A snapped or narrow browser window can be under 380px; the panel must
     shrink with it rather than run off the right edge of the host page.
     .ap-pdf-modal, which covers this panel, already guards the same way. */
  width: 380px; max-width: 100vw;
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
.ap-brand-lockup { height: 26px; width: auto; max-width: 160px; object-fit: contain; display: block; }
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
/* The Phosphor icons carry only a viewBox, so an unsized inline SVG falls back
   to the 300x150 replaced-element default and blows out the notice row. */
.ap-modal-notice-icon svg { width: 16px; height: 16px; display: block; }
.ap-modal-body {
  flex: 1; display: flex; overflow: hidden; min-height: 0;
}
/* Single-column modal (no category sidebar) — sized to its content. */
.ap-modal-narrow { width: 560px; height: auto; max-height: 78vh; }
.ap-modal-narrow .ap-modal-body { flex: 0 1 auto; }
.ap-modal-narrow .ap-signins-body { flex: 1; min-width: 0; }
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
.ap-form-row textarea {
  width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--stripe-hairline-soft); border-radius: 8px;
  color: var(--stripe-ink); background: #fff; box-sizing: border-box; resize: vertical;
}
.ap-form-row textarea:focus {
  outline: none; border-color: var(--stripe-primary);
  box-shadow: 0 0 0 2px rgba(var(--stripe-primary-rgb),0.1);
}
/* Editable work-experience entry */
.ap-exp-entry { padding-bottom: 6px; margin-bottom: 14px; border-bottom: 1px solid var(--stripe-hairline-soft); }
.ap-exp-del, .ap-custom-del {
  background: none; border: none; color: #b4232a; font-size: 12px; font-weight: 600;
  cursor: pointer; padding: 2px 0;
}
.ap-exp-del:hover { text-decoration: underline; }
/* User-added custom fields */
.ap-custom-section { margin-top: 8px; }
.ap-custom-heading { font-size: 12px; font-weight: 700; color: var(--stripe-ink-secondary); margin: 6px 0 8px; }
.ap-custom-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ap-custom-row input {
  flex: 1; min-width: 0; padding: 8px 10px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--stripe-hairline-soft); border-radius: 8px;
  color: var(--stripe-ink); background: #fff; box-sizing: border-box;
}
.ap-custom-row input:focus {
  outline: none; border-color: var(--stripe-primary);
  box-shadow: 0 0 0 2px rgba(var(--stripe-primary-rgb),0.1);
}
.ap-custom-del { flex-shrink: 0; display: flex; align-items: center; color: var(--stripe-ink-mute); }
.ap-custom-del:hover { color: #b4232a; }
.ap-custom-del svg { width: 16px; height: 16px; }
.ap-add-field {
  display: inline-flex; align-items: center; gap: 6px;
  background: none; border: 1px dashed var(--stripe-hairline);
  color: var(--stripe-primary); font-size: 13px; font-weight: 600;
  cursor: pointer; padding: 8px 12px; border-radius: 8px; margin-top: 4px;
}
.ap-add-field:hover { background: var(--stripe-canvas-soft); }
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
.ap-flow-text { flex: 1; color: var(--stripe-ink-mute); line-height: 1.35; }
.ap-flow-stop { flex: 0 0 auto; }
/* Next-page gate — pinned at the panel bottom, shown once a page is filled and
   waiting on the user. The one control they touch after the first Autofill. */
.ap-flow-next-wrap {
  display: flex; padding: 12px 14px; flex-shrink: 0;
  border-top: 1px solid var(--stripe-hairline-soft);
  background: var(--stripe-canvas);
}
.ap-flow-next {
  width: 100%; padding: 13px 14px; border: none; border-radius: 8px;
  background: #10cf7f; color: #fff;
  font-family: inherit; font-size: 14px; font-weight: 700; letter-spacing: 0.01em;
  cursor: pointer; transition: background 0.15s;
}
.ap-flow-next:hover { background: #0bb96f; }
.ap-flow-next:active { background: #0aa563; }
/* ---- Unanswered questions (panel card + modal) ---- */
.ap-gaps-card {
  display: flex; align-items: center; gap: 10px; width: calc(100% - 32px);
  margin: 0 16px 12px; padding: 11px 12px; text-align: left;
  border: 1px solid #f0dcae; border-radius: 10px; background: #fdf8ec;
  cursor: pointer; font-family: inherit; font-size: 12.5px; color: #7a5b12;
}
.ap-gaps-card:hover { background: #fcf3de; }
.ap-gaps-icon { display: flex; color: #b8860b; flex-shrink: 0; }
.ap-gaps-icon svg { width: 17px; height: 17px; }
.ap-gaps-text { flex: 1; font-weight: 600; }
.ap-gaps-arrow { display: flex; color: #b8860b; flex-shrink: 0; }
.ap-gaps-arrow svg { width: 15px; height: 15px; }
.ap-gaps-body { flex: 1; min-width: 0; padding: 4px 20px 8px; overflow-y: auto; }
.ap-gap-card { border-bottom: 1px solid var(--stripe-hairline-soft); padding: 14px 0; }
.ap-gap-card:last-child { border-bottom: none; }
.ap-gap-question { font-size: 13px; font-weight: 600; color: var(--stripe-ink); margin-bottom: 3px; }
.ap-gap-required { color: #c0392b; margin-left: 3px; }
.ap-gap-help {
  font-size: 11.5px; color: var(--stripe-ink-mute); line-height: 1.45; margin-bottom: 8px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ap-gap-private { font-size: 11px; color: var(--stripe-ink-mute); margin-top: 5px; }
.ap-gap-input {
  width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--stripe-hairline); border-radius: 8px;
  background: #fff; color: var(--stripe-ink);
}
.ap-gap-input:focus {
  outline: none; border-color: var(--stripe-primary);
  box-shadow: 0 0 0 3px rgba(var(--stripe-primary-rgb),0.12);
}
.ap-gap-choices { display: flex; flex-direction: column; gap: 6px; }
.ap-gap-choice {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border: 1px solid var(--stripe-hairline); border-radius: 8px;
  font-size: 13px; color: var(--stripe-ink); cursor: pointer; background: #fff;
}
.ap-gap-choice:hover { border-color: var(--stripe-primary-soft); }
.ap-gap-choice input { accent-color: var(--stripe-primary); margin: 0; flex: 0 0 auto; }
.ap-gap-choice-none { color: var(--stripe-ink-mute); border-style: dashed; }
.ap-gap-loading { font-size: 12.5px; color: var(--stripe-ink-mute); padding: 8px 0; }
.ap-btn-ghost {
  border: 1px solid var(--stripe-hairline); background: #fff; border-radius: 8px;
  padding: 9px 14px; font-size: 13px; font-weight: 600; font-family: inherit;
  cursor: pointer; color: var(--stripe-ink-secondary);
}
.ap-btn-ghost:hover { background: var(--stripe-canvas-soft); }
/* The shared footer stacks its children; a two-button footer needs a row. */
.ap-modal-actions { display: flex; align-items: center; gap: 10px; }
.ap-modal-actions .ap-btn-update { padding: 12px 28px; }

/* ---- Remembered answers (Autofill Information tab) ---- */
.ap-remembered-row { padding: 10px 0; border-bottom: 1px solid var(--stripe-hairline-soft); }
.ap-remembered-row:last-child { border-bottom: none; }
.ap-remembered-q {
  display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px;
  font-size: 12.5px; font-weight: 600; color: var(--stripe-ink);
}
.ap-remembered-q > span:first-child { flex: 1; min-width: 0; }
.ap-remembered-reuse {
  flex-shrink: 0; font-size: 11px; font-weight: 600; color: var(--stripe-primary);
  background: var(--stripe-accent-light); border-radius: 9999px; padding: 1px 8px;
}
.ap-remembered-edit { display: flex; gap: 8px; align-items: center; }
.ap-remembered-input {
  flex: 1; min-width: 0; padding: 8px 10px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--stripe-hairline); border-radius: 8px; color: var(--stripe-ink);
}
.ap-remembered-input:focus {
  outline: none; border-color: var(--stripe-primary);
  box-shadow: 0 0 0 3px rgba(var(--stripe-primary-rgb),0.12);
}

/* ---- Saved sign-ins (section row badge + modal card list) ---- */
.ap-section-count {
  min-width: 20px; padding: 1px 6px; border-radius: 9999px;
  background: var(--stripe-accent-light); color: var(--stripe-primary);
  font-size: 11px; font-weight: 700; text-align: center;
}
.ap-signins-body { padding: 4px 20px 20px; overflow-y: auto; }
.ap-signins-empty { text-align: center; padding: 28px 12px; color: var(--stripe-ink-mute); }
.ap-signins-empty-icon { display: block; color: var(--stripe-accent-soft); margin-bottom: 10px; }
.ap-signins-empty-icon svg { width: 34px; height: 34px; }
.ap-signins-empty-title { font-size: 14px; font-weight: 600; color: var(--stripe-ink-secondary); margin-bottom: 4px; }
.ap-signins-empty-sub { font-size: 12.5px; line-height: 1.5; max-width: 320px; margin: 0 auto; }
.ap-signin-card {
  border: 1px solid var(--stripe-hairline); border-radius: 10px;
  padding: 12px 14px; margin-bottom: 10px; background: #fff;
}
.ap-signin-head {
  display: flex; align-items: center; gap: 10px;
  padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--stripe-hairline-soft);
}
.ap-signin-site {
  flex: 1; min-width: 0;
  font-size: 13.5px; font-weight: 700; color: var(--stripe-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ap-signin-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; }
.ap-signin-label { width: 62px; flex-shrink: 0; color: var(--stripe-ink-mute); }
.ap-signin-value {
  flex: 1; min-width: 0; color: var(--stripe-ink-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ap-signin-pass { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.5px; }
.ap-signin-btn {
  flex-shrink: 0; border: 1px solid var(--stripe-hairline); background: #fff;
  border-radius: 6px; padding: 4px 9px; font-size: 11.5px; font-weight: 600;
  cursor: pointer; color: var(--stripe-ink-secondary); font-family: inherit;
}
.ap-signin-btn:hover { background: var(--stripe-canvas-soft); color: var(--stripe-ink); }
.ap-signin-del { border-color: #f3d0d0; color: #b3261e; }
.ap-signin-del:hover { background: #fdf1f1; color: #8c1d18; }
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
  /** Detected ATS label ("Workday"…), or null on a generic / unrecognized form. */
  siteLabel: string | null;
  selected: Set<string>;
  outcomes: Map<string, FillOutcome>;
  busy: boolean;
  scanned: boolean;
  view: View;
  infoCategory: string;
  /** Working copy of the editable profile fields while the info modal is open. */
  profileDraft: EditableProfileDraft | null;
  /** Device-local autofill extras (GitHub/experience overrides + custom fields)
   *  merged over the synced profile — loaded once, edited via extrasDraft. */
  extras: AutofillExtras;
  /** Working copy of `extras` while the info modal is open. */
  extrasDraft: AutofillExtras | null;
  /** Account-creation credentials draft (device-local; Account creation tab). */
  signupDraft: DefaultCredential | null;
  signupLoaded: boolean;
  tailorResult: TailorResult | null;
  tailorKeywords: Set<string>;
  tailorBusy: boolean;
  coverLetterText: string | null;
  coverLetterBusy: boolean;
  /** True once a fill has actually run on this page. The unanswered-questions
   *  card stays hidden until then — before autofill has tried, "3 questions
   *  need your answer" reads as a failure rather than a follow-up. */
  fillRan: boolean;
  /** Questions the last fill left blank that are worth remembering. */
  gaps: AnswerGap[];
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
  siteLabel: null,
  selected: new Set(),
  outcomes: new Map(),
  busy: false,
  scanned: false,
  view: "main",
  infoCategory: "personal",
  profileDraft: null,
  extras: emptyExtras(),
  extrasDraft: null,
  signupDraft: null,
  signupLoaded: false,
  tailorResult: null,
  tailorKeywords: new Set(),
  tailorBusy: false,
  coverLetterText: null,
  coverLetterBusy: false,
  fillRan: false,
  gaps: [],
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
  banner: HTMLDivElement;
  flow: HTMLDivElement;
  flowText: HTMLSpanElement;
  flowNext: HTMLDivElement;
  flowNextBtn: HTMLButtonElement;
  signinsModal: HTMLDivElement;
  signinsBody: HTMLDivElement;
  signinsCount: HTMLSpanElement;
  gapsCard: HTMLButtonElement;
  gapsText: HTMLSpanElement;
  gapsModal: HTMLDivElement;
  gapsBody: HTMLDivElement;
  gapsError: HTMLDivElement;
  gapsSave: HTMLButtonElement;
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
  infoFooter: HTMLDivElement;
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
  installRefs(root);
  wireBrandLogo(root);
  wireEvents(root);
  installMountWatchdog();
}

/**
 * The header lockup and the edge-tab mark are the real Tailrd logo as data-URI
 * <img>s. Pages with a strict `img-src` CSP (Greenhouse, Workday, many banks)
 * block data-URI images, and inline `onerror=""` handlers are blocked too — so
 * attach the error handlers from our own (allowed) content-script JS, and set
 * `src` only AFTER they are live so a synchronous failure can't beat the
 * listener. On failure the header falls back to the "Tailrd" wordmark and the
 * edge tab to its original purple chevron.
 */
function wireBrandLogo(root: HTMLElement): void {
  const img = root.querySelector<HTMLImageElement>(".ap-brand-lockup");
  if (img) {
    img.addEventListener("error", () => {
      img.style.display = "none";
      const wordmark = root.querySelector<HTMLElement>(".ap-brand-name");
      if (wordmark) wordmark.style.display = "";
    });
    img.src = BRAND_LOGO_DATA_URI;
  }

  const mark = root.querySelector<HTMLImageElement>(".ap-edge-mark");
  if (mark) {
    mark.addEventListener("error", () => {
      root.querySelector(".ap-edge-tab")?.classList.add("is-fallback");
    });
    mark.src = BRAND_MARK_DATA_URI;
  }
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
      <img class="ap-edge-mark" alt="" />
      ${I_CHEVRON_RIGHT}
    </button>
    <div class="ap-panel">
      <!-- Header -->
      <header class="ap-header">
        <div class="ap-brand">
          <img class="ap-brand-lockup" alt="Tailrd" />
          <span class="ap-brand-name" style="display:none">Tailrd</span>
        </div>
        <div class="ap-header-right">
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
        </div>

        <!-- Unanswered reusable questions (shown only after a fill has run) -->
        <button class="ap-gaps-card" id="ap-gaps-card" type="button" style="display:none">
          <span class="ap-gaps-icon">${I_QUESTION}</span>
          <span class="ap-gaps-text" id="ap-gaps-text"></span>
          <span class="ap-gaps-arrow">${I_CHEVRON_RIGHT}</span>
        </button>

        <!-- Banner -->
        <div class="ap-banner" id="ap-banner" style="display:none"></div>

        <!-- Multi-page flow status line -->
        <div class="ap-flow" id="ap-flow" style="display:none">
          <span class="ap-flow-text" id="ap-flow-text"></span>
        </div>


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

        <!-- Saved sign-ins (device-local signup-wall credentials) -> modal -->
        <div class="ap-section">
          <div class="ap-section-header" id="ap-section-signins">
            <div class="ap-section-left">
              <span class="ap-section-icon">${I_KEY}</span>
              <span class="ap-section-title">Saved sign-ins</span>
              <span class="ap-section-count" id="ap-signins-count" style="display:none"></span>
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

      <!-- Next-page gate — pinned at the panel bottom, shown only while a
           multi-page flow is parked at "ready" (see updateFlowProgress). -->
      <div class="ap-flow-next-wrap" style="display:none">
        <button class="ap-flow-next" id="ap-flow-next" type="button">Continue To The Next Page ▶</button>
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
            <button class="ap-modal-sidebar-item" data-cat="remembered">Remembered answers</button>
          </div>
          <div class="ap-modal-form" id="ap-info-form"></div>
        </div>
        <div class="ap-modal-footer" id="ap-info-footer">
          <div class="ap-modal-error" id="ap-info-error" style="display:none"></div>
          <button class="ap-btn-update" id="ap-btn-update">Update</button>
        </div>
      </div>
    </div>

    <!-- Unanswered-questions MODAL (page-level, outside the side panel) -->
    <div class="ap-modal-backdrop" id="ap-gaps-modal">
      <div class="ap-modal ap-modal-narrow">
        <div class="ap-modal-header">
          <h2>Questions we couldn't answer</h2>
          <button class="ap-modal-close" id="ap-gaps-close">${I_CLOSE}</button>
        </div>
        <div class="ap-modal-notice">
          <span class="ap-modal-notice-icon">${I_INFO}</span>
          <span>Tailrd never guesses an answer it can't back up. Answer these once and they'll be filled in automatically on future applications.</span>
        </div>
        <div class="ap-modal-body">
          <div class="ap-gaps-body" id="ap-gaps-body"></div>
        </div>
        <div class="ap-modal-footer">
          <div class="ap-modal-error" id="ap-gaps-error" style="display:none"></div>
          <div class="ap-modal-actions">
            <button class="ap-btn-ghost" id="ap-gaps-skip" type="button">Skip for now</button>
            <button class="ap-btn-update" id="ap-gaps-save" type="button">Save &amp; fill</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Saved sign-ins MODAL (page-level, outside the side panel) -->
    <div class="ap-modal-backdrop" id="ap-signins-modal">
      <div class="ap-modal ap-modal-narrow">
        <div class="ap-modal-header">
          <h2>Saved sign-ins</h2>
          <button class="ap-modal-close" id="ap-signins-close">${I_CLOSE}</button>
        </div>
        <div class="ap-modal-notice">
          <span class="ap-modal-notice-icon">${I_INFO}</span>
          <span>When autofill creates an account to get past a signup wall, the sign-in it used is saved <b>on this device only</b>. It never syncs and never leaves this browser.</span>
        </div>
        <div class="ap-modal-body">
          <div class="ap-signins-body" id="ap-signins-body"></div>
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


/** Bind the module's element refs to a mounted panel root.
 *  Exported alongside buildHTML so tests can drive the real render paths
 *  (updateFlowProgress, showReloadRequired…) without the chrome.* APIs a full
 *  mount needs. */
export function installRefs(root: HTMLDivElement): void {
  refs = collectRefs(root);
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
    banner: q("#ap-banner"),
    flow: q("#ap-flow"),
    flowText: q("#ap-flow-text"),
    flowNext: q(".ap-flow-next-wrap"),
    flowNextBtn: q("#ap-flow-next"),
    signinsModal: q("#ap-signins-modal"),
    signinsBody: q("#ap-signins-body"),
    signinsCount: q("#ap-signins-count"),
    gapsCard: q("#ap-gaps-card"),
    gapsText: q("#ap-gaps-text"),
    gapsModal: q("#ap-gaps-modal"),
    gapsBody: q("#ap-gaps-body"),
    gapsError: q("#ap-gaps-error"),
    gapsSave: q("#ap-gaps-save"),
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
    infoFooter: q("#ap-info-footer"),
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

  // Autofill button
  root.querySelector("#ap-btn-autofill")!.addEventListener("click", () => void doAutofill());

  // Flow Next page button -> advance to the next page; hide the button now so
  // it can't be double-clicked (the next "ready" beat re-shows it if needed).
  root.querySelector("#ap-flow-next")!.addEventListener("click", () => {
    if (refs) refs.flowNext.style.display = "none";
    callbacks?.onFlowAdvance();
  });


  // Unanswered questions -> open the modal; Save writes + remembers, Skip closes.
  root.querySelector("#ap-gaps-card")!.addEventListener("click", openGapsModal);
  root.querySelector("#ap-gaps-close")!.addEventListener("click", closeGapsModal);
  root.querySelector("#ap-gaps-skip")!.addEventListener("click", closeGapsModal);
  root.querySelector("#ap-gaps-save")!.addEventListener("click", () => void saveGaps());
  root.querySelector("#ap-gaps-modal")!.addEventListener("click", (e) => {
    if (e.target === refs?.gapsModal) closeGapsModal();
  });

  // "Saved sign-ins" section -> open the credentials modal (rendered on open,
  // so a credential saved mid-session shows without reloading the panel).
  root.querySelector("#ap-section-signins")!.addEventListener("click", () => {
    void openSigninsModal();
  });
  root.querySelector("#ap-signins-close")!.addEventListener("click", closeSigninsModal);
  // Backdrop click closes; clicks inside the modal card must not.
  root.querySelector("#ap-signins-modal")!.addEventListener("click", (e) => {
    if (e.target === refs?.signinsModal) closeSigninsModal();
  });

  // "Your Autofill Information" section -> open info view
  root.querySelector("#ap-section-info")!.addEventListener("click", () => {
    void showInfoView();
  });

  // Upload résumé to the current form
  root.querySelector("#ap-btn-upload-resume")!.addEventListener("click", () => void doUploadResume());

  // Résumé rewrite → open the real app modal (iframe overlay) for full parity.
  root.querySelector("#ap-btn-tailor")!.addEventListener("click", () => callbacks?.onOpenAiModal?.("resume"));

  // Cover letter → open the real app modal (iframe overlay).
  root.querySelector("#ap-btn-cover")!.addEventListener("click", () => callbacks?.onOpenAiModal?.("cover"));

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
  // Device-local, so it needs no session — badge the Saved sign-ins row before
  // the (possibly slow, possibly failing) status round-trip.
  void refreshSigninsCount();

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
  // Device-local edits + custom fields the user added, merged over the synced
  // profile so what they see in the panel is exactly what the scanner fills.
  overlayState.extras = await getExtras();
  // Feed the (merged) profile to the scanner so fields get proposed values; it
  // re-scans and calls updateOverlay() (which re-derives the selection). Done
  // before applyDefaultSelection() so the button reflects the enriched fields.
  callbacks?.onProfileResolved(fillProfile());
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
  overlayState.signupDraft = null;
  overlayState.signupLoaded = false;
  signupOriginal = null;
  setInfoError("");
  refs.infoSidebar.querySelectorAll<HTMLButtonElement>(".ap-modal-sidebar-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.cat === "personal")
  );
  // Render immediately from what we already have so the modal opens instantly.
  overlayState.profileDraft = overlayState.profile ? draftFromProfile(overlayState.profile) : null;
  overlayState.extrasDraft = structuredClone(overlayState.extras);
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
  refreshGaps();
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

  // The primary action always runs the full flow (click Apply, create account,
  // fill, advance), so it stays live whenever a profile is loaded -- even on a
  // bare job posting with no form fields.
  //
  // Nothing is rendered under the button: no field count, no "will click
  // Apply" hint, no "No form fields detected". The flow's own beats and the
  // per-page fill summary above the Continue gate are the feedback surface.
  const canRun = Boolean(overlayState.profile) && !overlayState.busy;
  refs.btnAutofill.disabled = !canRun;
  refs.btnAutofill.textContent = overlayState.busy ? "Working\u2026" : "Account Creation & Autofill";


  // Keep the r\u00e9sum\u00e9-upload button in sync as the form is (re)scanned.
  updateUploadButtonState();
  updateTailorButtonState();
  updateCoverButtonState();
}

/** Friendly fallback names when a field's own label is missing/too generic. */



// ---------------------------------------------------------------------------
// Saved sign-ins (device-local signup-wall credentials)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unanswered questions ("we couldn't answer these — tell us once")
// ---------------------------------------------------------------------------

/**
 * Recompute the questions the last fill left blank and paint the panel card.
 * Called on every re-render, but the card only shows once a fill has run — see
 * PanelState.fillRan.
 */
function refreshGaps(): void {
  if (!refs) return;
  overlayState.gaps = overlayState.fillRan
    ? selectAnswerGaps(overlayState.fields, {
        company: overlayState.company,
        jobTitle: overlayState.jobTitle,
      })
    : [];
  const n = overlayState.gaps.length;
  refs.gapsCard.style.display = n > 0 ? "" : "none";
  refs.gapsText.textContent =
    n === 1 ? "1 question needs your answer" : `${n} questions need your answer`;
}

/** True while a harvest pass is in flight — the only time "Loading choices…"
 *  may stand in for a control. Reset unconditionally when the pass settles, so
 *  a widget that yielded nothing can never be stuck un-answerable. */
let gapHarvestPending = false;

function openGapsModal(): void {
  if (!refs || overlayState.gaps.length === 0) return;
  const harvest = callbacks?.onHarvestGapOptions;
  gapHarvestPending = Boolean(harvest);
  renderGaps();
  refs.gapsError.style.display = "none";
  refs.gapsModal.classList.add("visible");
  if (!harvest) return;
  // Harvest AFTER showing the modal so it never delays opening — a modal that
  // sits dead for four seconds after the user clicks the card is worse than a
  // late-arriving dropdown. The consequence is that the user can be typing
  // while the pass runs, so the settle handler resolves ONLY the placeholders
  // (see resolveGapPlaceholders) instead of rebuilding the body.
  void harvestGapOptions(overlayState.gaps, harvest).then(() => {
    gapHarvestPending = false;
    if (refs?.gapsModal.classList.contains("visible")) {
      resolveGapPlaceholders(refs.gapsBody, overlayState.gaps);
    }
  });
}

function closeGapsModal(): void {
  refs?.gapsModal.classList.remove("visible");
}

/** One input per unanswered question, shaped to the page's own control. */
function renderGaps(): void {
  if (!refs) return;
  refs.gapsBody.innerHTML = gapsBodyHTML(overlayState.gaps, gapHarvestPending);
}

/** The whole modal body. Exported so the render and the surgical placeholder
 *  swap can be tested against the same markup the panel really shows. */
export function gapsBodyHTML(gaps: readonly AnswerGap[], harvestPending: boolean): string {
  return gaps
    .map((g, i) => {
      const req = g.required ? `<span class="ap-gap-required" title="Required">*</span>` : "";
      const help = g.helpText ? `<div class="ap-gap-help">${esc(g.helpText)}</div>` : "";
      // Sensitive answers never leave the device — say so, next to the input.
      const priv = g.sensitive
        ? `<div class="ap-gap-private">Kept on this device only — never uploaded.</div>`
        : "";
      return `
      <div class="ap-gap-card">
        <div class="ap-gap-question">${esc(g.question)}${req}</div>
        ${help}
        ${gapControlHTML(g, i, harvestPending)}
        ${priv}
      </div>`;
    })
    .join("");
}

/**
 * Swap the "Loading choices…" placeholders for real controls once the harvest
 * has settled — and touch nothing else.
 *
 * The modal is interactive from the moment it opens, and the pass can take
 * seconds, so a blanket re-render here would replace gapsBody wholesale and
 * erase every answer typed in the meantime: the user could hit Save & fill on
 * a form they had just filled in and be told "only filled 0 of 2".
 *
 * Only placeholder rows are replaced, and that is sufficient as well as safe.
 * Safe, because a placeholder holds no input — there is nothing to lose.
 * Sufficient, because a placeholder is exactly the row that must change: its
 * options either arrived (a real dropdown) or did not (the free-text fallback,
 * without which the row would stay un-answerable forever).
 */
export function resolveGapPlaceholders(root: ParentNode, gaps: readonly AnswerGap[]): void {
  for (const node of [...root.querySelectorAll<HTMLElement>(".ap-gap-loading[data-i]")]) {
    const i = Number(node.dataset.i);
    const gap = gaps[i];
    if (!gap) continue; // body no longer matches the gap list — leave it be
    node.outerHTML = gapControlHTML(gap, i, false);
  }
}

/** Constrained controls whose options may not be in the DOM until opened. */
const GAP_HARVEST_TYPES: ReadonlySet<ControlType> = new Set<ControlType>([
  "combobox",
  "customDropdown",
  "select",
]);

/**
 * Fill in the real options for any dropdown the scan could not read.
 *
 * A combobox's listbox is mounted lazily, so `gap.options` is empty and the
 * modal would offer a text box — whose answer the widget then rejects. Opening
 * each dropdown briefly is a visible side effect on the page; it is the price
 * of the modal offering the page's own choices, and it was chosen deliberately
 * over a silent free-text box. Mutates `gaps` in place. Never throws: a frame
 * that has gone away just leaves the questions as free text.
 */
export async function harvestGapOptions(
  gaps: AnswerGap[],
  harvest: (fieldIds: string[]) => Promise<Record<string, string[]>>
): Promise<void> {
  const wanted = gaps.filter(
    (g) => GAP_HARVEST_TYPES.has(g.controlType) && (g.options?.length ?? 0) === 0
  );
  if (wanted.length === 0) return;
  try {
    const found = await harvest(wanted.map((g) => g.fieldId));
    for (const g of wanted) {
      const opts = found[g.fieldId];
      if (opts && opts.length > 0) g.options = opts;
    }
  } catch {
    // Leave them as free text — an honest fallback, and the pre-existing shape.
  }
}

/**
 * The control for one question, plus the only state gapInputHTML cannot see:
 * whether a harvest is still running.
 *
 * The placeholder MUST be keyed on that and not merely on "constrained with no
 * options" — otherwise a widget whose harvest came back empty would show
 * "Loading choices…" forever and the question could never be answered, which is
 * the opposite of the free-text fallback harvestGapOptions promises.
 */
export function gapControlHTML(gap: AnswerGap, i: number, harvestPending: boolean): string {
  if (harvestPending && GAP_HARVEST_TYPES.has(gap.controlType) && (gap.options?.length ?? 0) === 0) {
    // data-i so resolveGapPlaceholders can find and replace exactly this row.
    return `<div class="ap-gap-loading" data-i="${i}">Loading choices…</div>`;
  }
  return gapInputHTML(gap, i);
}

/** Control types whose answer is one of a fixed set the page already shows. */
const GAP_CHOICE_TYPES: ReadonlySet<ControlType> = new Set<ControlType>([
  "radioGroup",
  "ariaRadioGroup",
]);
const GAP_MULTI_TYPES: ReadonlySet<ControlType> = new Set<ControlType>(["checkboxGroup"]);

/**
 * The way out of a radio group.
 *
 * An HTML radio cannot be deselected, and the modal's only other exit is "Skip
 * for now", which discards EVERY answer. Without this, one mis-click on a
 * sponsorship question was unrecoverable — and, once written, remembered
 * forever (answersWorthRemembering). Its value is "" so readGapAnswer reports
 * the question as unanswered, exactly like the <select> placeholder it replaced.
 * Checked by default: the modal opens with nothing asserted on the user's behalf.
 */
const noAnswerChoice = (id: string): string =>
  `<label class="ap-gap-choice ap-gap-choice-none">
      <input type="radio" name="${id}" value="" checked /><span>No answer</span>
    </label>`;

/**
 * The control for one question — the SAME shape the page shows.
 *
 * A radio group rendered as a dropdown is not the question the form asked, and
 * a constrained control rendered as a text box produces an answer the widget
 * will reject. Falls back to a text input only when the page genuinely offers
 * free text (or a dropdown yielded no options — see harvestGapOptions).
 */
export function gapInputHTML(gap: AnswerGap, i: number): string {
  const id = `ap-gap-${i}`;
  const opts = gap.options ?? [];

  if (opts.length > 0 && GAP_CHOICE_TYPES.has(gap.controlType)) {
    return `<div class="ap-gap-choices" data-i="${i}" data-kind="radio">${noAnswerChoice(id)}${opts
      .map(
        (o, k) => `<label class="ap-gap-choice">
          <input type="radio" name="${id}" value="${esc(o)}" id="${id}-${k}" />
          <span>${esc(o)}</span>
        </label>`
      )
      .join("")}</div>`;
  }

  if (opts.length > 0 && GAP_MULTI_TYPES.has(gap.controlType)) {
    return `<div class="ap-gap-choices" data-i="${i}" data-kind="checkbox">${opts
      .map(
        (o, k) => `<label class="ap-gap-choice">
          <input type="checkbox" name="${id}" value="${esc(o)}" id="${id}-${k}" />
          <span>${esc(o)}</span>
        </label>`
      )
      .join("")}</div>`;
  }

  if (opts.length > 0) {
    const options = opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    return `<select class="ap-gap-input" id="${id}" data-i="${i}">
      <option value="">Select an answer…</option>${options}
    </select>`;
  }

  if (gap.controlType === "checkbox") {
    return `<div class="ap-gap-choices" data-i="${i}" data-kind="radio">${noAnswerChoice(id)}
      <label class="ap-gap-choice"><input type="radio" name="${id}" value="Yes" /><span>Yes</span></label>
      <label class="ap-gap-choice"><input type="radio" name="${id}" value="No" /><span>No</span></label>
    </div>`;
  }

  const type = gap.inputType === "date" || gap.inputType === "number" ? gap.inputType : "text";
  return `<input class="ap-gap-input" id="${id}" data-i="${i}" type="${esc(type)}" placeholder="Your answer" />`;
}

/** The answer the user gave for question `i`, whatever control it rendered as.
 *  "" when unanswered — an unanswered question is skipped, not an error. */
export function readGapAnswer(root: ParentNode, i: number): string {
  const group = root.querySelector<HTMLElement>(`.ap-gap-choices[data-i="${i}"]`);
  if (group) {
    const picked = [...group.querySelectorAll<HTMLInputElement>("input:checked")].map((el) => el.value);
    return picked.join(", ");
  }
  const single = root.querySelector<HTMLInputElement | HTMLSelectElement>(`.ap-gap-input[data-i="${i}"]`);
  return (single?.value ?? "").trim();
}

/**
 * What to tell the user after Save & fill.
 *
 * "Saved" must not be said about an answer that was deliberately thrown away.
 * answersWorthRemembering discards a value the widget rejected precisely SO
 * THAT the question gets asked again; reporting it as saved would be a lie the
 * user cannot see through — the panel card would still show the question and
 * nothing would explain why. `discarded` takes precedence, and implies
 * `filled < total` (an answer can only be discarded when its write failed).
 */
export function gapsSaveBanner(
  total: number,
  filled: number,
  discarded: number
): { text: string; tone: "ok" | "warn" } {
  if (discarded > 0) {
    const what = discarded === 1 ? "an answer" : `${discarded} answers`;
    const it = discarded === 1 ? "it" : "them";
    return {
      text: `Filled ${filled} of ${total}. This form rejected ${what}, so we didn't save ${it} — we'll ask again next time.`,
      tone: "warn",
    };
  }
  if (filled === total) {
    return {
      text: `Saved ${total === 1 ? "your answer" : `${total} answers`} — they'll fill automatically next time.`,
      tone: "ok",
    };
  }
  return {
    text: `Saved, but only filled ${filled} of ${total} on this page. Check the form.`,
    tone: "warn",
  };
}

/**
 * Fill the answered questions into the page and remember them. Questions left
 * blank are simply skipped — closing without answering everything is a normal
 * outcome, not an error.
 */
async function saveGaps(): Promise<void> {
  if (!refs || !callbacks) return;
  const answers: { gap: AnswerGap; value: string }[] = [];
  overlayState.gaps.forEach((gap, i) => {
    const value = readGapAnswer(refs!.gapsBody, i);
    if (value) answers.push({ gap, value });
  });
  if (answers.length === 0) {
    closeGapsModal();
    return;
  }

  refs.gapsSave.disabled = true;
  refs.gapsSave.textContent = "Saving…";
  try {
    const res = await callbacks.onAnswerGaps(answers);
    if (!res.ok) {
      refs.gapsError.textContent = res.reason ?? "Could not save your answers.";
      refs.gapsError.style.display = "block";
      return;
    }
    closeGapsModal();
    // Re-scan so each answered field's currentValue reflects what was written;
    // the panel's next render drops those questions from the card.
    callbacks.onRescan();
    const banner = gapsSaveBanner(answers.length, res.filled, res.discarded ?? 0);
    showBanner(banner.text, banner.tone);
  } catch (err) {
    refs.gapsError.textContent = err instanceof Error ? err.message : "Could not save your answers.";
    refs.gapsError.style.display = "block";
  } finally {
    refs.gapsSave.disabled = false;
    refs.gapsSave.textContent = "Save & fill";
  }
}

/** Open the Saved sign-ins modal, rendering the current credential list. */
async function openSigninsModal(): Promise<void> {
  if (!refs) return;
  refs.signinsModal.classList.add("visible");
  await renderSavedSignins();
}

function closeSigninsModal(): void {
  refs?.signinsModal.classList.remove("visible");
}

/**
 * Keep the panel's "Saved sign-ins" row badge in step with the stored count, so
 * the section advertises that there is something behind it without the user
 * having to open the modal to find out.
 */
async function refreshSigninsCount(): Promise<void> {
  if (!refs) return;
  const n = (await listCredentials()).length;
  refs.signinsCount.textContent = String(n);
  refs.signinsCount.style.display = n > 0 ? "" : "none";
}

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
  void refreshSigninsCount();
  if (creds.length === 0) {
    host.innerHTML = `
      <div class="ap-signins-empty">
        <span class="ap-signins-empty-icon">${I_KEY}</span>
        <div class="ap-signins-empty-title">No saved sign-ins yet</div>
        <div class="ap-signins-empty-sub">Nothing to show yet — the first signup wall autofill gets you past will appear here automatically.</div>
      </div>`;
    return;
  }
  host.innerHTML = creds
    .map(
      (c, i) => `
    <div class="ap-signin-card" data-origin="${esc(c.origin)}">
      <div class="ap-signin-head">
        <span class="ap-signin-site">${esc(c.origin.replace(/^https?:\/\//, ""))}</span>
        <button class="ap-signin-btn ap-signin-del" data-i="${i}" type="button">Delete</button>
      </div>
      <div class="ap-signin-field">
        <span class="ap-signin-label">Email</span>
        <span class="ap-signin-value">${esc(c.email)}</span>
        <button class="ap-signin-btn ap-signin-copy-email" data-i="${i}" type="button">Copy</button>
      </div>
      <div class="ap-signin-field">
        <span class="ap-signin-label">Password</span>
        <code class="ap-signin-value ap-signin-pass" id="ap-pass-${i}" data-hidden="1">••••••••</code>
        <button class="ap-signin-btn ap-signin-reveal" data-i="${i}" type="button">Show</button>
        <button class="ap-signin-btn ap-signin-copy" data-i="${i}" type="button">Copy</button>
      </div>
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
      flashCopied(btn);
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-copy-email").forEach((btn) => {
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(creds[Number(btn.dataset.i)].email).catch(() => {});
      flashCopied(btn);
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      void deleteCredential(creds[Number(btn.dataset.i)].origin).then(renderSavedSignins);
    });
  });
}

/** "Copy" → "Copied" for a beat. The row is re-rendered on any list change, so
 *  a stale timer can only touch a button that is already detached. */
function flashCopied(btn: HTMLButtonElement): void {
  const prev = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => {
    btn.textContent = prev;
  }, 1200);
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
    // A fill has now run on this page, so any question it couldn't answer is a
    // real gap worth surfacing (see PanelState.fillRan).
    overlayState.fillRan = true;
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

/**
 * This content script has been orphaned — the extension was reloaded, updated
 * or disabled while the tab stayed open, so `chrome.runtime` is gone and
 * nothing the panel offers can work any more.
 *
 * Without this the panel keeps rendering perfectly: the Autofill button looks
 * enabled, clicking it silently does nothing, and no flow can ever start
 * because the background can neither be asked for the profile nor told to
 * persist flow state. That is indistinguishable from "the extension is
 * broken". Say what happened and what fixes it.
 */
export function showReloadRequired(): void {
  if (!refs) return;
  refs.btnAutofill.disabled = true;
  refs.flow.style.display = "none";
  refs.flowNext.style.display = "none";
  showBanner("Tailrd was updated — reload this page to continue.", "warn");
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

/** The profile the scanner + AI actually fill from: the synced profile with the
 *  user's device-local extras (GitHub / experience overrides) merged on top, so
 *  the panel shows exactly what will fill. Custom fields are applied separately
 *  in the fill path (contentScript), matched by label. */
function fillProfile(): UserApplicationProfile | null {
  return overlayState.profile
    ? mergeProfileWithExtras(overlayState.profile, overlayState.extras)
    : null;
}

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

/** One field bound to the device-local extras (extrasDraft.fields[key]) via
 *  data-extra — for scalar fields the sync treats as read-only, e.g. GitHub. */
function apExtraField(key: string, label: string, value: string, opts: { type?: string } = {}): string {
  return `<div class="ap-form-row"><label>${label}</label><input data-extra="${esc(key)}" type="${opts.type ?? "text"}" value="${esc(value)}" /></div>`;
}

/** One work-experience field bound to extrasDraft.experience[idx][key]. */
function apExpField(
  idx: number,
  key: "company" | "title" | "startDate" | "endDate" | "description",
  label: string,
  value: string,
  opts: { type?: string } = {}
): string {
  const control =
    opts.type === "textarea"
      ? `<textarea data-exp-idx="${idx}" data-exp-key="${esc(key)}" rows="2">${esc(value)}</textarea>`
      : `<input data-exp-idx="${idx}" data-exp-key="${esc(key)}" type="${opts.type ?? "text"}" value="${esc(value)}" />`;
  return `<div class="ap-form-row"><label>${label}</label>${control}</div>`;
}

/**
 * The user's own added fields for a section (label + value, editable + removable)
 * plus an "Add field" button. Custom fields are device-local and fill any
 * application question whose label matches, so people can teach the extension
 * answers the standard profile has no slot for.
 */
function renderSectionCustom(section: string): string {
  const ed = overlayState.extrasDraft ?? emptyExtras();
  const rows = ed.customFields
    .filter((c) => c.section === section)
    .map(
      (c) => `
      <div class="ap-custom-row">
        <input class="ap-custom-label" data-custom-id="${esc(c.id)}" data-custom-key="label" value="${esc(c.label)}" placeholder="Field name (e.g. Pronouns)" />
        <input class="ap-custom-value" data-custom-id="${esc(c.id)}" data-custom-key="value" value="${esc(c.value)}" placeholder="Your answer" />
        <button type="button" class="ap-custom-del" data-custom-del="${esc(c.id)}" title="Remove field">${I_CLOSE}</button>
      </div>`
    )
    .join("");
  return `
    <div class="ap-custom-section">
      ${rows ? `<div class="ap-custom-heading">Your added fields</div>${rows}` : ""}
      <button type="button" class="ap-add-field" data-add-field="${esc(section)}">+ Add field</button>
    </div>`;
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

  // Remembered answers edit in place (commit on blur) and have no draft to
  // submit, so the shared "Update" footer would be a button that does nothing
  // to what's on screen.
  refs.infoFooter.style.display = cat === "remembered" ? "none" : "";

  if (!p || !d) {
    form.innerHTML = '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">Sign in and upload a resume to see your information.</div>';
    return;
  }

  const ed = overlayState.extrasDraft ?? emptyExtras();
  switch (cat) {
    case "personal": {
      // Data-driven links: a link row only appears when the user actually has
      // one, so nobody sees a phantom GitHub/LinkedIn they never filled. GitHub
      // is editable via the device-local extras (the sync treats it read-only);
      // to add a link they don't have yet, use "Add field".
      const github = ed.fields.github ?? p.github;
      const links = [
        d.linkedin ? apField("linkedin", "LinkedIn", d.linkedin, { type: "url" }) : "",
        github ? apExtraField("github", "GitHub", github, { type: "url" }) : "",
        d.portfolio ? apField("portfolio", "Portfolio", d.portfolio, { type: "url" }) : "",
      ].filter(Boolean);
      form.innerHTML = `
        <div class="ap-form-grid">
          ${apField("firstName", "First Name", d.firstName, { required: true })}
          ${apField("lastName", "Last Name", d.lastName, { required: true })}
        </div>
        ${apField("email", "Email Address", d.email, { required: true, type: "email" })}
        ${apField("phone", "Phone", d.phone, { required: true, type: "tel" })}
        ${apField("location", "Location", d.location)}
        ${links.join("")}
        ${renderSectionCustom("personal")}
      `;
      break;
    }
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
        ${renderSectionCustom("address")}
      `;
      break;
    case "education": {
      let html =
        (p.education ?? []).length === 0
          ? '<div class="ap-form-hint">No education synced from your résumé yet.</div>'
          : RESUME_HINT;
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
      form.innerHTML = html + renderSectionCustom("education");
      break;
    }
    case "experience": {
      // Editable: work off the user's edited copy if there is one, else the
      // synced résumé entries. Edits + added roles persist to device-local extras.
      const entries = ed.experience ?? p.experience ?? [];
      let html =
        '<div class="ap-form-hint">Edit any role, add ones your résumé missed, or add your own fields. Saved on this device and used to autofill applications.</div>';
      entries.forEach((e, i) => {
        html += `
          <div class="ap-exp-entry">
            <div class="ap-form-grid">
              ${apExpField(i, "company", "Company", e.company)}
              ${apExpField(i, "title", "Title", e.title)}
            </div>
            <div class="ap-form-grid">
              ${apExpField(i, "startDate", "Start Date", e.startDate)}
              ${apExpField(i, "endDate", "End Date", e.endDate)}
            </div>
            ${apExpField(i, "description", "Description", e.description ?? "", { type: "textarea" })}
            <button type="button" class="ap-exp-del" data-exp-del="${i}">Remove role</button>
          </div>`;
      });
      html += `<button type="button" class="ap-add-field" data-add-exp="1">+ Add work experience</button>`;
      html += renderSectionCustom("experience");
      form.innerHTML = html;
      break;
    }
    case "skill":
      form.innerHTML =
        ((p.skills ?? []).length === 0
          ? '<div class="ap-form-hint">No skills synced from your résumé yet.</div>'
          : RESUME_HINT + apReadonly("Skills", (p.skills ?? []).join(", "))) +
        renderSectionCustom("skill");
      break;
    case "preference":
      form.innerHTML = `
        ${apField("workAuthorization", "Work Authorization", d.workAuthorization)}
        ${apField("requiresSponsorship", "Requires Sponsorship", d.requiresSponsorship)}
        ${apField("salaryExpectation", "Salary Expectation", d.salaryExpectation)}
        ${renderSectionCustom("preference")}
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
    case "remembered":
      renderRememberedAnswers(form);
      break;
  }
}

/**
 * Render the answer bank — the screening answers the user gave on earlier
 * applications, which /api/fill recalls semantically on new ones. Same rows the
 * web app's Profile page shows, so an edit in either surface is the same edit.
 *
 * Device-local sensitive answers are deliberately NOT listed here: they never
 * reach the backend, and putting EEO answers on screen is a separate decision.
 */
function renderRememberedAnswers(form: HTMLElement): void {
  form.innerHTML =
    '<div style="padding:20px;text-align:center;color:var(--stripe-ink-mute)">Loading…</div>';
  void (async () => {
    const resp = await bg<AnswersResponse>({ type: "GET_ANSWERS" }).catch(() => null);
    // The user may have clicked to another category while this was in flight.
    if (!refs || overlayState.infoCategory !== "remembered") return;
    if (!resp?.ok) {
      form.innerHTML = `<div class="ap-form-hint">Could not load your remembered answers.</div>`;
      return;
    }
    const answers: SavedAnswerItem[] = resp.answers;
    if (answers.length === 0) {
      form.innerHTML = `<div class="ap-form-hint">Nothing remembered yet. When autofill hits a question it can't answer, the panel offers to ask you — the answers you give appear here and fill automatically from then on.</div>`;
      return;
    }
    form.innerHTML =
      `<div class="ap-form-hint">Answers Tailrd reuses on future applications. Edit one and it changes everywhere, including your Tailrd profile page.</div>` +
      answers
        .map(
          (a) => `
        <div class="ap-remembered-row" data-answer-id="${a.id}">
          <div class="ap-remembered-q">
            <span>${esc(a.question)}</span>
            ${a.timesReused > 0 ? `<span class="ap-remembered-reuse">used ${a.timesReused}×</span>` : ""}
          </div>
          <div class="ap-remembered-edit">
            <input class="ap-remembered-input" data-answer-id="${a.id}" value="${esc(a.answer)}" />
            <button class="ap-mini-btn ap-remembered-del" data-answer-id="${a.id}" type="button">Delete</button>
          </div>
        </div>`
        )
        .join("");

    // Commit an edit on blur — no Save button, matching how the rest of the
    // modal's device-local fields behave.
    form.querySelectorAll<HTMLInputElement>(".ap-remembered-input").forEach((input) => {
      const original = input.value;
      input.addEventListener("blur", () => {
        const answer = input.value.trim();
        if (!answer || answer === original) {
          if (!answer) input.value = original; // never store an empty answer
          return;
        }
        void bg<SimpleResponse>({
          type: "UPDATE_ANSWER",
          id: Number(input.dataset.answerId),
          answer,
        }).catch(() => {});
      });
    });
    form.querySelectorAll<HTMLButtonElement>(".ap-remembered-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        void bg<SimpleResponse>({ type: "DELETE_ANSWER", id: Number(btn.dataset.answerId) })
          .then(() => renderRememberedAnswers(form))
          .catch(() => {});
      });
    });
  })();
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

/** Delegated input handler: mirror form edits into the draft (survives re-render). */
function onInfoInput(e: Event): void {
  const t = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  // Account-creation credentials (device-local; not part of the profile draft).
  const signupField = t.dataset.signup;
  if (signupField === "email" || signupField === "password") {
    if (overlayState.signupDraft) overlayState.signupDraft[signupField] = t.value;
    return;
  }
  const ed = overlayState.extrasDraft;
  // Device-local scalar override (e.g. GitHub).
  const extraKey = t.dataset.extra;
  if (extraKey && ed) {
    ed.fields[extraKey] = t.value;
    return;
  }
  // Work-experience entry edit — lazily fork the synced entries into the draft
  // the first time one is touched, so "no override" holds until the user edits.
  const expIdx = t.dataset.expIdx;
  const expKey = t.dataset.expKey;
  if (expIdx !== undefined && expKey && ed) {
    if (!ed.experience) {
      ed.experience = (overlayState.profile?.experience ?? []).map((x) => ({ ...x }));
    }
    const entry = ed.experience[Number(expIdx)];
    if (entry) (entry as unknown as Record<string, string>)[expKey] = t.value;
    return;
  }
  // Custom field label/value edit.
  const customId = t.dataset.customId;
  const customKey = t.dataset.customKey;
  if (customId && (customKey === "label" || customKey === "value") && ed) {
    const cf = ed.customFields.find((c) => c.id === customId);
    if (cf) cf[customKey] = t.value;
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

/** Delegated click handler on the info form: password Show/Hide, and the
 *  add/remove controls for custom fields and work-experience entries. */
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
  const ed = overlayState.extrasDraft;
  if (!ed) return;

  const add = target.closest<HTMLElement>("[data-add-field]");
  if (add) {
    ed.customFields.push({
      id: cryptoId(),
      section: add.dataset.addField ?? "personal",
      label: "",
      value: "",
    });
    renderInfoForm();
    focusLastCustomLabel();
    return;
  }
  const del = target.closest<HTMLElement>("[data-custom-del]");
  if (del) {
    ed.customFields = ed.customFields.filter((c) => c.id !== del.dataset.customDel);
    renderInfoForm();
    return;
  }
  if (target.closest("[data-add-exp]")) {
    if (!ed.experience) {
      ed.experience = (overlayState.profile?.experience ?? []).map((x) => ({ ...x }));
    }
    ed.experience.push({ company: "", title: "", startDate: "", endDate: "", description: "" });
    renderInfoForm();
    return;
  }
  const expDel = target.closest<HTMLElement>("[data-exp-del]");
  if (expDel) {
    if (!ed.experience) {
      ed.experience = (overlayState.profile?.experience ?? []).map((x) => ({ ...x }));
    }
    ed.experience.splice(Number(expDel.dataset.expDel), 1);
    renderInfoForm();
    return;
  }
}

/** After adding a custom field, put the cursor in its (empty) name input. */
function focusLastCustomLabel(): void {
  const inputs = refs?.infoForm.querySelectorAll<HTMLInputElement>(".ap-custom-label");
  inputs?.[inputs.length - 1]?.focus();
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

  // Device-local autofill extras (GitHub / work-experience edits + custom
  // fields), also independent of the backend profile — they never leave the
  // machine. Saved regardless of whether any synced field changed.
  if (overlayState.extrasDraft) {
    const pruned = pruneExtras(overlayState.extrasDraft);
    await saveExtras(pruned);
    overlayState.extras = pruned;
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

  if (Object.keys(update).length === 0) {
    // Nothing to sync — but device-local extras may have changed, so re-feed the
    // scanner with the merged profile before closing.
    callbacks?.onProfileResolved(fillProfile());
    refreshMainView();
    hideInfoView();
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const resp = await bg<ProfileResponse>({ type: "UPDATE_PROFILE", update });
    if (resp?.ok && resp.profile) {
      overlayState.profile = resp.profile;
      overlayState.source = resp.source ?? overlayState.source;
      // Re-feed the scanner (merged with device-local extras) so the just-edited
      // values immediately propose fills.
      callbacks?.onProfileResolved(fillProfile());
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
