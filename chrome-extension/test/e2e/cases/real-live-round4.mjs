/**
 * Round 4 (2026-10-05, night): real-user pages first, then new ground.
 *
 * Batch R: the pages behind the last real fills in prod telemetry
 * (`autofill_reports`, 2026-09-28 and 2026-10-03). Those fills ran on the
 * July Store build (their reports carry no extension_version), so this batch
 * asks what the current build does on the same postings, with a synthetic
 * applicant shaped like the real one (a Canadian engineering student applying
 * to US internships). No real profile data here.
 *
 * Exploration cases have no `expect` until every write is read by hand.
 */
import { COMPLETE_CANADIAN } from "../profiles.mjs";

const live = (c) => ({ mode: "live", trigger: { fillTimeoutMs: 180000 }, expect: {}, ...c });

export default [
  // ------------------------------------------- batch R: real-user pages
  live({
    id: "r4r-embed-brex",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://job-boards.greenhouse.io/embed/job_app?for=brex&token=8864176002",
  }),
  live({
    id: "r4r-embed-waymo",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://careers.withwaymo.com/jobs/2027-summer-intern-ms-phd-perception-machine-learning-mountain-view-california-united-states?gh_jid=8227411",
  }),
  live({
    id: "r4r-gh-astranis",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://job-boards.greenhouse.io/astranis/jobs/4704826006",
  }),
  live({
    id: "r4r-embed-carvana",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://www.carvana.com/careers/apply/?gh_jid=8234285",
  }),
];
