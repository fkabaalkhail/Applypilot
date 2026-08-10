/**
 * The create-account gate must offer the panel's Continue button.
 *
 * Two independent causes hid it: the posting's "Apply" button (still in the
 * DOM behind the gate) read as the flow's terminal submit, and Workday's live
 * password-rule alerts parked the flow on a `validation` pause that showed no
 * gate. This page reproduces both at once.
 *
 * Usage: npm run test:workday-gate
 */
import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.AP_EXT_DIR || path.resolve(here, "..", "..", "dist");
const REG_EMAIL = "wd-gate@probe.dev";
const REG_PASSWORD = "Probe#Pass123";

const html = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Acme, Workday</title></head><body>${body}</body></html>`;

// Both causes on one page:
//  - `adventureButton` "Apply", the posting's entry button, still in the DOM
//    behind the gate. It matches the terminal verb list, so before the fix the
//    flow called this page's advance "terminal" and finished with no gate.
//  - a visible role="alert" password rule, Workday renders these live while
//    the password is typed, so pauseReason() reports "validation" and the flow
//    parks. Before the fix that pause showed no gate and no press cleared it.
//
// The Apply button sits INSIDE the account container on purpose: the flow only
// searches for an advance within the form scope, and that scope is the lowest
// common ancestor of the recognized fields (formScope.ts). A sibling of the
// account container is outside it, so the flow would never see Apply and the
// page would quietly stop exercising the terminal-Apply cause at all,
// measured, not assumed: with Apply outside, reverting advance.ts still passed.
// Sharing a scope is also what the real page does, and what the unit-level
// regression in advance.test.ts models.
//
// The Create Account button deliberately has NO page-side handler: this probe
// is about the panel offering the gate, not about the site advancing.
const ACCOUNT = html(`
  <h1>Create Account</h1>
  <div data-automation-id="createAccountPage">
    <button data-automation-id="adventureButton">Apply</button>
    <label>Email Address <input data-automation-id="email" type="email" name="email"></label>
    <label>Password <input data-automation-id="password" type="password" name="pw"></label>
    <label>Verify New Password <input data-automation-id="verifyPassword" type="password" name="pw2"></label>
    <div role="alert" id="pwrule">Password must contain a special character.</div>
    <button data-automation-id="createAccountSubmitButton" type="button" id="create">Create Account</button>
  </div>`);

const PAGES = { "/account": ACCOUNT };

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "tailrd-wdgate-"));
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
 *  Workday-host adapter auto-mount doesn't apply here.
 *
 *  TOGGLE_PANEL is a toggle: if this page ever DOES satisfy the auto-mount
 *  evidence gate on its own, a single send would collapse the panel instead of
 *  opening it. Send until the root actually carries `.ap-expanded`. */
async function openPanel(sw, pg, urlPrefix) {
  const expanded = () =>
    pg.evaluate(() =>
      Boolean(
        document
          .getElementById("applypilot-overlay-host")
          ?.shadowRoot?.querySelector(".ap-expanded")
      )
    );
  for (let i = 0; i < 20; i++) {
    if (await expanded()) return;
    await sw.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({ url: `${prefix}/*` });
      if (!tabs.length) return false;
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_PANEL" });
        return true;
      } catch {
        return false; // content script not listening yet
      }
    }, urlPrefix);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("panel never opened in response to TOGGLE_PANEL");
}

/** The gate's live state, read through the panel's shadow root. */
function readGate(pg) {
  return pg.evaluate(() => {
    const sr = document.getElementById("applypilot-overlay-host")?.shadowRoot;
    const btn = sr?.querySelector("#ap-flow-next");
    const wrap = btn?.closest(".ap-flow-next-wrap");
    if (!btn || !wrap) return null;
    const box = wrap.getBoundingClientRect();
    return {
      visible: wrap.style.display !== "none" && box.width > 0 && box.height > 0,
      label: (btn.textContent ?? "").trim(),
      bg: getComputedStyle(btn).backgroundImage,
    };
  });
}

/** Poll until the gate is visible (Playwright's own visibility check does not
 *  reach inside a closed-over shadow tree as reliably as reading it directly). */
async function waitForGate(pg, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readGate(pg).catch(() => null);
    if (last?.visible) return last;
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const results = [];
const check = (label, ok, extra = "") => {
  results.push(ok);
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${extra ? `: ${extra}` : ""}`);
};

async function main() {
  const hits = [];
  const { server, port } = await startServer(hits);
  const origin = `http://127.0.0.1:${port}`;
  let ctx, mode;
  try { ({ ctx, mode } = await launch()); }
  catch (err) { console.log(`ENV-SKIP  ${err.message}`); server.close(); process.exit(2); }
  console.log(`Launched Chromium (${mode}); fake Workday create-account at ${origin}/account`);

  const sw = await getSW(ctx);
  if (!sw) throw new Error("service worker never registered");
  // Sample-data mode (the panel skips the login view) plus the account-creation
  // credentials the panel's Account creation tab would have stored.
  await sw.evaluate(async (cred) => {
    await chrome.storage.local.set({
      ap_config: { useMockData: true },
      apCredentialDefaults: cred,
    });
  }, { email: REG_EMAIL, password: REG_PASSWORD });

  const pg = await ctx.newPage();
  // The flow narrates itself; forwarding those lines makes a failure its own
  // diagnosis instead of a bare timeout.
  pg.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[Tailrd flow]")) console.log(`      ${t}`);
  });
  await pg.goto(`${origin}/account`, { waitUntil: "load" });
  await openPanel(sw, pg, origin);
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

  // 1. The live password-rule alert parks the flow on a `validation` pause.
  //    Before the fix that pause showed nothing at all, the reported symptom.
  const paused = await waitForGate(pg, 30000);
  check(
    "validation pause offers the advance gate",
    Boolean(paused?.visible),
    paused ? `label "${paused.label}"` : "gate element missing"
  );
  if (!paused?.visible) {
    await ctx.close();
    server.close();
    console.log("\nFAIL  no advance gate on the create-account page.");
    process.exit(1);
  }

  // 2. The user judges the password fine and presses Continue; the press
  //    releases the validation pause and the flow reaches the wall's own
  //    advance. That advance must be the page's "Create Account", NOT the
  //    posting's "Apply", which is still in the DOM and reads as terminal.
  //    A terminal advance finishes the flow with no gate at all.
  await pg.locator("#ap-flow-next").click();
  const until = Date.now() + 30000;
  let gate = null;
  for (;;) {
    gate = await waitForGate(pg, Math.max(0, until - Date.now()));
    if (!gate?.visible || /create account/i.test(gate.label) || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("gate returns after the press (flow did not end as terminal)", Boolean(gate?.visible), gate ? `label "${gate.label}"` : "gate hidden");
  check(
    "gate names the wall's own advance",
    Boolean(gate && /create account/i.test(gate.label)),
    gate ? `label "${gate.label}"` : "(none)"
  );
  check(
    "gate is painted with the primary gradient",
    Boolean(gate?.visible && gate.bg.includes("gradient")),
    gate?.visible ? gate.bg : "(gate not on screen)"
  );

  await ctx.close();
  server.close();
  const ok = results.every(Boolean);
  console.log(
    `\n${ok ? "PASS" : "FAIL"}  Workday create-account gate: gate visible on the validation pause, ` +
      `press released it, gate names "Create Account" in the primary gradient.`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
