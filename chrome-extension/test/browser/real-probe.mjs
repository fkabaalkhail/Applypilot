/**
 * Robust real-ATS probe (hang-proof). Loads the packaged extension, opens a real
 * public Greenhouse/Lever application form, and reports — with a hard overall
 * timeout — exactly what happens: how many form fields the PAGE actually has,
 * whether the extension detected them (overlay mount + [Tailrd scan] diagnostics),
 * and, if so, the result of driving Autofill. Viewport screenshots only.
 *
 * Usage: node test/browser/real-probe.mjs "<url>"
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "..", "dist");
const SHOTS = path.join(here, "artifacts");
mkdirSync(SHOTS, { recursive: true });
const URL = process.argv[2] || "https://boards.greenhouse.io/embed/job_app?for=databricks&token=9740521002";
const TAG = (process.argv[3] || "site").replace(/[^a-z0-9]/gi, "_");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`\n=== REAL ATS PROBE: ${TAG} ===\nURL: ${URL}\n`);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tailrd-probe-"));
  const base = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--headless=new"];
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, args: base, viewport: { width: 1280, height: 900 } });

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  if (sw) { await sw.evaluate(() => chrome.storage.local.set({ ap_config: { useMockData: true, fillEEO: false } })); console.log("seeded useMockData ✅, ext SW loaded ✅"); }

  const page = await ctx.newPage();
  const scanLines = [];
  page.on("console", async (m) => {
    const t = m.text();
    if (!/Tailrd/.test(t)) return;
    let detail = "";
    try {
      const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => undefined)));
      const obj = args.find((a) => a && typeof a === "object");
      if (obj) detail = " " + JSON.stringify(obj);
    } catch {}
    scanLines.push(t + detail);
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 40000 }).catch((e) => console.log("goto warn:", e.message.split("\n")[0]));
  // Wait for the application form to hydrate (an input that isn't the extension's).
  await page.waitForFunction(() => {
    return [...document.querySelectorAll("input,select,textarea")].some(
      (el) => !el.closest("#applypilot-overlay-host") && !["hidden", "submit", "button"].includes((el.type || "").toLowerCase())
    );
  }, null, { timeout: 25000 }).catch(() => console.log("(no real form field appeared within 25s)"));
  await sleep(2500); // let the content script scan + overlay settle

  const pageFields = await page.evaluate(() => {
    const fields = [...document.querySelectorAll("input,select,textarea")]
      .filter((el) => !el.closest("#applypilot-overlay-host"))
      .filter((el) => !["hidden", "submit", "button"].includes((el.type || "").toLowerCase()))
      .map((el) => {
        const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        return { label: (lab?.textContent || el.getAttribute("aria-label") || el.name || el.id || el.tagName).trim().slice(0, 38), type: (el.type || el.tagName).toLowerCase() };
      });
    return fields;
  });
  const overlay = await page.$("#applypilot-overlay-host");
  console.log(`PAGE has ${pageFields.length} fillable form controls; overlay mounted: ${overlay ? "✅" : "❌"}`);
  for (const f of pageFields.slice(0, 16)) console.log(`   • ${f.label.padEnd(38)} [${f.type}]`);

  let autofillResult = "not attempted";
  if (overlay) {
    await page.locator("#applypilot-overlay-host >> .ap-edge-tab").click({ timeout: 6000 }).catch(() => {});
    await sleep(1000);
    const mockBtn = page.locator("#applypilot-overlay-host >> #ap-btn-use-mock");
    if (await mockBtn.isVisible().catch(() => false)) { await mockBtn.click().catch(() => {}); await sleep(1500); }
    const autofill = page.locator("#applypilot-overlay-host >> #ap-btn-autofill");
    let enabled = false;
    for (let i = 0; i < 16 && !enabled; i++) { enabled = await autofill.isEnabled().catch(() => false); if (!enabled) await sleep(500); }
    if (enabled) {
      await autofill.click().catch(() => {});
      await sleep(4000);
      const vals = await page.evaluate(() =>
        [...document.querySelectorAll("input,select,textarea")]
          .filter((el) => !el.closest("#applypilot-overlay-host"))
          .filter((el) => !["hidden", "submit", "button", "file"].includes((el.type || "").toLowerCase()))
          .map((el) => ({ k: (el.getAttribute("aria-label") || el.name || el.id || "").slice(0, 30), v: (el.tagName === "SELECT" ? el.options[el.selectedIndex]?.text : el.value) || "" }))
          .filter((x) => x.v)
      );
      autofillResult = `filled ${vals.length} controls: ` + vals.map((x) => `${x.k}="${x.v}"`).join(", ");
    } else {
      autofillResult = "Autofill button never enabled";
    }
  }
  console.log(`AUTOFILL: ${autofillResult}`);

  await page.screenshot({ path: path.join(SHOTS, `${TAG}.png`) }).catch(() => {});
  console.log(`\n[Tailrd] console (${scanLines.length} lines):`);
  for (const l of scanLines.slice(0, 25)) console.log("  " + l);
  console.log(`screenshot: ${path.join(SHOTS, TAG + ".png")}`);

  await ctx.close().catch(() => {});
}

// Hard overall timeout so the probe can never hang the session.
await Promise.race([
  run(),
  sleep(120000).then(() => { console.log("\n⏱ probe hard-timeout (120s) — exiting"); process.exit(0); }),
]);
process.exit(0);
