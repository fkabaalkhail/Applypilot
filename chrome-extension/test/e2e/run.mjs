/**
 * Real-extension e2e runner.
 *
 *   node build.mjs && node test/e2e/run.mjs [--filter <id|=exact-id|ats>,...] [--report-only] [--save <name>]
 *
 * Loads every case module under test/e2e/cases/, runs each through the REAL
 * packaged extension (harness.mjs) against the fake backend with the AI dead,
 * scores it (evaluate.mjs), prints a per-case + per-ATS report, and writes
 * test/e2e/results/latest.json (gitignored).
 *
 * Exit code: 0 when every case passes, 1 otherwise (--report-only forces 0,
 * for baseline measurement runs).
 */
import { readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeApi } from "./fakeApi.mjs";
import { launchExtension, seedExtension, runCase } from "./harness.mjs";
import { evaluateCase, formatCase } from "./evaluate.mjs";
import { MOCK } from "./profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function loadCases() {
  const dir = path.join(here, "cases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  const all = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const list = typeof mod.default === "function" ? await mod.default() : mod.default;
    for (const c of list ?? []) all.push({ ...c, file: f });
  }
  return all;
}

async function main() {
  const filter = valueOf("--filter");
  let cases = await loadCases();
  if (filter) {
    // "=<id>" matches that id only; anything else is a substring of the id,
    // or an ATS name ("lever").
    const parts = filter.split(",");
    cases = cases.filter((c) => parts.some((p) => (p.startsWith("=") ? c.id === p.slice(1) : c.id.includes(p) || c.ats === p)));
  }
  if (cases.length === 0) {
    console.log("no cases matched");
    process.exit(1);
  }

  const resumePdf = path.resolve(here, "..", "browser", "sample-resume.pdf");
  const api = await startFakeApi({ profile: MOCK, resumeFilePath: existsSync(resumePdf) ? resumePdf : null });
  const ext = await launchExtension();
  await seedExtension(ext.sw, api.url);
  console.log(`extension loaded (sw=${ext.sw.url().split("/").pop()}), fake API at ${api.url}, AI mode=${api.state.aiMode}`);
  console.log(`running ${cases.length} case(s)\n`);

  const results = [];
  for (const c of cases) {
    let result;
    try {
      result = await runCase({ ctx: ext.ctx, sw: ext.sw, api }, c);
    } catch (err) {
      result = { before: [], after: [], trace: { error: `harness error: ${err.message.split("\n")[0]}` }, blocked: [], console: [] };
    }
    const ev = evaluateCase(c, result);
    console.log(formatCase(ev, result.trace));
    if (process.env.E2E_DEBUG === "1") {
      for (const l of result.console) console.log(`     console: ${l}`);
      if (result.blocked.length) console.log(`     blocked: ${result.blocked.slice(0, 10).join(" | ")}`);
    }
    results.push({ case: { id: c.id, ats: c.ats, url: c.url, file: c.file }, ev, trace: result.trace, after: result.after, before: result.before, blocked: result.blocked, ...(result.nextPages?.length ? { nextPages: result.nextPages } : {}) });
  }

  await ext.close();
  await api.close();

  // Per-ATS summary.
  const byAts = new Map();
  for (const { ev } of results) {
    const a = byAts.get(ev.ats) ?? { cases: 0, casesOk: 0, pass: 0, total: 0, fills: 0, fillsPassed: 0, abstains: 0, abstainsPassed: 0, unexpected: 0 };
    a.cases++;
    if (ev.ok) a.casesOk++;
    a.pass += ev.pass;
    a.total += ev.total;
    a.fills += ev.fills;
    a.fillsPassed += ev.fillsPassed;
    a.abstains += ev.abstains;
    a.abstainsPassed += ev.abstainsPassed;
    a.unexpected += ev.unexpected.length;
    byAts.set(ev.ats, a);
  }
  console.log("\n" + "=".repeat(96));
  console.log("ATS".padEnd(18) + "cases ok".padEnd(10) + "checks".padEnd(12) + "rate".padEnd(8) + "fills ok".padEnd(12) + "abstain ok".padEnd(12) + "wrong writes");
  console.log("-".repeat(96));
  let gp = 0;
  let gt = 0;
  for (const [ats, a] of [...byAts.entries()].sort()) {
    gp += a.pass;
    gt += a.total;
    const rate = a.total ? `${Math.round((100 * a.pass) / a.total)}%` : "-";
    console.log(
      ats.padEnd(18) +
        `${a.casesOk}/${a.cases}`.padEnd(10) +
        `${a.pass}/${a.total}`.padEnd(12) +
        rate.padEnd(8) +
        `${a.fillsPassed}/${a.fills}`.padEnd(12) +
        `${a.abstainsPassed}/${a.abstains}`.padEnd(12) +
        String(a.unexpected)
    );
  }
  console.log("-".repeat(96));
  console.log(`TOTAL checks ${gp}/${gt} (${gt ? Math.round((100 * gp) / gt) : 0}%)`);

  const outDir = path.join(here, "results");
  mkdirSync(outDir, { recursive: true });
  const payload = { at: new Date().toISOString(), summary: Object.fromEntries(byAts), results };
  writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));
  if (valueOf("--save")) writeFileSync(path.join(outDir, `${valueOf("--save")}.json`), JSON.stringify(payload, null, 2));

  const allOk = results.every((r) => r.ev.ok);
  process.exit(flag("--report-only") || allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
