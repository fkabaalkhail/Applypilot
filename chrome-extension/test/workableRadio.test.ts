/**
 * Workable's Yes / No (apply.workable.com, live 2026-10-05): a
 * <fieldset role="radiogroup"> whose options are <div role="radio"> wrappers,
 * each around a native, aria-hidden <input type="radio">. Scanned as two
 * fields, the native group filled and the ARIA group, with no options it
 * could read, reported "No option matches" for every such question.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const option = (id: string, value: string, label: string): string =>
  `<label class="styles--2dcpC" role="presentation" data-checked="false"><div aria-labelledby="q_label radio_label_${id}" class="styles--fxWsq" id="wrapper_${id}" role="radio" aria-checked="false" aria-required="false" tabindex="0"><input aria-required="false" id="${id}" tabindex="-1" aria-hidden="true" type="radio" name="CA_31133" class="styles--2e9Cp" value="${value}"></div><span class="styles--QTMDv" id="radio_label_${id}">${label}</span></label>`;

const person = {
  firstName: "Maya", lastName: "Tremblay", email: "maya.tremblay@example.com", phone: "(416) 555-0142",
  location: "Toronto, ON, Canada", country: "Canada", dateOfBirth: "2004-02-11",
  skills: [], education: [], experience: [],
} as unknown as UserApplicationProfile;

describe("Workable's Yes / No", () => {
  it("is one question, answered once", () => {
    document.body.innerHTML = `<form><div class="styles--3aPac"><span><span class="styles--QTMDv" id="q_label"><strong>Are you at least 18 years or older?</strong></span></span>
      <fieldset role="radiogroup" data-ui="CA_31133" aria-labelledby="q_label">${option("yes1", "300034", "Yes")}${option("no1", "300035", "No")}</fieldset></div></form>`;
    const fields = scanPage(person, false, null).fields.filter((f) => /at least 18/i.test(f.label));
    expect(fields.map((f) => f.controlType)).toEqual(["radioGroup"]);
    expect(fields[0]?.options).toEqual(["Yes", "No"]);
    expect(fields[0]?.proposedValue).toBe("Yes");
  });
});
