/**
 * Reproduces the reported Workday create-account failure in real Chromium with
 * the packaged extension, and proves the fix.
 *
 * The `/account` page mimics Workday's create-account gate:
 *  - password + verifyPassword inputs tagged only by data-automation-id
 *  - a consent checkbox that is `data-automation-id="createAccountCheckbox"`,
 *    visually hidden, NOT `required`, and has NO agreement-worded label — the
 *    exact shape the old filter skipped ("0 agreement boxes")
 *  - a "Create Account" button whose page-side handler refuses to submit unless
 *    the consent box is checked AND both passwords are filled and match
 *
 * Before the fix the consent box was never ticked, so the button did nothing
 * and the flow stopped. This asserts the extension ticks it and advances.
 *
 * Usage: npm run build && node test/browser/workday-account-probe.mjs
 */
import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "..", "dist");
const REG_EMAIL = "wd-e2e@probe.dev";
const REG_PASSWORD = "Probe#Pass123";

const html = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Acme — Workday</title></head><body>${body}</body></html>`;

// The consent checkbox is hidden and unlabelled — only its automation-id marks
// it. The page script gates Create Account on it, exactly like Workday.
const ACCOUNT = html(`
  <h1>Create Account</h1>
  <div data-automation-id="createAccountPage">
    <label>Email Address <input data-automation-id="email" type="email" name="email"></label>
    <label>Password <input data-automation-id="password" type="password" name="pw"></label>
    <label>Verify New Password <input data-automation-id="verifyPassword" type="password" name="pw2"></label>
    <span data-automation-id="createAccountCheckbox" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">
      <input type="checkbox" data-automation-id="createAccountCheckbox" id="consent">
    </span>
    <button data-automation-id="createAccountSubmitButton" type="button" id="create">Create Account</button>
  </div>
  <script>
    document.getElementById('create').addEventListener('click', function () {
      var pw = document.querySelector('[data-automation-id="password"]').value;
      var pw2 = document.querySelector('[data-automation-id="verifyPassword"]').value;
      var ok = document.getElementById('consent').checked && pw && pw === pw2;
      // Workday's real gate: nothing happens unless consent + valid passwords.
      if (ok) location.href = '/form';
    });
  </script>`);

const FORM = html(`
  <h1>My Information</h1>
  <form action="/done" method="get">
    <label>First Name <input name="first" type="text"></label>
    <label>Last Name <input name="last" type="text"></label>
    <button data-automation-id="pageFooterNextButton" type="submit">Next</button>
  </form>`);

const PAGES = { "/account": ACCOUNT, "/form": FORM, "/done": html("<h1>Done</h1>") };

function startServer(hits) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      hits.push(u.pathname);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGES[u.pathname] ?? html("<h1>404</h1>"));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function launch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tailrd-wd-"));
  const base = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"];
  for (const m of [
    { label: "headless=new", opts: { headless: false, args: [...base, "--headless=new"] } },
    { label: "headed", opts: { headless: false, args: base } },
  ]) {
    try {
      return { ctx: await chromium.launchPersistentContext(dir, m.opts), mode: m.label };
    } catch (err) {
      console.log(`   launch (${m.label}) failed: ${err.message.split("\n")[0]}`);
    }
  }
  throw new Error("could not launch Chromium with the extension");
}

async function getSW(ctx) {
  const cur = ctx.serviceWorkers();
  if (cur.length) return cur[0];
  return Promise.race([
    ctx.waitForEvent("serviceworker").catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 8000)),
  ]);
}

/** Open the panel the way the toolbar icon does (retry until the content
 *  script is listening). The fake gate is served from 127.0.0.1, so the
 *  Workday-host adapter auto-mount doesn't apply here. */
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
const check = (label, ok, extra = "") => {
  results.push(ok);
  console.log(`   ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

async function main() {
  const hits = [];
  const { server, port } = await startServer(hits);
  const origin = `http://127.0.0.1:${port}`;
  let ctx, mode;
  try { ({ ctx, mode } = await launch()); }
  catch (err) { console.log(`❌ ENV-SKIP  ${err.message}`); server.close(); process.exit(2); }
  console.log(`Launched Chromium (${mode}); fake Workday create-account at ${origin}/account`);

  const sw = await getSW(ctx);
  if (!sw) throw new Error("service worker never registered");
  // Seed sample-data mode (so the panel skips the login view and auto-opens
  // with the mock profile) and the account-creation credentials the panel's
  // Account creation tab would store.
  await sw.evaluate(async (cred) => {
    await chrome.storage.local.set({
      ap_config: { useMockData: true },
      apCredentialDefaults: cred,
    });
  }, { email: REG_EMAIL, password: REG_PASSWORD });

  const pg = await ctx.newPage();
  await pg.goto(`${origin}/account`, { waitUntil: "load" });
  // A bare email+password gate is no job-application evidence, and 127.0.0.1
  // is not a Workday host — the panel no longer auto-mounts here (on real
  // Workday the host-matched adapter mounts it). Open it as the user would.
  await togglePanel(sw, origin);
  await pg.waitForSelector("#applypilot-overlay-host", { state: "attached", timeout: 10000 });
  await pg.waitForFunction(
    () => {
      const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
      const b = sr?.querySelector("#ap-btn-autofill");
      return b && !b.disabled;
    },
    null,
    { timeout: 15000 }
  );

  await pg.locator("#ap-btn-autofill").click();

  // The whole point: the flow ticks the hidden consent box, the page-side gate
  // passes, and Create Account navigates to the form. Before the fix this timed
  // out on /account.
  const advanced = await pg
    .waitForURL((u) => u.pathname === "/form", { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check("create-account advanced to the form (consent ticked, gate passed)", advanced, pg.url());

  const consentWasChecked = hits.includes("/form"); // only reachable if consent passed
  check("Create Account was actually submitted (server served /form)", consentWasChecked);

  await ctx.close();
  server.close();
  const ok = results.every(Boolean);
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  Workday create-account: hidden consent checkbox ticked, gated submit advanced.`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
