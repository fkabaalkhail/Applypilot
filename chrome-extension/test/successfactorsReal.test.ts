import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { injectResumeFile, findFileInput } from "../src/content/fileUpload";
import {
  successFactorsEeoHtml,
  successFactorsAttachmentHtml,
  SF_RACE_OPTIONS,
} from "./fixtures/successfactorsReal";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * Real SuccessFactors self-identification section (rcmpaginatedselect). These
 * are the exact fields failing in production autofill_reports. Verifies the
 * genuine DOM is detected + classified correctly (a prerequisite for filling);
 * the live commit is exercised by browser verification.
 */
describe("SuccessFactors rcmpaginatedselect — real DOM", () => {
  function fields() {
    document.body.innerHTML = successFactorsEeoHtml();
    return scanPage(MOCK_PROFILE, true).fields; // fillEEO=true: user opted into EEO
  }
  const byLabel = (label: string) =>
    fields().find((f) => f.label.toLowerCase().includes(label));

  it("detects each picklist as a combobox (not a text field)", () => {
    for (const label of ["gender", "race/ethnicity", "protected veteran", "conflict of interest"]) {
      const f = byLabel(label);
      expect(f, `${label} detected`).toBeTruthy();
      expect(f!.controlType, `${label} controlType`).toBe("combobox");
    }
  });

  it("classifies the EEO picklists as their sensitive categories", () => {
    const all = fields();
    const cat = (label: string) => all.find((f) => f.label.toLowerCase().includes(label));
    expect(cat("gender")?.category).toBe("eeoGender");
    expect(cat("race/ethnicity")?.category).toBe("eeoRace");
    expect(cat("protected veteran")?.category).toBe("eeoVeteran");
    for (const c of ["gender", "race/ethnicity", "protected veteran"]) {
      expect(cat(c)?.sensitive, `${c} sensitive`).toBe(true);
    }
  });

  it("harvests the real option list from the widget's aria-owns'd listbox", () => {
    const race = byLabel("race/ethnicity");
    expect(race?.options).toBeTruthy();
    // the real SF race options must be readable so the on-device matcher / AI
    // is constrained to what the widget actually offers
    expect(race!.options).toContain("Asian (not Hispanic or Latino)");
    expect(race!.options!.length).toBe(SF_RACE_OPTIONS.length);
  });
});

describe("SuccessFactors custom résumé / cover-letter upload widgets", () => {
  it("detects the <div role=button> résumé + cover uploads as file fields", () => {
    document.body.innerHTML =
      successFactorsAttachmentHtml({ kind: "resume" }) + successFactorsAttachmentHtml({ kind: "cover" });
    const { fields } = scanPage(MOCK_PROFILE, false);
    const resume = fields.find((f) => f.category === "resumeUpload");
    const cover = fields.find((f) => f.category === "coverLetter");
    expect(resume, "résumé upload detected").toBeTruthy();
    expect(resume!.controlType).toBe("file");
    expect(cover, "cover-letter upload detected").toBeTruthy();
    expect(cover!.controlType).toBe("file");
  });

  it("detects only ONE field per widget (not each role=button part)", () => {
    document.body.innerHTML = successFactorsAttachmentHtml({ kind: "resume" });
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.filter((f) => f.category === "resumeUpload").length).toBe(1);
  });

  it("finds the widget's hidden <input type=file> (a sibling several levels up)", () => {
    // The real attach mechanism (DataTransfer → input.files) needs a browser;
    // jsdom can't assign input.files. What we verify here is the part that was
    // broken: findFileInput must climb from the role=button to the sibling input
    // so injectResumeFile has something to attach to when SF exposes one.
    document.body.innerHTML = successFactorsAttachmentHtml({ kind: "resume", hiddenInput: true });
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const el = registry.get(fields.find((f) => f.category === "resumeUpload")!.id)!.el!;
    expect(findFileInput(el)?.id).toBe("res-file");
  });

  it("clicks the upload button to reveal SF's file input (Jobright approach)", async () => {
    document.body.innerHTML = successFactorsAttachmentHtml({ kind: "resume", hiddenInput: false });
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const el = registry.get(fields.find((f) => f.category === "resumeUpload")!.id)!.el!;
    let clicked = false;
    el.addEventListener("click", () => {
      clicked = true;
      // SF mounts its "Upload from device" input only after the button is clicked.
      const input = document.createElement("input");
      input.type = "file";
      input.id = "revealed-file";
      document.body.append(input);
    });
    await injectResumeFile(el, new File(["x"], "r.pdf", { type: "application/pdf" }), {
      revealWaitMs: 200,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(clicked).toBe(true); // it activated the upload button
    expect(document.getElementById("revealed-file")).toBeTruthy(); // and revealed the input to target
  });

  it("reports manual (for download-and-guide) when clicking reveals nothing", async () => {
    document.body.innerHTML = successFactorsAttachmentHtml({ kind: "resume", hiddenInput: false });
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const el = registry.get(fields.find((f) => f.category === "resumeUpload")!.id)!.el!;
    const res = await injectResumeFile(el, new File(["x"], "r.pdf", { type: "application/pdf" }), {
      revealWaitMs: 30,
      sleep: () => Promise.resolve(),
    });
    expect(res.ok).toBe(false);
    expect(res.manual).toBe(true);
  });
});
