/**
 * Conservative widget-kind detection for the MAIN-world drivers. A false positive
 * routes an ordinary field through page-context injection, so each signature
 * requires a strong, specific marker, never a bare role=combobox.
 */
import type { FillDriver } from "./mainWorldBridge";

const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

/**
 * react-select stamps `id="react-select-<instanceId>-…"` on its internal nodes:
 * the input (`-input`, default), and, even when the site passes a custom
 * `inputId` (Greenhouse job-boards uses "country"/"605"…), the placeholder
 * (`-placeholder`), live region (`-live-region`) and listbox (`-listbox`).
 * Those generated ids are hardcoded in react-select itself, so any of them
 * inside the widget is a strong, library-specific marker with no false-positive
 * surface on ordinary markup.
 */
function isReactSelect(el: HTMLElement): boolean {
  if (
    el.matches('input[id^="react-select"]') ||
    el.querySelector('input[id^="react-select"]') !== null
  ) {
    return true;
  }
  // Custom inputId: the input's aria-describedby still references the
  // react-select-generated placeholder id.
  if (/(^|\s)react-select-/.test(el.getAttribute("aria-describedby") ?? "")) return true;
  // Or any react-select-generated id within the widget wrapper. The wrapper
  // depth varies (input-container → value-container → control → container), so
  // climb a few levels and look for the marker at each.
  let host: HTMLElement | null = el.parentElement;
  for (let i = 0; i < 5 && host; i++, host = host.parentElement) {
    if (host.querySelector('[id^="react-select-"]')) return true;
  }
  return false;
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
