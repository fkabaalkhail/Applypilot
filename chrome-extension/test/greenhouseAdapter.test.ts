// chrome-extension/test/greenhouseAdapter.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { greenhouseAdapter } from "../src/content/adapters/greenhouse";
import type { FieldContext } from "../src/content/adapters/types";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => { document.body.innerHTML = ""; });

function inputCtx(attrs: Record<string, string>): FieldContext {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}
const generic = { category: "unknown" as const, confidence: 0, sensitive: false };

describe("greenhouseAdapter.match", () => {
  it("matches greenhouse.io hosts", () => {
    expect(greenhouseAdapter.match("boards.greenhouse.io", "https://boards.greenhouse.io/acme")).toBe(true);
    expect(greenhouseAdapter.match("job-boards.greenhouse.io", "")).toBe(true);
  });
  it("does not match other hosts", () => {
    expect(greenhouseAdapter.match("notgreenhouse.io.evil.com", "")).toBe(false);
    expect(greenhouseAdapter.match("example.com", "")).toBe(false);
  });
});

describe("greenhouseAdapter.classify", () => {
  it("classifies a LinkedIn custom-URL question by its name attribute", () => {
    const ctx = inputCtx({ name: "urls[LinkedIn]" });
    expect(greenhouseAdapter.classify!(ctx, generic)?.category).toBe("linkedin");
  });
  it("classifies GitHub and portfolio URL questions", () => {
    expect(greenhouseAdapter.classify!(inputCtx({ name: "urls[GitHub]" }), generic)?.category).toBe("github");
    expect(greenhouseAdapter.classify!(inputCtx({ name: "urls[Website]" }), generic)?.category).toBe("portfolio");
  });
  it("declines (undefined) for an unrelated field", () => {
    expect(greenhouseAdapter.classify!(inputCtx({ name: "first_name" }), generic)).toBeUndefined();
  });
});

describe("greenhouseAdapter.resolveAnswer", () => {
  const el = document.createElement("input");
  const control = { controlType: "select" as const };
  it("maps profile gender to Greenhouse's exact EEO option when EEO is on", () => {
    const profile = { eeo: { gender: "female" } } as unknown as UserApplicationProfile;
    expect(greenhouseAdapter.resolveAnswer!({ category: "eeoGender", profile, control, fillEEO: true, el })).toBe("Female");
  });
  it("declines when EEO is off", () => {
    const profile = { eeo: { gender: "male" } } as unknown as UserApplicationProfile;
    expect(greenhouseAdapter.resolveAnswer!({ category: "eeoGender", profile, control, fillEEO: false, el })).toBeUndefined();
  });
  it("declines for non-EEO categories", () => {
    const profile = {} as UserApplicationProfile;
    expect(greenhouseAdapter.resolveAnswer!({ category: "firstName", profile, control, fillEEO: true, el })).toBeUndefined();
  });
});
