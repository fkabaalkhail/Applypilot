// Workable question bank builder (GET only). Usage:
//   node test/e2e/tools/qbank-workable.mjs <account,account,...> test/e2e/results/qbank/workable.json [jobsPerAccount=4]
// then: QBANK=test/e2e/results/qbank/workable.json QBANK_URL="https://apply.workable.com/qbank/j/QBANK0001/apply/" \
//   node node_modules/vitest/vitest.mjs run test/qbank.test.ts
// Accounts: prod scraped_jobs urls like apply.workable.com/<account>/ (read-only SELECT).
// Output: the qbank format test/qbank.test.ts reads (Greenhouse vocabulary).
import { writeFileSync } from "node:fs";

const ACCOUNTS = process.argv[2].split(",");
const OUT = process.argv[3];
const PER = Number(process.argv[4] ?? 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
      if (r.status === 429) { await sleep(3000); continue; }
      return r.status === 200 ? await r.json() : null;
    } catch { await sleep(1000); }
  }
  return null;
};

const seenTypes = new Map();
const choiceText = (c) => (typeof c === "string" ? c : c?.body ?? c?.value ?? c?.label ?? c?.name ?? "");
const bank = [];
const seenJobs = new Set();
for (const account of ACCOUNTS) {
  const w = await get(`https://apply.workable.com/api/v1/widget/accounts/${account}`);
  await sleep(300);
  if (!w?.jobs?.length) { console.log(account, "no jobs"); continue; }
  const jobs = [...w.jobs].sort((a, b) => String(b.published_on).localeCompare(String(a.published_on))).slice(0, PER);
  for (const j of jobs) {
    if (seenJobs.has(j.shortcode)) continue;
    seenJobs.add(j.shortcode);
    const form = await get(`https://apply.workable.com/api/v1/jobs/${j.shortcode}/form`);
    await sleep(300);
    if (!Array.isArray(form)) continue;
    const questions = [];
    for (const sec of form) {
      for (const f of sec.fields ?? []) {
        if (!/^(QA|CA)_/.test(f.id)) continue;
        if (!seenTypes.has(f.type)) { seenTypes.set(f.type, JSON.stringify(f).slice(0, 400)); }
        const opts = (f.choices ?? f.options ?? []).map(choiceText).filter(Boolean);
        let type = "input_text";
        let options = [];
        if (f.type === "boolean") { type = "multi_value_single_select"; options = ["Yes", "No"]; }
        else if (f.type === "dropdown" || f.type === "multiple_choice" && !f.multiple) { type = "multi_value_single_select"; options = opts; }
        else if (f.type === "multiple" || f.type === "multiple_choice" && f.multiple) { type = "multi_value_multi_select"; options = opts; }
        else if (f.type === "paragraph") type = "textarea";
        else if (f.type === "file") type = "input_file";
        else if (f.type === "number") type = "input_number";
        else if (f.type === "date") type = "input_date";
        if ((type === "multi_value_single_select" || type === "multi_value_multi_select") && options.length === 0) type = "input_text";
        questions.push({ group: sec.name ?? "", label: String(f.label ?? "").trim(), description: f.helper ?? "", required: !!f.required, name: f.id, type, options });
      }
    }
    const location = [j.city, j.state, j.country].filter(Boolean).join(", ");
    console.log(account, j.shortcode, questions.length, "|", j.title, "|", location);
    if (questions.length) bank.push({ board: account, id: j.shortcode, title: j.title, company: w.name ?? account, location, questions });
  }
}
writeFileSync(OUT, JSON.stringify(bank, null, 1));
console.log("postings", bank.length, "questions", bank.reduce((n, p) => n + p.questions.length, 0));
for (const [t, s] of seenTypes) console.log("TYPE", t, s);
