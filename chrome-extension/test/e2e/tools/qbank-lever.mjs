// Lever question bank builder. Usage:
//   node test/e2e/tools/qbank-lever.mjs <board[:jobs],board,...> test/e2e/results/qbank/lever.json [jobsPerBoard=1]
// then: QBANK=test/e2e/results/qbank/lever.json QBANK_URL="https://jobs.lever.co/qbank/00000000-0000-0000-0000-000000000000/apply" \
//   node node_modules/vitest/vitest.mjs run test/qbank.test.ts
// Boards: prod scraped_jobs urls like jobs.lever.co/<board>/ (read-only SELECT).
// Reads only (GET): the public postings API lists a board's jobs, and each
// posting's own /apply page is read as served, every question as the page
// shows it (standard fields, custom cards, the EEO survey). Postings whose
// question sets repeat one already taken are skipped. Output: the qbank
// format (Greenhouse vocabulary).
import { writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const BOARDS = process.argv[2].split(",").map((b) => b.trim()).filter(Boolean);
const OUT = process.argv[3];
const PER = Number(process.argv[4] ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" };

async function get(url, kind) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 429) { await sleep(4000); continue; }
      if (r.status !== 200) return null;
      return kind === "json" ? await r.json() : await r.text();
    } catch { await sleep(1000); }
  }
  return null;
}

const clean = (s) => String(s ?? "").replace(/✱/g, "").replace(/\s+/g, " ").trim();

/** The company a served page names: its logo's alt text, else its title. */
function companyOf(doc) {
  const alt = clean(doc.querySelector(".main-header-logo img")?.getAttribute("alt")).replace(/\s+logo$/i, "");
  return alt || clean(doc.title.split(" - ")[0]);
}

/** Every question of one served apply page, in page order. */
function questionsOf(doc) {
  const templates = new Map();
  for (const h of doc.querySelectorAll('input[type="hidden"][name$="[baseTemplate]"]')) {
    const card = h.name.slice("cards[".length, h.name.indexOf("]"));
    try { templates.set(card, JSON.parse(h.value)); } catch { /* unreadable card: the page text stands */ }
  }
  const out = [];
  for (const section of doc.querySelectorAll("form .application-form")) {
    const group = clean(section.querySelector("h4")?.textContent) || "Application";
    for (const q of section.querySelectorAll(".application-question")) {
      const controls = Array.from(q.querySelectorAll("input, select, textarea")).filter((c) => c.type !== "hidden");
      if (controls.length === 0) continue;
      const first = controls[0];
      const name = first.name || "";
      const m = /^cards\[([^\]]+)\]\[field(\d+)\]/.exec(name);
      const field = m ? templates.get(m[1])?.fields?.[Number(m[2])] : null;
      const shown = clean(q.querySelector(".application-label")?.textContent);
      const label = clean(field?.text) || shown;
      if (!label) continue;
      const description = clean(field?.description);
      const required = Boolean(field?.required) || Boolean(q.querySelector(".required"));
      let type = "input_text";
      let options = [];
      if (first.type === "file") type = "input_file";
      else if (first.tagName === "TEXTAREA") type = "textarea";
      else if (first.type === "radio") {
        type = "multi_value_single_select";
        options = controls.filter((c) => c.type === "radio").map((c) => clean(c.closest("label")?.textContent) || c.value);
      } else if (first.type === "checkbox") {
        type = "multi_value_multi_select";
        options = controls.filter((c) => c.type === "checkbox").map((c) => clean(c.closest("label")?.textContent) || c.value);
      } else if (first.tagName === "SELECT") {
        type = "multi_value_single_select";
        options = Array.from(first.options).filter((o) => o.value !== "").map((o) => clean(o.textContent));
      }
      if (type.startsWith("multi_value") && options.length === 0) type = "input_text";
      out.push({ group, label, description, required, name, type, options });
    }
  }
  // "Additional information" is a bare textarea outside any question block.
  const comments = doc.querySelector('textarea[name="comments"]');
  if (comments && !out.some((q) => q.name === "comments")) {
    out.push({ group: "Additional information", label: "Additional information", description: "", required: false, name: "comments", type: "textarea", options: [] });
  }
  return out;
}

const bank = [];
const seenSets = new Set();
for (const spec of BOARDS) {
  const [board, n] = spec.split(":");
  const want = Number(n ?? PER);
  const list = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`, "json");
  await sleep(400);
  if (!Array.isArray(list) || list.length === 0) { console.log(board, "no jobs"); continue; }
  const jobs = list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  let taken = 0;
  for (const j of jobs) {
    if (taken >= want) break;
    const html = await get(j.applyUrl ?? `https://jobs.lever.co/${board}/${j.id}/apply`, "text");
    await sleep(400);
    if (!html) { console.log(board, j.id, "no page"); continue; }
    const doc = new JSDOM(html).window.document;
    const questions = questionsOf(doc);
    const key = `${board}|${questions.map((q) => q.label).join("|")}`;
    if (seenSets.has(key)) continue;
    seenSets.add(key);
    // The place line the page shows under the title.
    const location = clean(doc.querySelector(".posting-categories .location")?.textContent) || clean(j.categories?.location);
    console.log(board, j.id, questions.length, "|", j.text, "|", location, "|", j.country ?? "");
    if (questions.length) bank.push({ board, id: j.id, title: j.text, company: companyOf(doc) || board, location, questions });
    taken++;
  }
}
writeFileSync(OUT, JSON.stringify(bank, null, 1));
console.log("postings", bank.length, "questions", bank.reduce((n, p) => n + p.questions.length, 0));
