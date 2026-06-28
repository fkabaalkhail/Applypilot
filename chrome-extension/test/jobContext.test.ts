import { describe, it, expect, beforeEach } from "vitest";
import { extractJobContext } from "../src/content/jobContext";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

describe("extractJobContext", () => {
  it("reads description, title, and company from common containers", () => {
    document.title = "Careers";
    document.head.innerHTML = `<meta property="og:site_name" content="Acme Corp" />`;
    document.body.innerHTML = `
      <h1>Senior Engineer</h1>
      <div class="job-description">${"We are hiring a senior engineer to build great things. ".repeat(10)}</div>
    `;
    const ctx = extractJobContext(document);
    expect(ctx.jobTitle).toBe("Senior Engineer");
    expect(ctx.company).toBe("Acme Corp");
    expect(ctx.jobDescription).toContain("senior engineer");
  });

  it("falls back to the largest text block when no description container exists", () => {
    document.body.innerHTML = `
      <nav>Home About</nav>
      <section>${"This role owns the billing platform end to end. ".repeat(12)}</section>
      <footer>© 2026</footer>
    `;
    const ctx = extractJobContext(document);
    expect(ctx.jobDescription).toContain("billing platform");
    expect(ctx.jobDescription).not.toContain("© 2026");
  });

  it("never throws and returns empty strings on a bare document", () => {
    const ctx = extractJobContext(document);
    expect(ctx).toEqual({ jobDescription: "", jobTitle: "", company: "" });
  });
});
