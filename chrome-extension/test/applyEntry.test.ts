import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { findApplyEntry } from "../src/content/applyEntry";
import { workdayAdapter } from "../src/content/adapters/workday";
import type { SiteAdapter } from "../src/content/adapters/types";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("findApplyEntry", () => {
  it("finds the posting's Apply button by anchored text", () => {
    document.body.innerHTML = `
      <p>To apply for this role you should read the description.</p>
      <button id="go">Apply Now</button>`;
    const entry = findApplyEntry(document, null);
    expect(entry?.el.id).toBe("go");
    expect(entry?.label).toBe("Apply Now");
    expect(entry?.fromAdapter).toBe(false);
  });

  it("never matches body copy containing the word apply", () => {
    document.body.innerHTML = `
      <a href="#">Learn how to apply for jobs like this one and stand out</a>
      <button>Save job</button>`;
    expect(findApplyEntry(document, null)).toBeNull();
  });

  it("prefers Apply Manually on the chooser and skips the bypass options", () => {
    document.body.innerHTML = `
      <a href="/apply/autofillWithResume">Autofill with Resume</a>
      <a href="/apply/applyManually" id="manual">Apply Manually</a>
      <a href="/apply/useMyLastApplication">Use My Last Application</a>`;
    const entry = findApplyEntry(document, null);
    expect(entry?.el.id).toBe("manual");
    expect(entry?.label).toBe("Apply Manually");
  });

  it("returns null when only bypass options exist", () => {
    document.body.innerHTML = `
      <a href="/apply/autofillWithResume">Autofill with Resume</a>
      <a href="#">Apply with LinkedIn</a>`;
    expect(findApplyEntry(document, null)).toBeNull();
  });

  it("ignores disabled and hidden buttons", () => {
    document.body.innerHTML = `
      <button disabled>Apply</button>
      <button aria-disabled="true">Apply Now</button>
      <button style="display:none">Apply</button>`;
    expect(findApplyEntry(document, null)).toBeNull();
  });

  it("falls back to Continue Application (a Workday draft in progress)", () => {
    document.body.innerHTML = `<button id="cont">Continue Application</button>`;
    expect(findApplyEntry(document, null)?.el.id).toBe("cont");
  });

  it("uses the Workday adapter's automation-id and marks it fromAdapter", () => {
    document.body.innerHTML = `
      <a data-automation-id="adventureButton" role="button" id="wd">Apply</a>`;
    const entry = findApplyEntry(document, workdayAdapter);
    expect(entry?.el.id).toBe("wd");
    expect(entry?.fromAdapter).toBe(true);
  });

  it("survives an adapter hook that throws", () => {
    const broken: SiteAdapter = {
      id: "broken",
      match: () => true,
      entryButton: () => {
        throw new Error("boom");
      },
    };
    document.body.innerHTML = `<button id="go">Apply</button>`;
    expect(findApplyEntry(document, broken)?.el.id).toBe("go");
  });
});
