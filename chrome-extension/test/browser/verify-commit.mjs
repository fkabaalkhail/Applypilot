/**
 * Post-fill commit verification: run the live harness fill on the real page,
 * wait for renders to settle, then read every react-select widget's committed
 * display (single-value / multi-value / placeholder) straight from the DOM.
 */
import * as esbuild from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || "https://job-boards.greenhouse.io/gusto/jobs/8029175";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await esbuild.build({
  entryPoints: [path.join(here, "entry-live.ts")],
  outfile: path.join(here, "dist", "harness-live.js"),
  bundle: true,
  format: "iife",
  target: ["chrome110"],
  logLevel: "silent",
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForFunction(
  () => [...document.querySelectorAll("input")].some((el) => !["hidden", "submit", "button"].includes(el.type)),
  null, { timeout: 30000 }
).catch(() => {});
await sleep(2500);
await page.addScriptTag({ path: path.join(here, "dist", "harness-live.js") });

await page.evaluate(() => window.__LIVE.scan(window.__LIVE.profile, true));
await page.evaluate(() => window.__LIVE.fill());
await sleep(2000); // let react re-render everything

const state = await page.evaluate(() => {
  const out = [];
  for (const shell of document.querySelectorAll(".select__container")) {
    const label = shell.querySelector("label")?.textContent?.trim() ?? "?";
    const single = shell.querySelector('[class*="single-value"]')?.textContent?.trim() ?? "";
    const multi = [...shell.querySelectorAll('[class*="multi-value"]')].map((m) => m.textContent?.trim()).join(",");
    const placeholder = shell.querySelector('[class*="placeholder"]')?.textContent?.trim() ?? "";
    const input = shell.querySelector("input[role=combobox]");
    out.push({ label: label.slice(0, 50), single, multi, placeholder, inputValue: input?.value ?? "" });
  }
  return out;
});
console.log("WIDGET STATE AFTER FILL + 2s:");
for (const w of state) {
  const val = w.single || w.multi;
  console.log(`${val ? "✅" : "▪️"} "${w.label}" single=${JSON.stringify(w.single)} multi=${JSON.stringify(w.multi)} ph=${JSON.stringify(w.placeholder)} input=${JSON.stringify(w.inputValue)}`);
}
await page.screenshot({ path: path.join(here, "artifacts", "verify-commit.png"), fullPage: true }).catch(() => {});
console.log("screenshot: test/browser/artifacts/verify-commit.png");
await browser.close();
process.exit(0);
