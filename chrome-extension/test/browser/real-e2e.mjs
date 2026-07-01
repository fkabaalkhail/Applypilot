/**
 * Real-ATS END-TO-END probe (fill → review → locate Submit; never clicks Submit).
 *
 * Loads the packaged extension on a live public application form, drives the real
 * overlay Autofill, then reports the full "ready to submit?" picture:
 *   - the extension's own completion banner ("Filled X of Y (N need attention)")
 *   - which still-EMPTY / required fields remain (the "missing field" indication)
 *   - that the Submit button exists and is reachable (located, NOT clicked)
 * Viewport screenshot. Hard 120s timeout.
 *
 * Usage: node test/browser/real-e2e.mjs "<apply url>" <tag>
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
const URL = process.argv[2] || "https://jobs.lever.co/mistral/7894fd8a-ffc9-4c89-87f0-f8a7b695cf01/apply";
const TAG = (process.argv[3] || "e2e").replace(/[^a-z0-9]/gi, "_");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`\n=== REAL ATS END-TO-END: ${TAG} ===\nURL: ${URL}\n`);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tailrd-e2e-"));
  const args = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--headless=new"];
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, args, viewport: { width: 1280, height: 1000 } });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  if (sw) await sw.evaluate(() => chrome.storage.local.set({ ap_config: { useMockData: true, fillEEO: false } }));

  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input,textarea")].some((el) => !el.closest("#applypilot-overlay-host") && !["hidden","submit","button"].includes((el.type||"").toLowerCase())),
    null, { timeout: 25000 }).catch(() => {});
  await sleep(2500);

  const overlay = await page.$("#applypilot-overlay-host");
  if (!overlay) { console.log("overlay did not mount (no form detected) — stopping."); await ctx.close(); return; }

  // Drive the real overlay: open → (sample data if needed) → Autofill.
  await page.locator("#applypilot-overlay-host >> .ap-edge-tab").click({ timeout: 6000 }).catch(() => {});
  await sleep(900);
  const mockBtn = page.locator("#applypilot-overlay-host >> #ap-btn-use-mock");
  if (await mockBtn.isVisible().catch(() => false)) { await mockBtn.click().catch(() => {}); await sleep(1500); }
  const autofill = page.locator("#applypilot-overlay-host >> #ap-btn-autofill");
  let enabled = false;
  for (let i = 0; i < 16 && !enabled; i++) { enabled = await autofill.isEnabled().catch(() => false); if (!enabled) await sleep(500); }
  if (enabled) { await autofill.click().catch(() => {}); await sleep(4500); }

  // 1) The extension's own completion indicator.
  const banner = (await page.locator("#applypilot-overlay-host >> #ap-banner").textContent().catch(() => ""))?.trim() || "(none)";

  // 2) Required/visible fields still EMPTY after autofill = the "missing field" indication.
  const analysis = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const labelOf = (el) => {
      const l = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      return (l?.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.id || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
    };
    const ctrls = [...document.querySelectorAll("input,select,textarea")]
      .filter((el) => !el.closest("#applypilot-overlay-host"))
      .filter((el) => !["hidden", "submit", "button", "file"].includes((el.type || "").toLowerCase()))
      .filter(vis);
    const filled = [], empty = [], requiredEmpty = [];
    for (const el of ctrls) {
      const v = el.tagName === "SELECT" ? (el.value && el.options[el.selectedIndex]?.text) : el.value;
      const req = el.required || el.getAttribute("aria-required") === "true" ||
        (el.id && /\*/.test(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || ""));
      const item = { label: labelOf(el), required: !!req };
      if (v) filled.push(item); else { empty.push(item); if (req) requiredEmpty.push(item); }
    }
    // Locate a Submit/Apply button (do NOT click).
    const btns = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
      .filter((el) => !el.closest("#applypilot-overlay-host")).filter(vis);
    const submit = btns.find((b) => /submit|apply|send application/i.test((b.textContent || b.value || "").trim()));
    return {
      filled: filled.map((f) => f.label),
      empty: empty.map((f) => f.label),
      requiredEmpty: requiredEmpty.map((f) => f.label),
      submit: submit ? (submit.textContent || submit.value || "").trim().slice(0, 40) : null,
    };
  });

  // Highlight the missing required fields + the submit button in the screenshot (visual only).
  await page.evaluate(() => {
    const mark = (el, color) => { el.style.outline = `3px solid ${color}`; el.style.outlineOffset = "2px"; };
    for (const el of document.querySelectorAll("input,select,textarea")) {
      if (el.closest("#applypilot-overlay-host")) continue;
      const v = el.tagName === "SELECT" ? el.value : el.value;
      const req = el.required || el.getAttribute("aria-required") === "true";
      if (!v && req) mark(el, "#e11d48"); // missing required → red
      else if (v) mark(el, "#16a34a");    // filled → green
    }
  }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, `${TAG}.png`) }).catch(() => {});

  console.log(`Extension banner: "${banner}"`);
  console.log(`\nFilled (${analysis.filled.length}): ${analysis.filled.join(", ")}`);
  console.log(`Still empty (${analysis.empty.length}): ${analysis.empty.join(", ") || "—"}`);
  console.log(`>> MISSING required field(s): ${analysis.requiredEmpty.join(", ") || "none 🎉"}`);
  console.log(`Submit button present: ${analysis.submit ? `YES → "${analysis.submit}" (NOT clicked)` : "not found"}`);
  console.log(`\nscreenshot (green=filled, red=missing-required): ${path.join(SHOTS, TAG + ".png")}`);
  await ctx.close().catch(() => {});
}

await Promise.race([run(), sleep(120000).then(() => { console.log("\n⏱ hard timeout"); process.exit(0); })]);
process.exit(0);
