/**
 * Cookie-consent / privacy-banner detection.
 *
 * Consent managers (OneTrust, Cookiebot, Usercentrics, …) inject their own
 * checkboxes, search boxes and toggles into every page. They are never
 * application fields, but they ARE real, visible form controls — so without
 * this guard the scanner counts them as "fields". On a page whose real form is
 * lazy-mounted (e.g. Databricks' embedded Greenhouse form), that leaves the
 * panel stuck reporting the cookie widgets ("0 of 8 fields", button disabled).
 *
 * Discovery skips these exactly like captcha widgets (see captcha.ts): we fill
 * the real form and never touch the consent UI.
 */

/** Containers the major consent managers render their controls inside. */
const CONSENT_CONTAINER = [
  // OneTrust
  "#onetrust-consent-sdk",
  "#onetrust-banner-sdk",
  "#onetrust-pc-sdk",
  "#ot-pc-content",
  '[id^="onetrust"]',
  '[class*="onetrust" i]',
  // Cookiebot
  "#CybotCookiebotDialog",
  // Usercentrics
  "#usercentrics-root",
  '[data-testid="uc-container"]',
  // CookieScript / generic
  "#cookiescript_injected",
  '[id*="cookie-consent" i]',
  '[class*="cookie-consent" i]',
  '[aria-label*="cookie" i][role="dialog"]',
].join(", ");

/**
 * The control's own id/name marks it as a consent widget's control. OneTrust
 * prefixes ids with "ot-"; other managers brand their own controls too. Anchored
 * so a mid-word "ot"/"cookie" in a real field name never matches.
 */
const CONSENT_OWN_ID = /^(ot-|onetrust|cookiebot|usercentrics|cookiescript)/i;

/**
 * True when a control belongs to a cookie-consent / privacy widget rather than
 * the application form. The scanner skips these so a consent banner can never
 * masquerade as the form's fields.
 */
export function isConsentField(el: HTMLElement): boolean {
  const id = el.id || "";
  const name = el.getAttribute("name") || "";
  if (CONSENT_OWN_ID.test(id) || CONSENT_OWN_ID.test(name)) return true;
  try {
    return el.closest(CONSENT_CONTAINER) !== null;
  } catch {
    return false;
  }
}
