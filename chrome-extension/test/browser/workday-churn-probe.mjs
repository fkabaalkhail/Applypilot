/**
 * Reproduces the #1 live Workday failure from prod telemetry — "Field no longer
 * found — rescan the page" — where the multi-page flow lands on a form that is
 * still a loading skeleton and swaps in the real labelled fields a beat later.
 * Filling during that churn captures throwaway controls (or nothing), so the
 * real fields end up empty.
 *
 * The flow enters via "Apply Now" (real navigation), then lands on /form which
 * shows "Loading…" and only mounts the real First/Last/Email inputs after 700ms.
 * With settle-before-fill the flow waits for the real form, then fills it.
 *
 * Usage: npm run build && node test/browser/workday-churn-probe.mjs
 */
import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "..", "dist");

const html = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers</title></head><body>${body}</body></html>`;

const PAGES = {
  "/start": html(`<h1>Software Engineer</h1><a href="/form" id="apply">Apply Now</a>`),
  // A form that mounts as a loading skeleton and swaps in the REAL labelled
  // fields 700ms later — Workday's skeleton→real render, which the fill races.
  "/form": html(`
    <h1>My Information</h1>
    <form action="/done" method="get">
      <div id="slot"><p>Loading your application…</p></div>
      <button type="submit">Submit application</button>
    </form>
    <script>
      // Real Workday re-renders the form section repeatedly as it hydrates —
      // each render REPLACES the input nodes (new elements). A fill in flight
      // during this window is left holding detached controls / stale ids.
      var real =
        '<label>First Name <input name="first" type="text"></label>' +
        '<label>Last Name <input name="last" type="text"></label>' +
        '<label>Email <input name="email" type="email"></label>';
      var slot = document.getElementById('slot');
      // Mount the real fields quickly, then keep replacing the nodes (fresh
      // elements each time) through the typical fill window, then go stable.
      [250, 600, 1000, 1500, 2100].forEach(function (t) {
        setTimeout(function () { slot.innerHTML = real; }, t);
      });
    </script>`),
  "/done": html("<h1>Done</h1>"),
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGES[u.pathname] ?? html("<h1>404</h1>"));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function launch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tailrd-churn-"));
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

async function togglePanel(sw, prefix) {
  for (let i = 0; i < 20; i++) {
    const ok = await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({ url: `${p}/*` });
      if (!tabs.length) return false;
      try { await chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_PANEL" }); return true; }
      catch { return false; }
    }, prefix);
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
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  let ctx, mode;
  try { ({ ctx, mode } = await launch()); }
  catch (err) { console.log(`❌ ENV-SKIP  ${err.message}`); server.close(); process.exit(2); }
  console.log(`Launched Chromium (${mode}); churning form at ${origin}/form`);

  const sw = await getSW(ctx);
  if (!sw) throw new Error("service worker never registered");
  await sw.evaluate(async () => { await chrome.storage.local.set({ ap_config: { useMockData: true } }); });

  const pg = await ctx.newPage();
  const churnLogs = [];
  pg.on("console", (m) => {
    const t = m.text();
    if (/no longer found|drift|Field was removed|\[Tailrd flow\]/i.test(t)) churnLogs.push(t);
  });
  await pg.goto(`${origin}/start`, { waitUntil: "load" });
  await togglePanel(sw, origin);
  await pg.waitForSelector("#applypilot-overlay-host", { state: "attached", timeout: 10000 });
  await pg.locator("#ap-btn-use-mock").click({ timeout: 10000 }).catch(() => {});
  await pg.waitForFunction(
    () => {
      const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
      const b = sr?.querySelector("#ap-btn-autofill");
      return b && !b.disabled;
    },
    null,
    { timeout: 15000 }
  );

  // Autofill → flow clicks Apply Now → lands on the churning /form → fills.
  await pg.locator("#ap-btn-autofill").click();
  await pg.waitForURL((u) => u.pathname === "/form", { timeout: 20000 });

  // Give the flow time to fill through the churn window (last swap at ~2.1s).
  await pg.waitForTimeout(9000);
  const first = await pg.locator('input[name="first"]').inputValue().catch(() => "");
  const last = await pg.locator('input[name="last"]').inputValue().catch(() => "");
  const staleSeen = churnLogs.some((t) => /no longer found|Field was removed/i.test(t));
  console.log(`   · "field no longer found"/removed seen in logs: ${staleSeen}`);
  check("real First Name field filled after the churn settles", first === "John", `first="${first}"`);
  check("real Last Name field filled after the churn settles", last === "Doe", `last="${last}"`);

  await ctx.close();
  server.close();
  const ok = results.every(Boolean);
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  Workday churn: flow waits for the real form and fills it (no stale-skeleton race).`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
