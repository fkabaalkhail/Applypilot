/**
 * Safe post-auth redirect target from a ``?next=`` query param.
 *
 * Used so the extension "Connect" page can bounce an unauthenticated user
 * through the normal sign-in UI and land them back on the connect page.
 *
 * Open-redirect guard: only same-origin absolute paths (start with a single
 * "/") are honored; anything else (``//evil.com``, ``https://…``) falls back.
 */
export function safeNextPath(next: string | null, fallback = "/app"): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return fallback;
}
