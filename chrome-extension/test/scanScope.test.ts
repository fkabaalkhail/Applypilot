import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("scanPage — chrome exclusion + form scoping", () => {
  it("never surfaces a header language switcher", () => {
    document.body.innerHTML = `
      <header>
        <select id="lang" aria-label="Language"><option>EN</option><option>FR</option></select>
      </header>
      <form>
        <label>First name <input name="first_name" /></label>
        <label>Last name <input name="last_name" /></label>
        <label>Email <input type="email" name="email" /></label>
      </form>`;
    const { fields, scopeEl } = scanPage(null, false);
    expect(fields.some((f) => f.label.toLowerCase().includes("language"))).toBe(false);
    expect(fields).toHaveLength(3);
    expect(scopeEl?.tagName).toBe("FORM");
  });

  it("drops an out-of-form newsletter email once a scope is found", () => {
    // 4 recognized fields in the form; the newsletter email is a 5th
    // recognized control outside it — 4/5 = 80%, so the form qualifies as the
    // scope and the newsletter is dropped despite its known category.
    document.body.innerHTML = `
      <form>
        <label>First name <input name="first_name" /></label>
        <label>Last name <input name="last_name" /></label>
        <label>Email <input type="email" name="email" /></label>
        <label>Phone <input type="tel" name="phone" /></label>
      </form>
      <div class="newsletter"><input type="email" name="newsletter_email" aria-label="Newsletter email" /></div>`;
    const { fields, registry } = scanPage(null, false);
    expect(fields).toHaveLength(4);
    // Registry is pruned in lockstep with fields.
    expect(registry.size).toBe(4);
  });

  it("keeps today's behavior when no scope container qualifies (fallback)", () => {
    document.body.innerHTML = `
      <div><label>First name <input name="first_name" /></label></div>
      <div><label>Email <input type="email" name="email" /></label></div>`;
    // LCA is <body> (excluded) and there is no form/main → unscoped result.
    const { fields, scopeEl } = scanPage(null, false);
    expect(fields).toHaveLength(2);
    expect(scopeEl).toBeNull();
  });
});
