/**
 * The Tailrd extension's Chrome Web Store listing.
 *
 * The extension is still in review, so the fallback below is a placeholder. Once
 * the listing is live, set VITE_CHROME_STORE_URL in Vercel — no code change and
 * no redeploy of source needed. Replacing the literal works too.
 */
// `||`, not `??`: an empty VITE_CHROME_STORE_URL (an easy mis-click in Vercel) is a
// missing value, not a valid one — `??` would keep "" and link to the current page.
export const CHROME_STORE_URL =
  (import.meta.env.VITE_CHROME_STORE_URL as string | undefined) ||
  "https://chromewebstore.google.com/detail/tailrd/PLACEHOLDER_STORE_ID";
