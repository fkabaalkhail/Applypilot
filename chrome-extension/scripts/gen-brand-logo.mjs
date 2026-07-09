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
const SRC = path.join(root, "logos", "Tailrd.jpg");
const OUT = path.join(root, "chrome-extension", "src", "content", "brandLogo.ts");

// Tight crop of the standalone gradient wing (top row of the source sheet).
const CROP = { left: 583, top: 36, width: 372, height: 236 };

const png = await sharp(SRC)
  .extract(CROP)
  .flatten({ background: "#ffffff" }) // header bg is white
  .resize({ height: 60 }) // 2x the ~30px display size
  .png({ compressionLevel: 9, palette: true, quality: 82 })
  .toBuffer();

const dataUri = "data:image/png;base64," + png.toString("base64");
const module = `// AUTO-GENERATED brand asset — do not hand-edit. Regenerate with
// scripts/gen-brand-logo.mjs. The real Tailrd wing mark (from logos/Tailrd.jpg)
// embedded as a data URI; the panel is a content script, so on strict-img-src
// CSP sites the <img> is blocked and the header falls back to the wordmark.
export const BRAND_LOGO_DATA_URI =
  "${dataUri}";
`;
writeFileSync(OUT, module);
console.log(`wrote ${OUT} (${png.length} B png, ${module.length} chars)`);
