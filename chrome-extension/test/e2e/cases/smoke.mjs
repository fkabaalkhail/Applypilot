/**
 * Harness smoke: one plain, well-labelled form. Proves the pipeline end to end
 * (extension loads, syncs the profile from the fake API, mounts, fills, the
 * dump reads the result) before any real ATS markup is involved.
 */
import { MOCK } from "../profiles.mjs";

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>${body}</body></html>`;

export default [
  {
    id: "smoke-basic",
    ats: "smoke",
    url: "https://careers.harness.test/apply",
    profile: MOCK,
    html: page(`
      <h1>Apply: Software Engineer</h1>
      <form id="application">
        <div><label for="first">First Name</label><input id="first" name="first" type="text"></div>
        <div><label for="last">Last Name</label><input id="last" name="last" type="text"></div>
        <div><label for="email">Email</label><input id="email" name="email" type="email"></div>
        <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
        <div><label for="ctry">Country</label>
          <select id="ctry" name="country"><option value="">Select…</option>
            <option>United States</option><option>Canada</option><option>Mexico</option></select></div>
        <div><label for="li">LinkedIn Profile</label><input id="li" name="linkedin" type="url"></div>
      </form>`),
    expect: {
      "#first": "John",
      "#last": "Doe",
      "#email": "john@example.com",
      "#phone": "+1 555 555 5555",
      "#ctry": "Canada",
      "#li": "https://linkedin.com/in/johndoe",
    },
  },
];
