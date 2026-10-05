/**
 * One Autofill click, a whole Workday application: the REAL packaged extension
 * in real Chromium, against the Workday replica in fixtures/workdayReplica.mjs
 * served under a real Workday host name (so the Workday adapter runs), with
 * the fake backend serving a complete profile and a résumé file.
 *
 * Scenarios (all by default, or `--scenario <name>`):
 *  - full:     ONE click on Autofill on the job posting, then hands off. The
 *              flow must open the application, create the account, fill and
 *              turn every page by itself, and stop at Review. Checks what each
 *              page REGISTERED when it was saved (the replica's own state),
 *              that no save was rejected, and that Submit was never clicked.
 *  - pause:    the panel's Pause on a counting page holds it (no turn in 5 s);
 *              its Continue turns it, and the flow goes on to Review by itself.
 *  - type:     clicking into the page while it counts down holds it the same way.
 *  - own-next: the user turns a page with the site's OWN button during the
 *              countdown; the flow follows, fills the new page and goes on.
 *
 * Usage: npm run build && node test/browser/workday-flow-probe.mjs [--scenario full]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { launchExtension, seedExtension } from "../e2e/harness.mjs";
import { startFakeApi } from "../e2e/fakeApi.mjs";
import { US_VETERAN } from "../e2e/profiles.mjs";
import { WD_ORIGIN, POSTING_PATH, APPLY_PATH, POSTING_HTML, APP_HTML } from "./fixtures/workdayReplica.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REG = { email: "marcus.hill@example.com", password: "Probe#Pass123" };
const STEPS = ["createAccount", "myInformation", "myExperience", "applicationQuestions", "voluntaryDisclosures", "selfIdentify", "review"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const only = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : null;

const results = [];
function check(label, ok, extra = "") {
  results.push(ok);
  console.log(`   ${ok ? "✅" : "❌"} ${label}${extra ? `: ${extra}` : ""}`);
  return ok;
}

async function installRoutes(ctx, apiUrl, hits) {
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (req.url().startsWith(apiUrl)) return route.continue();
    const url = new URL(req.url());
    if (url.origin !== WD_ORIGIN) return route.abort();
    hits.push(`${req.method()} ${url.pathname}`);
    const html = { [POSTING_PATH]: POSTING_HTML, [APPLY_PATH]: APP_HTML }[url.pathname];
    if (html && req.method() === "GET") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    return route.fulfill({ status: 404, contentType: "text/html; charset=utf-8", body: "<h1>Not found</h1>" });
  });
}

/** Panel helpers: the panel lives in an open shadow root, which locators pierce. */
const panelState = (page) =>
  page
    .evaluate(() => {
      const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
      const btn = sr?.querySelector("#ap-btn-autofill");
      const wrap = sr?.querySelector(".ap-flow-next-wrap");
      const pause = sr?.querySelector("#ap-flow-pause");
      return {
        mounted: Boolean(btn),
        enabled: Boolean(btn && !btn.disabled),
        gate: Boolean(wrap && wrap.style.display !== "none"),
        gateText: (sr?.querySelector("#ap-flow-next")?.textContent ?? "").trim(),
        pause: Boolean(pause && pause.style.display !== "none" && wrap && wrap.style.display !== "none"),
      };
    })
    .catch(() => ({ mounted: false, enabled: false, gate: false, gateText: "", pause: false }));

const appState = (page) =>
  page.evaluate(() => (window.__wd ? JSON.parse(JSON.stringify(window.__wd)) : null)).catch(() => null);

async function openPanel(page, sw) {
  for (let i = 0; i < 40; i++) {
    if ((await panelState(page)).mounted) return true;
    if (i >= 12 && i % 4 === 0) {
      await sw
        .evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }, { frameId: 0 }).catch(() => {});
        })
        .catch(() => {});
    }
    await sleep(250);
  }
  return false;
}

async function waitFor(fn, timeoutMs, pollMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(pollMs);
  }
}

/** Start a scenario: a fresh tab on the posting, the panel open, ONE Autofill click. */
async function start(env, name) {
  console.log(`\n▶ ${name}`);
  const page = await env.ctx.newPage();
  const log = { beats: [], flow: [], errors: [], all: [] };
  page.on("console", (m) => {
    const t = m.text();
    if (/^\[Tailrd\] /.test(t)) log.beats.push(t.slice(9, 160));
    if (/\[Tailrd (flow|stuck)\]/.test(t)) log.flow.push(t.slice(0, 220));
    if (process.env.WD_DEBUG === "1" && /\[Tailrd|\[adapter|\[combobox/i.test(t) && !/refreshMainView/.test(t)) log.all.push(t.slice(0, 400));
    if (m.type() === "error" && /Tailrd|applypilot|contentScript/.test(t)) log.errors.push(t.slice(0, 300));
  });
  page.on("pageerror", (e) => log.errors.push(`PAGEERROR ${String(e).slice(0, 300)}`));
  await page.goto(`${WD_ORIGIN}${POSTING_PATH}`, { waitUntil: "load" });
  if (!check("panel opens on the posting", await openPanel(page, env.sw))) return { page, log, ok: false };
  const enabled = await waitFor(async () => (await panelState(page)).enabled, 30000);
  if (!check("Autofill enabled (profile loaded)", Boolean(enabled))) return { page, log, ok: false };
  await page.locator("#ap-btn-autofill").click();
  return { page, log, ok: true };
}

/** Wait until the application sits on `step` (and its page has been drawn). */
async function reach(page, step, timeoutMs) {
  return waitFor(async () => {
    const s = await appState(page);
    return s && s.steps[s.steps.length - 1] === step ? s : null;
  }, timeoutMs, 300);
}

/** Wait for the panel's countdown on the current page. */
const counting = (page, timeoutMs) => waitFor(async () => (await panelState(page)).pause, timeoutMs, 100);

let apiRef = null;

async function dumpOnFail(log, page) {
  if (page) {
    const missing = await page.evaluate(() => (window.__wdMissing ? window.__wdMissing() : null)).catch(() => null);
    const state = await page.evaluate(() => (window.__wdState ? window.__wdState() : null)).catch(() => null);
    console.log(`   --- page: still missing ${JSON.stringify(missing)}`);
    if (process.env.WD_DEBUG === "1") {
      const radios = await page.evaluate(() => [...document.querySelectorAll('input[type=radio], input[type=checkbox]')].map((r) => `${r.name || r.id}=${r.value}:${r.checked ? "on" : "off"}${r.getAttribute("data-ap-field") ? ` [${r.getAttribute("data-ap-field")}]` : ""}`)).catch(() => []);
      console.log(`   --- page toggles: ${radios.join(" ")}`);
      const html = await page.evaluate(() => document.getElementById("wd-content")?.outerHTML ?? "").catch(() => "");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(process.env.TEMP || ".", "wd-stuck-page.html"), html);
      console.log(`   --- page markup saved (${html.length} chars)`);
    }
    if (process.env.WD_DEBUG === "1") console.log(`   --- page state: ${JSON.stringify(state)}`);
  }
  if (process.env.WD_DEBUG === "1") for (const l of log.all) console.log(`   | ${l}`);
  if (process.env.WD_DEBUG === "1" && apiRef) {
    // The extension's own per-field record of the last fill (telemetry).
    const short = (v, n) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
    for (const t of apiRef.state.telemetry.slice(-2)) {
      console.log(`   --- telemetry ${short(t.body?.page_url ?? t.body?.url, 60)}`);
      for (const c of t.body?.field_captures ?? []) {
        console.log(`   ${short(c.outcome, 9).padEnd(9)} ${short(c.category, 18).padEnd(18)} «${short(c.label, 60)}» ${JSON.stringify(short(c.observed_value, 40))} ${c.reason ? `(${short(c.reason, 70)})` : ""}`);
      }
    }
  }
  console.log("   --- last flow lines ---");
  for (const l of log.flow.slice(-30)) console.log(`   ${l}`);
  console.log("   --- last beats ---");
  for (const b of log.beats.slice(-12)) console.log(`   ${b}`);
  for (const e of log.errors.slice(-5)) console.log(`   ${e}`);
}

// ---------------------------------------------------------------------------

const sent = (wd, step) => wd.submissions.find((s) => s.step === step)?.sent ?? null;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkValues(wd) {
  const today = new Date();
  const acct = sent(wd, "createAccount");
  check("account: the saved email and password, both password boxes, consent ticked",
    acct && acct.email === REG.email && acct.password === REG.password && acct.verify === REG.password && acct.consent === true,
    acct ? `email=${acct.email} consent=${acct.consent}` : "never saved");
  const info = sent(wd, "myInformation") ?? {};
  const infoWant = {
    source: ["Company Website"], previous: "No", country: "United States of America", first: "Marcus", last: "Hill",
    line1: "4120 Duval St", city: "Austin", state: "Texas", postal: "78751", device: "Mobile", dial: ["United States of America (+1)"],
  };
  for (const [k, v] of Object.entries(infoWant)) check(`My Information: ${k}`, eq(info[k], v), JSON.stringify(info[k]));
  check("My Information: phone number", /512\D*555\D*0143/.test(info.phone ?? ""), JSON.stringify(info.phone));
  check("My Information: no extension invented", !info.ext, JSON.stringify(info.ext));

  const exp = sent(wd, "myExperience") ?? {};
  const jobs = [
    ["Signal Support Systems Specialist", "U.S. Army", { month: "6", year: "2012" }, { month: "5", year: "2016" }, false],
    ["Software Engineer", "Indeed", { month: "7", year: "2019" }, { month: "12", year: "2022" }, false],
    ["Software Engineer II", "Dell Technologies", { month: "1", year: "2023" }, null, true],
  ];
  check("My Experience: one row per job (3)", (exp.work ?? []).length === 3, String((exp.work ?? []).length));
  jobs.forEach(([title, company, from, to, current], n) => {
    const got = { title: exp[`w${n}title`], company: exp[`w${n}company`], from: norm(exp[`w${n}from`]), to: norm(exp[`w${n}to`]), current: exp[`w${n}current`] === true };
    const want = { title, company, from, to: to ?? got.to, current };
    check(`My Experience: job ${n + 1}`, eq(got, want), JSON.stringify(got));
  });
  check("My Experience: one education row", (exp.edu ?? []).length === 1, String((exp.edu ?? []).length));
  check("My Experience: school", eq(exp.e0school, ["University of Texas at Austin"]), JSON.stringify(exp.e0school));
  check("My Experience: degree", exp.e0degree === "Bachelor's Degree", JSON.stringify(exp.e0degree));
  check("My Experience: field of study", eq(exp.e0field, ["Computer Science"]), JSON.stringify(exp.e0field));
  check("My Experience: GPA", exp.e0gpa === "3.2", JSON.stringify(exp.e0gpa));
  check("My Experience: skills", ["Java", "Go", "AWS", "Kubernetes"].every((s) => (exp.skills ?? []).includes(s)), JSON.stringify(exp.skills));
  check("My Experience: résumé attached", Boolean(exp.resume), JSON.stringify(exp.resume));
  check("My Experience: LinkedIn", /linkedin\.com\/in\/marcus-hill-dev/.test(exp.linkedin ?? ""), JSON.stringify(exp.linkedin));

  const qs = sent(wd, "applicationQuestions") ?? {};
  const qWant = { q_auth: "Yes", q_sponsor: "No", q_age: "Yes", q_onsite: "Yes", q_years: "5-7 years", q_former: "No" };
  for (const [k, v] of Object.entries(qWant)) check(`Application Questions: ${k}`, qs[k] === v, JSON.stringify(qs[k]));
  check("Application Questions: salary", /135/.test(qs.q_salary ?? ""), JSON.stringify(qs.q_salary));

  const eeo = sent(wd, "voluntaryDisclosures") ?? {};
  check("Voluntary Disclosures: gender", eeo.gender === "Male", JSON.stringify(eeo.gender));
  check("Voluntary Disclosures: ethnicity", eeo.ethnicity === "Black or African American (Not Hispanic or Latino) (United States of America)", JSON.stringify(eeo.ethnicity));
  check("Voluntary Disclosures: veteran", eeo.veteran === "I identify as one or more of the classifications of protected veteran", JSON.stringify(eeo.veteran));
  check("Voluntary Disclosures: terms ticked", eeo.terms === true, JSON.stringify(eeo.terms));

  const self = sent(wd, "selfIdentify") ?? {};
  check("Self Identify: name", self.sname === "Marcus Hill", JSON.stringify(self.sname));
  check("Self Identify: today's date", eq(norm(self.signed), { month: String(today.getMonth() + 1), day: String(today.getDate()), year: String(today.getFullYear()) }), JSON.stringify(self.signed));
  check("Self Identify: disability", self.disability === "I do not want to answer", JSON.stringify(self.disability));
}

/** "06" and "6" are the same month to the page. */
function norm(d) {
  if (!d) return null;
  const out = {};
  for (const [k, v] of Object.entries(d)) out[k] = String(Number(v));
  return out;
}

// ---------------------------------------------------------------------------

async function full(env) {
  const { page, log, ok } = await start(env, "full: one Autofill click, then hands off");
  if (!ok) return dumpOnFail(log, page);
  const t0 = Date.now();
  const wd = await reach(page, "review", 240000);
  check("reached Review with no other click", Boolean(wd), wd ? `${Math.round((Date.now() - t0) / 1000)} s` : `stuck on ${(await appState(page))?.steps?.slice(-1)[0] ?? page.url()}`);
  if (!wd) return dumpOnFail(log, page);
  // The flow's last beat (it reads the Review page first), then a few seconds
  // more for anything that would click Submit.
  await waitFor(async () => log.beats.some((b) => /^Done\./.test(b)), 20000);
  await sleep(3000);
  const end = await appState(page);
  check("every step visited in order", eq(end.steps, STEPS), end.steps.join(" > "));
  check("no save was rejected by the page's validation", end.rejected.length === 0, JSON.stringify(end.rejected));
  check("Submit was never clicked", end.submitClicked === false && !env.hits.some((h) => /submitted/.test(h)));
  check("the flow finished at Review", log.beats.some((b) => /^Done\./.test(b)), log.beats.slice(-1)[0]);
  const paused = log.beats.filter((b) => /paused/.test(b));
  check("no page waited for the user", paused.length === 0, paused.join(" | "));
  checkValues(end);
  if (process.env.WD_DEBUG === "1" && apiRef) {
    // Every field the extension itself did not count as filled, on any page.
    apiRef.state.telemetry.forEach((t, i) => {
      for (const c of t.body?.field_captures ?? []) {
        if (c.outcome !== "filled") console.log(`   attention #${i}: ${c.outcome} ${c.category} «${String(c.label).slice(0, 60)}» ${JSON.stringify(String(c.observed_value ?? "").slice(0, 40))} (wanted ${JSON.stringify(String(c.proposed_value ?? "").slice(0, 40))}) (${c.reason ?? ""}) ${c.control_type ?? ""} ${c.field_id ?? ""} ${String(c.dom ?? c.selector ?? "").slice(0, 160)}`);
      }
    });
  }
  if (results.includes(false)) await dumpOnFail(log, page);
  await page.close();
}

async function pause(env) {
  const { page, log, ok } = await start(env, "pause: Pause holds a counting page, Continue turns it");
  if (!ok) return dumpOnFail(log, page);
  if (!check("My Information reached", Boolean(await reach(page, "myInformation", 120000)))) return dumpOnFail(log, page);
  if (!check("its countdown shows, with Pause", Boolean(await counting(page, 90000)))) return dumpOnFail(log, page);
  await page.locator("#ap-flow-pause").click();
  await sleep(5000);
  const held = await appState(page);
  const ps = await panelState(page);
  check("held: still on My Information 5 s later", held.steps[held.steps.length - 1] === "myInformation", held.steps.slice(-1)[0]);
  check("the gate is a plain Continue now, Pause gone", ps.gate && !ps.pause && /Continue To The Next Page/.test(ps.gateText), ps.gateText);
  await page.locator("#ap-flow-next").click();
  check("Continue turned it to My Experience", Boolean(await reach(page, "myExperience", 30000)));
  check("and the flow went on to Review by itself", Boolean(await reach(page, "review", 240000)));
  const end = await appState(page);
  check("Submit was never clicked", end.submitClicked === false);
  if (results.includes(false)) await dumpOnFail(log, page);
  await page.close();
}

async function typing(env) {
  const { page, log, ok } = await start(env, "type: clicking into the page while it counts down holds it");
  if (!ok) return dumpOnFail(log, page);
  if (!check("My Experience reached", Boolean(await reach(page, "myExperience", 150000)))) return dumpOnFail(log, page);
  if (!check("its countdown shows", Boolean(await counting(page, 150000)))) return dumpOnFail(log, page);
  await page.locator('[data-automation-id="linkedinQuestion"]').click();
  await page.keyboard.press("End");
  await sleep(5000);
  const held = await appState(page);
  check("held: still on My Experience 5 s later", held.steps[held.steps.length - 1] === "myExperience", held.steps.slice(-1)[0]);
  await page.locator("#ap-flow-next").click();
  check("Continue turned it", Boolean(await reach(page, "applicationQuestions", 30000)));
  check("and the flow went on to Review by itself", Boolean(await reach(page, "review", 240000)));
  if (results.includes(false)) await dumpOnFail(log, page);
  await page.close();
}

async function ownNext(env) {
  const { page, log, ok } = await start(env, "own-next: the user turns a page with the site's own button");
  if (!ok) return dumpOnFail(log, page);
  if (!check("Application Questions reached", Boolean(await reach(page, "applicationQuestions", 200000)))) return dumpOnFail(log, page);
  if (!check("its countdown shows", Boolean(await counting(page, 90000)))) return dumpOnFail(log, page);
  await page.locator('[data-automation-id="pageFooterNextButton"]').click();
  check("the site's own button turned it", Boolean(await reach(page, "voluntaryDisclosures", 15000)));
  check("the flow followed and went on to Review", Boolean(await reach(page, "review", 200000)));
  const end = await appState(page);
  const eeo = sent(end, "voluntaryDisclosures") ?? {};
  check("the page it followed onto was filled", eeo.gender === "Male" && eeo.terms === true, JSON.stringify({ gender: eeo.gender, terms: eeo.terms }));
  check("no step was skipped or saved twice", eq(end.submissions.map((s) => s.step), STEPS.slice(0, -1)), end.submissions.map((s) => s.step).join(" > "));
  check("Submit was never clicked", end.submitClicked === false);
  if (results.includes(false)) await dumpOnFail(log, page);
  await page.close();
}

async function main() {
  const resumePdf = path.resolve(here, "sample-resume.pdf");
  const api = await startFakeApi({ profile: US_VETERAN, resumeFilePath: existsSync(resumePdf) ? resumePdf : null });
  api.setResumes([{ id: 7, name: "Marcus Hill Resume", isPrimary: true, hasFile: true, fileName: "Marcus_Hill_Resume.pdf", fileContentType: "application/pdf" }]);
  const ext = await launchExtension();
  await seedExtension(ext.sw, api.url);
  // The setting under test (the harness turns it off), and the account
  // credentials a user saves once in Autofill Information > Account creation.
  await ext.sw.evaluate(async (reg) => {
    const { ap_config } = await chrome.storage.local.get("ap_config");
    await chrome.storage.local.set({ ap_config: { ...ap_config, flowAutoContinue: true }, apCredentialDefaults: reg });
  }, REG);
  const hits = [];
  await installRoutes(ext.ctx, api.url, hits);
  const env = { ctx: ext.ctx, sw: ext.sw, hits };
  apiRef = api;
  console.log(`extension loaded, fake API at ${api.url}, Workday replica at ${WD_ORIGIN}`);

  const scenarios = { full, pause, type: typing, "own-next": ownNext };
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && only !== name) continue;
    try {
      await run(env);
    } catch (err) {
      check(`${name} ran without a harness error`, false, err.message.split("\n")[0]);
    }
  }
  await ext.close();
  await api.close();
  const okAll = results.length > 0 && results.every(Boolean);
  console.log(`\n${okAll ? "✅ PASS" : "❌ FAIL"}  Workday, one click to Review: ${results.filter(Boolean).length}/${results.length} checks.`);
  process.exit(okAll ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
