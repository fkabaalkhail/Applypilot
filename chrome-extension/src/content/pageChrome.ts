/**
 * Page-chrome detection: header/nav/footer/aside landmarks are never part of
 * an application form. Mirrors consent.ts / captcha.ts: the scanner skips these
 * controls entirely, so an EN/FR language switcher in the site header (a real
 * <select>) can never surface as an application field.
 */

const CHROME_TAGS = new Set(["HEADER", "NAV", "FOOTER", "ASIDE"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "complementary"]);

/**
 * Ancestors of `el` in the composed tree, nearest first: the parentElement
 * chain, crossing open shadow-root boundaries via the host. (domUtils walks use
 * plain parentElement and would stop at a shadow root, SuccessFactors-style
 * UI5 widgets live inside them.)
 */
export function composedAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node) {
    let parent: HTMLElement | null = node.parentElement;
    if (!parent) {
      const root = node.getRootNode();
      parent = root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
    }
    if (parent) out.push(parent);
    node = parent;
  }
  return out;
}

/** True when a composed ancestor of `el` is a chrome landmark (tag or role). */
export function isInPageChrome(el: HTMLElement): boolean {
  for (const a of composedAncestors(el)) {
    if (CHROME_TAGS.has(a.tagName)) return true;
    const role = (a.getAttribute("role") || "").toLowerCase();
    if (CHROME_ROLES.has(role)) return true;
  }
  return false;
}
