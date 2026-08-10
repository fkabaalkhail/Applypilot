/**
 * Regenerate src/content/brandLogo.ts from the source logos.
 *
 * Emits two data URIs:
 *   BRAND_LOGO_DATA_URI: the horizontal lockup (mark + "Tailrd" wordmark) for
 *                         the panel header, cropped from docs/Logo.jpeg.
 *   BRAND_MARK_DATA_URI: the square mark on its own, for the collapsed-state
 *                         edge tab, from frontend/public/logo-icon.png.
 *
 * Because the panel is a content script injected into third-party pages (whose
 * img-src CSP can block data-URI images), both are embedded as compact data
 * URIs and each surface degrades on strict-CSP sites, the header to a plain
 * "Tailrd" wordmark, the edge tab to its original purple chevron.
 *
 * Run this if either source art changes:  node scripts/gen-brand-logo.mjs
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(root, "docs", "Logo.jpeg");
const MARK_SRC = path.join(root, "frontend", "public", "logo-icon.png");
const OUT = path.join(root, "chrome-extension", "src", "content", "brandLogo.ts");

// The full horizontal logo lockup (paper-plane ring mark + "Tailrd" wordmark),
// hand-cropped from the 1024×1024 source with even margins so the ring/plane top
// is never clipped (auto-trim collapses on the mostly-white art).
const CROP = { left: 128, top: 336, width: 770, height: 286 };

const png = await sharp(SRC)
  .extract(CROP)
  .flatten({ background: "#ffffff" }) // header bg is white
  .resize({ height: 56 }) // ~2x the ~28px display height
  .png({ compressionLevel: 9, palette: true, quality: 85 })
  .toBuffer();

// The square mark. Kept on transparency (not flattened) so the edge tab can
// change its own background without a white box showing through.
const markPng = await sharp(MARK_SRC)
  .resize({ width: 64, height: 64, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9, palette: true, quality: 90 })
  .toBuffer();

const dataUri = "data:image/png;base64," + png.toString("base64");
const markDataUri = "data:image/png;base64," + markPng.toString("base64");
const module = `// AUTO-GENERATED brand assets, do not hand-edit. Regenerate with
// scripts/gen-brand-logo.mjs. The panel is a content script, so on strict
// img-src CSP sites these <img> data URIs are blocked and each surface falls
// back (header → plain "Tailrd" wordmark, edge tab → purple chevron).

/** Horizontal lockup (paper-plane ring + "Tailrd" wordmark) for the panel header. */
export const BRAND_LOGO_DATA_URI =
  "${dataUri}";

/** Square mark on its own, for the collapsed-state edge tab. */
export const BRAND_MARK_DATA_URI =
  "${markDataUri}";
`;
writeFileSync(OUT, module);
console.log(
  `wrote ${OUT} (lockup ${png.length} B, mark ${markPng.length} B, ${module.length} chars)`
);
