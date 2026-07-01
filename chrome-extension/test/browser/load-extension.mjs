/**
 * Full-extension smoke: load the BUILT, packaged extension (dist/) into a real
 * Chromium, navigate to a job-application form served over http, and confirm the
 * shipped artifact actually (a) registers its MV3 service worker, (b) injects its
 * content script, and (c) auto-mounts the in-page overlay when it detects fields.
 *
 * This complements run.mjs (which exercises the fill engine directly): here we
 * prove the real extension boots and detects forms end-to-end in the browser.
 *
 * Usage: node test/browser/load-extension.mjs   (run `npm run build` first)
 */
import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "..", "dist");

const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Careers — Apply</title></head>
<body>
  <h1>Apply for Software Engineer</h1>
  <form id="application">
    <div><label for="first">First Name</label><input id="first" name="first" type="text"></div>
    <div><label for="last">Last Name</label><input id="last" name="last" type="text"></div>
    <div><label for="email">Email</label><input id="email" name="email" type="email"></div>
    <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
    <div><label for="ctry">Country</label>
      <select id="ctry" name="country"><option value="">Select…</option>
        <option>United States</option><option>Canada</option><option>Mexico</option></select></div>
    <div><label for="cover">Cover Letter</label><textarea id="cover" name="cover"></textarea></div>
  </form>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FORM_HTML);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function launchWithExtension() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tailrd-ext-"));
  const base = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"];
  // Extensions only load in the FULL chromium binary (headless:false). To run
  // without a display we add --headless=new (the new headless DOES support
  // extensions); if that fails we fall back to a real headed window.
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

async function main() {
  const { server, port } = await startServer();
  const url = `http://127.0.0.1:${port}/apply`;
  let ctx, mode;
  try {
    ({ ctx, mode } = await launchWithExtension());
  } catch (err) {
    console.log(`❌ ENV-SKIP  ${err.message}`);
    server.close();
    process.exit(2); // distinguishable: environment can't load extensions
  }

  console.log(`Launched Chromium (${mode}); extension dir: ${EXT}`);
  const sw = await getServiceWorker(ctx);
  const swOk = Boolean(sw);
  console.log(`   service worker registered: ${swOk ? "✅" : "❌"}${sw ? ` (${sw.url().split("/").pop()})` : ""}`);

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });

  // The content script runs at document_idle in its own ISOLATED world, so its
  // window globals are invisible to page.evaluate (the page's main world). Its
  // observable, cross-world output is the overlay host it injects into the shared
  // DOM — that element's presence proves the content script ran AND detected the
  // form (the overlay only mounts when >=1 field is recognized).
  const overlayMounted = await page
    .waitForFunction(() => Boolean(document.getElementById("applypilot-overlay-host")), null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  console.log(`   content script ran + form detected (overlay auto-mounted): ${overlayMounted ? "✅" : "❌"}`);

  // Confirm the overlay actually rendered the autofill UI inside its shadow root.
  const uiRendered = overlayMounted
    ? await page.evaluate(() => {
        const host = document.getElementById("applypilot-overlay-host");
        const sr = host && host.shadowRoot;
        return Boolean(sr && sr.childElementCount > 0);
      })
    : false;
  console.log(`   overlay UI rendered in shadow root: ${uiRendered ? "✅" : "❌"}`);

  await ctx.close();
  server.close();

  const ok = swOk && overlayMounted && uiRendered;
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  Packaged extension boots, injects, and detects the form in real Chromium.`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
