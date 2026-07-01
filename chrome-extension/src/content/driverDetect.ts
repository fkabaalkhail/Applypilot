/**
 * Conservative widget-kind detection for the MAIN-world drivers. A false positive
 * routes an ordinary field through page-context injection, so each signature
 * requires a strong, specific marker — never a bare role=combobox.
 */
import type { FillDriver } from "./mainWorldBridge";

const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

/**
 * react-select stamps its editable input with `id="react-select-<n>-input"` by
 * default (its internal instanceId) — an id no ordinary form uses. That marker is
 * the strong, specific signal we key on. A custom `inputId` would evade it (rare);
 * we accept that false-negative (the field falls back to the isolated combobox
 * engine) rather than risk false-positives on generic markup such as Bootstrap's
 * `.form-control` inside any `*-container` wrapper.
 */
function isReactSelect(el: HTMLElement): boolean {
  return (
    el.matches('input[id^="react-select"]') ||
    el.querySelector('input[id^="react-select"]') !== null
  );
}

function isWorkdayWidget(el: HTMLElement): boolean {
  return Boolean(el.closest("[data-automation-id]"));
}

export function detectFillDriver(
  el: HTMLElement,
  hostname: string = location.hostname
): FillDriver | null {
  if (WORKDAY_HOST.test(hostname) && isWorkdayWidget(el)) return "workday";
  if (isReactSelect(el)) return "react-select";
  return null;
}
