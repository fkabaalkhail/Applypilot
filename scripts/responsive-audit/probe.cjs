/* Ad-hoc single-screen probe: dumps what actually rendered, plus console errors.
 *   node scripts/responsive-audit/probe.cjs <stateId> [viewport]
 */
const path = require("path");
const REPO = path.resolve(__dirname, "..", "..");
const { chromium } = require(path.join(REPO, "chrome-extension", "node_modules", "playwright"));
const { STATES, VIEWPORTS } = require("./states.cjs");

const stateId = process.argv[2];
const vpId = process.argv[3] || "1440x900";
const state = STATES.find((s) => s.id === stateId);
const vp = VIEWPORTS.find((v) => v.id === vpId);
if (!state) throw new Error("no such state: " + stateId + "\n" + STATES.map((s) => s.id).join("\n"));

// Reuse the audit's stub table
const audit = require("fs").readFileSync(path.join(__dirname, "audit.cjs"), "utf8");
const F = require("./fixtures.cjs");
// eslint-disable-next-line no-eval
const stubFor = eval(
  "(" + audit.slice(audit.indexOf("function stubFor"), audit.indexOf("const API_PREFIX")) + ")"
);
const json = (b, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(b) });
const API_PREFIX =
  /^\/(auth|api|jobs|resumes|settings|ai|apply|connections|github-sources|feedback|health)\b/;
const BASE = "http://localhost:5173";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== BASE) {
      if (/fonts\.|cdnjs/.test(url.host)) return route.continue();
      return route.fulfill({ status: 204, body: "" });
    }
    if (API_PREFIX.test(url.pathname)) {
      const s = stubFor(url.pathname, route.request().method(), state.user);
      return route.fulfill(s || json({}));
    }
    return route.continue();
  });
  if (state.authed) await ctx.addInitScript(() => localStorage.setItem("access_token", "t"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200));
  });
  await page.goto(BASE + state.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  for (const step of state.steps || []) {
    if (step.clickIfVisible) {
      const el = page.locator(step.clickIfVisible).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    if (step.click) await page.locator(step.click).first().click({ timeout: 4000 }).catch((e) => errs.push("CLICK " + step.click + ": " + e.message.split("\n")[0]));
    if (step.fill) await page.locator(step.fill).first().fill(step.value).catch(() => {});
    await page.waitForTimeout(600);
  }
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    textLen: (document.body.innerText || "").length,
    text: (document.body.innerText || "").slice(0, 400),
    html: document.body.innerHTML.slice(0, 700),
  }));
  console.log("URL:", info.url);
  console.log("body text length:", info.textLen);
  console.log("--- TEXT ---\n" + info.text);
  console.log("\n--- HTML head ---\n" + info.html);
  console.log("\n--- ERRORS ---\n" + (errs.join("\n") || "none"));
  await page.screenshot({ path: path.join(__dirname, "out", "probe-" + stateId + ".png"), fullPage: true });
  await browser.close();
})();
