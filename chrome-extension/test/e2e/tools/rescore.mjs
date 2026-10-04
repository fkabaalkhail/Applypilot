// Re-score a saved e2e run (results/<name>.json) against the CURRENT case
// expectations, without re-running the browser. Usage:
//   node test/e2e/tools/rescore.mjs test/e2e/results/<run>.json [idFilter]
// Use after editing pins to confirm a saved run now passes.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
const only = process.argv[3];
const e2e = path.resolve(path.dirname(path.resolve(file)), "..");
const { evaluateCase, formatCase } = await import(pathToFileURL(path.join(e2e, "evaluate.mjs")).href);

const cases = new Map();
for (const f of readdirSync(path.join(e2e, "cases")).filter((f) => f.endsWith(".mjs")).sort()) {
  const mod = await import(pathToFileURL(path.join(e2e, "cases", f)).href + `?t=${Date.now()}`);
  const list = typeof mod.default === "function" ? await mod.default() : mod.default;
  for (const c of list ?? []) cases.set(c.id, c);
}

const saved = JSON.parse(readFileSync(file, "utf8"));
let pass = 0;
let total = 0;
let casesOk = 0;
let n = 0;
for (const r of saved.results) {
  if (only && !r.case.id.includes(only)) continue;
  const id = r.case.id.replace(/^x-/, "live-complete-").replace(/^fresh3-/, "live-fresh-");
  const c = cases.get(id);
  if (!c || Object.keys(c.expect ?? {}).length === 0) continue; // exploration cases have no expectations
  // Framework-state cases read the app's own state at run time; the saved JSON
  // does not keep it, so their verdict is the run's own.
  const ev = c.stateSelector ? r.ev : evaluateCase(c, { before: r.before, after: r.after, trace: r.trace });
  n++;
  pass += ev.pass;
  total += ev.total;
  if (ev.ok) casesOk++;
  else console.log(formatCase(ev, r.trace));
}
console.log(`\nRESCORED ${n} cases: ${casesOk} ok, checks ${pass}/${total} (${total ? Math.round((100 * pass) / total) : 0}%)`);
