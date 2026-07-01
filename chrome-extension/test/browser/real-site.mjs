/**
 * REAL-SITE test: load the packaged extension into Chromium, open a genuine,
 * public ATS application form (Greenhouse / Lever — no login required), drive the
 * extension's real overlay (open panel → sample-data profile → Autofill), and
 * read back every field from the live DOM. Captures the page console and
 * before/after screenshots so the result is independently verifiable.
 *
 * Usage: node test/browser/real-site.mjs "<url>"
 *   default: a live Anthropic Greenhouse application form.
 *
 * NOTE: This fills but never submits. It uses clearly-fake SAMPLE data
 * (John Doe / john@example.com), not anyone's real application.
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

const URL = process.argv[2] || "https://job-boards.greenhouse.io/anthropic/jobs/4036944008";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tailrd-real-"));
  const base = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"];
  for (const args of [[...base, "--headless=new"], base]) {
    try {
      return await chromium.launchPersistentContext(userDataDir, { headless: false, args, viewport: { width: 1280, height: 900 } });
    } catch (e) {
      console.log("launch retry:", e.message.split("\n")[0]);
    }
  }
  throw new Error("could not launch Chromium with the extension");
}

async function main() {
  console.log(`\n=== REAL ATS SITE TEST ===\nURL: ${URL}\nExtension: ${EXT}\n`);
  const ctx = await launch();

  // Seed sample-data mode so the extension resolves a profile without an account.
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  if (sw) {
    await sw.evaluate(() =>
      chrome.storage.local.set({ ap_config: { useMockData: true, fillEEO: false } })
    );
    console.log("seeded ap_config.useMockData = true via service worker ✅");
  } else {
    console.log("⚠ no service worker handle — will fall back to clicking 'Try with sample data'");
  }

  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("Tailrd") || t.includes("[Tailrd")) logs.push(t);
  });
  page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));

  console.log("navigating…");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("goto warn:", e.message.split("\n")[0]));
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Dismiss a cookie banner if present (best effort).
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Accept all")', '#onetrust-accept-btn-handler']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }

  const overlay = await page.waitForSelector("#applypilot-overlay-host", { timeout: 15000 }).then(() => true).catch(() => false);
  console.log(`overlay mounted: ${overlay ? "✅" : "❌"}`);

  // Snapshot the application form BEFORE.
  await page.screenshot({ path: path.join(SHOTS, "before.png"), fullPage: true }).catch(() => {});

  // Open the panel (edge tab), then ensure a profile is resolved.
  const root = page.locator("#applypilot-overlay-host >> .ap-root");
  await page.locator("#applypilot-overlay-host >> .ap-edge-tab").click({ timeout: 8000 }).catch((e) => console.log("edge-tab click warn:", e.message.split("\n")[0]));
  await sleep(1200);

  // If a login/connect view is showing, fall back to the sample-data button.
  const mockBtn = page.locator('#applypilot-overlay-host >> #ap-btn-use-mock');
  if (await mockBtn.isVisible().catch(() => false)) {
    console.log("clicking 'Try with sample data'…");
    await mockBtn.click().catch(() => {});
    await sleep(1500);
  }

  // Wait for the Autofill button to enable (fields detected + profile resolved).
  const autofill = page.locator('#applypilot-overlay-host >> #ap-btn-autofill');
  let enabled = false;
  for (let i = 0; i < 20; i++) {
    enabled = await autofill.isEnabled().catch(() => false);
    const count = await page.locator('#applypilot-overlay-host >> #ap-field-count').textContent().catch(() => "");
    if (enabled) { console.log(`Autofill enabled (field count: "${(count || "").trim()}")`); break; }
    await sleep(500);
  }
  if (!enabled) console.log("⚠ Autofill button never enabled — capturing state anyway.");

  if (enabled) {
    await autofill.click().catch((e) => console.log("autofill click warn:", e.message.split("\n")[0]));
    // Let the reconciler + combobox engine settle.
    await sleep(4000);
  }

  await page.screenshot({ path: path.join(SHOTS, "after.png"), fullPage: true }).catch(() => {});

  // Read back the real application form fields.
  const fields = await page.evaluate(() => {
    const out = [];
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.textContent.trim();
      }
      const al = el.getAttribute("aria-label");
      if (al) return al.trim();
      const wrapLabel = el.closest("label");
      if (wrapLabel) return wrapLabel.textContent.trim();
      return el.name || el.id || el.tagName.toLowerCase();
    };
    const isAppField = (el) => {
      // skip the extension's own overlay + obviously irrelevant controls
      if (el.closest("#applypilot-overlay-host")) return false;
      const t = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "search"].includes(t)) return false;
      return true;
    };
    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (!isAppField(el)) continue;
      const type = (el.type || el.tagName).toLowerCase();
      let value = "";
      if (el.tagName === "SELECT") value = el.options[el.selectedIndex]?.text ?? el.value;
      else value = el.value ?? "";
      out.push({ label: labelFor(el).slice(0, 40), type, value: String(value).slice(0, 60) });
    }
    return out;
  });

  await ctx.close();

  // Report.
  console.log(`\n--- Application form fields after autofill (${fields.length} controls) ---`);
  const filled = fields.filter((f) => f.value && f.type !== "file");
  for (const f of fields) {
    const mark = f.value && f.type !== "file" ? "✓ FILLED" : (f.type === "file" ? "  (file)" : "  empty ");
    console.log(`  ${mark}  ${f.label.padEnd(40)} [${f.type}] ${f.value ? `= "${f.value}"` : ""}`);
  }
  console.log(`\nFilled ${filled.length} of ${fields.length} non-file controls.`);

  console.log(`\n--- Extension console output (live page) ---`);
  if (logs.length === 0) console.log("  (no [Tailrd] console lines captured)");
  for (const l of logs.slice(0, 40)) console.log("  " + l);

  console.log(`\nScreenshots: ${path.join(SHOTS, "before.png")} , after.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
