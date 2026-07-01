/**
 * Workday "Autofill with Resume" step: the real file input is display:none behind
 * a styled drop zone and carries NO label/aria — its identity is the surrounding
 * "Upload your resume…" heading. Regression test for the panel reporting
 * "No résumé field detected" on that step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

/** Reconstruct Workday's drop-zone résumé widget (hidden, unlabeled input). */
function mountWorkdayResumeDropzone(): HTMLInputElement {
  document.body.innerHTML = "";
  const section = document.createElement("div");
  section.setAttribute("data-automation-id", "applyFlowPage");
  const heading = document.createElement("h3");
  heading.textContent = "Upload your resume for a fast and easy application process";
  const zone = document.createElement("div");
  zone.setAttribute("data-automation-id", "file-upload-drop-zone");
  const drop = document.createElement("div");
  drop.textContent = "Drop file here";
  const selectBtn = document.createElement("button");
  selectBtn.type = "button";
  selectBtn.setAttribute("data-automation-id", "select-files");
  selectBtn.textContent = "Select file";
  const input = document.createElement("input");
  input.type = "file";
  input.setAttribute("data-automation-id", "file-upload-input-ref");
  input.style.display = "none"; // hidden behind the styled zone
  zone.append(drop, selectBtn, input);
  section.append(heading, zone);
  document.body.append(section);
  return input;
}

describe("Workday résumé drop zone", () => {
  it("detects the hidden, unlabeled file input as a résumé upload field", () => {
    mountWorkdayResumeDropzone();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume, "expected a resumeUpload field").toBeDefined();
    expect(resume!.controlType).toBe("file");
    expect(resume!.fillable).toBe(false); // never auto-scripted; offered as an upload action
  });

  it("does not mistake it for a cover-letter upload", () => {
    mountWorkdayResumeDropzone();
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.some((f) => f.category === "coverLetter")).toBe(false);
  });
});
