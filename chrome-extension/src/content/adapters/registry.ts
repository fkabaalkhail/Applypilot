import type { SiteAdapter } from "./types";

/** Registered adapters, ordered — first match wins. Populated in the adapter
 *  modules (greenhouse.ts, workday.ts) via `ADAPTERS.push(...)` at import time. */
export const ADAPTERS: SiteAdapter[] = [];

/** Pure resolution against an explicit list — a throwing match() is skipped. */
export function resolveAdapter(adapters: SiteAdapter[], host: string, url: string): SiteAdapter | null {
  for (const a of adapters) {
    try {
      if (a.match(host, url)) return a;
    } catch {
      /* a broken adapter must never break resolution */
    }
  }
  return null;
}

/** Resolve the adapter for a page against the live registry. */
export function getAdapter(host: string, url: string): SiteAdapter | null {
  return resolveAdapter(ADAPTERS, host, url);
}
