import { describe, it, expect, beforeEach } from "vitest";
import { monogramOf, resolveCompanyLogo } from "../src/content/companyLogo";

describe("monogramOf", () => {
  it("takes the initial of a single-word company", () => {
    expect(monogramOf("Salesforce")).toBe("S");
  });
  it("takes first + last initials of a multi-word company", () => {
    expect(monogramOf("Acme Corp")).toBe("AC");
    expect(monogramOf("Foo Bar Baz")).toBe("FB");
  });
  it("falls back to ? for empty / whitespace", () => {
    expect(monogramOf("")).toBe("?");
    expect(monogramOf("   ")).toBe("?");
  });
});

describe("resolveCompanyLogo", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("prefers apple-touch-icon and returns an absolute URL", () => {
    document.head.innerHTML = `<link rel="apple-touch-icon" href="/icons/company.png">`;
    const logo = resolveCompanyLogo(document, "Salesforce");
    expect(logo.src).toMatch(/\/icons\/company\.png$/);
    expect(logo.src!.startsWith("http")).toBe(true);
  });

  it("prefers the largest declared favicon when no apple-touch-icon", () => {
    document.head.innerHTML =
      `<link rel="icon" sizes="16x16" href="https://x.test/small.png">` +
      `<link rel="icon" sizes="64x64" href="https://x.test/big.png">`;
    expect(resolveCompanyLogo(document, "Acme").src).toBe("https://x.test/big.png");
  });

  it("falls back to og:image when no icon links are declared", () => {
    document.head.innerHTML = `<meta property="og:image" content="https://x.test/og.png">`;
    expect(resolveCompanyLogo(document, "Acme").src).toBe("https://x.test/og.png");
  });

  it("returns null src + monogram + color when the page exposes no image", () => {
    const logo = resolveCompanyLogo(document, "Salesforce");
    expect(logo.src).toBeNull();
    expect(logo.monogram).toBe("S");
    expect(logo.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("assigns a deterministic color regardless of case", () => {
    expect(resolveCompanyLogo(document, "Acme").color).toBe(resolveCompanyLogo(document, "acme").color);
  });
});
