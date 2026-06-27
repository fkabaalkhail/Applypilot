/**
 * Headless smoke test for the scanner + matcher + autofill engine.
 *
 * Loads test/sample-form.html into jsdom, scans it with the mock profile,
 * prints every detected field, then autofills the confident ones and
 * verifies the values actually landed in the DOM.
 *
 * Uses jsdom from ../frontend/node_modules (kept out of the extension's own
 * dependencies on purpose). Run with: node test/scan-smoke.mjs
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;

// --- resolve jsdom -----------------------------------------------------------
// Prefer this package's own jsdom (devDependency); fall back to the frontend
// workspace for local setups that share it. CI only installs the extension's
// deps, so the local resolution must succeed on its own.
let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  try {
    const req = createRequire(path.join(here, "..", "..", "frontend", "package.json"));
    ({ JSDOM } = req("jsdom"));
  } catch {
    console.error("jsdom not found — run `npm install` in chrome-extension first.");
    process.exit(1);
  }
}

// --- bundle the engine for node -----------------------------------------------
const bundlePath = path.join(here, ".scan-smoke-bundle.mjs");
await build({
  entryPoints: [path.join(here, "scan-smoke-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
});

// --- set up a DOM ---------------------------------------------------------------
const html = readFileSync(path.join(here, "sample-form.html"), "utf8");
const dom = new JSDOM(html, { url: "http://localhost:8080/sample-form.html" });
const { window } = dom;

// jsdom has no layout engine — pretend everything has a box so the
// visibility check passes (we are testing classification, not layout).
window.HTMLElement.prototype.getClientRects = function () {
  return [{ width: 100, height: 20 }];
};

for (const key of [
  "document",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Event",
  "InputEvent",
]) {
  globalThis[key] = window[key];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const { scanPage, fillFields, MOCK_PROFILE, AUTOFILL_CONFIDENCE_THRESHOLD } = await import(
  pathToFileURL(bundlePath).href
);
rmSync(bundlePath);

// --- scan ---------------------------------------------------------------------
const { fields, registry } = scanPage(MOCK_PROFILE, false);

console.log(`\nDetected ${fields.length} fields:\n`);
for (const f of fields) {
  const conf = `${Math.round(f.confidence * 100)}%`.padStart(4);
  const flags = [
    f.sensitive ? "EEO" : "",
    !f.fillable ? "manual" : "",
    f.required ? "req" : "",
  ]
    .filter(Boolean)
    .join(",");
  console.log(
    `  [${conf}] ${f.category.padEnd(18)} ${f.controlType.padEnd(12)} ` +
      `"${f.label.slice(0, 44)}"${flags ? ` (${flags})` : ""}` +
      (f.proposedValue !== null ? ` → "${String(f.proposedValue).slice(0, 40)}"` : "")
  );
}

// --- autofill the confident ones ------------------------------------------------
const toFill = fields.filter(
  (f) =>
    f.fillable &&
    f.proposedValue !== null &&
    !f.sensitive &&
    f.confidence >= AUTOFILL_CONFIDENCE_THRESHOLD
);
const outcomes = fillFields(
  toFill.map((f) => ({ fieldId: f.id, value: f.proposedValue })),
  registry
);

console.log(`\nAutofill: attempted ${outcomes.length}`);
let failures = 0;
for (const o of outcomes) {
  if (!o.ok) {
    failures++;
    const f = fields.find((x) => x.id === o.fieldId);
    console.log(`  ✗ ${f?.label ?? o.fieldId}: ${o.reason}`);
  }
}
console.log(`  ✓ ${outcomes.length - failures} succeeded, ${failures} failed`);

// --- assertions ------------------------------------------------------------------
const doc = window.document;
const expect = (desc, actual, expected) => {
  const pass = actual === expected;
  console.log(`  ${pass ? "✓" : "✗"} ${desc}: ${JSON.stringify(actual)}`);
  if (!pass) {
    console.log(`      expected ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  }
};

console.log("\nDOM verification:");
expect("first name", doc.getElementById("first_name").value, "John");
expect("last name", doc.getElementById("last_name").value, "Doe");
expect("email", doc.getElementById("email").value, "john@example.com");
expect("phone", doc.getElementById("phone").value, "+1 555 555 5555");
expect("city", doc.getElementById("city").value, "Ottawa, ON, Canada");
expect("country select resolves token", doc.getElementById("country").value, "Canada");
expect("linkedin", doc.getElementById("linkedin").value, "https://linkedin.com/in/johndoe");
expect("github", doc.getElementById("github").value, "https://github.com/johndoe");
expect("portfolio", doc.getElementById("website").value, "https://johndoe.com");
expect("work auth yes/no select", doc.getElementById("work_auth").value, "Yes");
expect(
  "sponsorship radio = No",
  doc.querySelector('input[name="sponsorship"]:checked')?.value,
  "no"
);
expect("company", doc.getElementById("company").value, "Example Company");
expect("title", doc.getElementById("title").value, "Software Engineer");
expect(
  "school (nearby-text label)",
  doc.querySelector('input[name="education[school]"]').value,
  "University of Ottawa"
);
expect(
  "degree",
  doc.querySelector('input[name="education[degree]"]').value,
  "BSc Computer Science"
);
expect(
  "grad year",
  doc.querySelector('input[name="education[grad_year]"]').value,
  "2026"
);
expect("EEO gender untouched", doc.getElementById("gender").value, "");
expect("EEO race untouched", doc.getElementById("race").value, "");
expect("EEO veteran untouched", doc.getElementById("veteran").value, "");
expect("resume file untouched", doc.getElementById("resume").value, "");

console.log(process.exitCode ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
