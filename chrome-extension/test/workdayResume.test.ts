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

/**
 * The real Workday "Autofill with Resume" step (td.wd3.myworkdayjobs.com):
 * the drop zone renders with NO <input type=file> at all — the input is created
 * only when "Select file" is clicked. So the scanner must surface the zone
 * element itself. Regression for "No résumé field detected" on live Workday.
 */
function mountInputlessWorkdayDropzone(): HTMLElement {
  document.body.innerHTML = "";
  const section = document.createElement("div");
  section.setAttribute("data-automation-id", "applyFlowPage");
  const heading = document.createElement("h2");
  heading.textContent = "Upload your resume for a fast and easy application process";
  const hint = document.createElement("p");
  hint.textContent = "Upload either DOC, DOCX, HTML, PDF, or TXT file types (5MB max)";
  const zone = document.createElement("div");
  zone.setAttribute("data-automation-id", "file-upload-drop-zone");
  const drop = document.createElement("div");
  drop.textContent = "Drop file here";
  const selectBtn = document.createElement("button");
  selectBtn.type = "button";
  selectBtn.setAttribute("data-automation-id", "select-files");
  selectBtn.textContent = "Select file";
  zone.append(drop, selectBtn); // NOTE: no <input type=file>
  section.append(heading, hint, zone);
  document.body.append(section);
  return zone;
}

describe("Workday input-less résumé drop zone", () => {
  it("detects the drop zone as a résumé upload field when no file input exists", () => {
    const zone = mountInputlessWorkdayDropzone();
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume, "expected a resumeUpload field").toBeDefined();
    expect(resume!.controlType).toBe("file");
    expect(resume!.fillable).toBe(false);
    // The upload target must be the zone element (so a simulated drop can drive it).
    expect(registry.get(resume!.id)?.el).toBe(zone);
  });

  it("surfaces exactly one résumé field (the outer zone, not the nested button)", () => {
    mountInputlessWorkdayDropzone();
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.filter((f) => f.category === "resumeUpload")).toHaveLength(1);
  });
});

describe("generic input-less drop zones", () => {
  it("detects a non-Workday dropzone anchored on affordance text alone", () => {
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    const label = document.createElement("p");
    label.textContent = "Attach your resume";
    const zone = document.createElement("div");
    zone.className = "uploader"; // no author markers on the zone itself
    zone.textContent = "Drag & drop your file here or browse files";
    wrap.append(label, zone);
    document.body.append(wrap);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.some((f) => f.category === "resumeUpload")).toBe(true);
  });

  it("ignores an input-less drop zone that is not a document upload", () => {
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    const label = document.createElement("p");
    label.textContent = "Profile photo";
    const zone = document.createElement("div");
    zone.textContent = "Drop file here to upload your photo";
    wrap.append(label, zone);
    document.body.append(wrap);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.some((f) => f.category === "resumeUpload")).toBe(false);
    expect(fields.some((f) => f.category === "coverLetter")).toBe(false);
  });

  it("does not add a duplicate zone field when a real résumé input already exists", () => {
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "resume-upload";
    const heading = document.createElement("h3");
    heading.textContent = "Resume";
    // A visible affordance div that is a SIBLING of the real input (not its parent),
    // so the zone sweep would otherwise surface it separately.
    const zone = document.createElement("div");
    zone.textContent = "Drag & drop your resume or select file";
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("aria-label", "Resume");
    wrap.append(heading, zone, input);
    document.body.append(wrap);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.filter((f) => f.category === "resumeUpload")).toHaveLength(1);
  });

  it("keeps a résumé and a cover-letter zone separate under a shared upload wrapper", () => {
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "file-uploads"; // marker-matching ancestor of BOTH zones
    const resumeZone = document.createElement("div");
    resumeZone.className = "dropzone";
    resumeZone.textContent = "Drop your resume here";
    const coverZone = document.createElement("div");
    coverZone.className = "dropzone";
    coverZone.textContent = "Drop your cover letter here";
    wrap.append(resumeZone, coverZone);
    document.body.append(wrap);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.filter((f) => f.category === "resumeUpload")).toHaveLength(1);
    expect(fields.filter((f) => f.category === "coverLetter")).toHaveLength(1);
  });

  it("classifies sibling résumé/cover zones by their own heading, not the shared ancestor", () => {
    document.body.innerHTML = "";
    const section = document.createElement("div");
    section.className = "section";
    const rHead = document.createElement("div");
    rHead.textContent = "Resume";
    const rZone = document.createElement("div");
    rZone.className = "dropzone";
    rZone.textContent = "Drop file here";
    const cHead = document.createElement("div");
    cHead.textContent = "Cover Letter";
    const cZone = document.createElement("div");
    cZone.className = "dropzone";
    cZone.textContent = "Drop file here";
    section.append(rHead, rZone, cHead, cZone);
    document.body.append(section);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.filter((f) => f.category === "resumeUpload")).toHaveLength(1);
    expect(fields.filter((f) => f.category === "coverLetter")).toHaveLength(1);
  });

  it("ignores marketing résumé copy that is not an upload widget", () => {
    document.body.innerHTML = "";
    const blurb = document.createElement("div");
    blurb.textContent = "Ready to join? Upload your resume and we'll match you with jobs.";
    const cta = document.createElement("a");
    cta.textContent = "Upload your CV";
    document.body.append(blurb, cta);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.some((f) => f.category === "resumeUpload")).toBe(false);
  });

  it("ignores a drag-to-reorder list even with a nearby Resume (continue) button", () => {
    document.body.innerHTML = "";
    const list = document.createElement("div");
    list.textContent = "Drag and drop to reorder";
    const resumeBtn = document.createElement("button");
    resumeBtn.textContent = "Resume"; // "continue", not a document
    document.body.append(list, resumeBtn);

    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.some((f) => f.category === "resumeUpload")).toBe(false);
  });
});
