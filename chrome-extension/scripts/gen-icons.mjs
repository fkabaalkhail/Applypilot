/**
 * Generates the extension toolbar icons from the Tailrd logo
 * (frontend/public/logo-icon.png — the purple paper-plane-in-a-circle mark).
 * The source has a white background, so we key near-white pixels to transparent
 * first, then resize the clean purple line-art into assets/icon-{16,32,48,128}.png.
 *
 * Run: npm run icons
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const LOGO = path.join(here, "..", "..", "frontend", "public", "logo-icon.png");
const outDir = path.join(here, "..", "assets");
mkdirSync(outDir, { recursive: true });
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

// 1) Key out the near-white background → transparent (keep the purple line-art).
const { data, info } = await sharp(LOGO).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const keyed = Buffer.from(data);
for (let i = 0; i < keyed.length; i += info.channels) {
  const r = keyed[i], g = keyed[i + 1], b = keyed[i + 2];
  if (Math.min(r, g, b) > 235) keyed[i + 3] = 0; // near-white → transparent
}
const base = await sharp(keyed, { raw: { width: info.width, height: info.height, channels: info.channels } })
  .png()
  .toBuffer();

// 2) Trim the now-transparent margin and resize into each icon size with padding.
for (const size of [16, 32, 48, 128]) {
  const pad = Math.max(1, Math.round(size * 0.06));
  const inner = size - pad * 2;
  const buf = await sharp(base)
    .trim()
    .resize(inner, inner, { fit: "contain", background: transparent })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: transparent })
    .png()
    .toBuffer();
  await sharp(buf).toFile(path.join(outDir, `icon-${size}.png`));
  console.log(`wrote assets/icon-${size}.png`);
}
