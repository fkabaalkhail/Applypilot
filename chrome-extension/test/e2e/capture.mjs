/**
 * Capture REAL application pages from jobs in the Tailrd app into fixtures.
 *
 *   node test/e2e/capture.mjs [--only greenhouse,lever] [--har]
 *
 * For each target: open the posting in plain Chromium (no extension), walk to
 * the application form the way a user would, wait for it to render, then save
 *   test/fixtures/real/<ats>/<slug>.html         rendered DOM, scripts stripped,
 *                                                 <base> to the real origin
 *   test/fixtures/real/<ats>/<slug>.fields.json  the field inventory (dumpFields)
 *   test/e2e/results/capture/<slug>.png          screenshot (gitignored)
 *   test/e2e/results/har/<slug>.har              full-fidelity replay (--har, gitignored)
 *
 * SAFETY: every request other than a read is aborted (GET/HEAD/OPTIONS, plus
 * GraphQL POSTs whose operation is a `query`). No form is submitted, nothing is
 * uploaded, no account is created. Capture never types into the page.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpFieldsInPage } from "./dumpFields.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "fixtures", "real");
const SHOTS = path.resolve(here, "results", "capture");
const HARS = path.resolve(here, "results", "har");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click the first visible element matching any of `selectors` (or text). */
async function clickFirst(page, candidates, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const c of candidates) {
      const loc = c.startsWith("text=") || c.startsWith("role=") ? page.locator(c) : page.locator(c);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 5000 }).catch(() => {});
          return c;
        }
      }
    }
    await sleep(300);
  }
  return null;
}

export const TARGETS = [
  // ---- Greenhouse: the form renders under the posting on the same page.
  { ats: "greenhouse", slug: "gh-oneimaging-fullstack", url: "https://job-boards.greenhouse.io/oneimaging/jobs/4403125009" },
  { ats: "greenhouse", slug: "gh-garnerhealth-applied-scientist", url: "https://job-boards.greenhouse.io/garnerhealth/jobs/6174213004" },
  { ats: "greenhouse", slug: "gh-bertram-fde", url: "https://job-boards.greenhouse.io/bertramcapitalmanagement/jobs/8789855002" },
  // ---- Lever: /apply is the form.
  { ats: "lever", slug: "lever-rover-swe", url: "https://jobs.lever.co/rover/303b3b2f-9679-4a77-8908-456e29240486/apply" },
  { ats: "lever", slug: "lever-eqbank-intern", url: "https://jobs.lever.co/eqbank/eefb3fa3-a55b-4bfd-b1b2-5419f35c7703/apply" },
  { ats: "lever", slug: "lever-kepler-intern", url: "https://jobs.lever.co/kepler/2ad02ce3-1d56-4aee-9f1d-5199c780c0c1/apply" },
  // ---- Ashby: /application is the form (rendered from GraphQL queries).
  { ats: "ashby", slug: "ashby-pangram-swe", url: "https://jobs.ashbyhq.com/pangramlabs/0512183c-2373-499c-8459-91d0fd2d72f3/application" },
  { ats: "ashby", slug: "ashby-greenboard-swe", url: "https://jobs.ashbyhq.com/greenboard/e5deef5b-8667-48d7-be48-a0b6616eaba5/application" },
  { ats: "ashby", slug: "ashby-interplay-intern", url: "https://jobs.ashbyhq.com/interplay/bdf67758-1f20-4a01-8bb3-ccebfa79e9ac/application" },
  // ---- Workable: /apply/ is the form.
  { ats: "workable", slug: "workable-mindex-coop", url: "https://apply.workable.com/mindex/j/84B10DB922/apply/" },
  { ats: "workable", slug: "workable-financeit-ds", url: "https://apply.workable.com/financeit/j/D3CF97088A/apply/" },
  // ---- SmartRecruiters: posting → "I'm interested" → one-click apply UI.
  {
    ats: "smartrecruiters",
    slug: "sr-servicenow-swe",
    url: "https://jobs.smartrecruiters.com/ServiceNow/744000149338366-software-engineer",
    walk: async (page) => {
      await clickFirst(page, ["#st-apply", 'a:has-text("I\'m interested")', 'button:has-text("I\'m interested")', 'a:has-text("Apply")']);
      await page.waitForLoadState("load").catch(() => {});
      await sleep(4000);
    },
  },
  {
    ats: "smartrecruiters",
    slug: "sr-bosch-intern",
    url: "https://jobs.smartrecruiters.com/BoschGroup/744000148575999-product-management-ai-tool-intern-8-months-40hrs-per-week-",
    walk: async (page) => {
      await clickFirst(page, ["#st-apply", 'a:has-text("I\'m interested")', 'button:has-text("I\'m interested")', 'a:has-text("Apply")']);
      await page.waitForLoadState("load").catch(() => {});
      await sleep(4000);
    },
  },
  // ---- BambooHR: the posting has an "Apply for This Job" button that opens the form.
  {
    ats: "bamboohr",
    slug: "bamboo-nexthop-intern",
    url: "https://nexthopai.bamboohr.com/careers/64",
    walk: async (page) => {
      await clickFirst(page, ['button:has-text("Apply for This Job")', 'a:has-text("Apply for This Job")', 'button:has-text("Apply")']);
      await sleep(3000);
    },
  },
  {
    ats: "bamboohr",
    slug: "bamboo-armstrong-coop",
    url: "https://armstrongfluidtechnology.bamboohr.com/careers/1001",
    walk: async (page) => {
      await clickFirst(page, ['button:has-text("Apply for This Job")', 'a:has-text("Apply for This Job")', 'button:has-text("Apply")']);
      await sleep(3000);
    },
  },
  // ---- Jobvite: /apply is the form.
  { ats: "jobvite", slug: "jobvite-actionet-jrdev", url: "https://jobs.jobvite.com/actionet/job/ofYQzfwm/apply" },
  // ---- iCIMS: the posting's apply link leads to the candidate login (email) step.
  {
    ats: "icims",
    slug: "icims-sas-intern",
    url: "https://careers-sas.icims.com/jobs/42964/summer-2027---software-development-and-testing-intern/job",
    walk: async (page) => {
      await clickFirst(page, ['a:has-text("Apply for this job online")', 'a.iCIMS_ApplyOnlineButton', 'a:has-text("Apply")']);
      await page.waitForLoadState("load").catch(() => {});
      await sleep(4000);
    },
  },
  {
    ats: "icims",
    slug: "icims-gdms-intern",
    url: "https://careers-gdms.icims.com/jobs/75269/software-engineering-intern/job",
    walk: async (page) => {
      await clickFirst(page, ['a:has-text("Apply for this job online")', 'a.iCIMS_ApplyOnlineButton', 'a:has-text("Apply")']);
      await page.waitForLoadState("load").catch(() => {});
      await sleep(4000);
    },
  },
  // ---- Workday: posting → Apply → chooser → Apply Manually → sign-in wall.
  {
    ats: "workday",
    slug: "workday-capitalone-ds",
    url: "https://capitalone.wd12.myworkdayjobs.com/en-US/capital_one/job/Cambridge-MA/Part-Time-Applied-Data-Scientist_R1000592",
    walk: async (page) => {
      await clickFirst(page, ['[data-automation-id="adventureButton"]', 'a:has-text("Apply")', 'button:has-text("Apply")'], 15000);
      await sleep(2500);
      await clickFirst(page, ['[data-automation-id="applyManually"]', 'a:has-text("Apply Manually")', 'button:has-text("Apply Manually")'], 8000);
      await sleep(5000);
    },
  },
  {
    ats: "workday",
    slug: "workday-graco-ai-intern",
    url: "https://graco.wd501.myworkdayjobs.com/en-US/graco_careers/job/Dayton-Minnesota-USA-French-Lake/AI-Intern_R0023511-1",
    walk: async (page) => {
      await clickFirst(page, ['[data-automation-id="adventureButton"]', 'a:has-text("Apply")', 'button:has-text("Apply")'], 15000);
      await sleep(2500);
      await clickFirst(page, ['[data-automation-id="applyManually"]', 'a:has-text("Apply Manually")', 'button:has-text("Apply Manually")'], 8000);
      await sleep(5000);
    },
  },
];

function isSafe(req) {
  const m = req.method();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  if (m !== "POST") return false;
  try {
    const parsed = JSON.parse(req.postData() || "");
    const ops = Array.isArray(parsed) ? parsed : [parsed];
    return ops.every((op) => typeof op?.query === "string" && /^\s*(query\b|\{)/.test(op.query));
  } catch {
    return false;
  }
}

/** Serialize the rendered DOM (open shadow roots inlined as declarative shadow
 *  DOM), drop scripts, and pin relative URLs to the real origin with <base>. */
async function snapshot(page) {
  return page.evaluate(() => {
    const html = document.documentElement.getHTML
      ? document.documentElement.getHTML({ serializableShadowRoots: true, shadowRoots: [...document.querySelectorAll("*")].map((e) => e.shadowRoot).filter(Boolean) })
      : document.documentElement.innerHTML;
    const doc = new DOMParser().parseFromString(`<html>${html}</html>`, "text/html");
    doc.querySelectorAll("script, noscript, iframe[src*='recaptcha'], link[rel='preload'], link[rel='modulepreload'], link[rel='prefetch']").forEach((n) => n.remove());
    const head = doc.head;
    if (head && !head.querySelector("base")) {
      const base = doc.createElement("base");
      base.href = location.origin + "/";
      head.prepend(base);
    }
    // Keep input state: the snapshot should be the EMPTY form, but record any
    // server-rendered defaults as attributes so the replay starts identical.
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1].split(",") : null;
  const har = argv.includes("--har");
  const targets = TARGETS.filter((t) => !only || only.includes(t.ats) || only.includes(t.slug));
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(HARS, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const summary = [];
  for (const t of targets) {
    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ...(har ? { recordHar: { path: path.join(HARS, `${t.slug}.har`), content: "embed" } } : {}),
    });
    const blocked = [];
    await ctx.route("**/*", (route) => {
      const req = route.request();
      if (isSafe(req)) return route.continue();
      blocked.push(`${req.method()} ${req.url().slice(0, 100)}`);
      return route.abort();
    });
    const page = await ctx.newPage();
    let status = "ok";
    let fields = [];
    try {
      await page.goto(t.url, { waitUntil: "load", timeout: 60000 });
      await sleep(3500);
      if (t.walk) await t.walk(page);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      fields = await page.evaluate(dumpFieldsInPage);
      const frames = page.frames().filter((f) => f !== page.mainFrame());
      const frameFields = [];
      for (const f of frames) {
        const ff = await f.evaluate(dumpFieldsInPage).catch(() => []);
        if (ff.length) frameFields.push({ url: f.url(), fields: ff });
      }
      const html = await snapshot(page);
      const dir = path.join(FIXTURES, t.ats);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${t.slug}.html`), html);
      writeFileSync(
        path.join(dir, `${t.slug}.fields.json`),
        JSON.stringify({ capturedAt: new Date().toISOString(), sourceUrl: t.url, finalUrl: page.url(), fields, frames: frameFields }, null, 2)
      );
      for (const fr of frameFields) {
        const fhtml = await page.frames().find((f) => f.url() === fr.url)?.evaluate(() => "<!doctype html>\n" + document.documentElement.outerHTML).catch(() => null);
        if (fhtml) writeFileSync(path.join(dir, `${t.slug}.frame-${frameFields.indexOf(fr)}.html`), fhtml.replace(/<script\b[\s\S]*?<\/script>/gi, ""));
      }
      await page.screenshot({ path: path.join(SHOTS, `${t.slug}.png`), fullPage: true }).catch(() => {});
    } catch (err) {
      status = `error: ${err.message.split("\n")[0]}`;
    }
    const visibleFields = fields.filter((f) => f.visible).length;
    summary.push({ slug: t.slug, ats: t.ats, status, url: page.url(), fields: fields.length, visible: visibleFields, blocked: blocked.length });
    console.log(`${status === "ok" ? "OK " : "ERR"} ${t.slug.padEnd(36)} fields=${String(fields.length).padEnd(4)} visible=${String(visibleFields).padEnd(4)} blocked=${blocked.length}  ${page.url().slice(0, 90)}`);
    if (blocked.length && process.env.E2E_DEBUG === "1") console.log(`      blocked: ${blocked.slice(0, 6).join(" | ")}`);
    await ctx.close();
  }
  await browser.close();
  writeFileSync(path.join(here, "results", "capture-summary.json"), JSON.stringify(summary, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
