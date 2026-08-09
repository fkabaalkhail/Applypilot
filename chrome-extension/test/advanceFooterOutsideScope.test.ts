// chrome-extension/test/advanceFooterOutsideScope.test.ts
/**
 * Regression: a filled page whose Next button lives in a page-level footer ended
 * the flow silently, with no advance gate for the user to press.
 *
 * Workday's "My Experience" step (BMO, 2026-08-09 15:06 UTC). The fill
 * succeeded — `autofill_reports` #156, 11 fields, 11 filled, 0 failed — and the
 * panel still offered no "Continue To The Next Page". `findAdvanceButton`
 * searches only the FORM SCOPE, and `resolveFormScope` picks the deepest
 * container holding the fields, which on that step excludes the fixed
 * Back / Save-and-Continue footer. With no advance found, flowController takes
 * `finish("done")` — a beat that hides the flow strip AND the gate, so the page
 * looks finished when it is not.
 *
 * Two independent ways that happens, both covered here:
 *   1. the tenant's footer button is not one of the automation-ids we know, so
 *      only the generic text search can find it — and it is out of scope;
 *   2. an earlier step's next-button is still in the DOM, hidden. The adapter
 *      returned that first match, `isClickable` rejected it, and the whole
 *      adapter path was abandoned. This is why the failure shows up on a later
 *      step and not on the first one.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { findAdvanceButton } from "../src/content/advance";
import { workdayAdapter } from "../src/content/adapters/workday";
import { stubLayout } from "./helpers/layout";

const restoreLayout = stubLayout();
afterAll(restoreLayout);

beforeEach(() => {
  document.body.innerHTML = "";
});

const scopeEl = (): HTMLElement => document.querySelector("#content") as HTMLElement;

/** The step's fields and its footer are siblings — the footer is NOT in scope. */
function page(footer: string, opts: { staleNext?: boolean } = {}): void {
  document.body.innerHTML = `
    ${opts.staleNext ? `<div style="display:none"><button disabled data-automation-id="bottom-navigation-next-button">Save and Continue</button></div>` : ""}
    <div id="content">
      <label for="jt">Job Title</label><input id="jt" />
      <button>Add Another</button>
    </div>
    ${footer}`;
}

describe("advance button in a page-level footer, outside the form scope", () => {
  it("finds a Save and Continue footer the scope does not contain", () => {
    page(`<div class="footer"><button>Back</button><button>Save and Continue</button></div>`);
    const adv = findAdvanceButton(scopeEl(), null);
    expect(adv?.kind).toBe("advance");
    expect(adv?.el.textContent).toBe("Save and Continue");
  });

  it("still prefers a button inside the scope over one outside it", () => {
    document.body.innerHTML = `
      <div id="content"><button>Continue</button></div>
      <div class="footer"><button>Save and Continue</button></div>`;
    expect(findAdvanceButton(scopeEl(), null)?.el.textContent).toBe("Continue");
  });

  it("never reaches out to a nav link — the reason the search was scoped", () => {
    page(`<nav><button>Continue shopping</button></nav>`);
    expect(findAdvanceButton(scopeEl(), null)).toBeNull();
  });

  it("never offers a cookie banner's Continue as the page turn", () => {
    page(`<div id="onetrust-banner-sdk"><button>Continue</button></div>`);
    expect(findAdvanceButton(scopeEl(), null)).toBeNull();
  });

  it("does not treat a footer Submit as an advance", () => {
    page(`<div class="footer"><button>Submit Application</button></div>`);
    expect(findAdvanceButton(scopeEl(), null)?.kind).toBe("terminal");
  });
});

describe("Workday: a stale hidden next-button must not shadow the live one", () => {
  it("returns the visible footer button, not the earlier step's hidden one", () => {
    page(
      `<div data-automation-id="bottom-navigation"><button data-automation-id="bottom-navigation-next-button">Save and Continue</button></div>`,
      { staleNext: true }
    );
    const el = workdayAdapter.advanceButton!(scopeEl());
    expect(el).not.toBeNull();
    expect((el as HTMLButtonElement).disabled).toBe(false);
    expect(findAdvanceButton(scopeEl(), workdayAdapter)?.kind).toBe("advance");
  });

  it("falls back to the document when the scope holds no footer at all", () => {
    page(
      `<div data-automation-id="bottom-navigation"><button data-automation-id="bottom-navigation-next-button">Save and Continue</button></div>`
    );
    expect(findAdvanceButton(scopeEl(), workdayAdapter)?.kind).toBe("advance");
  });
});
