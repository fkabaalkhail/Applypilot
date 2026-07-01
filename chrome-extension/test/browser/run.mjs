/**
 * Real-Chromium autofill harness runner.
 *
 * Loads the bundled engine harness into a genuine Chromium page (and, for the
 * iframe case, into a real same-origin child frame) and drives the EXACT shipping
 * autofill engine against faithful per-ATS fixtures. Asserts, per field, that the
 * value actually committed in the live DOM — including custom dropdowns, shadow
 * DOM, and an iframe realm, which jsdom cannot exercise.
 *
 * Usage: node test/browser/run.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "dist", "harness.js");

const BLANK = "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";

// Which ATS belongs to which difficulty tier (for the report).
const TIER = {
  greenhouse: "Easy", lever: "Easy", bamboohr: "Easy", breezy: "Easy",
  ashby: "Medium", workable: "Medium", smartrecruiters: "Medium",
  jobvite: "Medium", rippling: "Medium", bullhorn: "Medium",
  workday: "Hard", icims: "Hard", taleo: "Hard", adp: "Hard", successfactors: "Hard",
};

const TOP_FIXTURES = Object.keys(TIER);

function norm(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Literal fields must commit the profile value EXACTLY. Dropdowns/radios legitimately
// map a profile string to an option label (e.g. location "Ottawa, ON, Canada" → option
// "Canada"), so for those we accept the committed option being contained in the
// expected value — but never a loose partial of the expected (which would hide a
// half-filled dropdown).
const LITERAL_TYPES = new Set(["text", "textarea", "contenteditable"]);

function matches(actual, expected, controlType) {
  const a = norm(actual), b = norm(expected);
  if (!b || !a) return false;
  if (LITERAL_TYPES.has(controlType)) return a === b;
  // select / combobox / radio: exact, or the committed option is a token of the
  // expected profile value (the location→country transform). NOT expected⊂actual.
  return a === b || b.includes(a);
}

/** Assert one fixture's field results; returns {fills, fillFails, violations, rows}. */
function evaluateResults(results, { eeo = false } = {}) {
  const rows = [];
  const violations = [];
  let fills = 0, fillFails = 0;

  for (const f of results) {
    let verdict = "—"; // not a fill target
    const isFileLike = f.controlType === "file";

    if (f.fillable && f.expected !== null) {
      const ok = matches(f.actual, f.expected, f.controlType);
      verdict = ok ? "PASS" : "FAIL";
      if (ok) fills++;
      else { fillFails++; violations.push(`${f.category}/${f.label}: expected "${f.expected}", got "${f.actual}"`); }
    } else if (isFileLike) {
      // File inputs must never be scripted.
      if (f.actual !== "") { verdict = "LEAK"; violations.push(`${f.label}: file input was written ("${f.actual}")`); }
      else verdict = "skip-file";
    } else if (f.sensitive && !eeo) {
      // EEO/sensitive fields must stay untouched when the toggle is off.
      if (f.actual !== "") { verdict = "LEAK"; violations.push(`${f.label}: EEO field filled while toggle off ("${f.actual}")`); }
      else verdict = "skip-eeo";
    }
    rows.push({ ...f, verdict });
  }
  return { fills, fillFails, violations, rows };
}

function printFixture(name, tier, evald, { eeo = false } = {}) {
  const tag = eeo ? `${name} (EEO on)` : name;
  const status = evald.violations.length === 0 ? "✅ PASS" : "❌ FAIL";
  console.log(`\n${"─".repeat(76)}`);
  console.log(`${status}  ${tag.toUpperCase()}  [${tier}]   ${evald.fills} fields filled, ${evald.fillFails} fill failures`);
  console.log(`${"─".repeat(76)}`);
  for (const r of evald.rows) {
    const exp = r.expected === null ? "" : r.expected;
    const mark =
      r.verdict === "PASS" ? "  ✓" :
      r.verdict === "FAIL" ? "  ✗" :
      r.verdict === "LEAK" ? " ⚠ " :
      "   ";
    const detail =
      r.verdict === "PASS" || r.verdict === "FAIL"
        ? `exp="${exp}" got="${r.actual}"`
        : r.verdict.startsWith("skip") ? `(${r.verdict})` : `got="${r.actual}"`;
    console.log(`${mark} ${(r.category).padEnd(16)} ${(r.controlType).padEnd(14)} ${r.label.slice(0, 34).padEnd(35)} ${detail}`);
  }
  if (evald.violations.length) {
    console.log("   VIOLATIONS:");
    for (const v of evald.violations) console.log(`     • ${v}`);
  }
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const failures = [];
  const summary = [];

  // ---- 1. All 15 ATS in the top realm --------------------------------------
  for (const name of TOP_FIXTURES) {
    const page = await ctx.newPage();
    await page.setContent(BLANK);
    await page.addScriptTag({ path: HARNESS });
    const results = await page.evaluate((n) => window.__T.fillAndVerify(n, false), name);
    const evald = evaluateResults(results, { eeo: false });
    printFixture(name, TIER[name], evald);
    summary.push({ name, tier: TIER[name], realm: "top", fills: evald.fills, ok: evald.violations.length === 0 });
    if (evald.violations.length) failures.push(name);
    await page.close();
  }

  // ---- 2. Workday combobox inside an OPEN SHADOW ROOT ----------------------
  {
    const page = await ctx.newPage();
    await page.setContent(BLANK);
    await page.addScriptTag({ path: HARNESS });
    const results = await page.evaluate(() => window.__T.fillAndVerify("workday-shadow", false));
    const evald = evaluateResults(results, { eeo: false });
    printFixture("workday-shadow", "Hard / shadow DOM", evald);
    summary.push({ name: "workday-shadow", tier: "Hard/shadow", realm: "shadow", fills: evald.fills, ok: evald.violations.length === 0 });
    if (evald.violations.length) failures.push("workday-shadow");
    await page.close();
  }

  // ---- 3. iCIMS form inside a real SAME-ORIGIN IFRAME ----------------------
  {
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html><html><body><h1>Career site</h1>` +
        `<iframe id="ats" srcdoc="${BLANK.replace(/"/g, "&quot;")}" style="width:900px;height:700px;border:0"></iframe>` +
        `</body></html>`
    );
    await page.waitForSelector("iframe#ats");
    const handle = await page.$("iframe#ats");
    const frame = await handle.contentFrame();
    await frame.addScriptTag({ path: HARNESS });
    const results = await frame.evaluate(() => window.__T.fillAndVerify("icims", false));
    const evald = evaluateResults(results, { eeo: false });
    printFixture("icims-in-iframe", "Hard / iframe realm", evald);
    summary.push({ name: "icims-in-iframe", tier: "Hard/iframe", realm: "iframe", fills: evald.fills, ok: evald.violations.length === 0 });
    if (evald.violations.length) failures.push("icims-in-iframe");
    await page.close();
  }

  // ---- 4. EEO-enabled path (Workday) ---------------------------------------
  {
    const page = await ctx.newPage();
    await page.setContent(BLANK);
    await page.addScriptTag({ path: HARNESS });
    const results = await page.evaluate(() => window.__T.fillAndVerifyEeo("workday"));
    // With EEO on + answers present, the gender/veteran selects should be filled.
    const evald = evaluateResults(results, { eeo: true });
    const gender = results.find((r) => r.category === "eeoGender");
    const veteran = results.find((r) => r.category === "eeoVeteran");
    const eeoOk =
      gender && matches(gender.actual, "Female", "select") &&
      veteran && matches(veteran.actual, "I am not a veteran", "select");
    printFixture("workday", "Hard / EEO", evald, { eeo: true });
    console.log(`   EEO check: gender="${gender?.actual}" veteran="${veteran?.actual}" → ${eeoOk ? "✅" : "❌"}`);
    summary.push({ name: "workday-eeo", tier: "Hard/EEO", realm: "top", fills: evald.fills, ok: Boolean(eeoOk) && evald.violations.length === 0 });
    if (!eeoOk) failures.push("workday-eeo");
    await page.close();
  }

  // ---- 5. Résumé file-upload injection (real DataTransfer) -----------------
  {
    const page = await ctx.newPage();
    await page.setContent(BLANK);
    await page.addScriptTag({ path: HARNESS });
    const b64 = readFileSync(path.join(here, "sample-resume.pdf")).toString("base64");
    const up = await page.evaluate(
      ({ b64 }) => window.__T.testFileUpload("greenhouse", b64, "John_Doe_Resume.pdf", "application/pdf"),
      { b64 }
    );
    const ok = up.ok && up.fileCount === 1 && up.fileName === "John_Doe_Resume.pdf" && up.changeFired;
    console.log(`\n${"─".repeat(76)}`);
    console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  RÉSUMÉ UPLOAD (real DataTransfer injection)`);
    console.log("─".repeat(76));
    console.log(`   attached file="${up.fileName}"  count=${up.fileCount}  change-event=${up.changeFired}  ok=${up.ok}${up.reason ? `  reason=${up.reason}` : ""}`);
    summary.push({ name: "resume-upload", tier: "Upload", realm: "top", fills: ok ? 1 : 0, ok });
    if (!ok) failures.push("resume-upload");
    await page.close();
  }

  await browser.close();

  // ---- Summary -------------------------------------------------------------
  console.log(`\n${"=".repeat(76)}`);
  console.log("SUMMARY — real Chromium autofill across ATS systems");
  console.log("=".repeat(76));
  let totalFills = 0;
  for (const s of summary) {
    totalFills += s.fills;
    console.log(`  ${(s.ok ? "✅" : "❌")}  ${s.name.padEnd(20)} ${String(s.tier).padEnd(14)} realm=${s.realm.padEnd(7)} ${s.fills} fields filled`);
  }
  console.log("=".repeat(76));
  console.log(`Scenarios: ${summary.length}   Passed: ${summary.filter((s) => s.ok).length}   Failed: ${failures.length}   Total fields filled: ${totalFills}`);

  if (failures.length) {
    console.log(`\nFAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll ATS autofill scenarios passed in real Chromium. ✅");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
