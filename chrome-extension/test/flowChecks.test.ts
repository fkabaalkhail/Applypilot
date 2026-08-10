import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  hasUnsolvedCaptcha,
  invalidFieldCount,
  isVerificationWall,
  resumeFieldForAttach,
  resumeFieldNeedingFile,
  validationMessages,
} from "../src/content/flowChecks";
import type { DetectedField } from "../src/shared/types";
import type { RuntimeControl } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("hasUnsolvedCaptcha", () => {
  it("is true for a visible reCAPTCHA widget without a token", () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="x"></div>`;
    expect(hasUnsolvedCaptcha(document)).toBe(true);
  });

  it("is false once the response token is populated", () => {
    document.body.innerHTML = `
      <div class="g-recaptcha" data-sitekey="x"></div>
      <textarea name="g-recaptcha-response">tok</textarea>`;
    expect(hasUnsolvedCaptcha(document)).toBe(false);
  });

  it("is false with no captcha at all", () => {
    document.body.innerHTML = `<form><input /></form>`;
    expect(hasUnsolvedCaptcha(document)).toBe(false);
  });

  it("finds a solved token inside a shadow root / embedded subtree", () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="x"></div><div id="host"></div>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const ta = document.createElement("textarea");
    ta.name = "g-recaptcha-response";
    ta.value = "tok";
    root.appendChild(ta);
    expect(hasUnsolvedCaptcha(document)).toBe(false);
  });
});

describe("validationMessages / invalidFieldCount", () => {
  it("collects populated role=alert texts and counts aria-invalid fields", () => {
    document.body.innerHTML = `
      <div id="scope">
        <div role="alert">Email is required</div>
        <div role="alert"></div>
        <input aria-invalid="true" /><input aria-invalid="true" /><input />
      </div>`;
    const scope = document.getElementById("scope")!;
    expect(validationMessages(scope)).toEqual(["Email is required"]);
    expect(invalidFieldCount(scope)).toBe(2);
  });

  /**
   * REGRESSION: the flow parked on "fix the highlighted errors to continue" on
   * every Workday job posting and never clicked Apply.
   *
   * `role="alert"` is also the standard marker for a screen-reader-only live
   * region, and Workday announces routine navigation through one:
   *   <div role="alert" class="css-ttaaxj">… page is loaded</div>
   * (captured live from cibc.wd3.myworkdayjobs.com, visually hidden, and not
   * an error at all). Counting it parks the flow on a pause the user cannot
   * clear, because they cannot see the thing they are told to fix.
   */
  it("ignores screen-reader-only live regions", () => {
    document.body.innerHTML = `
      <div id="scope">
        <div role="alert" style="clip: rect(0px, 0px, 0px, 0px)">Private Banking Associate page is loaded</div>
        <div role="alert" style="display: none">Hidden toast</div>
        <div role="alert" style="visibility: hidden">Invisible toast</div>
      </div>`;
    expect(validationMessages(document.getElementById("scope")!)).toEqual([]);
  });

  it("still reports a real, visible error", () => {
    document.body.innerHTML = `
      <div id="scope">
        <div role="alert" style="clip: rect(0px, 0px, 0px, 0px)">page is loaded</div>
        <div role="alert">Enter your email address</div>
      </div>`;
    expect(validationMessages(document.getElementById("scope")!)).toEqual(["Enter your email address"]);
  });
});

describe("resumeFieldNeedingFile", () => {
  function fileField(id: string, required: boolean): DetectedField {
    return {
      id, category: "resumeUpload", confidence: 0.9, label: "Resume", controlType: "file",
      required, proposedValue: null, fillable: false, sensitive: false,
    };
  }

  it("returns the required empty resume field", () => {
    document.body.innerHTML = `<input type="file" id="f" />`;
    const el = document.getElementById("f") as HTMLInputElement;
    const control: RuntimeControl = { id: "1", controlType: "file", el };
    expect(resumeFieldNeedingFile([fileField("1", true)], () => control)?.id).toBe("1");
  });

  it("ignores optional resume fields", () => {
    document.body.innerHTML = `<input type="file" id="f" />`;
    const control: RuntimeControl = { id: "1", controlType: "file", el: document.getElementById("f") as HTMLInputElement };
    expect(resumeFieldNeedingFile([fileField("1", false)], () => control)).toBeNull();
  });
});

/**
 * Attaching and BLOCKING are different questions, and conflating them breaks
 * one way or the other: gate attach on `required` and an optional upload is
 * never attached (Workday's drop zone carries no `required`), gate the pause on
 * anything less and every optional file input on every ATS parks the flow
 * behind "attach your résumé to continue" for a user with no résumé on file.
 */
describe("resumeFieldForAttach vs resumeFieldNeedingFile", () => {
  function fileField(id: string, required: boolean): DetectedField {
    return {
      id, category: "resumeUpload", confidence: 0.9, label: "Resume", controlType: "file",
      required, proposedValue: null, fillable: false, sensitive: false,
    };
  }
  function control(): RuntimeControl {
    document.body.innerHTML = `<input type="file" id="f" />`;
    return { id: "1", controlType: "file", el: document.getElementById("f") as HTMLInputElement };
  }

  it("attaches to an OPTIONAL empty résumé upload", () => {
    const c = control();
    expect(resumeFieldForAttach([fileField("1", false)], () => c)?.id).toBe("1");
  });

  it("attaches to a required empty résumé upload too", () => {
    const c = control();
    expect(resumeFieldForAttach([fileField("1", true)], () => c)?.id).toBe("1");
  });

  it("does not pause the flow for that same optional upload", () => {
    const c = control();
    expect(resumeFieldNeedingFile([fileField("1", false)], () => c)).toBeNull();
  });

  it("skips a résumé upload that already holds a file", () => {
    document.body.innerHTML = `<input type="file" id="f" />`;
    const el = document.getElementById("f") as HTMLInputElement;
    // jsdom implements neither DataTransfer nor a settable FileList, and the
    // check only ever reads `.length`.
    Object.defineProperty(el, "files", { value: { length: 1 }, configurable: true });
    const c: RuntimeControl = { id: "1", controlType: "file", el };
    expect(resumeFieldForAttach([fileField("1", false)], () => c)).toBeNull();
  });

  it("still returns the required one when an optional upload precedes it", () => {
    document.body.innerHTML = `<input type="file" id="a" /><input type="file" id="b" />`;
    const els: Record<string, RuntimeControl> = {
      "1": { id: "1", controlType: "file", el: document.getElementById("a") as HTMLInputElement },
      "2": { id: "2", controlType: "file", el: document.getElementById("b") as HTMLInputElement },
    };
    const fields = [fileField("1", false), fileField("2", true)];
    expect(resumeFieldNeedingFile(fields, (id) => els[id])?.id).toBe("2");
    expect(resumeFieldForAttach(fields, (id) => els[id])?.id).toBe("1");
  });
});

describe("isVerificationWall", () => {
  it("detects EN and FR verification prompts", () => {
    document.body.innerHTML = `<div id="s">Enter the verification code we emailed you.</div>`;
    expect(isVerificationWall(document.getElementById("s")!)).toBe(true);
    document.body.innerHTML = `<div id="s">Entrez le code de vérification.</div>`;
    expect(isVerificationWall(document.getElementById("s")!)).toBe(true);
  });

  it("is false on an ordinary form", () => {
    document.body.innerHTML = `<div id="s"><label>Email <input /></label></div>`;
    expect(isVerificationWall(document.getElementById("s")!)).toBe(false);
  });
});
