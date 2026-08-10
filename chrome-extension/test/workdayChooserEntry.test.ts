// chrome-extension/test/workdayChooserEntry.test.ts
/**
 * REGRESSION: "Autofill doesn't click Apply on the first page."
 *
 * Reproduced live on cibc.wd3.myworkdayjobs.com. Clicking Workday's Apply
 * button opens the apply-method chooser as an IN-PAGE overlay: the URL never
 * changes and the posting's own `adventureButton` stays in the DOM, visible,
 * behind it.
 *
 * findApplyEntry used to consult the site adapter FIRST, so after the chooser
 * opened it still answered "Apply" (the adapter matches `adventureButton` by
 * automation-id). Two consequences, both fatal:
 *   1. the flow would re-click the button that opened the chooser instead of
 *      choosing the manual path, and
 *   2. stepSignature(), which on a field-less page is `page:<url>|<entry
 *      label>`, stayed byte-identical across the transition, so the flow
 *      concluded the page never changed, timed out, and stopped with
 *      "Couldn't open the application from this page".
 *
 * The manual-path tier therefore has to outrank the adapter hook.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { findApplyEntry } from "../src/content/applyEntry";
import { workdayAdapter } from "../src/content/adapters/workday";
import { stepSignature, type FlowSnapshot } from "../src/content/flowController";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

/** The posting's Apply control, captured verbatim from the live CIBC page. */
const ADVENTURE_BUTTON = `
  <a href="https://cibc.wd3.myworkdayjobs.com/search/job/Toronto-ON/Private-Banking-Associate_2616608-1/apply"
     role="button" data-uxi-element-id="Apply_adventureButton" data-uxi-query-id=""
     data-uxi-widget-type="adventureButton" data-automation-id="adventureButton"
     font-size="14" height="40" class="css-1i3qzi3">Apply</a>`;

/** The chooser Workday overlays on top of it, note the Apply button survives. */
const CHOOSER = `
  <div role="dialog">
    <a href="#" role="button">Autofill with Resume</a>
    <a href="#" role="button" id="manual">Apply Manually</a>
    <a href="#" role="button">Use My Last Application</a>
  </div>`;

const URL = "https://cibc.wd3.myworkdayjobs.com/search/job/Toronto-ON/Private-Banking-Associate_2616608-1";

const snap = (entry: ReturnType<typeof findApplyEntry>): FlowSnapshot => ({
  fields: [],
  scopeEl: null,
  url: URL,
  entry: entry ? { el: entry.el, label: entry.label } : null,
  accountWall: false,
});

describe("Workday job posting → apply-method chooser", () => {
  it("picks the posting's Apply button before the chooser exists", () => {
    document.body.innerHTML = ADVENTURE_BUTTON;
    const entry = findApplyEntry(document, workdayAdapter);
    expect(entry?.label).toBe("Apply");
    expect(entry?.fromAdapter).toBe(true);
  });

  it("switches to Apply Manually once the chooser opens, even though adventureButton is still on the page", () => {
    document.body.innerHTML = ADVENTURE_BUTTON + CHOOSER;
    // The adapter can still see its button, that is the whole trap.
    expect(workdayAdapter.entryButton!(document)).not.toBeNull();

    const entry = findApplyEntry(document, workdayAdapter);
    expect(entry?.label).toBe("Apply Manually");
    expect((entry?.el as HTMLElement).id).toBe("manual");
  });

  it("changes the step signature across the transition, so the flow sees the page move", () => {
    document.body.innerHTML = ADVENTURE_BUTTON;
    const before = stepSignature(snap(findApplyEntry(document, workdayAdapter)));

    document.body.innerHTML = ADVENTURE_BUTTON + CHOOSER;
    const after = stepSignature(snap(findApplyEntry(document, workdayAdapter)));

    // Same URL, no fields, the entry label is the ONLY change signal there is.
    expect(before).toBe(`page:${URL}|Apply`);
    expect(after).toBe(`page:${URL}|Apply Manually`);
    expect(after).not.toBe(before);
  });

  it("still refuses the chooser options that bypass the manual form", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <a href="#" role="button">Autofill with Resume</a>
        <a href="#" role="button">Use My Last Application</a>
      </div>`;
    // No manual option and no adventureButton: nothing here is safe to click.
    expect(findApplyEntry(document, workdayAdapter)).toBeNull();
  });

  it("still falls back to the adapter's button when no generic text tier matches", () => {
    // Workday's resume-a-draft button carries an automation-id but wording the
    // generic tiers do not anchor on, the adapter is what finds it.
    document.body.innerHTML = `
      <a href="#" role="button" data-automation-id="continueButton">Continue</a>`;
    const entry = findApplyEntry(document, workdayAdapter);
    expect(entry?.fromAdapter).toBe(true);
    expect(entry?.label).toBe("Continue");
  });
});
