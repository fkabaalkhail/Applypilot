/**
 * Loads a REAL react-select (React 18 + react-select from esm.sh) into Chromium,
 * injects the shipping dist/mainWorld.js, dispatches a fill request over the
 * bridge, and asserts the value commits through the widget's own React state —
 * the exact path jsdom cannot exercise.
 *
 * Usage: npm run build && node test/browser/react-select-driver.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN_WORLD = readFileSync(path.join(here, "..", "..", "dist", "mainWorld.js"), "utf8");
const FIELD_ID_ATTR = "data-ap-field";

const PAGE = `<!doctype html><html><body><div id="root"></div>
<script type="module">
  import React from "https://esm.sh/react@18";
  import { createRoot } from "https://esm.sh/react-dom@18/client";
  import Select from "https://esm.sh/react-select@5?deps=react@18,react-dom@18";
  const options = [{value:"us",label:"United States"},{value:"ca",label:"Canada"},{value:"mx",label:"Mexico"}];
  function App(){
    const [v,setV] = React.useState(null);
    const wrapRef = React.useRef(null);
    React.useEffect(() => {
      // react-select@5's own root only carries an emotion-generated
      // "css-<hash>-container" class (no BEM "rs__container" class exists even
      // with classNamePrefix set) — so anchor from the reliably-prefixed
      // ".rs__control" and climb to ITS nearest "-container"/"__container"
      // ancestor, the same way the driver itself resolves the container. Tag
      // THAT real node with FIELD_ID_ATTR so the driver's own
      // el.closest('[class*="-container"]') lands on react-select's actual
      // subtree (and thus its Fiber), not an artificial wrapper.
      const control = wrapRef.current?.querySelector(".rs__control");
      const real = control?.closest('[class*="-container"], [class*="__container"]');
      if (real) real.setAttribute("${FIELD_ID_ATTR}", "rs-real-1");
    }, []);
    return React.createElement("div", { ref: wrapRef },
      React.createElement(Select, { classNamePrefix:"rs", options, value:v, onChange:setV }),
      React.createElement("div", { id:"chosen" }, v ? v.label : ""));
  }
  createRoot(document.getElementById("root")).render(React.createElement(App));
  window.__ready = true;
</script></body></html>`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => console.log(`[page:${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.error("[pageerror]", err));
  await page.setContent(PAGE);
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForSelector(".rs__control");
  // Wait for the fixture's effect to tag react-select's real container with
  // FIELD_ID_ATTR (see comment above) before the driver goes looking for it.
  await page.waitForSelector(`[data-ap-field="rs-real-1"]`);
  await page.addScriptTag({ content: MAIN_WORLD });

  const start = Date.now();
  const committed = await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener("tailrd:mw:result", (e) => resolve(e.detail), { once: true });
    window.dispatchEvent(new CustomEvent("tailrd:mw:fill", {
      detail: { id: 1, fieldId: "rs-real-1", value: "Canada", kind: "react-select" },
    }));
    setTimeout(() => resolve({ ok: false, reason: "timeout" }), 4000);
  }));
  const elapsedMs = Date.now() - start;

  const shown = await page.textContent("#chosen");
  await browser.close();

  const ok = committed.ok && String(shown).trim() === "Canada";
  // Fiber path (`selectOption`/`onChange` called directly) resolves near-instantly;
  // the DOM fallback (open → filter → click) has two internal sleeps (~90ms) plus
  // real event dispatch, so a >=80ms round trip is a strong signal it took over.
  const likelyPath = elapsedMs >= 80 ? "DOM fallback (slow path)" : "React Fiber (selectOption/onChange)";
  console.log(`react-select driver: committed=${JSON.stringify(committed)} shown="${shown}" elapsedMs=${elapsedMs} likelyPath=${likelyPath} → ${ok ? "✅ PASS" : "❌ FAIL"}`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
