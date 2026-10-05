/**
 * Round 4 (2026-10-05): what live pages and the last real fills in prod
 * telemetry showed the current build getting wrong. Each test fails on the
 * code before its fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

describe("a job still running has no end date to write (Workday replica, 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  /** Workday's work-experience row: the "To" date is on the page until the
   *  "I currently work here" box is ticked, then Workday removes it. */
  function row(n: number): string {
    const p = `workExperience-${21 + n}`;
    const part = (date: string, cap: string) =>
      `<input type="text" role="spinbutton" id="${p}--${date}-dateSection${cap}-input" data-automation-id="dateSection${cap}-input" aria-label="${cap}" aria-valuemin="1" aria-valuemax="${cap === "Year" ? "2100" : "12"}">`;
    const date = (key: string, label: string) =>
      `<div data-automation-id="formField-${key}"><div id="${p}-${key}-l">${label}*</div><div data-automation-id="dateInputWrapper" role="group" aria-labelledby="${p}-${key}-l">${part(key, "Month")}${part(key, "Year")}</div></div>`;
    return `<div class="row" role="group" data-automation-id="workExperience-${n + 1}" aria-labelledby="${p}-heading">
      <h4 id="${p}-heading">Work Experience ${n + 1}</h4>
      <div data-automation-id="formField-company"><label for="${p}--company">Company*</label><input type="text" id="${p}--company" data-automation-id="company"></div>
      <div data-automation-id="formField-currentlyWorkHere"><input type="checkbox" id="${p}--currentlyWorkHere" data-automation-id="currentlyWorkHere"><label for="${p}--currentlyWorkHere">I currently work here</label></div>
      ${date("startDate", "From")}${date("endDate", "To")}
    </div>`;
  }

  it("the current job's To parts get nothing; a past job's get its date", () => {
    document.body.innerHTML = `<div data-automation-id="workExperienceSection"><h3>Work Experience</h3>${row(0)}${row(1)}</div>`;
    const profile = {
      ...MOCK_PROFILE,
      experience: [
        { company: "Dell Technologies", title: "Software Engineer II", startDate: "Jan 2023", endDate: "Present", description: "" },
        { company: "Indeed", title: "Software Engineer", startDate: "Jul 2019", endDate: "Dec 2022", description: "" },
      ],
    };
    const { fields } = scanPage(profile, false);
    const to = (n: number, cap: string) => fields.find((f) => fieldEl(f.id)?.id === `workExperience-${21 + n}--endDate-dateSection${cap}-input`);
    expect(to(1, "Year"), "the past job's To year is scanned").toBeDefined();
    // Typed into a Month box, "Present" could only fail: Workday removes the
    // date once the box is ticked, and the fill reported two failed fields.
    expect(to(0, "Month")?.proposedValue ?? null).toBeNull();
    expect(to(0, "Year")?.proposedValue ?? null).toBeNull();
    expect(to(1, "Year")?.proposedValue).toBe("Dec 2022");
    document.body.innerHTML = "";
  });
});

describe("a follow-up after a legal-status condition is never answered by the condition (Pinterest, question bank 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  it("'If you do require sponsorship…, please list the type of support' gets no bare Yes/No", async () => {
    const { setResolveContext } = await import("../src/content/fieldResolver");
    const label = "If you do require employee sponsorship or assistance for work authorization, please list the type of support you may require.";
    // The profile's own sponsorship answer ("No", about Canada) was typed in.
    const canadian = { ...MOCK_PROFILE, location: "Toronto, ON, Canada", workAuthorization: "Canadian citizen", requiresSponsorship: "No", authorizedUS: "No", authorizedCanada: "Yes" };
    const opt = { ...MOCK_PROFILE, location: "Boston, MA", workAuthorization: "F-1 STEM OPT", requiresSponsorship: "Yes", authorizedUS: "Yes" };
    for (const p of [canadian, opt]) {
      document.body.innerHTML = `<div class="job__location">San Francisco, CA, US</div><form><div class="field"><label for="q0">${label}</label><input type="text" id="q0"></div></form>`;
      setResolveContext({ jobCountry: "US", jobCity: "San Francisco", jobPlaces: null, company: "Pinterest" });
      const { fields } = scanPage(p, true);
      const f = fields.find((x) => fieldEl(x.id)?.id === "q0");
      expect(f, "the question is scanned").toBeDefined();
      expect(f!.proposedValue ?? null).toBeNull();
    }
    document.body.innerHTML = "";
  });
});

describe("JazzHR's questionnaire (Directors Investment Group, live 2026-10-05)", () => {
  let restore: () => void;
  let fields: import("../src/shared/types").DetectedField[] = [];
  beforeAll(async () => {
    restore = stubLayout();
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { setResolveContext } = await import("../src/content/fieldResolver");
    const { detectJobPlace } = await import("../src/content/jobLocation");
    const { US_H1B_SENIOR } = await import("./e2e/profiles.mjs");
    const html = readFileSync(path.resolve(__dirname, "fixtures", "real", "jazzhr", "jazzhr-dig-analyst.html"), "utf8");
    document.documentElement.innerHTML = html.replace(/^<!doctype html>\s*/i, "").replace(/^<html[^>]*>|<\/html>\s*$/gi, "");
    const place = detectJobPlace(document);
    setResolveContext({ jobCountry: place.country ?? "US", jobCity: place.city, jobPlaces: place.places ?? null, company: "Directors Investment Group" });
    fields = scanPage(US_H1B_SENIOR as never, true).fields;
  });
  afterAll(() => {
    restore();
    document.body.innerHTML = "";
  });
  const byId = (id: string) => fields.find((f) => fieldEl(f.id)?.id === id || document.getElementById(id)?.closest("[data-ap-field]") === fieldEl(f.id));
  const proposal = (id: string) => byId(id)?.proposedValue ?? null;

  it("an acknowledgement offered as 'I consent' / 'I do not Consent' is consent, never the disability question", () => {
    // Its paragraph ends "…a qualified individual with a disability…ADA": read
    // as the disability question, the profile's "No" ticked "I do not Consent".
    const group = fields.find((f) => f.controlType === "checkboxGroup" && /misrepresentation/.test(f.label));
    expect(group, "the acknowledgement is scanned").toBeDefined();
    expect(group!.category).not.toMatch(/^eeo/);
    expect(group!.proposedValue).toBe("I consent");
  });

  it("a select showing its '-- No answer --' placeholder is empty, and answered", () => {
    // JazzHR's placeholders carry values ("0", "resumator_no_selection"): read
    // as answers already given, ten questions were never filled.
    for (const id of ["resumator-relocate-value", "resumator-over18-value", "resumator-questionnaire-q1340209", "resumator-questionnaire-q1340211", "resumator-questionnaire-q1340212"]) {
      expect(byId(id)?.currentValue, id).toBeUndefined();
    }
    expect(proposal("resumator-relocate-value")).toBe("No");
    expect(proposal("resumator-over18-value")).toBe("Yes");
    expect(proposal("resumator-questionnaire-q1340209")).toBe("Yes");
    expect(proposal("resumator-questionnaire-q1340211")).toBe("Yes");
    expect(proposal("resumator-questionnaire-q1340212")).toBe("No");
  });

  it("each repeated education and employment block is its own row; their addresses are not the applicant's", () => {
    // Both schools were the first school, both employers the current one, and
    // the employers' "Address?" got the applicant's home street.
    expect(proposal("resumator-questionnaire-q1340185")).toBe("University of Washington");
    expect(proposal("resumator-questionnaire-q1340189")).toBe("Hanoi University of Science and Technology");
    expect(proposal("resumator-questionnaire-q1340192")).toBe("Computer Science");
    expect(proposal("resumator-questionnaire-q1340187")).toBeNull();
    expect(proposal("resumator-questionnaire-q1340190")).toBeNull();
    expect(proposal("resumator-questionnaire-q1340193")).toBe("Expedia Group");
    expect(proposal("resumator-questionnaire-q1340201")).toBe("Redfin");
    expect(proposal("resumator-questionnaire-q1340196")).toBeNull();
    expect(proposal("resumator-questionnaire-q1340204")).toBeNull();
  });
});

describe("Greenhouse batch 2 and the question bank: what a scan proposes (2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());
  const scanOne = async (html: string, profile: object, ctx: { jobCountry: string | null; jobCity?: string | null; company: string }) => {
    const { setResolveContext } = await import("../src/content/fieldResolver");
    document.body.innerHTML = `<form>${html}</form>`;
    setResolveContext({ jobPlaces: null, jobCity: null, ...ctx });
    const fields = scanPage(profile as never, true).fields;
    document.body.innerHTML = "";
    return fields;
  };
  const select = (label: string, options: string[]) =>
    `<div class="field"><label for="s">${label}</label><select id="s"><option value="">Select...</option>${options.map((o, i) => `<option value="${i}">${o}</option>`).join("")}</select></div>`;
  const text = (label: string) => `<div class="field"><label for="t">${label}</label><input type="text" id="t"></div>`;

  it("a typed signature asking for the full legal name gets the full name, not the last name (Block)", async () => {
    const { COMPLETE_CANADIAN } = await import("./e2e/profiles.mjs");
    const label = "I certify that all of the information I have provided is correct and complete and realize that falsification or misrepresentation, including omission, on this or any other personnel record, or in the hiring process, may be grounds for refusal of employment. By signing this Electronic Signature Acknowledgment Online Form, I agree that my electronic signature is the legally binding equivalent to my handwritten signature. Please sign by typing your Full Legal First, Middle Initial, and Last Name*";
    const [f] = await scanOne(text(label), COMPLETE_CANADIAN, { jobCountry: "CA", company: "Block" });
    expect(f.category).toBe("fullName");
    expect(f.proposedValue).toBe("Maya Tremblay");
  });

  it("an expectations agreement whose only option is 'I agree…' is agreed to, never a name (Block)", async () => {
    const { COMPLETE_CANADIAN } = await import("./e2e/profiles.mjs");
    const label = "How we interview: Our hiring process prioritizes authenticity and fairness. Recording any part of the interview without consent is prohibited. Lastly, maintain confidentiality by refraining from sharing any proprietary or trade secret information from previous employers.";
    const [f] = await scanOne(select(label, ["I agree to these expectations"]), COMPLETE_CANADIAN, { jobCountry: "CA", company: "Block" });
    expect(f.proposedValue).toBe("I agree to these expectations");
  });

  it("'Legal Name (if different than above)' stays blank (Cloudflare)", async () => {
    const { INDIA_NEW_GRAD } = await import("./e2e/profiles.mjs");
    const [f] = await scanOne(text("Legal Name (if different than above)"), INDIA_NEW_GRAD, { jobCountry: "US", company: "Cloudflare" });
    expect(f.proposedValue ?? null).toBeNull();
  });
});

describe("Duolingo's careers site (live 2026-10-05)", () => {
  /** Its select: the choice shown in a span beside an empty listbox button. */
  const widget = (shown: string) =>
    `<div role="group" id="g"><div><div class="FUCuR"><span class="GfJwj">${shown}</span><button aria-controls="web-ui11" aria-haspopup="listbox" type="button" id="b"></button></div></div></div>`;

  it("reads the choice shown beside the trigger, so a pick that took is no 'didn't stick'", async () => {
    // 13 fields on one page were reported "Selection didn't stick" while the
    // page showed every answer.
    const { readComboboxValue } = await import("../src/content/comboboxEngine");
    document.body.innerHTML = widget("Yes");
    expect(readComboboxValue(document.getElementById("b") as HTMLElement)).toBe("Yes");
    document.body.innerHTML = widget("Select...");
    expect(readComboboxValue(document.getElementById("b") as HTMLElement)).toBeUndefined();
    document.body.innerHTML = "";
  });

  it("'After the OPT, are you eligible for a 24-month OPT extension…?' is no residence question", async () => {
    // "…or are currently in a 24-month OPT extension based upon a degree from a
    // qualifying U.S. institution" read as "are you in the US?": a US citizen got Yes.
    const { resolveQuestion } = await import("../src/content/questionResolver");
    const { profileFacts } = await import("../src/content/profileFacts");
    const { BOOTCAMP_CAREER_GAP, US_OPT_ANALYST } = await import("./e2e/profiles.mjs");
    const label = "After the OPT, are you eligible for a 24-month OPT extension or are currently in a 24-month OPT extension based upon a degree from a qualifying U.S. institution in Science, Technology, Engineering, or Mathematics after the Optional Practical Training (OPT)?*";
    const ask = (p: object) => resolveQuestion({ label, controlType: "combobox", options: ["Yes", "No"], category: "school", kind: "boolean" }, profileFacts(p as never), p as never, { jobCountry: "US", company: "Duolingo" });
    expect(ask(BOOTCAMP_CAREER_GAP)).toMatchObject({ status: "answer", value: "No" });
    expect(ask(US_OPT_ANALYST)).toMatchObject({ status: "answer", value: "Yes" });
  });
});

describe("a country written 'US' is the United States (Accenture Federal, Epic Games; live 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());
  it("a phone picker of 'United States +1' takes it", async () => {
    // The picker matched no "US", and the field went to the AI.
    const { BOOTCAMP_CAREER_GAP } = await import("./e2e/profiles.mjs");
    document.body.innerHTML = `<form><div class="field"><label for="c">Country*</label><select id="c"><option value="">Select...</option><option>United States +1</option><option>Afghanistan +93</option><option>Canada +1</option></select></div></form>`;
    const [f] = scanPage(BOOTCAMP_CAREER_GAP as never, true).fields;
    expect(f.proposedValue).toBe("United States +1");
    document.body.innerHTML = "";
  });
});

describe("a second email the profile does not have stays blank (Duolingo, live 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());
  it("'Alternate Email' is not the email again", async () => {
    const { COMPLETE_CANADIAN } = await import("./e2e/profiles.mjs");
    document.body.innerHTML = `<form><div class="field"><label for="e1">Email*</label><input type="email" id="e1"></div><div class="field"><label for="e2">Alternate Email</label><input type="email" id="e2"></div></form>`;
    const fields = scanPage(COMPLETE_CANADIAN as never, true).fields;
    const alt = fields.find((f) => fieldEl(f.id)?.id === "e2");
    const main = fields.find((f) => fieldEl(f.id)?.id === "e1");
    expect(main?.proposedValue).toBe("maya.tremblay@example.com");
    expect(alt?.proposedValue ?? null).toBeNull();
    document.body.innerHTML = "";
  });
});

/** The element a scanned field was registered on. */
function fieldEl(id: string): HTMLElement | null {
  return document.querySelector(`[data-ap-field="${id}"]`);
}

describe("a phone widget that adds the country code (Waymo's embedded Greenhouse, live 2026-10-05)", () => {
  it("'(416) 555-0142' read back as '+14165550142' was written, not 'did not stick'", async () => {
    // Also in prod telemetry (2026-09-28): "Phone Number: Value did not stick.
    // Fill manually" on a page that held the right number.
    const { verifyControl } = await import("../src/content/writeEngine");
    const el = document.createElement("input");
    el.type = "tel";
    document.body.append(el);
    const control = { id: "p", controlType: "text" as const, el };
    el.value = "+14165550142";
    expect(verifyControl(control, "(416) 555-0142")).toBe(true);
    el.value = "+1 512-555-0143";
    expect(verifyControl(control, "512-555-0143")).toBe(true);
    // Another number, or a code that swallows a trunk zero, is not the number.
    el.value = "+14165550199";
    expect(verifyControl(control, "(416) 555-0142")).toBe(false);
    el.value = "+12079460958";
    expect(verifyControl(control, "020 7946 0958")).toBe(false);
    el.remove();
  });
});

describe("a place listed twice (Greenhouse's location lookup, Gemini and GitLab, live 2026-10-05)", () => {
  it("'Seattle, Washington, United States' twice is one place, not an ambiguity", async () => {
    // Every Seattle applicant's Location (City) stayed blank: the lookup
    // returns the city twice, and two identical suggestions read as a tie.
    const { pickPlaceOption } = await import("../src/content/placeMatch");
    const seattle = ["Seattle, Washington, United States", "Seattle, Washington, United States", "Seattle Bar, Oregon, United States", "Seattle Hill-Silver Firs, Washington, United States", "Seattle Heights, Washington, United States", "Seattle Hill, United States", "South Seattle, Washington, United States"];
    expect(pickPlaceOption(seattle, "Seattle, WA, United States")).toBe(0);
    // Two DIFFERENT places that both fit still choose none.
    expect(pickPlaceOption(["Springfield, United States", "Springfield, Illinois, United States", "Springfield, Missouri, United States"], "Springfield, United States")).toBe(-1);
  });
});

describe("react-select before v5: no role=combobox on its input (Epic Games' Greenhouse form, live 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  it("the phone country box is a dropdown driven by the react-select driver, never a text box", async () => {
    const { BOOTCAMP_CAREER_GAP } = await import("./e2e/profiles.mjs");
    // Typed into as text, "United States" was wiped on blur and reported as
    // "Value did not stick. Fill manually" on a box that already showed +1.
    document.body.innerHTML = `<form>
      <label for="phoneCountry">Country<span>*</span>:</label>
      <div class="dropdown-autocomplete css-2b097c-container"><div class=" css-l772dy-control"><div class=" css-w3rxe2"><div class=" css-1uccc91-singleValue"><span class="PhoneField__OptionLabel-sc-1u9iqd2-1 ZnQkP"><span class="phone-country-flag" aria-hidden="true"></span><span class="phone-country-code">+1</span></span></div><div class="css-iqsof5"><div class=""><input autocomplete="off" id="phoneCountry" tabindex="0" type="text" aria-autocomplete="list" aria-label="Country: United States +1" value=""><div></div></div></div></div><div class=" css-1wy0on6"><span class=" css-43ykx9-indicatorSeparator"></span><div aria-hidden="true" class=" css-tlfecz-indicatorContainer"></div></div></div></div>
      <label for="city">City</label><input type="text" id="city" aria-autocomplete="list">
    </form>`;
    const { fields, registry } = scanPage(BOOTCAMP_CAREER_GAP as never, true);
    const country = fields.find((f) => f.selector === "#phoneCountry" || /country/i.test(f.label));
    expect(country).toBeTruthy();
    const control = registry.get(country!.id)!;
    expect(control.controlType).toBe("combobox");
    expect(control.driver).toBe("react-select");
    // A plain suggestion box (no react-select markup) stays a text box.
    const city = fields.find((f) => /city/i.test(f.label));
    expect(city && registry.get(city.id)!.controlType).toBe("text");
    document.body.innerHTML = "";
  });
});

describe("react-select before v5 labelled by a <label for> naming no element (Epic Games' form, live 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  const widget = (n: number) =>
    `<div class="dropdown-autocomplete css-2b097c-container"><div class=" css-l772dy-control"><div class=" css-w3rxe2"><div class=" css-xewewq-placeholder">Select</div><div class="css-iqsof5"><div class=""><input autocapitalize="none" autocomplete="off" autocorrect="off" id="react-select-${n}-input" spellcheck="false" tabindex="0" type="text" aria-autocomplete="list" value=""><div></div></div></div></div><div class=" css-1wy0on6"><span class=" css-43ykx9-indicatorSeparator"></span><div aria-hidden="true" class=" css-tlfecz-indicatorContainer"></div></div></div></div>`;
  const question = (n: number, text: string) =>
    `<div class="field-group dropdown"><div class="InputLabel__Styled-sc-1ig3mnl-0 comeCg"><label for="${text}"><span>${text}⁠*⁠:</span></label></div><div><div class="CustomSelectstyles__Styled-sc-1f1rlew-0 iIwtmE custom-select"><div><div class="">${widget(n)}</div></div></div></div><div class="ue-spacer eyebrow"></div></div>`;

  it("each dropdown takes the question printed beside it, not its react-select id", async () => {
    // Sixteen questions (how did you hear, work authorization, 40 hours a
    // week, the truthfulness confirmation, School, Degree…) were invisible
    // as text boxes, then surfaced unlabelled as "react-select-4-input".
    const { BOOTCAMP_CAREER_GAP } = await import("./e2e/profiles.mjs");
    document.body.innerHTML = `<form>
      ${question(4, "How did you hear about this job posting?")}
      ${question(5, "Do you now, or will you in the future, require sponsorship for employment authorization in order to legally work in the location associated with this job posting?")}
      ${question(6, "Do you have legal authorization to work in the geographic region specified for the internship?")}
      ${question(12, "I confirm all answers provided by me within this application are true and correct.")}
      <div><div class="InputLabel__Styled-sc-1ig3mnl-0 comeCg"><label for="educations[0].school_name_id"><span>School⁠⁠⁠*⁠:</span></label></div><div class="">${widget(13)}</div></div>
    </form>`;
    const { fields } = scanPage(BOOTCAMP_CAREER_GAP as never, true);
    const field = (n: number) => fields.find((f) => fieldEl(f.id)?.id === `react-select-${n}-input`);
    const label = (n: number) => field(n)?.label ?? "";
    expect(label(4)).toMatch(/^How did you hear about this job posting\?/);
    // Past 160 characters a <label> is still a label, not a description to
    // skip on the way to the question before it.
    expect(label(5)).toMatch(/^Do you now, or will you in the future, require sponsorship/);
    expect(label(6)).toMatch(/^Do you have legal authorization to work/);
    expect(label(12)).toMatch(/^I confirm all answers/);
    expect(label(13)).toMatch(/^School/);
    expect(field(13)?.category).toBe("school");
    // "react-select-13-input" numbers the widget, not an education row: School
    // read as row 1 and proposed the applicant's high school.
    expect(field(13)?.groupIndex ?? 0).toBe(0);
    expect(field(13)?.proposedValue).toBe("Turing School of Software & Design");
    document.body.innerHTML = "";
  });

  it("keeps the question once the page marks the dropdown required, and past a description link", async () => {
    // Live, an empty required dropdown left by the fill grows "This section
    // is required" in its block, and the label search stopped short of the
    // question; a description link between question and dropdown was read
    // as the question.
    const { BOOTCAMP_CAREER_GAP } = await import("./e2e/profiles.mjs");
    const c = "Do you have demonstrated experience using C++ in the form of school, work, and/or personal projects included on your resume?";
    const notice = "I acknowledge that I have read and understand the Epic Games Candidate Privacy Notice.";
    document.body.innerHTML = `<form>
      <div class="field-group dropdown"><div class="InputLabel__Styled-sc-1ig3mnl-0 comeCg"><label for="${c}"><span>${c}⁠*⁠:</span></label></div><div><div class="CustomSelectstyles__Styled-sc-1f1rlew-0 iIwtmE custom-select"><div><div class="validate-error">${widget(8)}<div class="InputValidationErrorMsg__Styled-sc-r7ic4l-0 gohdUo validate-msg">This section is required</div></div></div></div></div><div class="ue-spacer eyebrow"></div></div>
      <div class="field-group dropdown"><div class="InputLabel__Styled-sc-1ig3mnl-0 comeCg"><label for="${notice}"><span>${notice}⁠*⁠:</span></label></div><div class="field-description"><p><a href="https://example.com/privacy">Epic Games Candidate Privacy Notice</a></p></div><div><div class="CustomSelectstyles__Styled-sc-1f1rlew-0 iIwtmE custom-select"><div><div class="">${widget(11)}</div></div></div></div></div>
    </form>`;
    const { fields } = scanPage(BOOTCAMP_CAREER_GAP as never, true);
    const label = (n: number) => fields.find((f) => fieldEl(f.id)?.id === `react-select-${n}-input`)?.label ?? "";
    expect(label(8)).toMatch(/^Do you have demonstrated experience using C\+\+/);
    expect(label(11)).toMatch(/^I acknowledge that I have read and understand/);
    document.body.innerHTML = "";
  });
});

describe("a high school diploma is a high school (Epic Games' Degree, live 2026-10-05)", () => {
  it("'High School Diploma' reads as High School, and snaps to 'High School / Secondary Education'", async () => {
    // Read as a "Diploma", it matched none of Epic's degree options and the
    // field stayed blank. A college "Diploma in …" stays a Diploma.
    const { deriveDegreeLevel } = await import("../src/content/fieldMatcher");
    expect(deriveDegreeLevel("High School Diploma")).toBe("High School");
    expect(deriveDegreeLevel("Diploma in Computer Engineering Technology")).toBe("Diploma");
    const { snapToOption } = await import("../src/content/fieldResolver");
    const epic = ["Associates", "Autre", "Baccalauréat", "Bachelors", "Diplôme d'études collégiales (DEC)", "Diplôme d'études secondaires (DES)", "Doctorat", "Doctorate", "High School / Secondary Education", "Maîtrise", "Masters", "Other"];
    expect(snapToOption(epic, deriveDegreeLevel("High School Diploma")!, "degree")).toBe("High School / Secondary Education");
  });
});

describe("education fields answered from the wrong fact (question bank 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  const select = (id: string, label: string, options: string[]) =>
    `<div class="field"><label for="${id}">${label}</label><select id="${id}"><option value="">Select...</option>${options.map((o, i) => `<option value="${i}">${o}</option>`).join("")}</select></div>`;
  const text = (id: string, label: string) => `<div class="field"><label for="${id}">${label}</label><input type="text" id="${id}"></div>`;

  it("Secondary Major, a university email, and when the degree ends are not the major, the email and the degree's name", async () => {
    const { COMPLETE_CANADIAN, US_H1B_SENIOR } = await import("./e2e/profiles.mjs");
    document.body.innerHTML = `<form>
      ${select("sm", "Secondary Major", ["Computer Science", "Engineering", "Information Systems", "Mathematics"])}
      ${text("ue", "University Email Address")}
      ${text("wd", "When do you expect to complete your degree?")}
    </form>`;
    const value = (p: unknown, id: string) => {
      const { fields } = scanPage(p as never, true);
      return fields.find((f) => fieldEl(f.id)?.id === id)?.proposedValue ?? null;
    };
    // Jane Street: "Engineering" and "Information Systems" as the SECOND major.
    expect(value(COMPLETE_CANADIAN, "sm")).toBeNull();
    expect(value(US_H1B_SENIOR, "sm")).toBeNull();
    // Jane Street: the personal email as the university one.
    expect(value(COMPLETE_CANADIAN, "ue")).toBeNull();
    // Stripe: "Bachelor of Applied Science in Mechatronics Engineering" as a date.
    expect(value(COMPLETE_CANADIAN, "wd")).toBe("April 2027");
    expect(value(US_H1B_SENIOR, "wd")).toBeNull();
    document.body.innerHTML = "";
  });

  it("a school list picks the school by its own name, never another sharing its generic words (Squarespace)", async () => {
    // "Turing School of Software & Design" chose "Parsons School of Design":
    // "school", "of" and "design" are every school's words.
    const { BOOTCAMP_CAREER_GAP, US_H1B_SENIOR } = await import("./e2e/profiles.mjs");
    const label = "School - Please select your most recently attended school from this list or select the option “My School is not listed” or “I did not attend college.”";
    const options = ["**My school is not listed", "**I did not attend college", "Parsons School of Design", "Rhode Island School of Design", "University of Washington", "University of Washington - Bothell", "Washington State University"];
    document.body.innerHTML = `<form>${select("sc", label, options)}</form>`;
    const value = (p: unknown) => scanPage(p as never, true).fields.find((f) => fieldEl(f.id)?.id === "sc")?.proposedValue ?? null;
    // Whether it is listed under another name is not ours to say: blank.
    expect(value(BOOTCAMP_CAREER_GAP)).toBeNull();
    expect(value(US_H1B_SENIOR)).toBe("University of Washington");
    document.body.innerHTML = "";
  });
});

describe("a salary in the unit asked (StackAdapt, question bank 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  it("'salary expectations (hourly)' never gets a yearly figure", async () => {
    const { US_H1B_SENIOR } = await import("./e2e/profiles.mjs");
    const box = (id: string, label: string) => `<div class="field"><label for="${id}">${label}</label><input type="text" id="${id}"></div>`;
    document.body.innerHTML = `<form>${box("h", "What are your salary expectations (hourly)?")}${box("y", "What are your salary expectations?")}</form>`;
    const { fields } = scanPage(US_H1B_SENIOR as never, true);
    const value = (id: string) => fields.find((f) => fieldEl(f.id)?.id === id)?.proposedValue ?? null;
    expect(value("h")).toBeNull();
    expect(value("y")).toBe("$185,000");
    document.body.innerHTML = "";
  });
});

describe("EEO answers in other words (question bank 2026-10-05: Chime, Braze)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  it("'Black or African American' is 'Black / Of African descent (…)' (Chime)", async () => {
    const { closestDemographicOption } = await import("../src/content/demographicMatch");
    const chime = ["Alaskan Native / American Indian / Indigenous American / Native American (A person having origins in any of the original peoples of North and South America (including Central America), and who maintain tribal affiliation or community attachment.)", "Black / Of African descent (A person having origins in any of the Black racial groups of Africa.)", "East Asian (inclusive of Chinese, Japanese, Korean, Mongolian, Tibetan, and Taiwanese)", "White (A person having origins in any of the original peoples of Europe)", "I don't wish to answer"];
    expect(closestDemographicOption("eeoRace", "Black or African American", chime)).toBe(chime[1]);
  });

  it("a cisgender woman among plain and transgender-only options is 'Female' (Braze)", async () => {
    const { COMPLETE_CANADIAN } = await import("./e2e/profiles.mjs");
    const braze = ["Agender", "Bigender", "Female", "Genderfluid", "Genderqueer", "Male", "Nonbinary", "Transgender", "Transgender-Female", "Transgender-Male", "I don't wish to answer"];
    document.body.innerHTML = `<form><div class="field"><label for="g">Voluntary Self-Identification of Gender and Gender Identity (Select one)</label><select id="g"><option value="">Select...</option>${braze.map((o, i) => `<option value="${i}">${o}</option>`).join("")}</select></div></form>`;
    const { fields } = scanPage(COMPLETE_CANADIAN as never, true);
    expect(fields.find((f) => fieldEl(f.id)?.id === "g")?.proposedValue).toBe("Female");
    document.body.innerHTML = "";
  });
});
