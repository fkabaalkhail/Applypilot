// node test/e2e/tools/review.cjs test/e2e/results/<run>.json [caseIdSubstring]
// Per case: the extension's own view of every field it touched (its label,
// category, the value it proposed, the outcome), plus what the page holds
// after the fill. Sensitive values are redacted in telemetry, so those show
// the page's value instead.
const r = require(require("path").resolve(process.argv[2]));
const only = process.argv[3];
const short = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
for (const x of r.results) {
  if (only && !x.case.id.includes(only)) continue;
  const tele = x.trace?.telemetry || {};
  const caps = tele.field_captures || [];
  console.log(`\n=== ${x.case.id}  ${x.trace?.error ? "ERR " + short(x.trace.error, 80) : (x.trace?.beats ?? []).slice(-1)[0] ?? ""}`);
  const after = x.after || [];
  for (const c of caps) {
    let v = c.observed_value;
    if (c.redacted || v === "<demographic>") v = "(sensitive)";
    const mark = c.outcome === "filled" ? "*" : c.outcome === "skipped" ? "-" : " ";
    console.log(`  ${mark} ${short(c.outcome, 9).padEnd(9)} ${short(c.category, 18).padEnd(18)} «${short(c.label, 78)}» ${c.outcome === "filled" ? "= " + JSON.stringify(short(v, 60)) : (c.reason ? "(" + short(c.reason, 50) + ")" : "")}${c.options?.length ? "  [" + c.options.slice(0, 5).map((o) => short(o, 18)).join("|") + (c.options.length > 5 ? "|+" + (c.options.length - 5) : "") + "]" : ""}`);
  }
  // EEO values, from the page (telemetry redacts them).
  const eeo = after.filter((f) => /gender|race|ethnic|hispanic|latino|veteran|military|disabilit|pronoun|orientation|lgbt|transgender/i.test(f.label || "") && f.value);
  for (const f of eeo) console.log(`    page: «${short(f.label, 70)}» = ${JSON.stringify(short(f.value, 60))}`);
}
