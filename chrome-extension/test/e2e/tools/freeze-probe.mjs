/**
 * Find where a live page freezes. Runs one pinned case's fill with the built
 * extension, streams the extension's console lines and every input/change/click
 * on the page, and if the fill has not finished after FREEZE_MS, pauses the
 * page in the debugger and prints the JavaScript stack. Found Workable's own
 * date-format loop on Saalex's form (2026-10-05).
 *
 *   node build.mjs && node test/e2e/tools/freeze-probe.mjs <case id>
 *   FREEZE_MS=30000 PROFILE=US_H1B_SENIOR LOCK=CA_31137,CA_31168 node test/e2e/tools/freeze-probe.mjs r4d-wk-saalex
 *
 * PROFILE swaps the case's persona; LOCK makes the named inputs read-only so
 * the extension leaves them alone (an experiment: which write triggers it).
 * Same rules as run.mjs: GET only (plus the case's allowRequests), headful.
 */
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeApi } from "../fakeApi.mjs";
import { launchExtension, seedExtension, installRouting, triggerAutofill } from "../harness.mjs";
import * as PROFILES from "../profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const e2e = path.resolve(here, "..");
const id = process.argv[2];
const FREEZE_MS = Number(process.env.FREEZE_MS ?? 45000);
let testCase = null;
for (const f of readdirSync(path.join(e2e, "cases")).filter((f) => f.endsWith(".mjs"))) {
  const mod = await import(pathToFileURL(path.join(e2e, "cases", f)).href);
  const list = typeof mod.default === "function" ? await mod.default() : mod.default;
  testCase = (list ?? []).find((c) => c.id === id) ?? testCase;
}
if (!testCase) throw new Error(`no case ${id}`);
const resumePdf = path.resolve(e2e, "..", "browser", "sample-resume.pdf");
const api = await startFakeApi({ profile: PROFILES.MOCK, resumeFilePath: existsSync(resumePdf) ? resumePdf : null });
const ext = await launchExtension();
await seedExtension(ext.sw, api.url);
if (process.env.PROFILE) testCase.profile = PROFILES[process.env.PROFILE];
if (testCase.profile) api.setProfile(testCase.profile);
api.setResumes(testCase.resumes ?? []);
await installRouting(ext.ctx, { apiUrl: api.url, pages: new Map(), mode: testCase.mode ?? "fixture", assets: new Map(), allowRequests: testCase.allowRequests });
const page = await ext.ctx.newPage();
await page.addInitScript(() => {
  const log = (kind) => (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const v = "value" in t ? String(t.value).slice(0, 40) : "";
    const checked = "checked" in t && t.checked ? " checked" : "";
    console.log(`[Tailrd probe] ${kind} ${t.tagName.toLowerCase()} ${t.id || t.getAttribute("name") || ""} = ${JSON.stringify(v)}${checked}`);
  };
  document.addEventListener("input", log("input"), true);
  document.addEventListener("change", log("change"), true);
  document.addEventListener("click", log("click"), true);
});
if (process.env.LOCK) {
  await page.addInitScript((names) => {
    setInterval(() => names.forEach((n) => document.querySelectorAll(`[name="${n}"]`).forEach((el) => el.setAttribute("readonly", ""))), 200);
  }, process.env.LOCK.split(","));
}
const t0 = Date.now();
page.on("console", (m) => {
  const t = m.text();
  if (/\[Tailrd|\[adapter|\[combobox/i.test(t) && !/refreshMainView/.test(t)) console.log(`${String(Date.now() - t0).padStart(6)} ${t.slice(0, 220)}`);
});
await page.goto(testCase.url, { waitUntil: "load", timeout: 60000 });
// The debugger is attached before the fill: a page already frozen answers no
// command, Debugger.enable included.
const cdp = await ext.ctx.newCDPSession(page);
const scripts = new Map();
cdp.on("Debugger.scriptParsed", (e) => scripts.set(e.scriptId, e.url));
await cdp.send("Debugger.enable");
await new Promise((r) => setTimeout(r, 800));
let done = false;
triggerAutofill(page, ext.sw, api, testCase.trigger ?? {}).then(
  () => {
    done = true;
    console.log("FINISHED", Date.now() - t0, "ms");
  },
  (e) => {
    done = true;
    console.log("TRIGGER ERROR", e.message);
  }
);
const deadline = Date.now() + FREEZE_MS;
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
if (!done) {
  console.log(`NOT FINISHED after ${FREEZE_MS} ms: pausing`);
  const paused = new Promise((r) => cdp.once("Debugger.paused", r));
  await cdp.send("Debugger.pause");
  const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 15000))]);
  if (!ev) console.log("could not pause (no JavaScript running?)");
  else {
    for (const f of ev.callFrames.slice(0, 25)) {
      console.log(`  at ${f.functionName || "(anon)"} ${(scripts.get(f.location.scriptId) || f.url || "").split("/").pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
    }
  }
}
process.exit(0);
