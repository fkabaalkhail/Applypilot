/**
 * Full-pipeline probe of the multi-page apply flow in the REAL packaged
 * extension: job posting → Apply → chooser → Apply Manually → create-account
 * wall (user-set credentials + consent + Create Account click) → application
 * form (fill + Next) → final page (Submit detected as terminal, NEVER clicked).
 *
 * Every transition is a REAL navigation, so this also proves the flow state
 * persists in the background and resumes in a fresh content script each page —
 * including the field-less chooser page (autoInit entry resume).
 *
 * Usage: npm run build && node test/browser/flow-probe.mjs
 */
import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "..", "dist");

const REG_EMAIL = "e2e@probe.dev";
const REG_PASSWORD = "Probe#Pass123";

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers</title></head><body>${body}</body></html>`;

const PAGES = {
  "/job": page(`
    <h1>Software Engineer</h1>
    <p>Acme builds rockets. Read on to learn how to apply your skills here.</p>
    <a href="/apply" id="apply-entry">Apply Now</a>`),
  "/apply": page(`
    <h1>How would you like to apply?</h1>
    <a href="/no-1">Autofill with Resume</a>
    <a href="/account" id="manual">Apply Manually</a>
    <a href="/no-2">Use My Last Application</a>`),
  "/account": page(`
    <h1>Create Account</h1>
    <form action="/form" method="get">
      <div><label for="e">Email Address</label><input id="e" name="reg_email" type="email" required></div>
      <div><label for="p1">Password</label><input id="p1" name="reg_pw" type="password" required></div>
      <div><label for="p2">Verify New Password</label><input id="p2" name="reg_pw2" type="password" required></div>
      <div><label><input type="checkbox" name="agree" required> I agree to the Privacy Statement</label></div>
      <button type="submit">Create Account</button>
    </form>`),
  "/form": page(`
    <h1>My Information</h1>
    <form action="/form2" method="get">
      <div><label for="f">First Name</label><input id="f" name="first" type="text"></div>
      <div><label for="l">Last Name</label><input id="l" name="last" type="text"></div>
      <div><label for="m">Email</label><input id="m" name="email" type="email"></div>
      <div><label for="ph">Phone</label><input id="ph" name="phone" type="tel"></div>
      <button type="submit">Next</button>
    </form>`),
  "/form2": page(`
    <h1>Review</h1>
    <form>
      <div><label for="notes">Anything else?</label><textarea id="notes" name="notes"></textarea></div>
      <button type="button" onclick="location.href='/submitted'">Submit application</button>
    </form>`),
  "/submitted": page(`<h1>SHOULD NEVER BE REACHED BY THE FLOW</h1>`),
};

function startServer(hits) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      hits.push(u.pathname + u.search);
      const body = PAGES[u.pathname] ?? page("<h1>404</h1>");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function launchWithExtension() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tailrd-flow-"));
  const base = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"];
  const modes = [
    { label: "headless=new", opts: { headless: false, args: [...base, "--headless=new"] } },
    { label: "headed", opts: { headless: false, args: base } },
  ];
  for (const m of modes) {
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, m.opts);
      return { ctx, mode: m.label };
    } catch (err) {
      console.log(`   launch (${m.label}) failed: ${err.message.split("\n")[0]}`);
    }
  }
  throw new Error("could not launch Chromium with the extension in this environment");
}

async function getServiceWorker(ctx, timeoutMs = 8000) {
  const existing = ctx.serviceWorkers();
  if (existing.length) return existing[0];
  return Promise.race([
    ctx.waitForEvent("serviceworker").catch(() => null),
    new Promise((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
}

/** Ask the background to toggle the in-page panel (the toolbar-click path). */
async function togglePanel(sw, urlPrefix) {
  for (let i = 0; i < 20; i++) {
    const ok = await sw.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({ url: `${prefix}/*` });
      if (!tabs.length) return false;
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_PANEL" });
        return true;
      } catch {
        return false; // content script not listening yet
      }
    }, urlPrefix);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("content script never answered TOGGLE_PANEL");
}

const results = [];
function check(label, ok, extra = "") {
  results.push(ok);
  console.log(`   ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  return ok;
}

async function main() {
  const hits = [];
  const { server, port } = await startServer(hits);
  const origin = `http://127.0.0.1:${port}`;
  let ctx, mode;
  try {
    ({ ctx, mode } = await launchWithExtension());
  } catch (err) {
    console.log(`❌ ENV-SKIP  ${err.message}`);
    server.close();
    process.exit(2);
  }
  console.log(`Launched Chromium (${mode}); serving fake multi-page ATS at ${origin}`);

  const sw = await getServiceWorker(ctx);
  if (!sw) throw new Error("service worker never registered");
  const pg = await ctx.newPage();
  await pg.goto(`${origin}/job`, { waitUntil: "load" });

  // 1. Open the panel via the toolbar path (job postings don't auto-mount for
  //    text-matched entries) and enter sample-data mode.
  await togglePanel(sw, origin);
  // The host div itself has no box (the UI lives in its fixed-position shadow
  // tree), so wait for attachment, not visibility.
  await pg.waitForSelector("#applypilot-overlay-host", { state: "attached", timeout: 10000 });
  await pg.locator("#ap-btn-use-mock").click({ timeout: 10000 });

  // 2. The entry page enables Autofill and says what it will click.
  await pg.waitForFunction(
    () => {
      const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
      const btn = sr?.querySelector("#ap-btn-autofill");
      return btn && !btn.disabled;
    },
    null,
    { timeout: 15000 }
  );
  const hint = await pg.locator("#ap-field-count").textContent();
  check("Autofill enabled on the job posting", true);
  check('panel explains it will click "Apply Now"', /Apply Now/.test(hint ?? ""), hint?.trim());

  // 3. Save account-creation credentials in Autofill Information → Account creation.
  await pg.locator("#ap-section-info").click();
  await pg.locator('.ap-modal-sidebar-item[data-cat="signup"]').click();
  await pg.locator('input[data-signup="email"]').fill(REG_EMAIL);
  await pg.locator('input[data-signup="password"]').fill(REG_PASSWORD);
  await pg.locator("#ap-btn-update").click();
  await pg.waitForFunction(
    () => {
      const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
      return !sr?.querySelector("#ap-modal-backdrop")?.classList.contains("visible");
    },
    null,
    { timeout: 10000 }
  );
  const storedDefaults = await sw.evaluate(async () => (await chrome.storage.local.get("apCredentialDefaults"))?.apCredentialDefaults);
  check(
    "account credentials saved device-locally",
    storedDefaults?.email === REG_EMAIL && storedDefaults?.password === REG_PASSWORD
  );

  // 4. Autofill → the flow clicks Apply Now → chooser → Apply Manually → account.
  await pg.locator("#ap-btn-autofill").click();
  await pg.waitForURL(`${origin}/apply`, { timeout: 20000 });
  check("flow clicked Apply Now (navigated to the chooser)", true);
  await pg.waitForURL(`${origin}/account`, { timeout: 20000 });
  check("flow resumed on the field-less chooser and picked Apply Manually", true);

  // 5. The account wall fills the saved credentials, ticks consent, and clicks
  //    Create Account (a real GET submit — the server sees exactly what the
  //    site would).
  await pg.waitForURL((u) => u.pathname === "/form", { timeout: 30000 });
  const acct = new URL(pg.url()).searchParams;
  check("create-account used the saved registration email", acct.get("reg_email") === REG_EMAIL, acct.get("reg_email") ?? "(none)");
  check("both password fields got the saved password", acct.get("reg_pw") === REG_PASSWORD && acct.get("reg_pw2") === REG_PASSWORD);
  check("required consent checkbox was ticked", acct.get("agree") === "on");

  const saved = await sw.evaluate(async () => (await chrome.storage.local.get("apCredentials"))?.apCredentials);
  const pair = saved?.[origin];
  check("per-site pair recorded under Saved sign-ins", pair?.email === REG_EMAIL && pair?.password === REG_PASSWORD);

  // 6. The application form fills from the profile, then parks at the user's
  //    Next-page gate — one Autofill click fills every page; the USER turns
  //    each page. Press the panel gate as the user would.
  await pg.waitForFunction(
    () => {
      const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
      const btn = sr?.querySelector("#ap-flow-next");
      const wrap = btn?.closest(".ap-flow-next-wrap");
      return Boolean(wrap && wrap.style.display !== "none");
    },
    null,
    { timeout: 45000 }
  );
  check("form page parked at the user's Next-page gate", true);
  await pg.locator("#ap-flow-next").click({ timeout: 10000 });
  await pg.waitForURL((u) => u.pathname === "/form2", { timeout: 45000 });
  const form = new URL(pg.url()).searchParams;
  check(
    "form page filled from the profile before advancing",
    form.get("first") === "John" && form.get("last") === "Doe" && form.get("email") === "john@example.com",
    `first=${form.get("first")} last=${form.get("last")} email=${form.get("email")} phone=${form.get("phone")}`
  );

  // 7. The final page's Submit is terminal: detected, bound, never clicked.
  await new Promise((r) => setTimeout(r, 6000));
  check("flow stopped at the final page (still on /form2)", new URL(pg.url()).pathname === "/form2", pg.url());
  check("Submit was never clicked (no /submitted hit)", !hits.some((h) => h.startsWith("/submitted")));

  await ctx.close();
  server.close();
  const ok = results.every(Boolean);
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  Multi-page apply flow: entry clicks, account creation, fill, advance, terminal stop.`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
