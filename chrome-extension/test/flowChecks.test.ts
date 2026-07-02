import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  hasUnsolvedCaptcha,
  invalidFieldCount,
  isVerificationWall,
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
