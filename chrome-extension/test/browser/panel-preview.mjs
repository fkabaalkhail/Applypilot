/**
 * Visual preview of the redesigned side panel. Bundles the real overlay STYLES +
 * buildHTML, renders them in a Shadow DOM in real Chromium, populates the job
 * card / résumé name / primary button, and screenshots the panel, so the
 * redesign can be eyeballed without loading the whole extension + chrome APIs.
 *
 * Usage: node test/browser/panel-preview.mjs
 */
import { chromium } from "playwright";
import esbuild from "esbuild";
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
const out = path.join(outDir, "panel-redesign.png");
await el.screenshot({ path: out });
console.log("wrote", out);
await browser.close();
