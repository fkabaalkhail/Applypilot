/**
 * Round 4 (2026-10-05): what live pages and the last real fills in prod
 * telemetry showed the current build getting wrong. Each test fails on the
 * code before its fix.
 */
import { describe, expect, it } from "vitest";

describe("a phone widget that adds the country code (Waymo's embedded Greenhouse, live 2026-10-05)", () => {
  it("'(416) 555-0142' read back as '+14165550142' was written, not 'did not stick'", async () => {
    // Also in prod telemetry (2026-09-28): "Phone Number: Value did not stick.
    // Fill manually" on a page that held the right number.
    const { verifyControl } = await import("../src/content/writeEngine");
    const el = document.createElement("input");
    el.type = "tel";
    document.body.append(el);
    const control = { id: "p", controlType: "text" as const, el };
    el.value = "+14165550142";
    expect(verifyControl(control, "(416) 555-0142")).toBe(true);
    el.value = "+1 512-555-0143";
    expect(verifyControl(control, "512-555-0143")).toBe(true);
    // Another number, or a code that swallows a trunk zero, is not the number.
    el.value = "+14165550199";
    expect(verifyControl(control, "(416) 555-0142")).toBe(false);
    el.value = "+12079460958";
    expect(verifyControl(control, "020 7946 0958")).toBe(false);
    el.remove();
  });
});
