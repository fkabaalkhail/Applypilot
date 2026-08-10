/**
 * Reproduces the live "extension can't interact with buttons" failure: a click
 * on a control inside an open shadow root (Workday, and many ATS, render their
 * app in shadow DOM) must be `composed` to cross the shadow boundary and reach
 * a framework's document-level click listener. A non-composed click bubbles
 * only within the shadow tree, so the button's real handler never runs and the
 * page never advances ("page changed after advance = false").
 *
 * Bundles the REAL activateElement from source and drives it in real Chromium
 * (jsdom's shadow event composition is unreliable).
 *
 * Usage: node test/browser/click-shadow-probe.mjs
 */
import { chromium } from "playwright";
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const built = await esbuild.build({
  stdin: {
    contents: `import { activateElement } from "../../src/content/comboboxEngine";
      window.__activate = activateElement;`,
    resolveDir: here,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});
const js = built.outputFiles[0].text;

const results = [];
const check = (label, ok, extra = "") => {
  results.push(ok);
  console.log(`   ${ok ? "✅" : "❌"} ${label}${extra ? `: ${extra}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body><div id='host'></div></body></html>");
await page.addScriptTag({ content: js });

const res = await page.evaluate(() => {
  const host = document.getElementById("host");
  const sr = host.attachShadow({ mode: "open" });
  sr.innerHTML = '<button id="btn">Create Account</button>';
  let docSaw = false;
  let btnSaw = false;
  // The framework's real listener is delegated at the document (React-style).
  document.addEventListener("click", () => { docSaw = true; });
  const btn = sr.querySelector("#btn");
  btn.addEventListener("click", () => { btnSaw = true; });
  window.__activate(btn);
  return { docSaw, btnSaw };
});

check("click fires the button's own handler", res.btnSaw);
check("click crosses the shadow boundary to a document listener (composed)", res.docSaw);

await browser.close();
const ok = results.every(Boolean);
console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  Shadow-DOM click delivery (composed events reach framework listeners).`);
process.exit(ok ? 0 : 1);
