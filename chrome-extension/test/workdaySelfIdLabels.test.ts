// chrome-extension/test/workdaySelfIdLabels.test.ts
/**
 * Regression: the gap modal asked Workday's self-identification questions under
 * the WIDGET's own boilerplate instead of the question.
 *
 * Reproduced from production, not from a guess. On 2026-08-09 a fill against
 * `bmo.wd3.myworkdayjobs.com` produced these rows:
 *
 *   autofill_reports #148  label "Select One Required"
 *                          reason 'No option matches "Yes"
 *                                  (saw: Female | Genderqueer | Male | …)'
 *   saved_answers    #39   question_raw "Yes Required"
 *   saved_answers    #40   question_raw "b0531cc2ff371001d8a97c876e680000-
 *                                        b0531cc2ff371001d8a9b7f658ab0007"
 *
 * So three distinct wrong answers to "what is this field called": the widget's
 * aria-label boilerplate, that boilerplate over an already-picked value, and,
 * when there was no aria-label at all, the raw Workday id. All three are what
 * the panel prints and what the gap modal puts to the user as the question.
 *
 * The markup below is `test/fixtures/workdayReal.ts` (BMO, captured verbatim
 * 2026-07-04) with only what production proves changed: the aria-label carries
 * no question, and the `<label>` is not associated to the widget. The nesting,
 * three divs between the `formField-*` wrapper and the button, is verbatim, and
 * is exactly what put the question out of `nearbyText`'s three-ancestor reach.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { collectSignals, bestDisplayLabel } from "../src/content/domUtils";
import { scanPage } from "../src/content/formScanner";
import { selectAnswerGaps, planAnswerSaves } from "../src/content/answerGaps";
import { stubLayout } from "./helpers/layout";

const restoreLayout = stubLayout();
afterAll(restoreLayout);

beforeEach(() => {
  document.body.innerHTML = "";
});

/** Workday's id on the self-ID page: `<32 hex>-<32 hex>`, per saved_answers #40. */
const WID = "56370316e58a1001d8aa4cd7b1d70000-b0531cc2ff371001d8a9b9c2eef00002";

/**
 * One Workday prompt field. `question` is rendered the way the self-ID page
 * does it, inside the `formField-*` wrapper, but NOT associated to the widget.
 */
function promptField(opts: {
  question: string;
  ariaLabel?: string;
  display?: string;
  questionTag?: "label" | "div";
}): string {
  const tag = opts.questionTag ?? "label";
  const aria = opts.ariaLabel === undefined ? "" : `aria-label="${opts.ariaLabel}"`;
  return `
    <div data-automation-id="formField-${WID}" data-fkit-id="${WID}">
      <${tag}><span>${opts.question}<abbr aria-hidden="true">*</abbr></span></${tag}>
      <div><div><div>
        <button aria-haspopup="listbox" type="button" value="" ${aria}
                aria-required="true" name="${WID}" id="${WID}">${opts.display ?? "Select One"}</button>
        <input type="text" value="">
        <span class="menu-icon"></span>
      </div></div></div>
    </div>`;
}

const trigger = (): HTMLElement =>
  document.querySelector("button[aria-haspopup=listbox]") as HTMLElement;

describe("Workday self-ID prompt, the label is the question, never the widget", () => {
  it("aria-label 'Select One Required' does not become the question (report #148)", () => {
    document.body.innerHTML = promptField({
      question: "Gender Identity",
      ariaLabel: "Select One Required",
    });
    expect(bestDisplayLabel(collectSignals(trigger()))).toBe("Gender Identity");
  });

  it("aria-label over an already-picked value is not the question either (saved_answers #39)", () => {
    document.body.innerHTML = promptField({
      question: "Are you a member of a visible minority?",
      ariaLabel: "Yes Required",
      display: "Yes",
    });
    expect(bestDisplayLabel(collectSignals(trigger()))).toBe(
      "Are you a member of a visible minority?"
    );
  });

  it("no aria-label at all: the raw Workday id is never the question (saved_answers #40)", () => {
    document.body.innerHTML = promptField({ question: "Ethnicity" });
    const label = bestDisplayLabel(collectSignals(trigger()));
    expect(label).toBe("Ethnicity");
    expect(label).not.toContain(WID);
  });

  it("finds the question when it is a plain div rather than a <label>", () => {
    document.body.innerHTML = promptField({
      question: "Veteran Status",
      questionTag: "div",
      ariaLabel: "Select One Required",
    });
    expect(bestDisplayLabel(collectSignals(trigger()))).toBe("Veteran Status");
  });

  it("finds the question with no Workday wrapper markers at all", () => {
    // The self-ID page's exact wrapper attributes are the one thing production
    // could not tell us. Same nesting, no `formField-*` and no `data-fkit-id`:
    // the structural climb has to carry it.
    document.body.innerHTML = `
      <div>
        <span>Do you identify as a person with a disability?</span>
        <div><div><div>
          <button aria-haspopup="listbox" type="button" value=""
                  aria-label="Select One Required" name="${WID}" id="${WID}">Select One</button>
          <input type="text" value="">
        </div></div></div>
      </div>`;
    expect(bestDisplayLabel(collectSignals(trigger()))).toBe(
      "Do you identify as a person with a disability?"
    );
  });

  it("does not steal the question from a neighbouring field", () => {
    document.body.innerHTML = `
      <div class="section">
        <div><label for="other">Preferred Name</label><input id="other" name="other" /></div>
        <div><div><div>
          <button aria-haspopup="listbox" type="button" value=""
                  aria-label="Select One Required" name="${WID}" id="${WID}">Select One</button>
        </div></div></div>
      </div>`;
    const label = bestDisplayLabel(collectSignals(trigger()));
    expect(label).not.toBe("Preferred Name");
    expect(label).not.toContain(WID);
  });

  it("keeps an aria-label that merely repeats a NON-choice control's own text", () => {
    // The boilerplate rule must not reach ordinary controls: what they display
    // is often the name of the thing, not an answer to a question.
    document.body.innerHTML = `<div><button aria-label="Country">Country</button></div>`;
    const el = document.querySelector("button") as HTMLElement;
    expect(collectSignals(el).ariaLabel).toBe("Country");
  });

  it("recovers the question from Workday's aria-label when nothing else names the field", () => {
    // Verbatim shape from test/fixtures/workdayReal.ts: "<question> <value> Required".
    document.body.innerHTML = `
      <div><div><div>
        <button aria-haspopup="listbox" type="button" value=""
                aria-label="How Did You Hear About Us? Select One Required"
                name="source" id="source--source">Select One</button>
      </div></div></div>`;
    expect(bestDisplayLabel(collectSignals(trigger()))).toBe("How Did You Hear About Us?");
  });
});

describe("Workday self-ID prompt, end to end into the gap modal", () => {
  it("asks under the real question, not the widget's boilerplate", () => {
    document.body.innerHTML = promptField({
      question: "Gender Identity",
      ariaLabel: "Select One Required",
    });
    const { fields } = scanPage(null, false);
    const gaps = selectAnswerGaps(fields, { company: "BMO", jobTitle: "Analyst" });

    expect(gaps).toHaveLength(1);
    expect(gaps[0].question).toBe("Gender Identity");
  });

  it("never puts a raw widget id to the user as a question", () => {
    // Nothing anywhere names this field. The label still must not be the
    // Workday id: that is what the user reads in the modal.
    document.body.innerHTML = `
      <div><div><div>
        <button aria-haspopup="listbox" type="button" value="" aria-required="true"
                name="${WID}" id="${WID}">Select One</button>
      </div></div></div>`;
    const { fields } = scanPage(null, false);
    const gaps = selectAnswerGaps(fields, {});
    for (const gap of gaps) {
      expect(gap.question).not.toContain(WID);
      // Self-ID has no profile slot, so the answer fills the page and persists
      // nowhere. There is no cross-application answer memory to poison.
      expect(planAnswerSaves([{ gap, value: "Yes" }])).toEqual({ profilePatch: {} });
    }
  });
});
