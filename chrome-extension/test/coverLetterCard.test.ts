import { describe, it, expect } from "vitest";
import { buildCoverLetterCardHtml } from "../src/content/coverLetterCard";

describe("buildCoverLetterCardHtml", () => {
  it("seeds the textarea and renders the action buttons", () => {
    const html = buildCoverLetterCardHtml("Dear Acme,", "Insert to form");
    expect(html).toContain('id="ap-cover-text"');
    expect(html).toContain("Dear Acme,");
    expect(html).toContain('id="ap-cover-regen"');
    expect(html).toContain('id="ap-cover-insert"');
    expect(html).toContain('id="ap-cover-copy"');
    expect(html).toContain('id="ap-cover-download"');
    expect(html).toContain('id="ap-cover-status"');
    expect(html).toContain("Insert to form");
  });

  it("uses the provided insert label (e.g. Attach PDF)", () => {
    expect(buildCoverLetterCardHtml("x", "Attach PDF")).toContain("Attach PDF");
  });

  it("escapes HTML in the letter text", () => {
    const html = buildCoverLetterCardHtml("<script>alert(1)</script>", "Insert to form");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
