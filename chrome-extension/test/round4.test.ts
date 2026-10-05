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
