/**
 * Regenerate src/content/brandLogo.ts from the source logo.
 *
 * The panel header shows the real Tailrd "wing" mark. Because the panel is a
 * content script injected into third-party pages (whose img-src CSP can block
 * data-URI images), the mark is embedded as a compact data URI and the header
 * degrades to the wordmark on strict-CSP sites. Run this if logos/Tailrd.jpg
 * changes:  node scripts/gen-brand-logo.mjs
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(root, "docs", "Logo.jpeg");
const OUT = path.join(root, "chrome-extension", "src", "content", "brandLogo.ts");

// The full horizontal logo lockup (paper-plane ring mark + "Tailrd" wordmark),
// hand-cropped tight from the 1024×1024 source (auto-trim collapses on the
// mostly-white art).
const CROP = { left: 125, top: 378, width: 772, height: 250 };

const png = await sharp(SRC)
  .extract(CROP)
  .flatten({ background: "#ffffff" }) // header bg is white
  .resize({ height: 56 }) // ~2x the ~28px display height
  .png({ compressionLevel: 9, palette: true, quality: 85 })
  .toBuffer();

const dataUri = "data:image/png;base64," + png.toString("base64");
const module = `// AUTO-GENERATED brand asset — do not hand-edit. Regenerate with
// scripts/gen-brand-logo.mjs. The real Tailrd logo lockup (paper-plane ring +
// "Tailrd" wordmark, from docs/Logo.jpeg) embedded as a data URI; the panel is a
// content script, so on strict-img-src CSP sites the <img> is blocked and the
// header falls back to a plain "Tailrd" text wordmark.
export const BRAND_LOGO_DATA_URI =
  "${dataUri}";
`;
writeFileSync(OUT, module);
console.log(`wrote ${OUT} (${png.length} B png, ${module.length} chars)`);
