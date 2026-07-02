import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";
import type { SiteAdapter } from "../src/content/adapters/types";
import type { UserApplicationProfile } from "../src/shared/types";

// jsdom has no layout engine (getClientRects() is empty), so the scanner's
// isVisible() would reject every plain control — see helpers/layout.ts.
let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });
const profile = { firstName: "Ada", github: "https://github.com/ada" } as unknown as UserApplicationProfile;

describe("scanPage adapter integration", () => {
  it("uses an adapter classify override to categorize a field the generic path misses", () => {
    document.body.innerHTML = `<input name="mystery" />`; // generic → unknown
    const adapter: SiteAdapter = {
      id: "t", match: () => true,
      classify: () => ({ category: "github", confidence: 0.9, sensitive: false }),
    };
    const { fields } = scanPage(profile, false, adapter);
    const f = fields.find((x) => x.category === "github");
    expect(f).toBeTruthy();
    expect(f!.proposedValue).toBe("https://github.com/ada");
  });

  it("uses an adapter resolveAnswer override for the value", () => {
    document.body.innerHTML = `<label for="a">First name</label><input id="a" />`;
    const adapter: SiteAdapter = {
      id: "t", match: () => true,
      resolveAnswer: () => "OVERRIDDEN",
    };
    const { fields } = scanPage(profile, false, adapter);
    const f = fields.find((x) => x.category === "firstName");
    expect(f!.proposedValue).toBe("OVERRIDDEN");
  });

  it("is unchanged from generic when no adapter matches (null)", () => {
    document.body.innerHTML = `<label for="a">First name</label><input id="a" />`;
    const withNull = scanPage(profile, false, null);
    const f = withNull.fields.find((x) => x.category === "firstName");
    expect(f!.proposedValue).toBe("Ada"); // generic resolveProfileValue
    expect(withNull.adapter).toBeNull();
  });
});
