/**
 * A <fieldset> that is a whole SECTION of the form is no field's question
 * (Pinpoint, live 2026-10-03). Its legend ("1. Personal Details … Apply with
 * LinkedIn") labelled every field inside that had no programmatic label: four
 * address boxes became "LinkedIn" and got the LinkedIn URL, and the radio
 * questions in "3. Questions" were answered from their categories without the
 * question being read. Markup trimmed from the live page, structure verbatim.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPage } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";
import { SPARSE_CANADIAN } from "./fixtures/profiles";
import { stubLayout } from "./helpers/layout";

const PROFILE: UserApplicationProfile = {
  ...SPARSE_CANADIAN,
  linkedin: "https://www.linkedin.com/in/maya-tremblay",
  addressStreet: "1 Washington Sq",
  addressCity: "San Jose",
  addressState: "CA",
  postalCode: "95192",
  country: "United States",
};

const DETAILS = `
<fieldset class="external-form__fieldset" id="application-fieldset-details">
  <legend class="external-form__legend"><div class="frow"><div><span class="external-form__legend-index">1.</span>Personal Details
    <p class="external-form__text">We'll need these details in order to be able to contact you.</p></div>
    <div><a class="external-button external-button--linkedin" href="https://app.pinpointhq.com/auth/linkedin">Apply with LinkedIn</a></div></div></legend>
  <div class="col-1-1"><label class="external-form__label" for="application_form_application_linkedin">LinkedIn URL</label>
    <input type="text" name="application_form[application][linkedin]" id="application_form_application_linkedin"></div>
  <div class="col-1-1"><label class="external-form__label external-form__label--required">Address Line 1</label>
    <input type="text" name="application_form[application][address1]" id="address1" required="" placeholder="Address Line 1" value=""></div>
  <div class="col-1-1"><label class="external-form__label">Address Line 2</label>
    <input type="text" name="application_form[application][address2]" id="address2" placeholder="Address Line 2" value=""></div>
  <div class="col-1-1"><label class="external-form__label">Town</label>
    <input type="text" name="application_form[application][town]" id="town" placeholder="Town" value=""></div>
  <div class="col-1-1"><label class="external-form__label">Postcode</label>
    <input type="text" name="application_form[application][postcode]" id="postcode" placeholder="Postcode" value=""></div>
</fieldset>`;

const boolean = (n: number, question: string) => `
<div class="col-md-1-1"><div class="pad-v-3">
  <label class="external-form__label" for="application_form_application_answers_attributes_${n}_boolean_answer"><span class="external-form__label--title">${question}</span></label>
  <div class="frow frow--gutters">
    <div class="col-1-2"><div class="checkable-input"><div id="answer-label-${n}-true" style="display: none;">${question} yes</div>
      <input class="checkable-input__input" type="radio" id="application_form_application_answers_attributes_${n}_boolean_answer_true" name="application_form[application][answers_attributes][${n}][boolean_answer]" aria-labelledby="answer-label-${n}-true" value="true">
      <label aria-labelledby="answer-label-${n}-true" class="checkable-input__label" for="application_form_application_answers_attributes_${n}_boolean_answer_true">Yes</label></div></div>
    <div class="col-1-2"><div class="checkable-input"><div id="answer-label-${n}-false" style="display: none;">${question} no</div>
      <input class="checkable-input__input" type="radio" id="application_form_application_answers_attributes_${n}_boolean_answer_false" name="application_form[application][answers_attributes][${n}][boolean_answer]" aria-labelledby="answer-label-${n}-false" value="false">
      <label aria-labelledby="answer-label-${n}-false" class="checkable-input__label" for="application_form_application_answers_attributes_${n}_boolean_answer_false">No</label></div></div>
  </div></div></div>`;

const QUESTIONS = `
<fieldset class="external-form__fieldset">
  <legend class="external-form__legend"><span class="external-form__legend-index">3.</span>Questions</legend>
  ${boolean(5, "Are you a U.S. Citizen?")}
  ${boolean(6, "Are you able to obtain/maintain a U.S. security clearance?")}
  ${boolean(7, "Military Service")}
</fieldset>`;

describe("a section <fieldset> labels none of its fields (Pinpoint)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const scan = (html: string) => {
    document.body.innerHTML = `<form>${html}</form>`;
    return scanPage(PROFILE, false, null).fields;
  };

  it("each address box keeps its own label, category and value", () => {
    const f = scan(DETAILS);
    const by = (label: string) => f.find((x) => x.label === label);
    expect(by("LinkedIn URL")?.proposedValue).toBe("https://www.linkedin.com/in/maya-tremblay");
    expect(by("Address Line 1")?.category).toBe("addressStreet");
    expect(by("Address Line 1")?.proposedValue).toBe("1 Washington Sq");
    expect(by("Town")?.category).toBe("addressCity");
    expect(by("Postcode")?.category).toBe("postalCode");
    // Nothing but the LinkedIn box takes the LinkedIn URL.
    expect(f.filter((x) => x.proposedValue === "https://www.linkedin.com/in/maya-tremblay")).toHaveLength(1);
  });

  it("each radio question is read from its own label, not the section's legend", () => {
    const f = scan(QUESTIONS);
    expect(f.map((x) => x.label)).toEqual([
      "Are you a U.S. Citizen?",
      "Are you able to obtain/maintain a U.S. security clearance?",
      "Military Service",
    ]);
  });

  it("a fieldset holding one question still names it by its legend", () => {
    const f = scan(`<fieldset><legend>Are you willing to relocate?</legend>
      <label><input type="radio" name="r" value="y">Yes</label><label><input type="radio" name="r" value="n">No</label></fieldset>`);
    expect(f).toHaveLength(1);
    expect(f[0].label).toBe("Are you willing to relocate?");
  });
});
