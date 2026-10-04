// node test/e2e/tools/fails.cjs test/e2e/results/<run>.json [idSubstring]
// Full keys of every failing row and unexpected write, for pinning or fixing.
const r = require(require("path").resolve(process.argv[2]));
const only = process.argv[3];
for (const x of r.results) {
  if (only && !x.case.id.includes(only)) continue;
  if (x.ev.ok) continue;
  console.log(`=== ${x.case.id}  (${x.case.file || ""})  ${x.ev.pass}/${x.ev.total}${x.trace?.error ? "  ERR " + String(x.trace.error).slice(0, 100) : ""}`);
  for (const row of x.ev.rows) if (row.status !== "PASS") console.log(`  ${row.status.padEnd(8)} ${JSON.stringify(row.key)}  expected ${row.expected}  got ${JSON.stringify(row.actual)}`);
  for (const u of x.ev.unexpected) console.log(`  UNEXPECTED ${JSON.stringify(u.key)}  = ${JSON.stringify(u.actual)}  «${String(u.label || "").slice(0, 70)}»`);
}
