/**
 * Input types beyond plain text, through the REAL extension:
 *
 *  - dates: a native <input type="date">, a text date with an "MM/DD/YYYY"
 *    placeholder, a DD/MM/YYYY one, and a Month/Year pair of <select>s, all
 *    answered from inference (start date = today + the stated notice period;
 *    graduation from the education row);
 *  - file upload: the résumé the sync advertises is fetched from the backend
 *    and attached to the page's <input type="file"> (real DataTransfer, the
 *    change event the ATS listens for).
 */
import { SPARSE_CANADIAN } from "../profiles.mjs";

const pad = (n) => String(n).padStart(2, "0");
const start = new Date(Date.now() + 14 * 86400000); // "2 weeks" notice
const y = start.getFullYear();
const m = pad(start.getMonth() + 1);
const d = pad(start.getDate());

const P = { ...SPARSE_CANADIAN, noticePeriod: "2 weeks", education: [{ school: "University of Waterloo", degree: "BASc Mechatronics Engineering", graduationYear: "2027-04" }] };

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title><style>body{font:14px sans-serif;margin:24px}div{margin:8px 0}label{display:block}</style></head><body><h1>Software Engineer Intern</h1><form>${body}</form></body></html>`;

export default [
  {
    id: "inputs-dates",
    ats: "inputs",
    url: "https://careers.inputs-harness.test/dates/apply",
    profile: P,
    html: page(`
      <div><label for="first">First name</label><input id="first" name="first"></div>
      <div><label for="start-native">Earliest start date</label><input id="start-native" type="date"></div>
      <div><label for="avail-us">Date available</label><input id="avail-us" placeholder="MM/DD/YYYY"></div>
      <div><label for="avail-eu">When can you start?</label><input id="avail-eu" placeholder="DD/MM/YYYY"></div>
      <div><label for="grad-month">Expected graduation month</label>
        <select id="grad-month"><option value="">Month</option>${["January","February","March","April","May","June","July","August","September","October","November","December"].map((x) => `<option>${x}</option>`).join("")}</select></div>
      <div><label for="grad-year">Expected graduation year</label>
        <select id="grad-year"><option value="">Year</option>${[2025, 2026, 2027, 2028].map((x) => `<option>${x}</option>`).join("")}</select></div>`),
    expect: {
      "#first": "Maya",
      "#start-native": `${y}-${m}-${d}`,
      "#avail-us": `${m}/${d}/${y}`,
      "#avail-eu": `${d}/${m}/${y}`,
      "#grad-year": "2027",
      // The month select is answered only if the month is known (it is: 2027-04).
      "#grad-month": { oneOf: ["April", ""] },
    },
  },
  {
    id: "inputs-resume-upload",
    ats: "inputs",
    url: "https://careers.inputs-harness.test/upload/apply",
    profile: P,
    resumes: [{ id: 7, name: "Maya Tremblay Resume", isPrimary: true, hasFile: true, fileName: "John_Doe_Resume.pdf", fileContentType: "application/pdf" }],
    html: page(`
      <div><label for="first">First name</label><input id="first" name="first"></div>
      <div><label for="email">Email</label><input id="email" type="email"></div>
      <div><label for="resume">Resume/CV</label><input id="resume" type="file" accept=".pdf,.doc,.docx"></div>`),
    expect: {
      "#first": "Maya",
      "#email": P.email,
      "#resume": { re: "\\.pdf$" },
    },
  },
];
