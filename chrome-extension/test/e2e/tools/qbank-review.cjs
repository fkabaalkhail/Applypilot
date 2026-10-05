// node test/e2e/tools/qbank-review.cjs test/e2e/results/qbank/<bank>-out.json [labelFilterRegex] [--all]
// The question bank's answers (test/qbank.test.ts), one line per distinct
// question (same words, same options) with each persona's answer beside it:
//   "Yes"     the device's answer
//   ~abst     kept from the AI on purpose (deviceAbstained)
//   -         no answer from the device (left blank, or to the AI)
//   ?         the scanner found no control for it
// Standard contact and upload fields are left out unless --all is passed.
const path = require("path");
const runs = require(path.resolve(process.argv[2]));
const filter = process.argv[3] && !process.argv[3].startsWith("--") ? new RegExp(process.argv[3], "i") : null;
const all = process.argv.includes("--all");
const STANDARD = /^(first name|last name|preferred (first )?name|email|phone|resume\/cv|resume|cover letter|linkedin profile|website|location \(city\))\*?$/i;
const short = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

const personas = [...new Set(runs.map((r) => r.persona))];
const byQ = new Map();
for (const r of runs) {
  for (const a of r.answers) {
    if (a.type === "input_file" || a.type === "input_hidden") continue;
    if (!all && STANDARD.test(a.label.trim())) continue;
    if (filter && !filter.test(a.label)) continue;
    const key = `${a.label.trim().toLowerCase()}|${a.options.join("|").toLowerCase()}`;
    let q = byQ.get(key);
    if (!q) byQ.set(key, (q = { label: a.label, options: a.options, boards: new Set(), places: new Set(), cats: new Set(), ans: new Map() }));
    q.boards.add(r.board);
    if (r.place?.country) q.places.add(r.place.country);
    if (a.category) q.cats.add(a.category);
    const shown = !a.scanned ? "?" : a.proposed !== null && a.proposed !== undefined ? JSON.stringify(short(a.proposed, 40)) : a.abstained ? "~abst" : "-";
    const per = q.ans.get(r.persona) ?? new Set();
    per.add(shown);
    q.ans.set(r.persona, per);
  }
}
let n = 0;
for (const q of byQ.values()) {
  n++;
  const opts = q.options.length ? `  [${q.options.slice(0, 6).map((o) => short(o, 30)).join(" | ")}${q.options.length > 6 ? ` | +${q.options.length - 6}` : ""}]` : "";
  console.log(`\nQ${n}. ${short(q.label, 160)}${opts}`);
  console.log(`    on: ${[...q.boards].slice(0, 6).join(", ")}${q.boards.size > 6 ? ` +${q.boards.size - 6}` : ""}  job in: ${[...q.places].join(",") || "?"}  as: ${[...q.cats].join(",") || "?"}`);
  console.log("    " + personas.map((p) => `${p.replace(/_/g, "").slice(0, 10)}: ${[...(q.ans.get(p) ?? [])].join(" / ")}`).join("   "));
}
console.log(`\n${n} distinct questions`);
