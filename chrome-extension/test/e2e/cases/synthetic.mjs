/**
 * The repo's synthetic ATS fixtures (test/fixtures/*.ts, the jsdom suite's
 * builders, including Workday's button-listbox prompts and a shadow-DOM
 * Workday) run through the REAL extension, each served at a URL on its ATS's
 * real host so the matching site adapter engages exactly as in production.
 *
 * These cover the ATSes whose live application forms cannot be reached
 * without creating an account (Workday, iCIMS, Taleo, SuccessFactors) or that
 * have no active listing in the app tonight (Taleo). They are reconstructions,
 * not captures; the real-page captures are in real-live.mjs.
 *
 * Profile: MOCK (the extension's own sample data), which these fixtures were
 * written against.
 */
import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { MOCK } from "../profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = buildSync({
  entryPoints: [path.join(here, "..", "fixtures-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "chrome110",
}).outputFiles[0].text;

const HOSTS = {
  greenhouse: "https://job-boards.greenhouse.io/acme/jobs/1001",
  lever: "https://jobs.lever.co/acme/1001/apply",
  bamboohr: "https://acme.bamboohr.com/careers/1001",
  breezy: "https://acme.breezy.hr/p/1001/apply",
  ashby: "https://jobs.ashbyhq.com/acme/1001/application",
  workable: "https://apply.workable.com/acme/j/1001/apply/",
  smartrecruiters: "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1001",
  jobvite: "https://jobs.jobvite.com/acme/job/1001/apply",
  rippling: "https://ats.rippling.com/acme/jobs/1001/apply",
  bullhorn: "https://acme.bullhornstaffing.com/jobs/1001/apply",
  workday: "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Ottawa/Software-Engineer_R1001/apply/applyManually",
  icims: "https://careers-acme.icims.com/jobs/1001/software-engineer/candidate?mode=apply",
  taleo: "https://acme.taleo.net/careersection/2/jobapply.ftl?job=1001",
  adp: "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=acme",
  successfactors: "https://career2.successfactors.eu/careers?company=acme&career_job_req_id=1001",
  "workday-shadow": "https://acme.wd3.myworkdayjobs.com/en-US/careers/job/Ottawa/Software-Engineer_R1002/apply/applyManually",
};

const page = (name) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Software Engineer - Apply</title></head>
<body><script src="/__fixtures.js"></script><script>__mount[${JSON.stringify(name)}](document);</script></body></html>`;

/**
 * Reviewed expectations (2026-10-03): every value the extension wrote on these
 * fixtures was checked by hand against the MOCK profile and frozen here, plus
 * the abstentions that must hold (Workday's "authorized to work in THIS
 * country?" with no job country on the page, "How did you hear about us?").
 * Any NEW write on these pages fails as UNEXPECTED until reviewed.
 */
export const SYNTHETIC_EXPECT = JSON.parse(readFileSync(path.join(here, "synthetic-expect.json"), "utf8"));

export default Object.entries(HOSTS).map(([name, url]) => {
  const origin = new URL(url).origin;
  return {
    id: `synthetic-${name}`,
    ats: name.replace("-shadow", ""),
    url,
    html: page(name),
    assets: { [`${origin}/__fixtures.js`]: { body: bundle, contentType: "application/javascript; charset=utf-8" } },
    profile: MOCK,
    expect: SYNTHETIC_EXPECT[name] ?? {},
  };
});
