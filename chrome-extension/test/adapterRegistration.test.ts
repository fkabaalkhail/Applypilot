import { describe, it, expect } from "vitest";
import { getAdapter } from "../src/content/adapters"; // barrel import → triggers built-in registration

describe("built-in adapter registration (live ADAPTERS)", () => {
  it("resolves greenhouse + workday by host through the registered list", () => {
    expect(getAdapter("boards.greenhouse.io", "https://boards.greenhouse.io/x")?.id).toBe("greenhouse");
    expect(getAdapter("acme.wd5.myworkdayjobs.com", "")?.id).toBe("workday");
  });
  it("returns null for an unrecognized host", () => {
    expect(getAdapter("example.com", "")).toBeNull();
  });
});
