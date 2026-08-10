/**
 * The Tailrd extension's Chrome Web Store listing (live since 2026-07-14).
 *
 * The trailing path segment is the store-assigned extension id; the slug before
 * it is decorative, and the Store redirects on the id alone, so renaming the
 * listing will not break this link.
 *
 * VITE_CHROME_STORE_URL still overrides, which is the escape hatch if the
 * listing ever moves.
 */
// `||`, not `??`: an empty VITE_CHROME_STORE_URL (an easy mis-click in Vercel) is a
// missing value, not a valid one, `??` would keep "" and link to the current page.
export const CHROME_STORE_URL =
  (import.meta.env.VITE_CHROME_STORE_URL as string | undefined) ||
  "https://chromewebstore.google.com/detail/tailrd-%E2%80%94-job-application/dadbhjlflnljgailcpgehdainjdmjeej";
