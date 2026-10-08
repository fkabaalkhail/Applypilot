// node test/e2e/tools/qbank-diff.cjs <old-out.json> <new-out.json> [labelFilterRegex]
// Every answer that changed between two runs of the same question bank
// (test/qbank.test.ts), grouped by question: old -> new per persona and
// posting. Read every line before calling a rule safe.
//   "Yes"   the device's answer      ~abst  kept from the AI on purpose
//   -       no answer from the device ?      the scanner found no control
const path = require("path");
const [oldFile, newFile, filterArg] = process.argv.slice(2);
const filter = filterArg ? new RegExp(filterArg, "i") : null;
const short = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const show = (a) => (!a ? "(gone)" : !a.scanned ? "?" : a.proposed !== null && a.proposed !== undefined ? JSON.stringify(short(a.proposed, 60)) : a.abstained ? "~abst" : "-");

const index = (runs) => {
  const m = new Map();
  for (const r of runs) r.answers.forEach((a, i) => m.set(`${r.board}|${r.id}|${r.persona}|${i}`, { ...a, run: r }));
  return m;
};
const before = index(require(path.resolve(oldFile)));
const after = index(require(path.resolve(newFile)));
const byQ = new Map();
let changed = 0;
for (const [key, a] of after) {
  const b = before.get(key);
  if (a.type === "input_file" || a.type === "input_hidden") continue;
  if (filter && !filter.test(a.label)) continue;
  if (show(b) === show(a) && (b?.category ?? null) === a.category) continue;
  changed++;
  const q = `${short(a.label, 110)}${a.options?.length ? "  [" + a.options.slice(0, 6).map((o) => short(o, 24)).join(" | ") + (a.options.length > 6 ? " | +" + (a.options.length - 6) : "") + "]" : ""}`;
  const list = byQ.get(q) ?? [];
  list.push(`    ${a.run.persona.padEnd(20)} ${show(b)} -> ${show(a)}${(b?.category ?? null) !== a.category ? `  (category ${b?.category ?? "-"} -> ${a.category ?? "-"})` : ""}  ${short(a.run.board, 24)}/${a.run.id}`);
  byQ.set(q, list);
}
for (const [q, lines] of byQ) {
  console.log(`\n«${q}»`);
  for (const l of lines) console.log(l);
}
console.log(`\n${changed} answers changed in ${byQ.size} questions (${after.size} answers compared)`);
