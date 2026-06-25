/**
 * In-page overlay — the full popup UI embedded in a Shadow DOM panel.
 *
 * A FAB (floating action button) sits in the bottom-right corner of job
 * application pages. Clicking it opens a 380px panel that mirrors the
 * extension popup: Autofill, Profile, Experience, Education, Skills, and
 * Settings tabs, plus a Login view. All profile/auth calls go through the
 * background service worker via chrome.runtime.sendMessage, exactly like the
 * popup does. Detected fields come from the content script via showOverlay /
 * updateOverlay.
 */

import { CATEGORY_LABELS, detectAtsName } from "../shared/constants";
import { defaultSelectedIds } from "../shared/selection";
import { getConfig, saveConfig, type ExtensionConfig } from "../shared/storage";
import type {
  BackgroundRequest,
  DetectedField,
  FillOutcome,
  LoginResponse,
  ProfileResponse,
  ProfileSource,
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
  if (!panelExpanded) void initPanel();
  else applyFieldsToAutofillTab();
}

export function updateOverlay(state: OverlayViewState): void {
  overlayState.fields = state.fields;
  overlayState.tabUrl = state.tabUrl;
  if (panelExpanded) applyFieldsToAutofillTab();
}

export function removeOverlay(): void {
  document.getElementById(HOST_ID)?.remove();
  shadow = null;
  refs = null;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const I_ZAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const I_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const I_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

const SVGS: Record<string, string> = {
  autofill:
    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  profile:
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  experience:
    '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  education:
    '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.5 2.5 3 6 3s6-1.5 6-3v-5"/>',
  skills:
    '<polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
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

function icon(paths: string, w = 24): string {
  return `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// ---------------------------------------------------------------------------
// Styles (all popup CSS converted for Shadow DOM)
// ---------------------------------------------------------------------------

const STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

/* ---- Root & FAB ---- */
.ap-root {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  color: #211b46;
}
.ap-fab {
  width: 52px; height: 52px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  box-shadow: 0 8px 24px rgba(124,108,255,0.45);
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s, box-shadow 0.15s;
  color: #fff;
}
.ap-fab:hover { transform: scale(1.06); }
.ap-fab svg { width: 24px; height: 24px; }
.ap-fab-badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 999px; background: #fff; color: #6a5ae0;
  font-size: 11px; font-weight: 800; line-height: 20px; text-align: center;
  box-shadow: 0 2px 6px rgba(0,0,0,0.18);
}
.ap-fab-wrap {
  position: relative; display: inline-flex;
}
.ap-root.ap-expanded .ap-fab-wrap { display: none; }
.ap-root.ap-collapsed .ap-panel { display: none; }

/* ---- Panel ---- */
.ap-panel {
  width: 380px;
  max-height: min(580px, 85vh);
  background: #f7f6ff;
  border: 1px solid #e7e4ff;
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(60,40,120,0.28);
  display: flex; flex-direction: column;
  overflow: hidden;
  transform-origin: bottom right;
  animation: ap-pop 0.18s ease-out;
}
@keyframes ap-pop {
  from { opacity:0; transform: translateY(8px) scale(0.96); }
  to   { opacity:1; transform: translateY(0) scale(1); }
}

/* ---- Header ---- */
.ap-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 14px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff; flex-shrink: 0;
}
.ap-brand { display: flex; align-items: center; gap: 9px; }
.ap-brand-logo {
  width: 28px; height: 28px; border-radius: 9px;
  background: rgba(255,255,255,0.2);
  display: flex; align-items: center; justify-content: center;
}
.ap-brand-logo svg { width: 16px; height: 16px; }
.ap-brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.ap-brand-name { font-weight: 700; font-size: 14px; }
.ap-brand-sub { font-size: 10px; color: rgba(255,255,255,0.82); }
.ap-header-right { display: flex; align-items: center; gap: 8px; }
.ap-chip {
  font-size: 10.5px; font-weight: 600; padding: 3px 8px;
  border-radius: 999px; background: rgba(255,255,255,0.18); color: #fff;
  white-space: nowrap;
}
.ap-chip.connected { background: rgba(255,255,255,0.95); color: #1e9e6a; }
.ap-chip.warn { background: rgba(255,255,255,0.95); color: #b97d10; }
.ap-icon-btn {
  border: none; background: rgba(255,255,255,0.14);
  width: 28px; height: 28px; border-radius: 8px;
  cursor: pointer; color: #fff;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.ap-icon-btn svg { width: 15px; height: 15px; }
.ap-icon-btn:hover { background: rgba(255,255,255,0.28); }
.ap-avatar {
  width: 28px; height: 28px; border-radius: 8px;
  background: rgba(255,255,255,0.22); color: #fff;
  font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.ap-btn-signin {
  border: none; background: rgba(255,255,255,0.95); color: #6a5ae0;
  font-size: 11.5px; font-weight: 700; padding: 5px 12px;
  border-radius: 999px; cursor: pointer; white-space: nowrap;
}
.ap-btn-signin:hover { background: #fff; }

/* ---- Tab bar ---- */
.ap-tabbar {
  display: flex; gap: 2px; padding: 8px 8px 0;
  background: #f0eeff; border-bottom: 1px solid #e7e4ff;
  overflow-x: auto; scrollbar-width: none; flex-shrink: 0;
}
.ap-tabbar::-webkit-scrollbar { display: none; }
.ap-tab {
  display: flex; align-items: center; gap: 5px; padding: 7px 9px;
  border: 1px solid transparent; border-bottom: none;
  border-radius: 8px 8px 0 0; background: none;
  color: #6f6a93; font-size: 11.5px; font-weight: 600;
  white-space: nowrap; cursor: pointer;
}
.ap-tab svg { width: 12px; height: 12px; }
.ap-tab:hover { color: #211b46; }
.ap-tab.active {
  background: #fff; color: #6a5ae0;
  border-color: #e7e4ff;
  box-shadow: 0 -1px 2px rgba(80,60,160,0.04);
}

/* ---- Views ---- */
.ap-view { display: none; flex: 1; overflow: hidden; flex-direction: column; }
.ap-view.visible { display: flex; }
.ap-tabpanel { padding: 12px; overflow-y: auto; flex: 1; }
.ap-tabpanel-wrap { display: none; }
.ap-tabpanel-wrap.visible { display: block; }

/* ---- Cards ---- */
.ap-card {
  background: #fff; border: 1px solid #e7e4ff;
  border-radius: 12px; padding: 12px; margin-bottom: 10px;
}

/* ---- Autofill tab ---- */
.ap-site-line {
  font-size: 12px; color: #6f6a93; margin: 0 2px 8px;
  display: flex; align-items: center; gap: 6px; min-height: 16px;
}
.ap-ats-badge {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.4px; color: #6a5ae0; background: #f0eeff;
  border: 1px solid #e7e4ff; border-radius: 4px; padding: 1px 5px;
}
.ap-scan-card {
  background: #fff; border: 1px solid #e7e4ff;
  border-radius: 12px; overflow: hidden; margin-bottom: 10px;
}
.ap-scan-card-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; background: #f0eeff;
  border-bottom: 1px solid #f1eeff;
}
.ap-scan-status { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
.ap-live-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #1e9e6a;
  display: inline-block; animation: ap-pulse 2s ease-in-out infinite;
}
@keyframes ap-pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
.ap-counts { font-size: 11px; color: #6f6a93; }
.ap-fields { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.ap-group-title {
  font-size: 10.5px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.5px; color: #6f6a93; margin: 2px 2px 0;
}
.ap-field-row {
  display: flex; gap: 8px; background: #fff;
  border: 1px solid #e7e4ff; border-radius: 9px; padding: 8px 10px;
}
.ap-field-row.sensitive { border-style: dashed; background: #fffdf5; }
.ap-field-row input[type="checkbox"] { margin: 2px 0 0; accent-color: #7c6cff; }
.ap-field-main { flex: 1; min-width: 0; }
.ap-field-label { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ap-field-meta { display: flex; align-items: center; gap: 6px; margin-top: 3px; flex-wrap: wrap; }
.ap-cat-chip { font-size: 10px; font-weight: 600; background: #f0eeff; color: #6a5ae0; border-radius: 4px; padding: 1px 5px; }
.ap-conf { font-size: 10px; font-weight: 700; }
.ap-conf.high { color: #1e9e6a; }
.ap-conf.med  { color: #b97d10; }
.ap-conf.low  { color: #c0392b; }
.ap-req-star { color: #c0392b; font-weight: 700; }
.ap-field-value { margin-top: 3px; font-size: 11.5px; color: #6f6a93; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ap-field-value.empty { font-style: italic; font-family: inherit; }
.ap-field-note { margin-top: 3px; font-size: 11px; color: #b97d10; }
.ap-outcome { font-size: 13px; line-height: 1; padding-top: 2px; }
.ap-outcome.ok { color: #1e9e6a; }
.ap-outcome.fail { color: #c0392b; }
.ap-outcome-reason { margin-top: 3px; font-size: 11px; color: #c0392b; }

/* ---- Buttons ---- */
.ap-btn {
  border-radius: 10px; padding: 10px 12px; font-size: 13px; font-weight: 700;
  cursor: pointer; border: 1px solid transparent;
}
.ap-btn.primary { background: #7c6cff; color: #fff; box-shadow: 0 6px 16px rgba(124,108,255,0.28); }
.ap-btn.primary:hover:not(:disabled) { background: #6a5ae0; }
.ap-btn.secondary { background: #fff; border-color: #e7e4ff; color: #6a5ae0; }
.ap-btn.secondary:hover:not(:disabled) { background: #f0eeff; }
.ap-btn.link { background: none; border: none; color: #6a5ae0; font-weight: 600; padding: 6px 2px; }
.ap-btn.link:hover { text-decoration: underline; }
.ap-btn.full { width: 100%; margin-top: 8px; }
.ap-btn:disabled { opacity: 0.55; cursor: default; }
.ap-actions { display: flex; gap: 8px; }
.ap-actions .ap-btn { flex: 1; }

/* ---- Banner ---- */
.ap-banner {
  border-radius: 10px; padding: 8px 10px; font-size: 12px; margin-bottom: 10px;
  background: #e7f7ef; border: 1px solid #bfe8d4; color: #1e9e6a;
}
.ap-banner.warn { background: #fdf3e0; border-color: #f3ddb0; color: #b97d10; }
.ap-banner.error { background: #fdecea; border-color: #f5c6c0; color: #c0392b; }

/* ---- Profile tab ---- */
.ap-profile-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.ap-avatar-lg {
  width: 48px; height: 48px; border-radius: 14px;
  background: linear-gradient(135deg, #7c6cff 0%, #9f6bff 100%);
  color: #fff; font-weight: 700; font-size: 18px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; box-shadow: 0 6px 16px rgba(124,108,255,0.3);
}
.ap-profile-name-lg { font-weight: 700; font-size: 15px; }
.ap-profile-title { color: #6f6a93; font-size: 12px; margin-top: 1px; }
.ap-profile-pill {
  display: inline-flex; align-items: center; gap: 5px; margin-top: 5px;
  padding: 2px 8px; border-radius: 999px;
  background: #e7f7ef; color: #1e9e6a; font-size: 10px; font-weight: 600;
}
.ap-profile-pill.warn { background: #fdf3e0; color: #b97d10; }
.ap-profile-pill .ap-live-dot { animation: none; }
.ap-profile-pill.warn .ap-live-dot { background: #b97d10; }
.ap-info-list {
  display: flex; flex-direction: column; background: #fff;
  border: 1px solid #e7e4ff; border-radius: 12px; overflow: hidden;
}
.ap-info-row {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 12px; border-bottom: 1px solid #f1eeff;
}
.ap-info-row:last-child { border-bottom: none; }
.ap-info-ico { color: #6f6a93; margin-top: 2px; flex-shrink: 0; }
.ap-info-ico svg { width: 14px; height: 14px; display: block; }
.ap-info-body { min-width: 0; }
.ap-info-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #6f6a93; }
.ap-info-val { font-size: 12.5px; color: #211b46; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ap-info-val.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

/* ---- Timeline ---- */
.ap-timeline { display: flex; flex-direction: column; gap: 10px; }
.ap-timeline-item {
  position: relative; background: #fff;
  border: 1px solid #e7e4ff; border-radius: 12px;
  padding: 11px 12px 11px 22px;
}
.ap-timeline-item::before {
  content: ""; position: absolute; left: 11px; top: 15px;
  width: 8px; height: 8px; border-radius: 50%; background: #7c6cff;
}
.ap-timeline-date { font-size: 10.5px; color: #6f6a93; font-weight: 600; }
.ap-timeline-title { font-weight: 700; font-size: 13px; margin-top: 2px; }
.ap-timeline-sub { font-size: 12px; color: #6f6a93; margin-top: 1px; }
.ap-timeline-desc { font-size: 11.5px; color: #211b46; margin-top: 6px; white-space: pre-wrap; line-height: 1.4; }

/* ---- Skills ---- */
.ap-tags { display: flex; flex-wrap: wrap; gap: 7px; }
.ap-tag { background: #f0eeff; color: #6a5ae0; border: 1px solid #e7e4ff; border-radius: 999px; padding: 4px 11px; font-size: 12px; font-weight: 600; }

/* ---- Settings ---- */
.ap-toggles { padding: 4px 4px; }
.ap-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 8px; cursor: pointer; }
.ap-toggle-row + .ap-toggle-row { border-top: 1px solid #f1eeff; }
.ap-toggle-text { display: flex; flex-direction: column; min-width: 0; }
.ap-toggle-title { font-size: 12.5px; font-weight: 600; }
.ap-toggle-desc { font-size: 11px; color: #6f6a93; margin-top: 2px; }
.ap-switch {
  appearance: none; -webkit-appearance: none;
  width: 38px; height: 22px; border-radius: 999px;
  background: #cfc9ef; position: relative; cursor: pointer;
  flex-shrink: 0; transition: background 0.15s; margin: 0;
}
.ap-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  transition: transform 0.15s;
}
.ap-switch:checked { background: #7c6cff; }
.ap-switch:checked::after { transform: translateX(16px); }

/* ---- Forms ---- */
.ap-form-label { display: block; font-size: 11.5px; font-weight: 600; color: #6f6a93; margin: 10px 0 3px; }
.ap-form-label:first-child { margin-top: 0; }
.ap-input {
  width: 100%; border: 1px solid #e7e4ff; border-radius: 9px;
  padding: 9px 10px; font-size: 13px; background: #fff; color: #211b46;
}
.ap-input:focus { outline: 2px solid #f0eeff; border-color: #7c6cff; }
.ap-error { margin-top: 8px; font-size: 12px; color: #c0392b; background: #fdecea; border: 1px solid #f5c6c0; border-radius: 8px; padding: 7px 9px; }
.ap-muted { color: #6f6a93; }
.ap-login-card h2 { margin: 0 0 2px; font-size: 15px; }
.ap-login-divider { display: flex; align-items: center; margin: 12px 0; gap: 8px; }
.ap-login-divider::before, .ap-login-divider::after { content: ""; flex: 1; height: 1px; background: #e7e4ff; }
.ap-login-divider span { font-size: 11px; color: #6f6a93; text-transform: uppercase; }
.ap-google-btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: #fff; border: 1px solid #e7e4ff; color: #211b46; font-weight: 600; }
.ap-google-btn:hover:not(:disabled) { background: #f8f8ff; }

/* ---- Footer ---- */
.ap-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; border-top: 1px solid #e7e4ff;
  background: #f0eeff; flex-shrink: 0;
}
.ap-footer-version { font-size: 10px; color: #6f6a93; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ap-footer-status { font-size: 10.5px; color: #6f6a93; display: flex; align-items: center; gap: 5px; }
.ap-footer .ap-btn.link { font-size: 11px; padding: 2px; }

/* ---- Misc ---- */
.ap-page-msg { text-align: center; color: #6f6a93; padding: 18px 8px; font-size: 12.5px; }
.ap-empty-tab { text-align: center; color: #6f6a93; padding: 26px 12px; font-size: 12.5px; }
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

type Tab = "autofill" | "profile" | "experience" | "education" | "skills" | "settings";
type View = "main" | "login";

interface PanelState {
  config: ExtensionConfig | null;
  status: StatusResponse | null;
  profile: UserApplicationProfile | null;
  source: ProfileSource | null;
  fields: DetectedField[];
  tabUrl: string;
  selected: Set<string>;
  outcomes: Map<string, FillOutcome>;
  busy: boolean;
  scanned: boolean;
  view: View;
  tab: Tab;
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
  fields: [],
  tabUrl: "",
  selected: new Set(),
  outcomes: new Map(),
  busy: false,
  scanned: false,
  view: "main",
  tab: "autofill",
};

interface Refs {
  root: HTMLDivElement;
  fabWrap: HTMLDivElement;
  fabBadge: HTMLSpanElement;
  panel: HTMLDivElement;
  header: HTMLElement;
  chip: HTMLSpanElement;
  btnSignin: HTMLButtonElement;
  avatar: HTMLSpanElement;
  tabbar: HTMLElement;
  viewMain: HTMLElement;
  viewLogin: HTMLElement;
  footer: HTMLElement;
  footerStatus: HTMLSpanElement;
  // autofill tab
  siteLine: HTMLDivElement;
  banner: HTMLDivElement;
  countsHeadline: HTMLSpanElement;
  counts: HTMLSpanElement;
  fields: HTMLDivElement;
  btnScan: HTMLButtonElement;
  btnFill: HTMLButtonElement;
  // profile tab
  profileHead: HTMLDivElement;
  profileInfo: HTMLDivElement;
  // timeline tabs
  experienceList: HTMLDivElement;
  educationList: HTMLDivElement;
  // skills
  skillsList: HTMLDivElement;
  // settings
  setApiUrl: HTMLInputElement;
  setDashUrl: HTMLInputElement;
  setMock: HTMLInputElement;
  setEeo: HTMLInputElement;
  settingsError: HTMLDivElement;
  btnLogout: HTMLButtonElement;
  // login
  loginEmail: HTMLInputElement;
  loginPassword: HTMLInputElement;
  loginError: HTMLDivElement;
  btnLogin: HTMLButtonElement;
  btnGoogleLogin: HTMLButtonElement;
}

let refs: Refs | null = null;

// ---------------------------------------------------------------------------
// Messaging helpers
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
  root.innerHTML = buildPanelHTML();
  shadow.appendChild(root);
  (document.documentElement || document.body).appendChild(host);

  wireEvents(root);
  refs = collectRefs(root);
}

function buildPanelHTML(): string {
  const TABS: Array<{ id: Tab; label: string; svgPaths: string }> = [
    { id: "autofill",   label: "Autofill",    svgPaths: SVGS.autofill },
    { id: "profile",    label: "Profile",     svgPaths: SVGS.profile },
    { id: "experience", label: "Experience",  svgPaths: SVGS.experience },
    { id: "education",  label: "Education",   svgPaths: SVGS.education },
    { id: "skills",     label: "Skills",      svgPaths: SVGS.skills },
    { id: "settings",   label: "Settings",    svgPaths: SVGS.settings },
  ];

  const tabBtns = TABS.map(
    (t) =>
      `<button class="ap-tab${t.id === "autofill" ? " active" : ""}" data-tab="${t.id}">
        ${icon(t.svgPaths, 12)}${t.label}
       </button>`
  ).join("");

  return `
    <div class="ap-fab-wrap">
      <button class="ap-fab" type="button" title="ApplyPilot" aria-label="Open ApplyPilot">
        ${I_ZAP}
      </button>
      <span class="ap-fab-badge" hidden></span>
    </div>
    <div class="ap-panel">
      <header class="ap-header">
        <div class="ap-brand">
          <span class="ap-brand-logo">${icon(SVGS.autofill, 16)}</span>
          <div class="ap-brand-text">
            <span class="ap-brand-name">ApplyPilot</span>
            <span class="ap-brand-sub">Job Application Autofill</span>
          </div>
        </div>
        <div class="ap-header-right">
          <span class="ap-chip" id="ap-chip">…</span>
          <button class="ap-icon-btn" id="ap-btn-settings" title="Settings">${I_GEAR}</button>
          <button class="ap-btn-signin" id="ap-btn-signin" hidden>Sign in</button>
          <span class="ap-avatar" id="ap-avatar" hidden>AP</span>
          <button class="ap-icon-btn" id="ap-btn-close" title="Close">${I_CLOSE}</button>
        </div>
      </header>

      <nav class="ap-tabbar" id="ap-tabbar" hidden>${tabBtns}</nav>

      <!-- Main view -->
      <main class="ap-view" id="ap-view-main">
        <div class="ap-tabpanel" id="ap-tabpanel-scroll">
          <!-- Autofill tab -->
          <div class="ap-tabpanel-wrap visible" id="ap-tab-autofill">
            <div class="ap-site-line" id="ap-site-line"></div>
            <div class="ap-banner" id="ap-banner" hidden></div>
            <div class="ap-scan-card">
              <div class="ap-scan-card-head">
                <span class="ap-scan-status">
                  <span class="ap-live-dot"></span>
                  <span id="ap-counts-headline">Scanning…</span>
                </span>
                <span id="ap-counts" class="ap-counts"></span>
              </div>
              <div class="ap-fields" id="ap-fields"></div>
            </div>
            <div class="ap-actions">
              <button id="ap-btn-scan" class="ap-btn secondary">Rescan</button>
              <button id="ap-btn-fill" class="ap-btn primary" disabled>Autofill</button>
            </div>
          </div>

          <!-- Profile tab -->
          <div class="ap-tabpanel-wrap" id="ap-tab-profile">
            <div class="ap-profile-head" id="ap-profile-head"></div>
            <div class="ap-info-list" id="ap-profile-info"></div>
          </div>

          <!-- Experience tab -->
          <div class="ap-tabpanel-wrap" id="ap-tab-experience">
            <div class="ap-timeline" id="ap-experience-list"></div>
          </div>

          <!-- Education tab -->
          <div class="ap-tabpanel-wrap" id="ap-tab-education">
            <div class="ap-timeline" id="ap-education-list"></div>
          </div>

          <!-- Skills tab -->
          <div class="ap-tabpanel-wrap" id="ap-tab-skills">
            <div class="ap-tags" id="ap-skills-list"></div>
          </div>

          <!-- Settings tab -->
          <div class="ap-tabpanel-wrap" id="ap-tab-settings">
            <div class="ap-card">
              <label class="ap-form-label" for="ap-set-api-url">API base URL</label>
              <input id="ap-set-api-url" class="ap-input" type="url" placeholder="https://www.tailrd.ca" />
              <label class="ap-form-label" for="ap-set-dash-url">Dashboard URL</label>
              <input id="ap-set-dash-url" class="ap-input" type="url" placeholder="https://www.tailrd.ca" />
            </div>
            <div class="ap-card ap-toggles">
              <label class="ap-toggle-row">
                <span class="ap-toggle-text">
                  <span class="ap-toggle-title">Use sample data</span>
                  <span class="ap-toggle-desc">Autofill from a demo profile — no backend needed.</span>
                </span>
                <input id="ap-set-mock" type="checkbox" class="ap-switch" />
              </label>
              <label class="ap-toggle-row">
                <span class="ap-toggle-text">
                  <span class="ap-toggle-title">Fill EEO / demographic fields</span>
                  <span class="ap-toggle-desc">Only filled when this is on and your profile has the answers.</span>
                </span>
                <input id="ap-set-eeo" type="checkbox" class="ap-switch" />
              </label>
            </div>
            <div id="ap-settings-error" class="ap-error" hidden></div>
            <div class="ap-actions" style="flex-direction:column">
              <button id="ap-btn-settings-save" class="ap-btn primary full">Save settings</button>
              <button id="ap-btn-logout" class="ap-btn link full" hidden>Sign out</button>
            </div>
          </div>
        </div>
      </main>

      <!-- Login view -->
      <main class="ap-view" id="ap-view-login">
        <div class="ap-tabpanel">
          <div class="ap-card ap-login-card">
            <h2>Connect your account</h2>
            <p class="ap-muted">Sign in with your ApplyPilot account to autofill with your real profile.</p>
            <label class="ap-form-label" for="ap-login-email">Email</label>
            <input id="ap-login-email" class="ap-input" type="email" autocomplete="username" />
            <label class="ap-form-label" for="ap-login-password">Password</label>
            <input id="ap-login-password" class="ap-input" type="password" autocomplete="current-password" />
            <div id="ap-login-error" class="ap-error" hidden></div>
            <button id="ap-btn-login" class="ap-btn primary full" type="button">Sign in</button>
            <div class="ap-login-divider"><span>or</span></div>
            <button id="ap-btn-google-login" class="ap-btn ap-google-btn full" type="button">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
            <button id="ap-btn-use-mock" class="ap-btn link full" type="button">Continue with sample data instead</button>
          </div>
        </div>
      </main>

      <footer class="ap-footer">
        <span class="ap-footer-version">v0.2.0</span>
        <span class="ap-footer-status" id="ap-footer-status"><span class="ap-live-dot"></span>Ready to fill</span>
        <button id="ap-btn-dashboard" class="ap-btn link" type="button">Open dashboard ↗</button>
      </footer>
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
    fabWrap: q(".ap-fab-wrap"),
    fabBadge: q(".ap-fab-badge"),
    panel: q(".ap-panel"),
    header: q(".ap-header"),
    chip: q("#ap-chip"),
    btnSignin: q("#ap-btn-signin"),
    avatar: q("#ap-avatar"),
    tabbar: q("#ap-tabbar"),
    viewMain: q("#ap-view-main"),
    viewLogin: q("#ap-view-login"),
    footer: q(".ap-footer"),
    footerStatus: q("#ap-footer-status"),
    siteLine: q("#ap-site-line"),
    banner: q("#ap-banner"),
    countsHeadline: q("#ap-counts-headline"),
    counts: q("#ap-counts"),
    fields: q("#ap-fields"),
    btnScan: q("#ap-btn-scan"),
    btnFill: q("#ap-btn-fill"),
    profileHead: q("#ap-profile-head"),
    profileInfo: q("#ap-profile-info"),
    experienceList: q("#ap-experience-list"),
    educationList: q("#ap-education-list"),
    skillsList: q("#ap-skills-list"),
    setApiUrl: q("#ap-set-api-url"),
    setDashUrl: q("#ap-set-dash-url"),
    setMock: q("#ap-set-mock"),
    setEeo: q("#ap-set-eeo"),
    settingsError: q("#ap-settings-error"),
    btnLogout: q("#ap-btn-logout"),
    loginEmail: q("#ap-login-email"),
    loginPassword: q("#ap-login-password"),
    loginError: q("#ap-login-error"),
    btnLogin: q("#ap-btn-login"),
    btnGoogleLogin: q("#ap-btn-google-login"),
  };
}

function wireEvents(root: HTMLDivElement): void {
  // FAB
  root.querySelector(".ap-fab")!.addEventListener("click", () => {
    setExpanded(true);
    if (!initialized) void initPanel();
  });

  // Close
  root.querySelector("#ap-btn-close")!.addEventListener("click", () => setExpanded(false));

  // Settings icon in header → jump to settings tab
  root.querySelector("#ap-btn-settings")!.addEventListener("click", () => {
    showView("main");
    selectTab("settings");
  });

  // Sign in button in header → show login view
  root.querySelector("#ap-btn-signin")!.addEventListener("click", () => showView("login"));

  // Dashboard
  root.querySelector("#ap-btn-dashboard")!.addEventListener("click", () => {
    void bg<SimpleResponse>({ type: "OPEN_DASHBOARD" });
  });

  // Tab clicks
  root.querySelectorAll<HTMLButtonElement>(".ap-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (overlayState.busy) return;
      selectTab(btn.dataset.tab as Tab);
    });
  });

  // Autofill tab
  root.querySelector("#ap-btn-scan")!.addEventListener("click", () => {
    callbacks?.onRescan();
    overlayState.scanned = false;
    renderAutofillTab();
  });
  root.querySelector("#ap-btn-fill")!.addEventListener("click", () => void doAutofill());

  // Settings
  root.querySelector("#ap-btn-settings-save")!.addEventListener("click", () => void saveSettings());
  root.querySelector("#ap-btn-logout")!.addEventListener("click", () => void doLogout());

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
// Panel init (called once, and on re-init after login/logout/settings)
// ---------------------------------------------------------------------------

async function initPanel(): Promise<void> {
  initialized = true;
  overlayState.config = await getConfig();

  const status = await bg<StatusResponse>({ type: "GET_STATUS" }).catch(() => null);
  overlayState.status = status;
  renderHeader();

  if (status && status.mode === "signedOut") {
    showView("login");
    return;
  }

  showView("main");
  selectTab("autofill");
  await loadProfile();
}

async function loadProfile(): Promise<void> {
  const resp = await bg<ProfileResponse>({ type: "GET_PROFILE" }).catch(() => null);
  if (!resp || !resp.ok) {
    if (resp?.needsLogin) { showView("login"); return; }
  } else {
    overlayState.profile = resp.profile ?? null;
    overlayState.source = resp.source ?? null;
  }
  renderHeader();
  overlayState.scanned = true;
  applyDefaultSelection();
  renderAutofillTab();
}

// ---------------------------------------------------------------------------
// View & tab switching
// ---------------------------------------------------------------------------

function setExpanded(val: boolean): void {
  panelExpanded = val;
  if (!refs) return;
  refs.root.classList.toggle("ap-expanded", val);
  refs.root.classList.toggle("ap-collapsed", !val);
}

function showView(view: View): void {
  overlayState.view = view;
  if (!refs) return;
  refs.viewMain.classList.toggle("visible", view === "main");
  refs.viewLogin.classList.toggle("visible", view === "login");
  refs.tabbar.hidden = view !== "main";
}

function selectTab(tab: Tab): void {
  overlayState.tab = tab;
  if (!refs) return;

  // Reset scroll
  refs.viewMain.querySelector("#ap-tabpanel-scroll")?.scrollTo(0, 0);

  const tabs: Tab[] = ["autofill", "profile", "experience", "education", "skills", "settings"];
  for (const t of tabs) {
    const wrap = refs.root.querySelector<HTMLElement>(`#ap-tab-${t}`);
    if (wrap) wrap.classList.toggle("visible", t === tab);
  }
  refs.root.querySelectorAll<HTMLButtonElement>(".ap-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  if (tab === "profile")    renderProfileTab();
  else if (tab === "experience") renderExperienceTab();
  else if (tab === "education")  renderEducationTab();
  else if (tab === "skills")     renderSkillsTab();
  else if (tab === "settings")   renderSettingsTab();
  else if (tab === "autofill")   renderAutofillTab();
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function profileInitials(): string {
  const p = overlayState.profile;
  const s = overlayState.status;
  const first = p?.firstName?.trim() ?? s?.firstName?.trim() ?? "";
  const last  = p?.lastName?.trim()  ?? s?.lastName?.trim()  ?? "";
  const initials = ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
  if (initials) return initials;
  const email = s?.email ?? p?.email ?? "";
  return email ? email[0].toUpperCase() : "AP";
}

function renderHeader(): void {
  if (!refs) return;
  const { chip, footerStatus, btnSignin, avatar } = refs;
  chip.className = "ap-chip";

  const s = overlayState.status;
  if (!s || !s.ok) {
    chip.textContent = "Offline";
    chip.classList.add("warn");
    footerStatus.innerHTML = `<span class="ap-live-dot"></span>Offline`;
  } else if (s.mode === "connected") {
    chip.textContent = "Connected";
    chip.classList.add("connected");
    footerStatus.innerHTML = `<span class="ap-live-dot"></span>Ready to fill`;
  } else if (s.mode === "mock") {
    chip.textContent = "Sample data";
    chip.classList.add("warn");
    footerStatus.innerHTML = `<span class="ap-live-dot"></span>Sample data`;
  } else {
    chip.textContent = "Signed out";
    footerStatus.innerHTML = `<span class="ap-live-dot"></span>Sign in to fill`;
  }

  const connected = Boolean(s?.ok && s.mode === "connected");
  btnSignin.hidden = connected;
  avatar.hidden = !connected;
  avatar.textContent = profileInitials();
}

// ---------------------------------------------------------------------------
// Autofill tab
// ---------------------------------------------------------------------------

function applyFieldsToAutofillTab(): void {
  applyDefaultSelection();
  renderAutofillTab();
  updateFabBadge();
}

function applyDefaultSelection(): void {
  overlayState.selected = defaultSelectedIds(overlayState.fields);
}

function renderAutofillTab(): void {
  if (!refs) return;
  renderSiteLine();
  renderFieldList();
  renderCounts();
  renderActions();
}

function renderSiteLine(): void {
  if (!refs) return;
  refs.siteLine.innerHTML = "";
  const url = overlayState.tabUrl;
  if (!/^https?:/i.test(url)) return;
  try {
    const host = new URL(url).hostname;
    const hostSpan = document.createElement("span");
    hostSpan.textContent = host;
    refs.siteLine.appendChild(hostSpan);
    const ats = detectAtsName(host);
    if (ats) {
      const badge = document.createElement("span");
      badge.className = "ap-ats-badge";
      badge.textContent = ats;
      refs.siteLine.appendChild(badge);
    }
  } catch { /* ignore */ }
}

function renderCounts(): void {
  if (!refs) return;
  const { fields, selected, scanned } = overlayState;
  if (fields.length === 0) {
    refs.counts.textContent = "";
    refs.countsHeadline.textContent = scanned ? "No fields detected" : "Scanning…";
    return;
  }
  const known = fields.filter((f) => f.category !== "unknown");
  const ready = known.filter((f) => selected.has(f.id)).length;
  const review = known.length - ready;
  const ignored = fields.length - known.length;
  refs.countsHeadline.textContent = `${fields.length} field${fields.length === 1 ? "" : "s"} detected`;
  refs.counts.textContent =
    `${ready} ready · ${review} to review` + (ignored > 0 ? ` · ${ignored} skipped` : "");
}

function renderActions(): void {
  if (!refs) return;
  const { busy, selected } = overlayState;
  refs.btnScan.disabled = busy;
  refs.btnScan.textContent = busy ? "Working…" : "Rescan";
  const count = selected.size;
  refs.btnFill.disabled = busy || count === 0;
  refs.btnFill.textContent = count > 0 ? `Autofill ${count} field${count === 1 ? "" : "s"}` : "Autofill";
}

function renderFieldList(): void {
  if (!refs) return;
  const container = refs.fields;
  container.innerHTML = "";
  const { fields, selected } = overlayState;

  if (fields.length === 0) {
    const msg = document.createElement("div");
    msg.className = "ap-page-msg";
    msg.textContent = "No form fields detected on this page. Open a job application and rescan.";
    container.appendChild(msg);
    return;
  }

  const known = fields.filter((f) => f.category !== "unknown");
  const ready = known.filter((f) => selected.has(f.id));
  const review = known.filter((f) => !selected.has(f.id));

  if (ready.length > 0) {
    const t = document.createElement("div");
    t.className = "ap-group-title";
    t.textContent = "Will fill";
    container.appendChild(t);
    for (const f of ready) container.appendChild(makeFieldRow(f));
  }
  if (review.length > 0) {
    const t = document.createElement("div");
    t.className = "ap-group-title";
    t.textContent = "Review — not filled automatically";
    container.appendChild(t);
    for (const f of review) container.appendChild(makeFieldRow(f));
  }
}

function makeFieldRow(field: DetectedField): HTMLElement {
  const row = document.createElement("div");
  row.className = "ap-field-row" + (field.sensitive ? " sensitive" : "");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = overlayState.selected.has(field.id);
  checkbox.disabled = !field.fillable || field.proposedValue === null;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) overlayState.selected.add(field.id);
    else overlayState.selected.delete(field.id);
    renderCounts();
    renderActions();
  });
  row.appendChild(checkbox);

  const main = document.createElement("div");
  main.className = "ap-field-main";

  const lbl = document.createElement("div");
  lbl.className = "ap-field-label";
  lbl.textContent = field.label;
  lbl.title = field.label;
  if (field.required) {
    const star = document.createElement("span");
    star.className = "ap-req-star";
    star.textContent = " *";
    lbl.appendChild(star);
  }
  main.appendChild(lbl);

  const meta = document.createElement("div");
  meta.className = "ap-field-meta";
  const cat = document.createElement("span");
  cat.className = "ap-cat-chip";
  cat.textContent = CATEGORY_LABELS[field.category] ?? field.category;
  meta.appendChild(cat);
  meta.appendChild(makeConfBadge(field.confidence));
  main.appendChild(meta);

  const val = document.createElement("div");
  if (field.proposedValue !== null) {
    val.className = "ap-field-value";
    val.textContent = `→ ${field.proposedValue}`;
    val.title = field.proposedValue;
  } else {
    val.className = "ap-field-value empty";
    val.textContent = field.sensitive ? "Not autofilled (EEO)" : "No profile data";
  }
  main.appendChild(val);

  if (field.currentValue && field.proposedValue !== null) {
    const note = document.createElement("div");
    note.className = "ap-field-note";
    note.textContent = `Already filled: "${field.currentValue}" — check to overwrite`;
    main.appendChild(note);
  }
  if (field.note) {
    const note = document.createElement("div");
    note.className = "ap-field-note";
    note.textContent = field.note;
    main.appendChild(note);
  }

  const outcome = overlayState.outcomes.get(field.id);
  if (outcome && !outcome.ok && outcome.reason) {
    const reason = document.createElement("div");
    reason.className = "ap-outcome-reason";
    reason.textContent = outcome.reason;
    main.appendChild(reason);
  }
  row.appendChild(main);

  if (outcome) {
    const mark = document.createElement("div");
    mark.className = `ap-outcome ${outcome.ok ? "ok" : "fail"}`;
    mark.textContent = outcome.ok ? "✓" : "✗";
    row.appendChild(mark);
  }

  return row;
}

function makeConfBadge(confidence: number): HTMLElement {
  const span = document.createElement("span");
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.8) {
    span.className = "ap-conf high";
    span.textContent = `High ${pct}%`;
  } else if (confidence >= 0.6) {
    span.className = "ap-conf med";
    span.textContent = `Medium ${pct}%`;
  } else {
    span.className = "ap-conf low";
    span.textContent = `Low ${pct}%`;
  }
  return span;
}

function updateFabBadge(): void {
  if (!refs) return;
  const count = overlayState.fields.filter((f) => f.category !== "unknown").length;
  refs.fabBadge.hidden = count === 0;
  refs.fabBadge.textContent = count > 0 ? String(count) : "";
}

// ---------------------------------------------------------------------------
// Autofill action
// ---------------------------------------------------------------------------

async function doAutofill(): Promise<void> {
  if (!callbacks || overlayState.busy) return;
  const ids = [...overlayState.selected];
  if (ids.length === 0) return;

  overlayState.busy = true;
  renderActions();
  showBanner("", "ok", true); // hide banner while working

  try {
    const { ok, fail, total } = await callbacks.onAutofill(ids);
    overlayState.outcomes = new Map(); // refresh from result
    // Re-render field list with outcome markers
    renderFieldList();
    const txt =
      `Filled ${ok} of ${total} field${total === 1 ? "" : "s"}` +
      (fail > 0 ? ` (${fail} need attention)` : "") +
      ". Review before submitting.";
    showBanner(txt, fail > 0 ? "warn" : "ok");
  } catch (err) {
    showBanner(`Autofill failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  } finally {
    overlayState.busy = false;
    renderActions();
  }
}

function showBanner(text: string, kind: "ok" | "warn" | "error", hide = false): void {
  if (!refs) return;
  if (hide || !text) { refs.banner.hidden = true; return; }
  refs.banner.hidden = false;
  refs.banner.className = "ap-banner" + (kind === "ok" ? "" : ` ${kind}`);
  refs.banner.textContent = text;
}

// ---------------------------------------------------------------------------
// Profile tab
// ---------------------------------------------------------------------------

function renderProfileTab(): void {
  if (!refs) return;
  refs.profileHead.innerHTML = "";
  refs.profileInfo.innerHTML = "";
  const p = overlayState.profile;

  if (!p) {
    const msg = document.createElement("div");
    msg.className = "ap-empty-tab";
    msg.textContent = overlayState.source === "mock"
      ? "Showing sample data. Sign in to load your real profile."
      : "Sign in and upload a resume to populate your profile.";
    refs.profileInfo.appendChild(msg);
    return;
  }

  const avatarEl = document.createElement("div");
  avatarEl.className = "ap-avatar-lg";
  avatarEl.textContent = profileInitials();

  const meta = document.createElement("div");
  const nameLine = document.createElement("div");
  nameLine.className = "ap-profile-name-lg";
  const { profile: pr, status: st } = overlayState;
  const first = pr?.firstName?.trim() ?? st?.firstName?.trim() ?? "";
  const last = pr?.lastName?.trim() ?? st?.lastName?.trim() ?? "";
  nameLine.textContent = [first, last].filter(Boolean).join(" ") || p.email || "Your profile";

  const titleLine = document.createElement("div");
  titleLine.className = "ap-profile-title";
  titleLine.textContent = [p.currentTitle, p.currentCompany].filter(Boolean).join(" · ") || "—";

  const complete = Boolean(p.firstName && p.email && p.phone);
  const pill = document.createElement("span");
  pill.className = "ap-profile-pill" + (complete ? "" : " warn");
  pill.innerHTML = `<span class="ap-live-dot"></span>${
    overlayState.source === "mock" ? "Sample profile" : complete ? "Profile complete" : "Needs details"
  }`;

  meta.appendChild(nameLine);
  meta.appendChild(titleLine);
  meta.appendChild(pill);
  refs.profileHead.appendChild(avatarEl);
  refs.profileHead.appendChild(meta);

  const rows: Array<[string, string, string, boolean]> = [
    ["Email",     p.email,     SVGS.mail,     true],
    ["Phone",     p.phone,     SVGS.phone,    true],
    ["Location",  p.location,  SVGS.pin,      false],
    ["Portfolio", p.portfolio, SVGS.globe,    true],
    ["LinkedIn",  p.linkedin,  SVGS.linkedin, true],
    ["GitHub",    p.github,    SVGS.github,   true],
  ];
  for (const [label, value, paths, mono] of rows) {
    if (!value) continue;
    refs.profileInfo.appendChild(makeInfoRow(label, value, paths, mono));
  }
  if (!refs.profileInfo.children.length) {
    const msg = document.createElement("div");
    msg.className = "ap-empty-tab";
    msg.textContent = "No contact details on file yet.";
    refs.profileInfo.appendChild(msg);
  }
}

function makeInfoRow(label: string, value: string, svgPaths: string, mono: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "ap-info-row";
  const ico = document.createElement("span");
  ico.className = "ap-info-ico";
  ico.innerHTML = icon(svgPaths, 14);
  const body = document.createElement("div");
  body.className = "ap-info-body";
  const lab = document.createElement("div");
  lab.className = "ap-info-label";
  lab.textContent = label;
  const val = document.createElement("div");
  val.className = "ap-info-val" + (mono ? " mono" : "");
  val.textContent = value;
  val.title = value;
  body.appendChild(lab);
  body.appendChild(val);
  row.appendChild(ico);
  row.appendChild(body);
  return row;
}

// ---------------------------------------------------------------------------
// Experience tab
// ---------------------------------------------------------------------------

function renderExperienceTab(): void {
  if (!refs) return;
  refs.experienceList.innerHTML = "";
  const exp = overlayState.profile?.experience ?? [];
  if (exp.length === 0) {
    refs.experienceList.appendChild(emptyTab(overlayState.profile ? "No experience on file yet." : needsProfileMsg()));
    return;
  }
  for (const e of exp) {
    const item = document.createElement("div");
    item.className = "ap-timeline-item";
    const dates = [e.startDate, e.endDate || "Present"].filter(Boolean).join(" → ");
    if (dates) {
      const d = document.createElement("div");
      d.className = "ap-timeline-date";
      d.textContent = dates;
      item.appendChild(d);
    }
    const t = document.createElement("div");
    t.className = "ap-timeline-title";
    t.textContent = e.title || e.company || "Role";
    item.appendChild(t);
    if (e.company && e.title) {
      const s = document.createElement("div");
      s.className = "ap-timeline-sub";
      s.textContent = e.company;
      item.appendChild(s);
    }
    if (e.description) {
      const desc = document.createElement("div");
      desc.className = "ap-timeline-desc";
      desc.textContent = e.description;
      item.appendChild(desc);
    }
    refs.experienceList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Education tab
// ---------------------------------------------------------------------------

function renderEducationTab(): void {
  if (!refs) return;
  refs.educationList.innerHTML = "";
  const edu = overlayState.profile?.education ?? [];
  if (edu.length === 0) {
    refs.educationList.appendChild(emptyTab(overlayState.profile ? "No education on file yet." : needsProfileMsg()));
    return;
  }
  for (const e of edu) {
    const item = document.createElement("div");
    item.className = "ap-timeline-item";
    if (e.graduationYear) {
      const d = document.createElement("div");
      d.className = "ap-timeline-date";
      d.textContent = e.graduationYear;
      item.appendChild(d);
    }
    const t = document.createElement("div");
    t.className = "ap-timeline-title";
    t.textContent = e.school || "School";
    item.appendChild(t);
    if (e.degree) {
      const s = document.createElement("div");
      s.className = "ap-timeline-sub";
      s.textContent = e.degree;
      item.appendChild(s);
    }
    refs.educationList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Skills tab
// ---------------------------------------------------------------------------

function renderSkillsTab(): void {
  if (!refs) return;
  refs.skillsList.innerHTML = "";
  const skills = overlayState.profile?.skills ?? [];
  if (skills.length === 0) {
    refs.skillsList.appendChild(emptyTab(overlayState.profile ? "No skills on file yet." : needsProfileMsg()));
    return;
  }
  for (const s of skills) {
    const tag = document.createElement("span");
    tag.className = "ap-tag";
    tag.textContent = s;
    refs.skillsList.appendChild(tag);
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function renderSettingsTab(): void {
  if (!refs || !overlayState.config) return;
  refs.setApiUrl.value = overlayState.config.apiBaseUrl;
  refs.setDashUrl.value = overlayState.config.dashboardUrl;
  refs.setMock.checked = overlayState.config.useMockData;
  refs.setEeo.checked = overlayState.config.fillEEO;
  refs.btnLogout.hidden = overlayState.status?.mode !== "connected";
  refs.settingsError.hidden = true;
}

async function saveSettings(): Promise<void> {
  if (!refs) return;
  refs.settingsError.hidden = true;

  const apiBaseUrl = refs.setApiUrl.value.trim().replace(/\/+$/, "");
  const dashboardUrl = refs.setDashUrl.value.trim().replace(/\/+$/, "");
  const useMockData = refs.setMock.checked;
  const fillEEO = refs.setEeo.checked;

  if (!useMockData && apiBaseUrl) {
    try {
      const u = new URL(apiBaseUrl);
      const pattern = `${u.protocol}//${u.hostname}/*`;
      const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
      if (!granted) {
        refs.settingsError.hidden = false;
        refs.settingsError.textContent = "Permission to reach that server was declined.";
        return;
      }
    } catch {
      refs.settingsError.hidden = false;
      refs.settingsError.textContent = "Enter a valid http(s) API base URL or enable sample data.";
      return;
    }
  }

  await saveConfig({ apiBaseUrl, dashboardUrl, useMockData, fillEEO });
  await reInit();
}

async function doLogout(): Promise<void> {
  await bg<SimpleResponse>({ type: "LOGOUT" });
  await reInit();
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function doEmailLogin(): Promise<void> {
  if (!refs) return;
  const email = refs.loginEmail.value.trim();
  const password = refs.loginPassword.value;
  refs.loginError.hidden = true;

  refs.btnLogin.disabled = true;
  refs.btnLogin.textContent = "Signing in…";
  try {
    const resp = await bg<LoginResponse>({ type: "LOGIN", email, password });
    if (!resp.ok) {
      refs.loginError.hidden = false;
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
  refs.loginError.hidden = true;
  refs.btnGoogleLogin.disabled = true;
  refs.btnGoogleLogin.textContent = "Signing in…";
  try {
    const resp = await bg<LoginResponse>({ type: "GOOGLE_LOGIN" });
    if (!resp.ok) {
      refs.loginError.hidden = false;
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

// ---------------------------------------------------------------------------
// Re-init after auth/settings changes
// ---------------------------------------------------------------------------

async function reInit(): Promise<void> {
  overlayState.config = null;
  overlayState.status = null;
  overlayState.profile = null;
  overlayState.source = null;
  overlayState.selected = new Set();
  overlayState.outcomes = new Map();
  overlayState.busy = false;
  overlayState.scanned = false;
  overlayState.tab = "autofill";
  if (refs) refs.banner.hidden = true;
  initialized = false;
  await initPanel();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emptyTab(message: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "ap-empty-tab";
  div.textContent = message;
  return div;
}

function needsProfileMsg(): string {
  return overlayState.source === "mock"
    ? "Showing sample data. Sign in to load your real profile."
    : "Sign in and upload a resume to populate your profile.";
}
