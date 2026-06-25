import { describe, it, expect } from "vitest";
import { detectAtsName } from "../src/shared/constants";
import { base64ToFile, findFileInput } from "../src/content/fileUpload";

describe("detectAtsName (ATS coverage)", () => {
  it("recognizes every supported ATS host", () => {
    expect(detectAtsName("boards.greenhouse.io")).toBe("Greenhouse");
    expect(detectAtsName("jobs.lever.co")).toBe("Lever");
    expect(detectAtsName("acme.myworkdayjobs.com")).toBe("Workday");
    expect(detectAtsName("acme.ashbyhq.com")).toBe("Ashby");
    expect(detectAtsName("acme.smartrecruiters.com")).toBe("SmartRecruiters");
    expect(detectAtsName("careers-acme.icims.com")).toBe("iCIMS");
    expect(detectAtsName("acme.bamboohr.com")).toBe("BambooHR");
    expect(detectAtsName("jobs.jobvite.com")).toBe("Jobvite");
    expect(detectAtsName("acme.taleo.net")).toBe("Taleo");
    expect(detectAtsName("career5.successfactors.com")).toBe("SuccessFactors");
    expect(detectAtsName("acme.sapsf.eu")).toBe("SuccessFactors");
  });

  it("returns null for non-ATS hosts", () => {
    expect(detectAtsName("example.com")).toBeNull();
    expect(detectAtsName("google.com")).toBeNull();
  });
});

describe("base64ToFile (resume auto-upload)", () => {
  it("round-trips base64 bytes into a named, typed File", () => {
    // "Hello" -> base64 "SGVsbG8="
    const file = base64ToFile("SGVsbG8=", "cv.pdf", "application/pdf");
    expect(file.name).toBe("cv.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(5);
  });

  it("defaults type and name when missing", () => {
    const file = base64ToFile("SGVsbG8=", "", "");
    expect(file.name).toBe("resume");
    expect(file.type).toBe("application/octet-stream");
  });
});

describe("findFileInput", () => {
  it("returns the element itself when it is a file input", () => {
    const input = document.createElement("input");
    input.type = "file";
    document.body.appendChild(input);
    expect(findFileInput(input)).toBe(input);
    input.remove();
  });

  it("finds a hidden file input inside a dropzone container", () => {
    const zone = document.createElement("div");
    zone.className = "resume-dropzone";
    const input = document.createElement("input");
    input.type = "file";
    zone.appendChild(input);
    document.body.appendChild(zone);
    expect(findFileInput(zone)).toBe(input);
    zone.remove();
  });
});
