// Ashby question bank builder. Usage:
//   node test/e2e/tools/qbank-ashby.mjs <board,board,...> test/e2e/results/qbank/ashby.json [jobsPerBoard=1]
// then: QBANK=test/e2e/results/qbank/ashby.json QBANK_URL="https://jobs.ashbyhq.com/qbank/00000000-0000-0000-0000-000000000000/application" \
//   node node_modules/vitest/vitest.mjs run test/qbank.test.ts
// Boards: prod scraped_jobs urls like jobs.ashbyhq.com/<board>/ (read-only SELECT).
// Reads only: the public posting API (GET) lists a board's jobs; each form
// comes from the ApiJobPosting GraphQL QUERY the application page itself runs
// (never a mutation). Output: the qbank format (Greenhouse vocabulary).
import { writeFileSync } from "node:fs";

const BOARDS = process.argv[2].split(",").map((b) => decodeURIComponent(b.trim())).filter(Boolean);
const OUT = process.argv[3];
const PER = Number(process.argv[4] ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json", ...(init?.headers ?? {}) } });
      if (r.status === 429) { await sleep(3000); continue; }
      return r.status === 200 ? await r.json() : null;
    } catch { await sleep(1000); }
  }
  return null;
}

const ENTRY = "fieldEntries { ... on FormFieldEntry { id field isRequired descriptionHtml isHidden } }";
const POSTING_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title locationName workplaceType
    applicationForm { sections { title isHidden ${ENTRY} } }
    surveyForms { sections { title isHidden ${ENTRY} } }
  }
}`;
const ORG_QUERY = `query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!) {
  organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName) { name }
}`;
const graphql = (op, query, variables) =>
  request(`https://jobs.ashbyhq.com/api/non-user-graphql?op=${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationName: op, variables, query }),
  });

const text = (html) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const seenTypes = new Map();

function question(group, e) {
  const f = e.field ?? {};
  if (!seenTypes.has(f.type)) seenTypes.set(f.type, JSON.stringify(f).slice(0, 300));
  const options = (f.selectableValues ?? []).map((v) => String(v.label ?? "")).filter(Boolean);
  let type = "input_text";
  let opts = [];
  if (f.type === "Boolean") { type = "multi_value_single_select"; opts = ["Yes", "No"]; }
  else if (f.type === "ValueSelect") { type = "multi_value_single_select"; opts = options; }
  else if (f.type === "MultiValueSelect") { type = "multi_value_multi_select"; opts = options; }
  else if (f.type === "LongText") type = "textarea";
  else if (f.type === "Number") type = "input_number";
  else if (f.type === "Date") type = "input_date";
  else if (f.type === "File") type = "input_file";
  else if (f.type === "EducationHistory" || f.type === "Score") return null;
  if ((type === "multi_value_single_select" || type === "multi_value_multi_select") && opts.length === 0) type = "input_text";
  return { group: e.isHidden ? `${group} (shown by another answer)` : group, label: String(f.title ?? "").trim(), description: text(e.descriptionHtml), required: !!e.isRequired, name: f.path ?? f.id ?? "", type, options: opts };
}

const bank = [];
for (const board of BOARDS) {
  const list = await request(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`);
  await sleep(300);
  const jobs = (list?.jobs ?? []).filter((j) => j.isListed !== false).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, PER);
  if (jobs.length === 0) { console.log(board, "no jobs"); continue; }
  const org = await graphql("ApiOrganizationFromHostedJobsPageName", ORG_QUERY, { organizationHostedJobsPageName: board });
  await sleep(300);
  const company = org?.data?.organization?.name ?? board;
  for (const j of jobs) {
    const res = await graphql("ApiJobPosting", POSTING_QUERY, { organizationHostedJobsPageName: board, jobPostingId: j.id });
    await sleep(300);
    const p = res?.data?.jobPosting;
    if (!p) { console.log(board, j.id, "no form", JSON.stringify(res?.errors ?? "").slice(0, 160)); continue; }
    const questions = [];
    for (const [form, groupName] of [[p.applicationForm, "Application"], ...(p.surveyForms ?? []).map((s) => [s, "Survey"])]) {
      for (const s of form?.sections ?? []) {
        for (const e of s.fieldEntries ?? []) {
          const q = question(s.title || groupName, e);
          if (q && q.label) questions.push(q);
        }
      }
    }
    const a = j.address?.postalAddress ?? {};
    const location = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", ") || p.locationName || j.location || "";
    console.log(board, j.id, questions.length, "|", p.title, "|", location);
    if (questions.length) bank.push({ board, id: j.id, title: p.title, company, location, questions });
  }
}
writeFileSync(OUT, JSON.stringify(bank, null, 1));
console.log("postings", bank.length, "questions", bank.reduce((n, p) => n + p.questions.length, 0));
for (const [t, s] of seenTypes) console.log("TYPE", t, s);
