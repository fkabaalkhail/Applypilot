/**
 * CAPTCHA / human-verification detection (spec §5 — hard constraint).
 *
 * We NEVER interact with, solve, or bypass verification systems. We only
 * detect their presence so the reconciler can enter a global suspend mode for
 * the whole form group and resume once the page stabilizes. Detection is
 * deliberately conservative: a false positive merely pauses autofill; we would
 * rather pause than risk touching a verification widget.
 */
import { deepQueryAll } from "./domUtils";

/** Widget iframes load from these verification hosts/paths. */
const CAPTCHA_SRC = /recaptcha|hcaptcha|\bcaptcha\b|challenges\.cloudflare\.com|turnstile|funcaptcha|arkoselabs|geetest/i;

/** Container/widget markers present even before the challenge iframe mounts. */
const CAPTCHA_SELECTORS = [
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "[data-sitekey]",
  "#recaptcha",
  "#captcha",
  '[id*="captcha" i]',
  '[class*="captcha" i]',
].join(", ");

/** iframe[title] text frameworks set on the challenge frame. */
const CAPTCHA_TITLE = /recaptcha|hcaptcha|captcha|verify you are human|challenge/i;

/**
 * True when the page is showing (or has mounted) a verification widget.
 * Traverses open shadow DOM via deepQueryAll so embedded widgets are seen.
 */
export function detectCaptcha(root: ParentNode = document): boolean {
  for (const frame of deepQueryAll(root, "iframe")) {
    const iframe = frame as HTMLIFrameElement;
    const src = iframe.getAttribute("src") ?? "";
    if (CAPTCHA_SRC.test(src)) return true;
    const title = iframe.getAttribute("title") ?? "";
    if (title && CAPTCHA_TITLE.test(title)) return true;
  }

  for (const el of deepQueryAll(root, CAPTCHA_SELECTORS)) {
    // [data-sitekey] is the strongest portable signal; the others are scoped
    // tightly enough that their presence implies a real widget.
    if (el.hasAttribute("data-sitekey")) return true;
    const idClass = `${el.id} ${el.className}`.toLowerCase();
    if (idClass.includes("captcha") || idClass.includes("turnstile") || idClass.includes("recaptcha")) {
      return true;
    }
  }

  return false;
}
