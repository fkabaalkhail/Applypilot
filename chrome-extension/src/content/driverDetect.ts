/**
 * Conservative widget-kind detection for the MAIN-world drivers. A false positive
 * routes an ordinary field through page-context injection, so each signature
 * requires a strong, specific marker — never a bare role=combobox.
 */
import type { FillDriver } from "./mainWorldBridge";

const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

/** react-select stamps its inputs `id="react-select-<n>-input"` and wraps the
 *  control in a `*__container` / `*__control` element pair (its classNamePrefix
 *  output). Require the container AND the react-select input id/class shape. */
function isReactSelect(el: HTMLElement): boolean {
  const input =
    el.matches('input[id^="react-select"]')
      ? el
      : el.querySelector<HTMLElement>('input[id^="react-select"]');
  const container = el.closest('[class*="-container"], [class*="__container"]');
  const control =
    el.closest('[class*="-control"], [class*="__control"]') ??
    container?.querySelector('[class*="-control"], [class*="__control"]');
  return Boolean((input || control) && container);
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
