import { describe, it, expect } from "vitest";
import { analyzeKeywords, heatmapTerms } from "../lib/keywordMatch";
import { DEFAULT_THEME, type ResumeDocument } from "../lib/resumeDocument";

const docWith = (bullets: string[], skills: string[] = []): ResumeDocument => ({
  header: { name: "X", email: "", phone: "", location: "", linkedin_url: "", github_url: "", other_link: "" },
  sections: [
    {
      id: "e",
      type: "experience",
      title: "WORK",
      text: "",
      skills: [],
      groups: {},
      items: [{ id: "i", title: "", subtitle: "", location: "", start_date: "", end_date: "", detail: "", link: "", bullets }],
    },
    { id: "s", type: "skills", title: "SKILLS", text: "", skills, groups: {}, items: [] },
  ],
  theme: DEFAULT_THEME,
});

describe("analyzeKeywords", () => {
  it("marks whole-word matches green and absent keywords red", () => {
    const a = analyzeKeywords(["Python", "Kubernetes"], docWith(["Built services in Python"]));
    expect(a.results.find((r) => r.keyword === "Python")!.status).toBe("green");
    expect(a.results.find((r) => r.keyword === "Kubernetes")!.status).toBe("red");
    expect(a.matched).toBe(1);
    expect(a.total).toBe(2);
    expect(a.coverage).toBe(50);
  });

  it("marks stem/substring matches yellow", () => {
    const a = analyzeKeywords(["manage"], docWith(["Led management of a team"]));
    expect(a.results[0].status).toBe("yellow");
  });

  it("handles multi-word phrases (full vs partial)", () => {
    expect(analyzeKeywords(["CI/CD"], docWith(["Owned CI/CD pipelines"])).results[0].status).toBe("green");
    expect(analyzeKeywords(["React Native"], docWith(["Built React apps"])).results[0].status).toBe("yellow");
  });

  it("dedupes keywords and reflects skills", () => {
    const a = analyzeKeywords(["AWS", "aws"], docWith([], ["AWS"]));
    expect(a.total).toBe(1);
    expect(a.results[0].status).toBe("green");
  });

  it("heatmapTerms returns only present (green/yellow) terms", () => {
    const terms = heatmapTerms(analyzeKeywords(["Python", "Kubernetes"], docWith(["Python here"])));
    expect(terms.map((t) => t.term)).toEqual(["Python"]);
    expect(terms[0].color).toBe("green");
  });
});
