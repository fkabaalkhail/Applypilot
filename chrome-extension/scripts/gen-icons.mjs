/**
 * Generates the extension icons (lavender rounded square + white checkmark)
 * as PNGs without any image dependencies — raw PNG chunks + zlib.
 *
 * Run: npm run icons   (writes assets/icon-{16,32,48,128}.png)
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---- minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // filter byte 0 at the start of each scanline
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing ----------------------------------------------------------------

const ACCENT = [124, 108, 255]; // #7C6CFF — ApplyPilot lavender

function insideRoundedSquare(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onCheckmark(x, y, thickness) {
  // checkmark: (0.28,0.53) → (0.45,0.70) → (0.74,0.36)
  return (
    distToSegment(x, y, 0.28, 0.53, 0.45, 0.7) <= thickness ||
    distToSegment(x, y, 0.45, 0.7, 0.74, 0.36) <= thickness
  );
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // 3x3 supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (insideRoundedSquare(px, py, 0.2)) {
            bgHits++;
            if (onCheckmark(px, py, 0.075)) fgHits++;
          }
        }
      }
      const total = SS * SS;
      const alpha = Math.round((bgHits / total) * 255);
      const fg = fgHits / Math.max(bgHits, 1);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(ACCENT[0] + (255 - ACCENT[0]) * fg);
      rgba[i + 1] = Math.round(ACCENT[1] + (255 - ACCENT[1]) * fg);
      rgba[i + 2] = Math.round(ACCENT[2] + (255 - ACCENT[2]) * fg);
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

const outDir = path.join(import.meta.dirname, "..", "assets");
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
