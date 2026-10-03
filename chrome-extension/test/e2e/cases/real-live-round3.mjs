/**
 * Round 3 (2026-10-03, evening): new ATS families and new data shapes.
 *
 * Postings drawn from prod `scraped_jobs` (active, seen in the last few days),
 * ATS families the corpus had not covered (JazzHR, Breezy, Recruitee,
 * Pinpoint, Paylocity, ADP, iCIMS, Oracle, CareerPuck) plus Greenhouse forms
 * embedded on company sites, Workable, Rippling and BambooHR. Each runs with
 * one of the five round-3 personas (profiles.mjs), chosen so the job and the
 * applicant disagree in interesting ways (a London applicant on a US job, a
 * French-first applicant on a Montreal job, a green-card student on a defense
 * contractor's internship).
 *
 * Exploration first: `expect: {}` until every write has been read by hand.
 */
import { MONTREAL_CHANGER, NEW_GRAD_DECLINER, UK_SENIOR, US_GREENCARD_STUDENT, US_VETERAN } from "../profiles.mjs";

const live = (c) => ({ mode: "live", trigger: { fillTimeoutMs: 180000 }, expect: {}, ...c });

// Paylocity checks the email with a POST as it is typed; blocked, the page
// broke and the fill never landed (a harness artifact). The lookup submits
// nothing, so these cases let exactly it through.
const PAYLOCITY_EMAIL_CHECK = [String.raw`^https://recruiting\.paylocity\.com/Recruiting/Jobs/GetEnhancedEmailValidation$`];

// Not cases, measured 2026-10-03: ADP Workforce Now and iCIMS open their form
// only behind a sign-in (an account these runs may not create), and a
// CareerPuck board only links out to the employer's Greenhouse posting.
// Also not cases (2026-10-03): Coinbase opens its form in a new tab, Samsara
// lazy-loads its Greenhouse iframe only once scrolled to, Fivetran keeps the
// form in an "Application" tab (a person opens it first; a run loading the
// job page directly fills only what is visible), and both Rippling postings
// were taken down (the URL redirects to the company's job list).

export default [
  // ---------------------------------------------- batch A: new ATS families
  live({ id: "r3a-jazzhr-sentinel", ats: "jazzhr", profile: US_VETERAN, url: "https://sentinelgroup.applytojob.com/apply/0RWBNqCbAy/Junior-Data-Engineer" }),
  live({ id: "r3a-jazzhr-kaizen", ats: "jazzhr", profile: US_GREENCARD_STUDENT, url: "https://kaizenanalytix.applytojob.com/apply/HFcfn6ikSA/AI-Engineer-Internship" }),
  live({ id: "r3a-jazzhr-k1", ats: "jazzhr", profile: UK_SENIOR, url: "https://k1im.applytojob.com/apply/7yVsObIt1i/AI-Engineer" }),
  live({ id: "r3a-breezy-kenect", ats: "breezy", profile: US_VETERAN, url: "https://kenect.breezy.hr/p/aa47c9879f1d-junior-data-engineer/apply" }),
  live({ id: "r3a-breezy-ninja", ats: "breezy", profile: US_GREENCARD_STUDENT, url: "https://ninjaholdings.breezy.hr/p/85be8c78a2ba-data-science-intern/apply" }),
  live({ id: "r3a-breezy-vagaro", ats: "breezy", profile: MONTREAL_CHANGER, url: "https://vagaro.breezy.hr/p/1a62d98b9483-software-engineer/apply" }),
  live({ id: "r3a-recruitee-huawei", ats: "recruitee", profile: MONTREAL_CHANGER, url: "https://huaweicanada.recruitee.com/o/power-system-analyst-1/c/new" }),
  live({ id: "r3a-pinpoint-idt", ats: "pinpoint", profile: US_GREENCARD_STUDENT, url: "https://idtus.pinpointhq.com/en/postings/20817d1b-bd0e-4aa8-a3d5-78e4614b52a3/applications/new" }),
  live({ id: "r3a-paylocity-atb", ats: "paylocity", allowRequests: PAYLOCITY_EMAIL_CHECK, profile: US_GREENCARD_STUDENT, url: "https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4504169" }),
  live({ id: "r3a-paylocity-choice", ats: "paylocity", allowRequests: PAYLOCITY_EMAIL_CHECK, profile: UK_SENIOR, url: "https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4489221" }),
  live({ id: "r3a-oracle-nokia", ats: "oracle", profile: NEW_GRAD_DECLINER, url: "https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/40261" }),

  // ------------------------------- batch B: embedded and familiar ATSs, new data
  live({ id: "r3b-embed-mongodb", ats: "greenhouse", profile: US_VETERAN, url: "https://www.mongodb.com/careers/job/?gh_jid=7523751" }),
  live({ id: "r3b-embed-d2l", ats: "greenhouse", profile: NEW_GRAD_DECLINER, url: "https://www.d2l.com/careers/jobs/?job_id=6297078&gh_jid=6297078" }),
  live({ id: "r3b-embed-zipline", ats: "greenhouse", profile: US_GREENCARD_STUDENT, url: "https://www.zipline.com/open-roles/7986810003?gh_jid=7986810003" }),
  live({ id: "r3b-workable-mila", ats: "workable", profile: MONTREAL_CHANGER, url: "https://apply.workable.com/mila-2/j/1E81635604/apply/" }),
  live({ id: "r3b-workable-syntiant", ats: "workable", profile: UK_SENIOR, url: "https://apply.workable.com/syntiant/j/11DDC0AC87/apply/" }),
  live({ id: "r3b-workable-disa", ats: "workable", profile: US_GREENCARD_STUDENT, url: "https://apply.workable.com/disa-technologies/j/73E7609B99/apply/" }),
  live({ id: "r3b-bamboo-nexthop", ats: "bamboohr", profile: NEW_GRAD_DECLINER, url: "https://nexthopai.bamboohr.com/careers/64" }),

  // ------------- batch C: forms the suite knows, answered by a different person
  live({ id: "r3c-gh-robinhood-uk", ats: "greenhouse", profile: UK_SENIOR, url: "https://boards.greenhouse.io/robinhood/jobs/8214142?gh_jid=8214142" }),
  live({ id: "r3c-ashby-superhuman-mtl", ats: "ashby", profile: MONTREAL_CHANGER, url: "https://jobs.ashbyhq.com/superhuman%20platform%20inc/e6b917b1-325a-47d0-b267-b279b0efdad0/application" }),
  live({ id: "r3c-gh-twitch-vet", ats: "greenhouse", profile: US_VETERAN, url: "https://job-boards.greenhouse.io/twitch/jobs/8700578002" }),
  live({ id: "r3c-gh-spacex-greencard", ats: "greenhouse", profile: US_GREENCARD_STUDENT, url: "https://boards.greenhouse.io/spacex/jobs/8622574002?gh_jid=8622574002" }),
  live({ id: "r3c-gh-anthropic-vet", ats: "greenhouse", profile: US_VETERAN, url: "https://job-boards.greenhouse.io/anthropic/jobs/5319696008" }),
  live({ id: "r3c-jobvite-actionet-vet", ats: "jobvite", profile: US_VETERAN, url: "https://jobs.jobvite.com/actionet/job/ofYQzfwm/apply" }),
  live({ id: "r3c-lever-palantir-uk", ats: "lever", profile: UK_SENIOR, url: "https://jobs.lever.co/palantir/d5486403-c050-4920-b2e0-91b69b61ebb2/apply" }),
  live({ id: "r3c-brex-mtl", ats: "greenhouse", profile: MONTREAL_CHANGER, url: "https://www.brex.com/careers/8864176002?gh_jid=8864176002" }),
  live({ id: "r3c-workable-mindex-vet", ats: "workable", profile: US_VETERAN, url: "https://apply.workable.com/mindex/j/84B10DB922/apply/" }),
  live({ id: "r3c-bamboo-armstrong-uk", ats: "bamboohr", profile: UK_SENIOR, url: "https://armstrongfluidtechnology.bamboohr.com/careers/1001" }),
  live({ id: "r3c-ashby-ramp-greencard", ats: "ashby", profile: US_GREENCARD_STUDENT, url: "https://jobs.ashbyhq.com/ramp/b39ceb08-a0a7-4f8b-a760-2fb88e209956/application" }),
  live({ id: "r3c-lever-zoox-mtl", ats: "lever", profile: MONTREAL_CHANGER, url: "https://jobs.lever.co/zoox/5f10dfaf-5920-4506-8a09-b39b29e6f48b/apply" }),
  live({ id: "r3c-gh-commvault-newgrad", ats: "greenhouse", profile: NEW_GRAD_DECLINER, url: "https://job-boards.greenhouse.io/commvault/jobs/5436608008" }),
  live({ id: "r3c-lever-hermeus-greencard", ats: "lever", profile: US_GREENCARD_STUDENT, url: "https://jobs.lever.co/hermeus/78008094-ca81-4a0c-9a18-93b30f932acd/apply" }),
  live({ id: "r3c-gh-planet-vet", ats: "greenhouse", profile: US_VETERAN, url: "https://job-boards.greenhouse.io/planetlabs/jobs/8244395" }),
];
