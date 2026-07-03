/**
 * Forensic probe against a REAL ATS page. Injects the live harness (the exact
 * shipping scan/fill engine) into the page's MAIN world, then reports per field:
 * scanner verdict → fill route → committed value. No extension load; pure engine.
 *
 * Usage: node test/browser/live-probe.mjs "<url>" [labelFilterRegex]
 */
import * as esbuild from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || "https://job-boards.greenhouse.io/gusto/jobs/8029175";
const DOM_FILTER = process.argv[3] || "country|veteran|disab|city|location|gender|search|select";
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

async function run() {
  console.log(`URL: ${URL}\n`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("input,select,textarea")].some((el) => !["hidden", "submit", "button"].includes((el.type || "").toLowerCase())),
      null,
      { timeout: 30000 }
    )
    .catch(() => console.log("(no form field appeared in 30s)"));
  await sleep(2500);

  await page.addScriptTag({ path: path.join(here, "dist", "harness-live.js") });

  // ---- 1. SCAN ----
  const dump = await page.evaluate(() => window.__LIVE.scan(window.__LIVE.profile, true));
  console.log(`SCAN: ${dump.length} fields\n`);
  for (const f of dump) {
    const flag = f.proposed === null ? "  (no value)" : "";
    console.log(
      `• [${f.controlType}${f.driver ? "/" + f.driver : ""}] "${f.label.slice(0, 60)}" → ${f.category}@${f.confidence}` +
        ` req=${f.required ? "Y" : "n"} proposed=${JSON.stringify(f.proposed && f.proposed.slice(0, 40))}${flag}`
    );
    if (f.options) console.log(`    options(${f.options.length}): ${f.options.slice(0, 6).join(" | ").slice(0, 150)}`);
    if (f.signals) console.log(`    signals: ${JSON.stringify(f.signals).slice(0, 220)}`);
  }

  // ---- 2. DOM dumps for the problem fields ----
  const doms = await page.evaluate((p) => window.__LIVE.domFor(p), DOM_FILTER);
  console.log(`\nDOM CONTAINERS (${doms.length} matching "${DOM_FILTER}"):`);
  for (const d of doms) {
    console.log(`\n===== ${d.label} =====`);
    console.log(d.html.replace(/></g, ">\n<").split("\n").slice(0, 40).join("\n"));
  }

  // ---- 3. FILL with the shipping routing ----
  const outcomes = await page.evaluate(() => window.__LIVE.fill());
  console.log(`\nFILL OUTCOMES (${outcomes.length}):`);
  for (const o of outcomes) {
    console.log(
      `${o.ok ? "✅" : "❌"} [${o.route}] "${o.label.slice(0, 55)}" actual=${JSON.stringify(o.actualAfter.slice(0, 45))}${o.reason ? ` reason: ${o.reason}` : ""}`
    );
  }

  await page.screenshot({ path: path.join(here, "artifacts", "live-probe.png"), fullPage: false }).catch(() => {});
}

await Promise.race([
  run().catch((e) => console.log("PROBE ERROR:", e.message)),
  sleep(150000).then(() => console.log("⏱ hard timeout")),
]);
await browser.close().catch(() => {});
process.exit(0);
