// node test/e2e/tools/rundiff.cjs <old run.json> <new run.json> [idSubstring]
// Per case, the fields whose page value changed between two runs (what a code
// change did to real pages).
const path = require("path");
const a = require(path.resolve(process.argv[2]));
const b = require(path.resolve(process.argv[3]));
const only = process.argv[4];
const short = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
for (const x of b.results) {
  if (only && !x.case.id.includes(only)) continue;
  const old = a.results.find((y) => y.case.id === x.case.id);
  if (!old) { console.log(`=== ${x.case.id}: no earlier run`); continue; }
  const before = new Map(old.after.map((f) => [f.key, f]));
  const lines = [];
  for (const f of x.after) {
    const o = before.get(f.key);
    const ov = o ? String(o.value ?? "") : "(absent)";
    if (ov !== String(f.value ?? "")) lines.push(`  ${short(f.label, 70).padEnd(70)} ${JSON.stringify(short(ov, 40))} -> ${JSON.stringify(short(f.value, 40))}`);
  }
  const now = new Set(x.after.map((f) => f.key));
  for (const o of old.after) if (!now.has(o.key) && o.value) lines.push(`  ${short(o.label, 70).padEnd(70)} ${JSON.stringify(short(o.value, 40))} -> (absent)`);
  console.log(`=== ${x.case.id}: ${lines.length} changed`);
  for (const l of lines) console.log(l);
}
