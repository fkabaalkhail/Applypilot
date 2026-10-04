// Pinned expectations from a REVIEWED run (read every write first, with
// review.cjs): every value the page holds after the fill, plus the questions
// deliberately left blank (PIN_BLANK). Review the output before writing it.
// node test/e2e/tools/pins-from-run.cjs test/e2e/results/<run>.json [...] > pins.json
const results = process.argv.slice(2).flatMap((p) => require(require("path").resolve(p)).results);
const GENERIC = /^(type your response|start typing|select\.\.\.|search schools|yesno|pick date|e\.g\.|month\.\.\.|year\.\.\.)/i;
const PIN_BLANK =
  /authorized to work|work authori[sz]ed|legally entitled|sponsorship|consent|arbitrat|agreement|u\.s\. citizen|gender|race|ethnicity|veteran|military|disability|lgbtq|hispanic|orientation|transgender|pronoun|government employee|clearance|high school|notetaker|expected graduation|degree are you (currently )?pursuing|end date|if yes|if no|^other$|please specify/i;
// As the evaluator reads labels: spaces collapsed, a trailing ✱/* dropped (one inside stays).
const norm = (s) => (s || "").replace(/\s+/g, " ").replace(/[\s*✱]+$/, "").trim();
const out = {};
// The dumper now numbers a repeated label key ("label=Search schools...#2");
// dumps made before that are numbered here the same way, in page order.
const numberLabels = (list) => {
  const seen = new Map();
  for (const f of list) {
    if (!/^label=/.test(f.key) || /#\d+$/.test(f.key)) continue;
    const n = (seen.get(`${f.frame}|${f.key}`) || 0) + 1;
    seen.set(`${f.frame}|${f.key}`, n);
    if (n > 1) f.key = `${f.key}#${n}`;
  }
};
for (const x of results) {
  numberLabels(x.before || []);
  numberLabels(x.after);
  const before = new Map((x.before || []).map((f) => [`${f.frame}|${f.key}`, f.value ?? ""]));
  const count = new Map();
  for (const f of x.after) {
    const l = norm(f.label).toLowerCase();
    count.set(l, (count.get(l) || 0) + 1);
  }
  const pins = [];
  const used = new Set();
  for (const f of x.after) {
    if (f.type === "file" || /recaptcha|captcha/i.test(f.key)) continue;
    const label = norm(f.label);
    const changed = String(f.value ?? "") !== String(before.get(`${f.frame}|${f.key}`) ?? "");
    const pinBlank = !changed && !f.value && f.visible !== false && PIN_BLANK.test(label);
    if (!changed && !pinBlank) continue;
    const dup = (count.get(label.toLowerCase()) || 0) > 1;
    // "label:" matches the FIRST label containing the text: a label inside
    // another field's ("Name" in "Full name") is pinned by the dump's own key.
    const inside = x.after.some((o) => o !== f && norm(o.label).toLowerCase() !== label.toLowerCase() && norm(o.label).toLowerCase().includes(label.toLowerCase()));
    let key = f.key;
    if (label && !GENERIC.test(label) && !dup && !inside && label.length <= 200) {
      key = f.type === "radio" || f.type === "aria-radiogroup" ? `${f.type}~${label.slice(0, 60)}` : `label:${label.slice(0, 60)}`;
    }
    // Ashby's radio keys carry ids regenerated on every load: by label always.
    if (/^radio=[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key) && label) key = `radio~${label.slice(0, 60)}`;
    if (used.has(key)) continue;
    used.add(key);
    // A date moves with the clock (today's signature date; a start date that
    // has passed becomes today): pinned by its shape, not its day.
    const v = changed ? String(f.value) : null;
    const DATE = /^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}|\d{2} [A-Z][a-z]{2} \d{4})$/;
    pins.push([key, v !== null && DATE.test(v) ? { re: DATE.source } : v, label.slice(0, 90)]);
  }
  out[x.case.id] = pins;
}
console.log(JSON.stringify(out, null, 1));
