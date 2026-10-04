// Write generated pins (pins-from-run.cjs) into a case file whose cases are
// written `live({ id: "...", ... })` and have no `expect:` yet.
// node test/e2e/tools/write-pins.cjs test/e2e/cases/<file>.mjs <pins.json> [<notes.json>]
// pins.json: { caseId: [[key, value|null, label], ...] } (pins-from-run.cjs)
// notes.json (optional): { caseId: { key: "// comment line" } } placed above a pin.
const fs = require("fs");
const file = process.argv[2];
const pins = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const notes = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], "utf8")) : {};
let s = fs.readFileSync(file, "utf8");
let done = 0;
for (const [id, list] of Object.entries(pins)) {
  const start = s.indexOf(`live({ id: "${id}",`);
  if (start < 0) {
    console.error("no case", id);
    continue;
  }
  const end = s.indexOf("}),", start);
  const head = s.slice(start, end).replace(/\s+$/, "");
  if (head.includes("expect:")) {
    console.error("already pinned", id);
    continue;
  }
  const lines = [];
  for (const [key, value] of list) {
    const note = notes[id]?.[key];
    if (note) lines.push(`      ${note}`);
    const shown = value === null ? "null" : typeof value === "object" ? `{ re: String.raw\`${value.re}\` }` : JSON.stringify(value);
    lines.push(`      ${JSON.stringify(key)}: ${shown},`);
  }
  const replacement = `${head.replace(/^live\(\{ /, "live({\n    ").replace(/, (ats|profile|url|allowRequests): /g, ",\n    $1: ")},\n    expect: {\n${lines.join("\n")}\n    },\n  })`;
  s = s.slice(0, start) + replacement + s.slice(end + 2);
  done++;
}
fs.writeFileSync(file, s);
console.log("pinned", done);
