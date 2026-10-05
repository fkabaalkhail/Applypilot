/**
 * A form inside a tab the visitor has not opened is not on screen.
 *
 * Recruitee (huaweicanada.recruitee.com, live 2026-10-05) keeps its whole
 * application in a hidden "Apply" tab. The scanner let that tab's styled
 * radios, consent box and upload inputs through (hidden natives behind custom
 * widgets are allowed), so the flow saw a form, filled three hidden answers
 * and never clicked "Apply": name, email and phone stayed empty.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { scanPage } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  // A layout stand-in that knows a hidden subtree renders nothing, and that a
  // styled native ([data-styled]) has no box of its own.
  const proto = window.HTMLElement.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = function (this: HTMLElement): DOMRectList {
    if (this.closest("[hidden]") || this.hasAttribute("data-styled")) return [] as unknown as DOMRectList;
    return [{ width: 100, height: 20 }] as unknown as DOMRectList;
  };
  restore = () => {
    proto.getClientRects = original;
  };
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const profile = {
  firstName: "Test", lastName: "Person", email: "test.person@example.com", phone: "416 555 0142",
  location: "Toronto, ON, Canada", country: "Canada", skills: [], education: [], experience: [],
} as unknown as UserApplicationProfile;

const QUESTIONS = `
  <fieldset><legend>Are you open to work fully onsite? *</legend>
    <label><input type="radio" data-styled name="q1" value="true"><span>Yes</span></label>
    <label><input type="radio" data-styled name="q1" value="false"><span>No</span></label>
  </fieldset>
  <label><input type="checkbox" data-styled name="consent"><span>I acknowledge the privacy policy</span></label>
  <label for="cv">CV or resume *</label><input type="file" id="cv" data-styled name="candidate.cv">`;

describe("controls in a tab nobody opened", () => {
  it("are not part of the form on screen", () => {
    document.body.innerHTML = `
      <div role="tablist"><button role="tab">Job details</button><button role="tab">Apply</button></div>
      <div role="tabpanel">We are hiring.</div>
      <div role="tabpanel" hidden>
        <label for="n">Full name</label><input id="n" name="candidate.name">
        <label for="e">Email</label><input id="e" type="email" name="candidate.email">
        ${QUESTIONS}
      </div>`;
    const fields = scanPage(profile, false, null).fields;
    expect(fields.map((f) => f.label)).toEqual([]);
  });

  it("while styled natives in an open form still count", () => {
    document.body.innerHTML = `
      <form>
        <label for="n">Full name</label><input id="n" name="candidate.name">
        ${QUESTIONS}
      </form>`;
    const labels = scanPage(profile, false, null).fields.map((f) => f.label);
    expect(labels).toContain("Are you open to work fully onsite? *");
    expect(labels.some((l) => /privacy policy/.test(l))).toBe(true);
    expect(labels.some((l) => /CV or resume/.test(l))).toBe(true);
  });
});
