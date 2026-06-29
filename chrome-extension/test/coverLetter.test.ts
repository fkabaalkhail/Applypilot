import { describe, it, expect } from "vitest";
import { buildCoverLetterRequestBody } from "../src/api/coverLetter";
import type { JobContext } from "../src/shared/types";

const ctx: JobContext = { jobDescription: "Need AWS", jobTitle: "Engineer", company: "Acme" };

describe("buildCoverLetterRequestBody", () => {
  it("maps args + context to the snake_case payload", () => {
    expect(buildCoverLetterRequestBody(7, ctx, "professional", "draft")).toEqual({
      resume_id: 7, job_description: "Need AWS", job_title: "Engineer",
      company: "Acme", tone: "professional", base_text: "draft",
    });
  });

  it("sends null tone/base_text when omitted (fresh letter)", () => {
    expect(buildCoverLetterRequestBody(null, ctx)).toEqual({
      resume_id: null, job_description: "Need AWS", job_title: "Engineer",
      company: "Acme", tone: null, base_text: null,
    });
  });
});
