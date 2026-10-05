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

  // Paylocity's application page (live 2026-10-05): the name is a hidden
  // heading beside the logo, and the only [class*=company] is the logo itself.
  // Unknown, its "Choice Website" was no longer the company's own site.
  it("reads a company name the page keeps beside its logo, not the logo", () => {
    document.body.innerHTML = `
      <div class="header-title" id="LayoutLogoSection"><a href="https://example.com"><img alt="company logo" class="branding-company-logo" src="/logo.png"></a>
      <h2 id="LayoutLogoName" style="display: none;">Choice Solutions LLC</h2></div>
      <h2>Apply with resume</h2>`;
    expect(extractJobContext(document).company).toBe("Choice Solutions LLC");
  });

  // Greenhouse's board pages and embeds name the company only in the title
  // (regression 2026-10-05: unknown, "Anduril Website" was no longer the
  // company's own site and "Other" was chosen).
  it("reads Greenhouse's 'Job Application for <role> at <Company>' title", () => {
    document.title = "Job Application for Software Engineer, Battlespace Awareness at Anduril Industries";
    document.body.innerHTML = `<h1>Software Engineer, Battlespace Awareness</h1>`;
    expect(extractJobContext(document).company).toBe("Anduril Industries");
  });

  it("reads the posting's hiring organization from its JSON-LD", () => {
    document.head.innerHTML = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"DevOps Intern","hiringOrganization":{"@type":"Organization","name":"Choice Solutions"}}</script>`;
    document.body.innerHTML = `<h1>DevOps Intern</h1>`;
    expect(extractJobContext(document).company).toBe("Choice Solutions");
  });

  it("never throws and returns empty strings on a bare document", () => {
    const ctx = extractJobContext(document);
    expect(ctx).toEqual({ jobDescription: "", jobTitle: "", company: "" });
  });

  it("truncates an over-long description to the max length", () => {
    document.body.innerHTML = `<div class="job-description">${"x ".repeat(5000)}</div>`;
    const ctx = extractJobContext(document);
    expect(ctx.jobDescription.length).toBeLessThanOrEqual(6000);
  });
});
