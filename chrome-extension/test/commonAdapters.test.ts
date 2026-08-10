import { describe, it, expect, beforeEach } from "vitest";
import { getAdapter } from "../src/content/adapters";
import { buildAtsAdapter } from "../src/content/adapters/common";
import {
  attrBlob,
  classifyByAttr,
  advanceBySelectors,
  parseDateParts,
  setNativeValue,
  SOCIAL_URL_RULES,
  NAME_ATTR_RULES,
} from "../src/content/adapters/shared";
import type { FieldContext } from "../src/content/adapters/types";

beforeEach(() => {
  document.body.innerHTML = "";
});

function input(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

function ctx(el: HTMLElement): FieldContext {
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}

// ---------------------------------------------------------------------------
// Host detection: every registered ATS resolves from a real careers hostname,
// and look-alike domains never match (anchored `(^|\.)…$`).
// ---------------------------------------------------------------------------

describe("getAdapter resolves each ATS by host", () => {
  const cases: Array<[string, string]> = [
    ["jobs.lever.co", "lever"],
    ["acme.bamboohr.com", "bamboohr"],
    ["acme.breezy.hr", "breezy"],
    ["jobs.ashbyhq.com", "ashby"],
    ["apply.workable.com", "workable"],
    ["jobs.smartrecruiters.com", "smartrecruiters"],
    ["jobs.jobvite.com", "jobvite"],
    ["ats.rippling.com", "rippling"],
    ["app.rippling-ats.com", "rippling"],
    ["public.hr.bullhornstaffing.com", "bullhorn"],
    ["careers-acme.icims.com", "icims"],
    ["acme.taleo.net", "taleo"],
    ["workforcenow.adp.com", "adp"],
    ["myjobs.adp.com", "adp"],
    ["career5.successfactors.com", "successfactors"],
    ["acme.sapsf.eu", "successfactors"],
    ["acme.fa.us2.oraclecloud.com", "oraclecloud"],
    ["acme.dayforcehcm.com", "dayforce"],
    ["recruiting.ultipro.com", "ukg"],
    ["acme.applytojob.com", "jazzhr"],
    ["recruiting.paylocity.com", "paylocity"],
    ["acme.avature.net", "avature"],
    ["acme.phenompeople.com", "phenom"],
    ["acme.teamtailor.com", "teamtailor"],
    ["acme.recruitee.com", "recruitee"],
    ["acme.jobs.personio.de", "personio"],
    ["acme.eightfold.ai", "eightfold"],
    ["acme.clearcompany.com", "clearcompany"],
    ["www.paycomonline.net", "paycom"],
    ["sjobs.brassring.com", "brassring"],
  ];

  it.each(cases)("%s → %s", (host, id) => {
    expect(getAdapter(host, `https://${host}/apply`)?.id).toBe(id);
  });

  it("still resolves the hand-tuned Greenhouse and Workday adapters", () => {
    expect(getAdapter("boards.greenhouse.io", "https://boards.greenhouse.io/x")?.id).toBe("greenhouse");
    expect(getAdapter("acme.wd5.myworkdayjobs.com", "")?.id).toBe("workday");
  });

  it("does not match unrelated or look-alike hosts", () => {
    expect(getAdapter("example.com", "https://example.com")).toBeNull();
    expect(getAdapter("notlever.co.evil.com", "")).toBeNull();
    expect(getAdapter("lever.co.attacker.net", "")).toBeNull();
    expect(getAdapter("fakeicims.com", "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Classification: social URLs by machine name, namespaced first/last names,
// and the safety vetoes.
// ---------------------------------------------------------------------------

describe("social-URL classification (shared across adapters)", () => {
  const lever = buildAtsAdapter({ id: "lever", host: /lever/ });

  it("classifies Lever-style urls[Network] fields the label hides", () => {
    expect(lever.classify!(ctx(input({ name: "urls[LinkedIn]" })), gen())?.category).toBe("linkedin");
    expect(lever.classify!(ctx(input({ name: "urls[GitHub]" })), gen())?.category).toBe("github");
    expect(lever.classify!(ctx(input({ name: "urls[Portfolio]" })), gen())?.category).toBe("portfolio");
  });

  it("does not mistake a company website field for a portfolio", () => {
    expect(lever.classify!(ctx(input({ name: "company_website" })), gen())).toBeUndefined();
  });

  it("declines fields with no structural attributes (defers to generic)", () => {
    expect(lever.classify!(ctx(input({})), gen())).toBeUndefined();
  });
});

describe("name-attribute classification (namespaced ATS)", () => {
  const jazzhr = buildAtsAdapter({ id: "jazzhr", host: /x/, rules: NAME_ATTR_RULES });
  const teamtailor = buildAtsAdapter({ id: "teamtailor", host: /x/, rules: NAME_ATTR_RULES });

  it("reads JazzHR job_application[first_name]/[last_name]", () => {
    expect(jazzhr.classify!(ctx(input({ name: "job_application[first_name]" })), gen())?.category).toBe("firstName");
    expect(jazzhr.classify!(ctx(input({ name: "job_application[last_name]" })), gen())?.category).toBe("lastName");
  });

  it("reads Teamtailor candidate[first_name]", () => {
    expect(teamtailor.classify!(ctx(input({ name: "candidate[first_name]" })), gen())?.category).toBe("firstName");
  });
});

describe("Lever org → currentCompany", () => {
  it("maps the Lever current-company machine name", () => {
    const adapter = getAdapter("jobs.lever.co", "https://jobs.lever.co/acme/x")!;
    expect(adapter.classify!(ctx(input({ name: "org" })), gen())?.category).toBe("currentCompany");
  });
});

// ---------------------------------------------------------------------------
// shared.ts unit coverage
// ---------------------------------------------------------------------------

describe("classifyByAttr", () => {
  it("flags EEO categories as sensitive", () => {
    const c = classifyByAttr(input({ name: "gender" }), [[/gender/, "eeoGender"]]);
    expect(c).toEqual({ category: "eeoGender", confidence: 0.95, sensitive: true });
  });
  it("reads an ancestor's data-automation-id when asked", () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-automation-id", "legalNameSection_firstName");
    const el = document.createElement("input");
    wrap.append(el);
    document.body.append(wrap);
    expect(classifyByAttr(el, [[/firstname/, "firstName"]], 0.96, ["data-automation-id"])?.category).toBe("firstName");
  });
});

describe("attrBlob", () => {
  it("concatenates and lowercases structural attributes only", () => {
    const el = input({ name: "urls[LinkedIn]", id: "q7", "aria-label": "LinkedIn" });
    const blob = attrBlob(el);
    expect(blob).toContain("urls[linkedin]");
    expect(blob).toContain("q7");
    expect(blob).not.toContain("aria"); // label sources are intentionally excluded
  });
});

describe("parseDateParts", () => {
  it("parses ISO and US dates into unpadded parts", () => {
    expect(parseDateParts("2023-05-09")).toEqual({ year: "2023", month: "5", day: "9" });
    expect(parseDateParts("5/9/2023")).toEqual({ month: "5", day: "9", year: "2023" });
  });
  it("returns null for unparseable input", () => {
    expect(parseDateParts("last tuesday")).toBeNull();
  });
});

describe("setNativeValue", () => {
  it("writes the value and dispatches input+change", () => {
    const el = input({});
    const events: string[] = [];
    el.addEventListener("input", () => events.push("input"));
    el.addEventListener("change", () => events.push("change"));
    setNativeValue(el, "hello");
    expect(el.value).toBe("hello");
    expect(events).toEqual(["input", "change"]);
  });
});

describe("advanceBySelectors", () => {
  it("prefers an enabled match and can look outside the scope", () => {
    document.body.innerHTML = `
      <div id="scope"><button disabled data-x>Next</button></div>
      <footer><button id="go" data-x>Next</button></footer>`;
    const scope = document.getElementById("scope") as HTMLElement;
    expect(advanceBySelectors(scope, ["button[data-x]"])?.id).toBe("go");
  });
  it("returns null when nothing matches", () => {
    const scope = input({});
    expect(advanceBySelectors(scope.parentElement as HTMLElement, [".nope"])).toBeNull();
  });
});

/** A neutral generic Classification passed as the 2nd classify() arg. */
function gen() {
  return { category: "unknown" as const, confidence: 0, sensitive: false };
}

// Exercise the exported rule tables so an accidental empty export fails loudly.
describe("rule tables are populated", () => {
  it("has social + name rules", () => {
    expect(SOCIAL_URL_RULES.length).toBeGreaterThanOrEqual(3);
    expect(NAME_ATTR_RULES.length).toBe(2);
  });
});
