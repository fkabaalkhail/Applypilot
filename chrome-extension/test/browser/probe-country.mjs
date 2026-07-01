/**
 * Verifies (or refutes) the audit claim: the Workday Country dropdown only fills
 * when the applicant's location string literally contains the country option's
 * name, so a US/other applicant would silently fail to get a country selected.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "dist", "harness.js");
const BLANK = "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";

const LOCATIONS = [
  "Ottawa, ON, Canada",        // baseline — contains "Canada"
  "San Francisco, CA, USA",    // option is "United States" — no token overlap with "USA"
  "Austin, Texas, United States", // contains "United States"
  "London, United Kingdom",    // contains "United Kingdom"
  "Berlin, Germany",           // no matching option at all
  "Mexico City, Mexico",       // contains "Mexico"
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(BLANK);
await page.addScriptTag({ path: HARNESS });

console.log("Workday Country dropdown — options: [United States, Canada, Mexico, United Kingdom]\n");
console.log("location".padEnd(30), "country filled?".padEnd(18), "city got");
console.log("-".repeat(90));
for (const loc of LOCATIONS) {
  // Fresh page per probe so prior fills don't bleed across.
  await page.setContent(BLANK);
  await page.addScriptTag({ path: HARNESS });
  const r = await page.evaluate((l) => window.__T.probeCountry("workday", l), loc);
  const filled = r.countryActual && r.countryActual !== "Select One" ? `✅ "${r.countryActual}"` : `❌ "${r.countryActual}"`;
  console.log(loc.padEnd(30), filled.padEnd(18), `"${r.cityActual}"`);
}
await browser.close();
