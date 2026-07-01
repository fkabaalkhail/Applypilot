import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyNavButton,
  findNavButtons,
  readWorkdayStep,
  isReviewStep,
  isApplicationComplete,
  runMultiStep,
  type MultiStepDeps,
} from "../src/content/multiStep";

beforeEach(() => {
  document.body.innerHTML = "";
});

function btn(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild as HTMLElement;
}

describe("classifyNavButton", () => {
  it("recognizes Workday footer nav ids", () => {
    expect(classifyNavButton(btn('<button data-automation-id="pageFooterNextButton">x</button>'))).toBe("next");
    expect(classifyNavButton(btn('<button data-automation-id="bottom-navigation-next-button">x</button>'))).toBe("next");
    expect(classifyNavButton(btn('<button data-automation-id="pageFooterSubmitButton">x</button>'))).toBe("submit");
  });

  it("classifies by label and lets submit win over next", () => {
    expect(classifyNavButton(btn("<button>Next</button>"))).toBe("next");
    expect(classifyNavButton(btn("<button>Save and Continue</button>"))).toBe("next");
    expect(classifyNavButton(btn("<button>Submit</button>"))).toBe("submit");
    // "Submit application" must never be treated as next.
    expect(classifyNavButton(btn("<button>Submit Application</button>"))).toBe("submit");
  });

  it("ignores disabled buttons and non-buttons", () => {
    expect(classifyNavButton(btn("<button disabled>Next</button>"))).toBeNull();
    expect(classifyNavButton(btn("<div>Next</div>"))).toBeNull();
    expect(classifyNavButton(btn("<button>Cancel</button>"))).toBeNull();
  });
});

describe("findNavButtons", () => {
  it("returns the first next and submit on the page", () => {
    document.body.innerHTML = `
      <button data-automation-id="pageFooterNextButton">Next</button>
      <button>Submit Application</button>`;
    const { next, submit } = findNavButtons(document);
    expect(next?.getAttribute("data-automation-id")).toBe("pageFooterNextButton");
    expect(submit?.textContent).toBe("Submit Application");
  });
});

describe("readWorkdayStep", () => {
  it("reads active index / total / title from the progress bar", () => {
    document.body.innerHTML = `
      <div data-automation-id="progressBar">
        <div data-automation-id="progressBarStepIcon"></div>
        <div data-automation-id="progressBarStepIcon"></div>
        <div data-automation-id="progressBarStepIcon"></div>
        <div data-automation-id="progressBarActiveStep">My Experience</div>
      </div>`;
    const step = readWorkdayStep(document);
    expect(step).not.toBeNull();
    expect(step!.total).toBe(3);
    expect(step!.title).toBe("my experience");
  });

  it("returns null with no progress bar", () => {
    expect(readWorkdayStep(document)).toBeNull();
  });
});

describe("isReviewStep / isApplicationComplete", () => {
  it("detects review/summary steps", () => {
    expect(isReviewStep("review")).toBe(true);
    expect(isReviewStep("summary")).toBe(true);
    expect(isReviewStep("my information")).toBe(false);
  });

  it("detects completion via path or heading", () => {
    expect(isApplicationComplete({ pathname: "/en-US/job/apply/jobTasks/completed" }, document)).toBe(true);
    document.body.innerHTML = "<h1>Congratulations! Your application was submitted.</h1>";
    expect(isApplicationComplete({ pathname: "/apply" }, document)).toBe(true);
    document.body.innerHTML = "<h1>My Information</h1>";
    expect(isApplicationComplete({ pathname: "/apply" }, document)).toBe(false);
  });
});

describe("runMultiStep controller", () => {
  const noSleep = async (): Promise<void> => {};

  it("fills each page, advances, and stops at review without submitting", async () => {
    const pages = ["information", "experience", "questions", "review"];
    let cur = 0;
    const filled: string[] = [];
    const deps: MultiStepDeps = {
      fillCurrentPage: async () => {
        filled.push(pages[cur]);
      },
      signature: () => `s${cur}`,
      navButtons: () => ({ next: cur < pages.length - 1 ? document.createElement("button") : null, submit: null }),
      atReviewStep: () => pages[cur] === "review",
      isComplete: () => false,
      click: () => {
        cur++;
      },
      sleep: noSleep,
    };
    const res = await runMultiStep(deps, { pollMs: 1, advanceWaitMs: 20 });
    expect(res.stoppedReason).toBe("review");
    expect(filled).toEqual(["information", "experience", "questions", "review"]);
  });

  it("stops when the page does not advance (validation error)", async () => {
    const filled: string[] = [];
    const deps: MultiStepDeps = {
      fillCurrentPage: async () => {
        filled.push("page");
      },
      signature: () => "same", // never changes → no advance
      navButtons: () => ({ next: document.createElement("button"), submit: null }),
      atReviewStep: () => false,
      isComplete: () => false,
      click: () => {},
      sleep: noSleep,
    };
    const res = await runMultiStep(deps, { pollMs: 1, advanceWaitMs: 5 });
    expect(res.stoppedReason).toBe("no-advance");
    expect(filled).toEqual(["page"]);
  });

  it("stops immediately when already complete", async () => {
    let filledCount = 0;
    const deps: MultiStepDeps = {
      fillCurrentPage: async () => {
        filledCount++;
      },
      signature: () => "x",
      navButtons: () => ({ next: null, submit: null }),
      atReviewStep: () => false,
      isComplete: () => true,
      click: () => {},
      sleep: noSleep,
    };
    const res = await runMultiStep(deps, { pollMs: 1, advanceWaitMs: 5 });
    expect(res.stoppedReason).toBe("complete");
    expect(filledCount).toBe(0);
  });
});
