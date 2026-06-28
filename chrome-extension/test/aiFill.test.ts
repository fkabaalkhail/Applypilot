import { describe, it, expect } from "vitest";
import { buildFillRequestBody } from "../src/api/aiFill";
import type { AiFillField, JobContext } from "../src/shared/types";

const fields: AiFillField[] = [
  { id: "q1", label: "Why us?", type: "textarea", options: [], required: true },
];
const ctx: JobContext = {
  jobDescription: "Build things",
  jobTitle: "Engineer",
  company: "Acme",
};

describe("buildFillRequestBody", () => {
  it("maps fields + context to the backend payload with empty resumeText", () => {
    expect(buildFillRequestBody(fields, ctx)).toEqual({
      fields,
      resumeText: "",
      jobDescription: "Build things",
      jobTitle: "Engineer",
      company: "Acme",
    });
  });
});
