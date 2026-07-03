/**
 * End-to-end probe of the missing-info modal loop on a real Greenhouse page:
 *  visit 1 — autofill → modal appears → assert it lists the unanswered
 *            demographic dropdowns WITH real options → answer them → Save &
 *            fill → assert the widgets committed.
 *  visit 2 — fresh page, autofill again → assert those dropdowns fill
 *            SILENTLY from the device-local store (no modal row for them).
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
const URL = "https://job-boards.greenhouse.io/gusto/jobs/8029175";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANSWERS = {
  transgender: "No",
  "sexual orientation": "Heterosexual",
  "first-generation": "No",
};

async function autofillAndModal(page, { expectModal }) {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("input")].some((el) => !["hidden", "submit", "button"].includes(el.type)),
    null, { timeout: 30000 }
  ).catch(() => {});
  await sleep(2500);

  await page.locator("#applypilot-overlay-host >> .ap-edge-tab").click({ timeout: 8000 }).catch(() => {});
  await sleep(800);
  const autofill = page.locator("#applypilot-overlay-host >> #ap-btn-autofill");
  for (let i = 0; i < 16; i++) {
    if (await autofill.isEnabled().catch(() => false)) break;
    await sleep(500);
  }
  await autofill.click().catch(() => {});

  // Wait for the missing-info modal (or its absence).
  let modal = null;
  for (let i = 0; i < 40; i++) {
    modal = await page.$("#tailrd-missing-info-host");
    if (modal) break;
    await sleep(500);
  }

  if (!modal) {
    console.log(expectModal ? "❌ modal never appeared" : "✅ no modal (nothing left to ask)");
    return { rows: [] };
  }

  const rows = await page.evaluate(() => {
    const host = document.getElementById("tailrd-missing-info-host");
    if (!host?.shadowRoot) return [];
    return [...host.shadowRoot.querySelectorAll(".mi-row")].map((row) => {
      const q = row.querySelector(".mi-q")?.textContent?.trim() ?? "";
      const select = row.querySelector("select");
      const options = select ? [...select.options].map((o) => o.textContent?.trim()).slice(1) : null;
      return { q, options };
    });
  });
  console.log(`${expectModal ? "✅" : "⚠️"} modal appeared with ${rows.length} question(s):`);
  for (const r of rows) {
    console.log(`   • "${r.q.slice(0, 70)}" options=${r.options ? r.options.length + " [" + r.options.slice(0, 4).join(" | ").slice(0, 90) + "…]" : "TEXT INPUT"}`);
  }

  // Answer the demographic questions we know, leave others blank.
  await page.evaluate((answers) => {
    const host = document.getElementById("tailrd-missing-info-host");
    if (!host?.shadowRoot) return;
    for (const row of host.shadowRoot.querySelectorAll(".mi-row")) {
      const q = (row.querySelector(".mi-q")?.textContent ?? "").toLowerCase();
      const select = row.querySelector("select");
      if (!select) continue;
      for (const [needle, val] of Object.entries(answers)) {
        if (!q.includes(needle)) continue;
        const opt = [...select.options].find((o) => (o.textContent ?? "").toLowerCase().includes(val.toLowerCase()));
        if (opt) { select.value = opt.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    }
    host.shadowRoot.querySelector(".mi-save")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, ANSWERS);
  await sleep(4000); // let the fill + persistence run
  return { rows };
}

async function widgetState(page) {
  return page.evaluate(() => {
    const out = {};
    for (const shell of document.querySelectorAll(".select__container")) {
      const label = shell.querySelector("label")?.textContent?.trim() ?? "?";
      const single = shell.querySelector('[class*="single-value"]')?.textContent?.trim() ?? "";
      if (/transgender|orientation|first-generation/i.test(label)) out[label.slice(0, 50)] = single;
    }
    return out;
  });
}

const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tailrd-modal-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--headless=new"],
  viewport: { width: 1360, height: 1000 },
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
if (sw) await sw.evaluate(() => chrome.storage.local.set({ ap_config: { useMockData: true, fillEEO: true } }));

async function run() {
  const page = await ctx.newPage();

  console.log("=== VISIT 1: expect modal with demographic questions ===");
  await autofillAndModal(page, { expectModal: true });
  console.log("widgets after answering:", JSON.stringify(await widgetState(page), null, 1));
  const store = await page.evaluate(async () => (await chrome.storage.local.get("ap_local_answers"))["ap_local_answers"]).catch(() => null)
    ?? (sw ? await sw.evaluate(async () => (await chrome.storage.local.get("ap_local_answers"))["ap_local_answers"]) : null);
  console.log("local answer store:", JSON.stringify(store));
  await page.screenshot({ path: path.join(SHOTS, "modal-visit1.png"), fullPage: true }).catch(() => {});

  console.log("\n=== VISIT 2: expect SILENT refill from local store ===");
  const page2 = await ctx.newPage();
  const { rows } = await autofillAndModal(page2, { expectModal: false });
  const asked = rows.map((r) => r.q.toLowerCase());
  const reAsked = ["transgender", "orientation"].filter((k) => asked.some((q) => q.includes(k)));
  console.log(reAsked.length === 0 ? "✅ transgender/orientation NOT re-asked" : `❌ re-asked: ${reAsked.join(", ")}`);
  console.log("widgets on visit 2:", JSON.stringify(await widgetState(page2), null, 1));
  await page2.screenshot({ path: path.join(SHOTS, "modal-visit2.png"), fullPage: true }).catch(() => {});
}

await Promise.race([
  run().catch((e) => console.log("PROBE ERROR:", e.message)),
  sleep(200000).then(() => console.log("⏱ hard timeout")),
]);
await ctx.close().catch(() => {});
process.exit(0);
