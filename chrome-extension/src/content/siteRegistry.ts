// chrome-extension/src/content/siteRegistry.ts
/**
 * The single source of truth for "which site am I on". A typed port of
 * Jobright's `SITE_REGISTRY`: one data table keyed by site id, each entry
 * carrying any of domains / url patterns / path gate / iframe markers /
 * page-source keyword. `detectSite()` resolves a page to at most one entry.
 *
 * Detection is intentionally pure (host + url + a couple of ambient flags) so
 * it is trivially unit-testable and can run identically in the top document and
 * inside an embedded application iframe.
 */

/** Chrome match-pattern → RegExp. `*` scheme = http/https; a `*.` host also
 *  matches the apex; path `*` matches any run of characters (incl. `/`). */
export function matchPatternToRegex(pattern: string): RegExp {
  const m = /^(\*|https?|file):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)?$/.exec(pattern);
  if (!m) return /$^/; // structurally invalid → never matches
  const [, scheme, host = "*", path = "/*"] = m;
  // Escape every regex metachar INCLUDING `*`, so the `\*` → `.*` pass below is
  // the only thing that can reintroduce a wildcard.
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
  const schemeRe = scheme === "*" ? "https?" : scheme;
  let hostRe: string;
  if (host === "*") hostRe = "[^/]+";
  else if (host.startsWith("*.")) hostRe = "(?:[^/]+\\.)?" + esc(host.slice(2));
  else hostRe = esc(host);
  const pathRe = esc(path).replace(/\\\*/g, ".*");
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, "i");
}

/** True when `url` satisfies the Chrome match-pattern `pattern`. */
export function matchPattern(pattern: string, url: string): boolean {
  try {
    return matchPatternToRegex(pattern).test(url);
  } catch {
    return false;
  }
}
