import { describe, it, expect } from "vitest";
import { scoreJumpText, buildTailorCardHtml } from "../src/content/tailorCard";
import type { TailorResult } from "../src/shared/types";

const result: TailorResult = {
  document: {}, originalScore: 72, newScore: 85, atsScore: 88,
  keywordCoverage: 92, matchedKeywords: ["react"], missingKeywords: ["aws", "docker"],
  diffSummary: "",
};

describe("scoreJumpText", () => {
  it("shows a jump when the score improves", () => {
    expect(scoreJumpText(72, 85)).toBe("Match 7.2 → 8.5");
  });
  it("shows 'held' when unchanged", () => {
    expect(scoreJumpText(80, 80)).toBe("Match held at 8.0");
  });
});

describe("buildTailorCardHtml", () => {
  it("renders score, stats, keyword chips and action buttons", () => {
    const html = buildTailorCardHtml(result, new Set(["aws"]));
    expect(html).toContain("Match 7.2 → 8.5");
    expect(html).toContain("ATS 88 · 92% coverage");
    expect(html).toContain('data-kw="aws"');
    expect(html).toContain('data-kw="docker"');
    expect(html).toContain("ap-kw on"); // aws is selected
    expect(html).toContain('id="ap-tailor-attach"');
    expect(html).toContain('id="ap-tailor-regen"');
    expect(html).toContain('id="ap-tailor-download"');
  });
  it("omits the keyword row when there are no missing keywords", () => {
    const html = buildTailorCardHtml({ ...result, missingKeywords: [] }, new Set());
    expect(html).not.toContain("ap-kw-row");
  });
  it("escapes HTML in keyword chips", () => {
    const evil: TailorResult = { ...result, missingKeywords: ['"><img src=x onerror=alert(1)>'] };
    const html = buildTailorCardHtml(evil, new Set());
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
