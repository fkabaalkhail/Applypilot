/**
 * Round 4 (2026-10-05, night): real-user pages first, then new ground.
 *
 * Batch R: the pages behind the last real fills in prod telemetry
 * (`autofill_reports`, 2026-09-28 and 2026-10-03). Those fills ran on the
 * July Store build (their reports carry no extension_version), so this batch
 * asks what the current build does on the same postings, with a synthetic
 * applicant shaped like the real one (a Canadian engineering student applying
 * to US internships). No real profile data here. Pinned after every write was
 * read by hand (2026-10-05), on the build with this round's fixes.
 *
 * Waymo's own site renders each label with a hash that changes on every load
 * ("First Name (required) a2f147a2"): pinned by the label before it.
 */
import { COMPLETE_CANADIAN } from "../profiles.mjs";

const live = (c) => ({ mode: "live", trigger: { fillTimeoutMs: 180000 }, expect: {}, ...c });

const DATE = String.raw`^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}|\d{2} [A-Z][a-z]{2} \d{4})$`;

export default [
  // ------------------------------------------- batch R: real-user pages
  live({
    id: "r4r-embed-brex",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    // The iframe's own address, loaded alone: no surrounding page says where
    // the job is, so the stated-location questions stay blank.
    url: "https://job-boards.greenhouse.io/embed/job_app?for=brex&token=8864176002",
    expect: {
      "label:First Name": "Maya",
      "label:Last Name": "Tremblay",
      "label:Email": "maya.tremblay@example.com",
      "#country": "+1",
      "label:Phone": "(416) 555-0142",
      "label:Location (City)": "Toronto, Ontario, Canada",
      "label:LinkedIn Profile": "https://www.linkedin.com/in/maya-tremblay",
      "label:Website or GitHub": "https://github.com/mayatremblay",
      "label:What are your preferred gender pronouns? (She/Her/Hers; He/H": "She/Her",
      "label:How did you hear about us?": "LinkedIn",
      "label:What country are you based in?": "Canada",
      "label:Are you authorized to work in the stated location of this ro": null,
      "label:If you're not authorized to work at the stated location, wha": null,
      "label:Do you currently live in, or plan to relocate to, the specif": "Yes, I plan to relocate",
      "label:Do you consent to Brex processing your personal information ": "Consent",
      "label:This role requires in-office work three days per week (Mon, ": "Yes, I’d relocate prior to the start of the role",
      "#question_38647896002": "No",
      "#gender": "Female",
      "label:Are you Hispanic/Latino?": "No",
      "label:Please identify your race": "White",
      "label:Veteran Status": "I am not a protected veteran",
    },
  }),
  live({
    id: "r4r-embed-waymo",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://careers.withwaymo.com/jobs/2027-summer-intern-ms-phd-perception-machine-learning-mountain-view-california-united-states?gh_jid=8227411",
    expect: {
      // A hidden copy of these three comes first on the page: by id.
      "#form_first_name_7_0_0": "Maya",
      "#form_last_name_7_0_1": "Tremblay",
      "#form_email_7_0_2": "maya.tremblay@example.com",
      // The widget adds the country code (was reported "did not stick").
      "label:Phone Number (required)": "+14165550142",
      "label:Website": "https://mayatremblay.dev",
      "label:LinkedIn Profile": "https://www.linkedin.com/in/maya-tremblay",
      "label:How did you hear about this opportunity?": "LinkedIn",
      // A Canadian on a Mountain View internship (was "No": read as "are you authorized?").
      "label:Do you require work authorization? (required)": "Yes",
      "label:If yes, what kind? (If you do not require work authorization": null,
      // Was left to the AI: "current or former" hid the company.
      "label:Are you a current or former Alphabet employee, intern, vendo": "Never worked at Alphabet",
      "label:If yes, please provide your LDAP.": null,
      "label:Please review and acknowledge our Candidate Privacy Policy l": "I acknowledge that I have read and understood the terms of the Waymo Applicant and Candidate Privacy Policy.",
      "label:Please provide your full legal name as it appears on your go": "Maya Tremblay",
      "#question_7_0_4_0_12": "I acknowledge the above policies",
      // New York, Illinois, another US state, APAC, EMEA or Other: Toronto is Other.
      "label:Please provide the state/region in which you currently resid": "Other",
      "label:Please indicate if you are a veteran or active member of the": "No, I am not a veteran or active member",
      "label:Please indicate your race / ethnic group (choose all that ap": "White (Not of Hispanic Origin)",
      "label:Please indicate your gender (required)": "Female",
      "label:Location (required)": "Toronto, ON, Canada",
      "#form_declaration_7_0_6": "checked",
      // A subscription: never ticked for the applicant.
      "label:Check this box to join the talent community and sign up for": "",
    },
  }),
  live({
    id: "r4r-gh-astranis",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://job-boards.greenhouse.io/astranis/jobs/4704826006",
    expect: {
      "label:First Name": "Maya",
      "label:Last Name": "Tremblay",
      "label:Email": "maya.tremblay@example.com",
      "label:Country": "+1",
      "#phone": "(416) 555-0142",
      "label:Location (City)": "Toronto, Ontario, Canada",
      "label:School": "University of Waterloo",
      "label:Degree": "Bachelor's Degree",
      // The 80 disciplines have no Mechatronics.
      "label:Discipline": "Other",
      "label:End date month": "April",
      "label:End date year": "2027",
      // A Canadian citizen is none of the U.S. persons listed.
      "label:Astranis complies with U.S. Government space technology expo": "None of the above.",
      // The posting's only option.
      "label:Please confirm the season you are applying for.": "Winter 2027",
      "label:When are you able to join Astranis as an intern/associate? (": { re: DATE },
      "label:What is your preferred end date for the internship/associate": null,
      "label:At Astranis, we value in-person collaboration and a strong w": "Yes",
      "label:How did you hear about Astranis?": "LinkedIn",
      "label:LinkedIn Profile": "https://www.linkedin.com/in/maya-tremblay",
      "label:By selecting YES, I consent to receive recruiting SMS messag": "No",
      "label:Gender": "Female",
      "label:Are you Hispanic/Latino?": "No",
      "label:Please identify your race": "White",
      "label:Veteran Status": "I am not a protected veteran",
    },
  }),
  live({
    id: "r4r-embed-carvana",
    ats: "greenhouse",
    profile: COMPLETE_CANADIAN,
    url: "https://www.carvana.com/careers/apply/?gh_jid=8234285",
    expect: {
      "label:First Name": "Maya",
      "label:Last Name": "Tremblay",
      "label:Email": "maya.tremblay@example.com",
      "label:Phone": "416-555-0142",
      // Was left to the AI: the question names no company (it is Carvana's form).
      "label:Are you a current or former employee?": "Select answerNo",
      "label:How did you hear about this job? If referred by a Carvana em": "LinkedIn",
      "label:Are you 18 years of age or older?": "Select answerYes",
      "label:Do you require Visa sponsorship?": "Select answerYes",
    },
  }),
];
