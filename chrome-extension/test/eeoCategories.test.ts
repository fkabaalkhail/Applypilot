import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { resolveProfileValue } from "../src/content/fieldMatcher";
import { closestDemographicOption } from "../src/content/demographicMatch";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

function selectField(label: string): void {
  const wrap = document.createElement("div");
  const lbl = document.createElement("label");
  const id = `f-${Math.random().toString(36).slice(2)}`;
  lbl.setAttribute("for", id);
  lbl.textContent = label;
  const sel = document.createElement("select");
  sel.id = id;
  sel.innerHTML = `<option value="">Select One</option>`;
  wrap.append(lbl, sel);
  document.body.append(wrap);
}

const catOf = (label: string) => {
  document.body.innerHTML = "";
  selectField(label);
  return scanPage(null, false).fields[0]?.category;
};

describe("gender identity + sexual orientation classification", () => {
  it("distinguishes gender / gender identity / sexual orientation", () => {
    expect(catOf("What is your gender?")).toBe("eeoGender");
    expect(catOf("What is your gender identity?")).toBe("eeoGenderIdentity");
    expect(catOf("What is your sexual orientation?")).toBe("eeoSexualOrientation");
  });
  it("keeps all three flagged sensitive (never AI-guessed)", () => {
    selectField("What is your sexual orientation?");
    expect(scanPage(null, false).fields[0]?.sensitive).toBe(true);
  });
});

describe("resolution from the profile EEO answers", () => {
  const ctrl = { controlType: "select" as const, options: undefined, groupIndex: null };
  it("gender identity uses genderIdentity, falling back to gender", () => {
    const p1 = { eeo: { genderIdentity: "Non-binary", gender: "Male" } } as unknown as UserApplicationProfile;
    expect(resolveProfileValue("eeoGenderIdentity", p1, ctrl, true)).toBe("Non-binary");
    const p2 = { eeo: { gender: "Male" } } as unknown as UserApplicationProfile;
    expect(resolveProfileValue("eeoGenderIdentity", p2, ctrl, true)).toBe("Male");
  });
  it("sexual orientation uses sexualOrientation", () => {
    const p = { eeo: { sexualOrientation: "Heterosexual" } } as unknown as UserApplicationProfile;
    expect(resolveProfileValue("eeoSexualOrientation", p, ctrl, true)).toBe("Heterosexual");
  });
});

describe("on-device option matching", () => {
  it("maps a saved orientation to the widget's option text", () => {
    const opts = ["Select One", "Heterosexual/Straight", "Gay or Lesbian", "Bisexual", "I don't wish to answer"];
    expect(closestDemographicOption("eeoSexualOrientation", "Straight", opts)).toBe("Heterosexual/Straight");
    expect(closestDemographicOption("eeoSexualOrientation", "Gay", opts)).toBe("Gay or Lesbian");
    expect(closestDemographicOption("eeoSexualOrientation", "asexual", opts)).toBe("I don't wish to answer");
  });
});
