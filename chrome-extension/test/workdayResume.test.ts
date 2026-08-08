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
import { workdayAdapter } from "../src/content/adapters/workday";
import { findFileInput } from "../src/content/fileUpload";

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

/**
 * The drop zone as reported from a live Workday application: hashed CSS
 * classes, NO "Upload your resume" heading, and the only "resume" token is an
 * element id on the Select-files button.
 */
function mountBareDropzone(): void {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowPage">
      <div class="css-wtpnzt">
        <div data-automation-id="file-upload-drop-zone" class="css-1ikudie">
          <div class="css-1ge88gr">Drop files here</div>
          <div class="css-xszj4y">
            <div class="css-1j5bq6h">or</div>
            <button type="button" data-automation-id="select-files"
                    id="resumeAttachments--attachments" class="css-ne6lk6">Select files</button>
          </div>
        </div>
        <input data-automation-id="file-upload-input-ref" type="file" multiple class="css-1hyfx7x">
      </div>
    </div>`;
}

describe("Workday drop zone with no document heading", () => {
  // The adapter is passed explicitly: on a real Workday host `scanPage` resolves
  // it from `location.hostname`, but jsdom serves every test from localhost, so
  // the default lookup would hand back `null` and skip the adapter entirely.
  it("classifies as a résumé upload from the widget's element id", () => {
    mountBareDropzone();
    const { fields } = scanPage(MOCK_PROFILE, false, workdayAdapter);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume, "expected a resumeUpload field").toBeDefined();
    expect(resume!.controlType).toBe("file");
  });

  it("finds the real file input from the drop zone (hashed classes match nothing)", () => {
    mountBareDropzone();
    const zone = document.querySelector('[data-automation-id="file-upload-drop-zone"]') as HTMLElement;
    const input = findFileInput(zone);
    expect(input).not.toBeNull();
    expect(input!.getAttribute("data-automation-id")).toBe("file-upload-input-ref");
  });

  it("routes a cover-letter widget to coverLetter, not résumé", () => {
    document.body.innerHTML = `
      <div data-automation-id="file-upload-drop-zone">
        <button data-automation-id="select-files" id="coverLetter--attachments">Select files</button>
        <input data-automation-id="file-upload-input-ref" type="file">
      </div>`;
    const { fields } = scanPage(MOCK_PROFILE, false, workdayAdapter);
    expect(fields.some((f) => f.category === "coverLetter")).toBe(true);
    expect(fields.some((f) => f.category === "resumeUpload")).toBe(false);
  });
});
