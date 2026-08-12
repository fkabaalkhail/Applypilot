/**
 * Visual preview of the redesigned side panel. Bundles the real overlay STYLES +
 * buildHTML, renders them in a Shadow DOM in real Chromium, populates the job
 * card / résumé name / primary button, and screenshots the panel, so the
 * redesign can be eyeballed without loading the whole extension + chrome APIs.
 *
 * Also captures the "Autofilling" state: the block mid-slide, then settled at
 * two points of the wave cycle. jsdom cannot run CSS animations, so this is
 * the only place the waves are shown to really move, and the frame-hash check
 * below fails loudly if they ever stop.
 *
 * Usage: node test/browser/panel-preview.mjs
 */
import { chromium } from "playwright";
import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "artifacts");
mkdirSync(outDir, { recursive: true });

// Bundle just STYLES + buildHTML from the real overlay module.
const built = await esbuild.build({
  stdin: {
    contents: `import { STYLES, buildHTML } from "../../src/content/overlay";
      window.__PANEL = { STYLES, buildHTML };`,
    resolveDir: here,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});
const js = built.outputFiles[0].text;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 920 }, deviceScaleFactor: 2 });
await page.setContent(
  "<!doctype html><html><head><meta charset=utf-8></head><body style='margin:0;background:#eef1f5'></body></html>"
);
// Minimal chrome stub so any incidental module reference doesn't throw on load.
await page.addScriptTag({
  content:
    "window.chrome=window.chrome||{runtime:{getURL:x=>x,sendMessage(){},onMessage:{addListener(){}}},storage:{local:{get(){},set(){}}}};",
});
await page.addScriptTag({ content: js });

await page.evaluate(() => {
  const { STYLES, buildHTML } = window.__PANEL;
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  shadow.appendChild(style);
  const root = document.createElement("div");
  root.className = "ap-root";
  root.innerHTML = buildHTML();
  shadow.appendChild(root);
  document.body.appendChild(host);
  window.__shadow = shadow;

  const q = (s) => shadow.querySelector(s);
  const login = q("#ap-login-view"); if (login) login.style.display = "none";
  const btn = q("#ap-btn-autofill"); if (btn) btn.disabled = false;
  const jc = q("#ap-jobcard"); if (jc) jc.style.display = "flex";
  q("#ap-jobcard-company").textContent = "Salesforce";
  const title = q("#ap-jobcard-title");
  title.textContent = "Corporate Counsel, Global Trade";
  title.style.display = "block";
  const logo = q("#ap-jobcard-logo");
  logo.classList.add("is-mono");
  logo.style.background = "#0ea5e9";
  logo.textContent = "S";
  q("#ap-resume-name").textContent = "Wissam_Elmasry_CV";
  for (const id of ["#ap-btn-upload-resume", "#ap-btn-tailor", "#ap-btn-cover"]) {
    const b = q(id); if (b) b.disabled = false;
  }
});

const handle = await page.evaluateHandle(() => window.__shadow.querySelector(".ap-panel"));
const el = handle.asElement();

// STYLES @imports Inter from Google Fonts. Shooting before it lands gives a
// fallback-font baseline that no later frame can match, which reads as a
// layout regression in the idle-vs-closed check below.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(250);

async function shot(name) {
  const out = path.join(outDir, `${name}.png`);
  const buf = await el.screenshot({ path: out });
  console.log("wrote", out);
  return createHash("sha1").update(buf).digest("hex");
}

const idle = await shot("panel-redesign");

// ---- "Autofilling": raise the waves and prove they move -------------------
await page.evaluate(() => {
  window.__shadow.querySelector("#ap-fillwave").classList.add("is-active");
});
await page.waitForTimeout(120); // mid-slide, the block is still growing
await shot("panel-autofilling-sliding");

await page.waitForTimeout(400); // slide done (0.32s), waves settled in place
const frames = [];
for (const i of [0, 1, 2]) {
  if (i) await page.waitForTimeout(900);
  frames.push(await shot(`panel-autofilling-t${i}`));
}

const running = await page.evaluate(() =>
  [...window.__shadow.querySelectorAll(".ap-wave-layer, .ap-wave-layer svg")]
    .flatMap((n) => n.getAnimations().map((a) => a.animationName ?? a.constructor.name))
);
console.log("wave animations running:", running.join(", ") || "(none)");

// ---- Slide shut, back to the idle layout ---------------------------------
await page.evaluate(() => {
  window.__shadow.querySelector("#ap-fillwave").classList.remove("is-active");
});
await page.waitForTimeout(500);
const settled = await shot("panel-autofilling-closed");

await browser.close();

// Fail loudly rather than quietly writing four identical PNGs: a typo in a
// keyframe name or a dropped animation shorthand would otherwise sail through
// as "the preview still renders".
const problems = [];
if (running.length !== 4) {
  problems.push(`expected 4 wave animations (2 bob + 2 drift), got ${running.length}: ${running}`);
}
if (new Set(frames).size !== frames.length) {
  problems.push("wave frames are identical, the waves are not moving");
}
if (settled !== idle) {
  problems.push("closing the waves did not restore the idle layout pixel-for-pixel");
}
if (problems.length) {
  console.error("PREVIEW CHECKS FAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("preview checks passed");
