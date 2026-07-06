import { describe, it, expect } from "vitest";
import { changedStrings } from "../lib/resumeDiff";
import { DEFAULT_THEME, type ResumeDocument } from "../lib/resumeDocument";

const mk = (bullets: string[]): ResumeDocument => ({
  header: { name: "", email: "", phone: "", location: "", linkedin_url: "", github_url: "", other_link: "" },
  sections: [{
    id: "exp", type: "experience", title: "WORK EXPERIENCE", text: "", skills: [], groups: {},
    items: [{ id: "i1", title: "Eng", subtitle: "Acme", location: "", start_date: "", end_date: "", detail: "", link: "", bullets }],
  }],
  theme: DEFAULT_THEME,
});

describe("changedStrings", () => {
  it("returns reworded bullets, not unchanged ones", () => {
    const out = changedStrings(mk(["Did A", "Did B"]), mk(["Led A with impact", "Did B"]));
    expect(out.has("led a with impact")).toBe(true);
    expect(out.has("did b")).toBe(false);
  });

  it("treats an added summary section as changed", () => {
    const before = mk(["Did A"]);
    const after: ResumeDocument = {
      ...before,
      sections: [
        { id: "sum", type: "summary", title: "SUMMARY", text: "Sharp engineer.", skills: [], groups: {}, items: [] },
        ...before.sections,
      ],
    };
    expect(changedStrings(before, after).has("sharp engineer.")).toBe(true);
  });

  it("ignores whitespace-only differences", () => {
    const out = changedStrings(mk(["Did  A"]), mk(["Did A"]));
    expect(out.has("did a")).toBe(false);
  });
});
