/**
 * LIVE real application pages, taken from jobs in the Tailrd app (prod
 * scraped_jobs, listing_status=active, 2026-10-03). The real ATS JavaScript
 * runs; only reads leave the browser (harness.mjs blocks every submit, upload,
 * mutation, autosave and beacon).
 *
 * Profile: SPARSE_CANADIAN, shaped like real production profiles (one location
 * string, free-text work authorization "Canadian citizen", no stated years,
 * no stated current company, a co-op in progress). Expectations encode what a
 * CORRECT deterministic filler does with it:
 *
 *   - fill what the profile states or implies with high confidence
 *     (Kinaxis is the current employer: its row ends "Present"; Toronto/ON/
 *     Canada come from the location string; a Canadian citizen IS entitled to
 *     work in Canada; Toronto is NOT in the United States)
 *   - leave everything else untouched: preferences nobody stated, US work
 *     authorization for a Canadian citizen (unknown, not "no"), salary, EEO
 *     (this profile has none), essays.
 *
 * A field missing from `expect` must stay unchanged: any write there is
 * reported as UNEXPECTED, the wrong-kind / invented-answer failure.
 */
import { SPARSE_CANADIAN } from "../profiles.mjs";

const P = SPARSE_CANADIAN;
const NAME = "Maya Tremblay";
const PHONE = { re: "416\\D*555\\D*0142" };
const TORONTO = { re: "toronto" };
const LINKEDIN = P.linkedin;
// Greenhouse's phone dial-code picker: "Canada" selects "Canada +1", and the
// widget then displays only "+1".
const DIAL_CODE_CANADA = { re: String.raw`canada|^\+1$` };

const live = (c) => ({ mode: "live", profile: P, trigger: { fillTimeoutMs: 180000 }, ...c });

async function openBambooForm(page) {
  const btn = page.locator('button:has-text("Apply for This Job"), a:has-text("Apply for This Job")').first();
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  await page.waitForTimeout(2500);
}

export default [
  // ---------------------------------------------------------------- Greenhouse
  live({
    id: "live-gh-oneimaging",
    ats: "greenhouse",
    url: "https://job-boards.greenhouse.io/oneimaging/jobs/4403125009",
    expect: {
      "#first_name": "Maya",
      "#last_name": "Tremblay",
      "#preferred_name": { oneOf: ["Maya", ""] },
      "#email": P.email,
      // The phone dial-code picker (inside fieldset.phone-input): "Canada"
      // selects "Canada +1", and the widget then displays only "+1".
      "#country": DIAL_CODE_CANADA,
      "#phone": PHONE,
      "label:University of": { re: "^no" },
      "label:Miami HQ": null,
      "label:career fair": null,
      "label:LinkedIn Profile": LINKEDIN,
      "label:Desired Salary": null,
      "label:authorized to work in the United States": null,
      "label:require sponsorship": null,
      "#gender": null,
      "#hispanic_ethnicity": null,
      "#veteran_status": null,
    },
  }),
  live({
    id: "live-gh-garner",
    ats: "greenhouse",
    url: "https://job-boards.greenhouse.io/garnerhealth/jobs/6174213004",
    expect: {
      "#first_name": "Maya",
      "#last_name": "Tremblay",
      "#preferred_name": { oneOf: ["Maya", ""] },
      "#email": P.email,
      // The phone dial-code picker (inside fieldset.phone-input): "Canada"
      // selects "Canada +1", and the widget then displays only "+1".
      "#country": DIAL_CODE_CANADA,
      "#phone": PHONE,
      "#candidate-location": TORONTO,
      "#school--0": { re: "waterloo" },
      "#degree--0": { re: "bachelor" },
      "label:expected graduation date": { re: "2027|^$" },
      "label:LinkedIn Profile": LINKEDIN,
      "label:If 'Other' selected": null,
      "label:desired salary": null,
      "label:legally authorized to work": null,
      "label:require sponsorship": null,
      "label:relocate to the NYC": null,
      "label:Which state do you currently reside": { re: "^$|outside|other|not|canada|international|n/?a" },
      "label:gender identity": null,
      "label:racial/ethnic": null,
      "label:sexual orientation": null,
      "label:transgender": null,
      "label:disability": null,
      "label:veteran or active": null,
    },
  }),
  live({
    id: "live-gh-bertram",
    ats: "greenhouse",
    url: "https://job-boards.greenhouse.io/bertramcapitalmanagement/jobs/8789855002",
    expect: {
      "#first_name": "Maya",
      "#last_name": "Tremblay",
      "#email": P.email,
      // The phone dial-code picker (inside fieldset.phone-input): "Canada"
      // selects "Canada +1", and the widget then displays only "+1".
      "#country": DIAL_CODE_CANADA,
      "#phone": PHONE,
      "#candidate-location": TORONTO,
      "label:LinkedIn Profile": LINKEDIN,
      "label:require employer sponsorship": null,
      "label:undergraduate degree": { oneOf: ["University of Waterloo", ""] },
      "label:standardized tests": null,
      "#gender": null,
      "#hispanic_ethnicity": null,
      "#veteran_status": null,
    },
  }),
  // --------------------------------------------------------------------- Lever
  live({
    id: "live-lever-rover",
    ats: "lever",
    url: "https://jobs.lever.co/rover/303b3b2f-9679-4a77-8908-456e29240486/apply",
    expect: {
      "name=name": NAME,
      "name=email": P.email,
      "name=phone": PHONE,
      "#location-input": TORONTO,
      "name=org": "Kinaxis",
      "name=urls[LinkedIn]": LINKEDIN,
      "name=urls[Twitter]": null,
      "name=urls[GitHub]": null,
      "name=urls[Portfolio]": null,
      "name=urls[Other]": null,
      "label:require sponsorship in the future": null,
      "label:live in or near Seattle": null,
      "label:good fit for this role": null,
      "label:years of professional software development": "1-3 years",
      "name=eeo[gender]": null,
      "name=eeo[race]": null,
      "name=eeo[veteran]": null,
    },
  }),
  live({
    id: "live-lever-eqbank",
    ats: "lever",
    url: "https://jobs.lever.co/eqbank/eefb3fa3-a55b-4bfd-b1b2-5419f35c7703/apply",
    expect: {
      "name=name": NAME,
      "name=email": P.email,
      "name=phone": PHONE,
      "#location-input": TORONTO,
      "name=org": "Kinaxis",
      "label:background check": null,
      "label:school you are currently attending": "University of Waterloo",
      "label:legally entitled to work in Canada": "Yes",
      "label:year of studies": null,
      "label:Gender Identity": null,
      "label:Indigenous": null,
    },
  }),
  live({
    id: "live-lever-kepler",
    ats: "lever",
    url: "https://jobs.lever.co/kepler/2ad02ce3-1d56-4aee-9f1d-5199c780c0c1/apply",
    expect: {
      "name=name": NAME,
      "name=email": P.email,
      "name=phone": PHONE,
      "#location-input": TORONTO,
      "name=org": "Kinaxis",
      "name=urls[LinkedIn]": LINKEDIN,
      "name=urls[Twitter]": null,
      "name=urls[GitHub]": null,
      "name=urls[Portfolio]": null,
      "name=urls[Other]": null,
      "name=urls[Website/Blog]": null,
      "label:enrolled as a student": null,
      "label:returning to your studies": null,
      "label:legally able to work in Canada": "Yes",
      "label:Toronto Office": null,
      "label:What year of study": null,
      "label:final year of study": null,
      "label:Select a university or college": { re: "waterloo" },
      "label:availability for a 4-month": null,
      "label:age range": null,
      "label:ethnicity": null,
      "label:gender do you identify": null,
      "label:sexual orientation": null,
      "label:disability": null,
      "label:veteran": null,
    },
  }),
  // --------------------------------------------------------------------- Ashby
  live({
    id: "live-ashby-pangram",
    ats: "ashby",
    url: "https://jobs.ashbyhq.com/pangramlabs/0512183c-2373-499c-8459-91d0fd2d72f3/application",
    expect: {
      "#_systemfield_name": NAME,
      "#_systemfield_email": P.email,
      "label:authorized to work in the United States": null,
      "label:right use of AI tools": null,
      "label:Why Pangram": null,
      "label:Anything else": null,
    },
  }),
  live({
    id: "live-ashby-interplay",
    ats: "ashby",
    url: "https://jobs.ashbyhq.com/interplay/bdf67758-1f20-4a01-8bb3-ccebfa79e9ac/application",
    expect: {
      "#_systemfield_name": NAME,
      "#_systemfield_email": P.email,
      "label:LinkedIn Profile": LINKEDIN,
      "label:Where are you located": "North America",
      "label:Introvert": null,
      "label:Sensing": null,
      "label:Feeling": null,
      "label:Perceiving": null,
      "label:AI will take over": null,
    },
  }),
  // ------------------------------------------------------------------ Workable
  live({
    id: "live-workable-mindex",
    ats: "workable",
    url: "https://apply.workable.com/mindex/j/84B10DB922/apply/",
    expect: {
      "#firstname": "Maya",
      "#lastname": "Tremblay",
      "#email": P.email,
      "#headline": null,
      "#input_phone": PHONE,
      // Workable pre-fills Address from the visitor's IP geolocation; a
      // non-empty field is never overwritten.
      "#address": { unchanged: true },
      "#cover_letter": null,
      "label:Salary Range": null,
      "radio=QA_12563770": null,
      "radio=QA_12563778": null,
      "radio=QA_12457572": null,
      "radio=QA_12457573": "NO",
      "label:Do you live in the United States": "NO",
      "radio=QA_12457574": null,
      "label:referred to this job": null,
      "label:Where did you see this job": null,
    },
  }),
  live({
    id: "live-workable-financeit",
    ats: "workable",
    url: "https://apply.workable.com/financeit/j/D3CF97088A/apply/",
    expect: {
      "#firstname": "Maya",
      "#lastname": "Tremblay",
      "#email": P.email,
      "#input_phone": PHONE,
      // Workable pre-fills Address from the visitor's IP geolocation; a
      // non-empty field is never overwritten.
      "#address": { unchanged: true },
      "#summary": null,
      "#cover_letter": null,
      "label:salary expectations": null,
      "radio=QA_12558420": null,
      "radio=QA_12558421": "YES",
      "ariaradio=Are you eligible to work in Canada without sponsorship?": "YES",
    },
  }),
  // ----------------------------------------------------------- SmartRecruiters
  live({
    id: "live-sr-servicenow",
    ats: "smartrecruiters",
    url: "https://jobs.smartrecruiters.com/oneclick-ui/company/ServiceNow/publication/c6a55189-e797-4e24-93c8-7bd5cef0e2ef?dcr_ci=ServiceNow",
    expect: {
      "label:First name": "Maya",
      "label:Last name": "Tremblay",
      "label:Email*": P.email,
      "label:Confirm your email": P.email,
      "label:City": TORONTO,
      "label:Phone number": PHONE,
      "label:LinkedIn": LINKEDIN,
      "label:Facebook": null,
      "label:X (fka Twitter)": null,
      "label:Website": null,
      "label:Let the company know": null,
    },
  }),
  live({
    id: "live-sr-bosch",
    ats: "smartrecruiters",
    url: "https://jobs.smartrecruiters.com/oneclick-ui/company/BoschGroup/publication/70832055-56fb-4b0e-bcd5-a70360ecca4a?dcr_ci=BoschGroup",
    expect: {
      "label:First name": "Maya",
      "label:Last name": "Tremblay",
      "label:Email*": P.email,
      "label:Confirm your email": P.email,
      "label:City": TORONTO,
      "label:Phone number": PHONE,
      "label:LinkedIn": LINKEDIN,
      "label:Website": null,
      "label:Let the company know": null,
    },
  }),
  // ------------------------------------------------------------------ BambooHR
  live({
    id: "live-bamboo-nexthop",
    ats: "bamboohr",
    url: "https://nexthopai.bamboohr.com/careers/64",
    beforeFill: openBambooForm,
    expect: {
      "#nickname_hpcsaf": null,
      "#firstName": "Maya",
      "#lastName": "Tremblay",
      "#email": P.email,
      "#phone": PHONE,
      "label:Address": null,
      "label:City": "Toronto",
      "label:Postal Code": null,
      "label:Date Available": null,
      "#websiteUrl": null,
      "#linkedinUrl": LINKEDIN,
      "#educationInstitutionName": "University of Waterloo",
      // BambooHR fills this itself with the posting URL; we must not touch it.
      "label:Link to This Job": { re: "bamboohr\.com|^$" },
    },
  }),
  live({
    id: "live-bamboo-armstrong",
    ats: "bamboohr",
    url: "https://armstrongfluidtechnology.bamboohr.com/careers/1001",
    beforeFill: openBambooForm,
    expect: {
      "#nickname_hpcsaf": null,
      "#firstName": "Maya",
      "#lastName": "Tremblay",
      "#email": P.email,
      "#phone": PHONE,
      "label:Address": null,
      "label:City": "Toronto",
      "label:Postal Code": null,
      "label:Date Available": null,
      "#desiredPay": null,
      "#websiteUrl": null,
      "#linkedinUrl": LINKEDIN,
      // BambooHR renders a native radio and an ARIA twin per question.
      "radio~legally entitled to work in Canada": "Yes",
      "label:background check": null,
      // BambooHR fills this itself with the posting URL; we must not touch it.
      "label:Link to This Job": { re: "bamboohr\.com|^$" },
    },
  }),
  // ------------------------------------------------------------------- Jobvite
  live({
    id: "live-jobvite-actionet",
    ats: "jobvite",
    url: "https://jobs.jobvite.com/actionet/job/ofYQzfwm/apply",
    expect: {
      "label:First Name": "Maya",
      "label:Last Name": "Tremblay",
      "label:Address*": null,
      "label:Address2": null,
      "label:City": "Toronto",
      "label:State": { oneOf: ["Not Applicable", ""] },
      "label:Zip/Postal Code": null,
      "label:Email": P.email,
      "label:Phone": PHONE,
      "label:Desired Salary": null,
      "label:Gender": null,
      "label:Race/Ethnicity": null,
      "label:Disability Status": null,
      "label:Veteran Status": null,
      "label:age 18 or older": null,
      "label:Active Clearance": null,
      "label:Clearance Type": null,
      "label:highest education": null,
      "label:certifications": null,
      "label:total number of years of relevant experience": { oneOf: ["1", ""] },
      "label:current or past employee of ActioNet": "Neither",
      "label:family member": null,
      "label:How did you hear": null,
      "label:If referred by": null,
      "label:Job Fair": null,
      "label:conflicts of interest": null,
      "label:non-competes": null,
      "label:current or former government employee?": null,
      "label:are you currently": null,
      "label:recused": null,
      "label:procurement official": null,
    },
  }),
];
