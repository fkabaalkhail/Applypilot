// chrome-extension/test/telemetryCapture.test.ts
/**
 * Diagnostic capture at the telemetry layer.
 *
 * The first test is the one that matters most: with no `capture` input, the
 * record must contain no answers and no markup at all. That is the promise made
 * to every account that did not opt in, and it is a promise about absence,
 * which is exactly the kind that rots silently if nothing asserts it.
 */
import { describe, it, expect } from "vitest";
import { buildAutofillTelemetry, rankForCapture } from "../src/content/telemetry";
import type { DetectedField, FieldCaptureRecord } from "../src/shared/types";

function field(over: Partial<DetectedField>): DetectedField {
  return {
    id: "f1", category: "school", confidence: 0.95, label: "School",
    controlType: "combobox", required: false, proposedValue: "University of Ottawa",
    fillable: true, sensitive: false, options: [], helpText: "", inputType: "",
    groupIndex: 0, ...over,
  };
}

const ctx = { host: "job-boards.greenhouse.io", url: "https://x/y", atsType: "greenhouse" };

const snapshot = () => ({
  dom: '<div class="input-wrapper"><label for="school--0">School</label><input id="school--0" role="combobox"/></div>',
  selector: "#school--0",
  options: ["University of Ottawa", "McGill University"],
});

const base = {
  reports: [{ fieldId: "f1", ok: false, reason: 'No option matches "University of Ottawa"' }] as never,
  outcomes: [],
  intended: [{ fieldId: "f1", value: "University of Ottawa" }],
  observed: [{ fieldId: "f1", value: "" }],
};

describe("the default record carries no answers and no markup", () => {
  it("emits no fieldCaptures when capture is not requested", () => {
    const t = buildAutofillTelemetry([field({})], ctx, base);
    expect(t.fieldCaptures).toBeUndefined();
  });

  it("still emits the ordinary outcome record", () => {
    const t = buildAutofillTelemetry([field({})], ctx, base);
    expect(t.fieldOutcomes).toHaveLength(1);
    // Presence, not content: the boolean is the whole observation.
    expect(t.fieldOutcomes![0].observedValuePresent).toBe(false);
  });

  it("strips the answer the fill engine quoted into its failure reason", () => {
    // The leak this caught: reasons are built as `No option matches "<answer>"`,
    // and that string shipped in field_outcomes for EVERY account, despite this
    // module documenting that it never sends answer values.
    const t = buildAutofillTelemetry([field({})], ctx, base);
    expect(JSON.stringify(t.fieldOutcomes)).not.toContain("University of Ottawa");
    expect(JSON.stringify(t.failedFields)).not.toContain("University of Ottawa");
    // …while keeping the part that says WHY, which is the useful half.
    expect(t.fieldOutcomes![0].reason).toContain("No option matches");
  });

  it("keeps the employer's option list, which is not the user's data", () => {
    const t = buildAutofillTelemetry([field({})], ctx, {
      ...base,
      reports: [{ fieldId: "f1", ok: false, reason: 'No option matches "Ada" (saw: Yes | No)' }] as never,
    });
    expect(t.fieldOutcomes![0].reason).toContain("saw: Yes | No");
    expect(t.fieldOutcomes![0].reason).not.toContain("Ada");
  });
});

describe("an opted-in record carries what a fix actually needs", () => {
  const built = () =>
    buildAutofillTelemetry([field({})], ctx, { ...base, capture: { snapshot } });

  it("records the value we tried to write", () => {
    // Without this, a wrong-but-written answer is only findable by noticing that
    // its CATEGORY looks odd for the label, which is how the 2026-08-12
    // certification bug was caught, by luck rather than by data.
    expect(built().fieldCaptures![0].proposedValue).toBe("University of Ottawa");
  });

  it("records the control type and the options the widget really offered", () => {
    const c = built().fieldCaptures![0];
    expect(c.controlType).toBe("combobox");
    expect(c.options).toEqual(["University of Ottawa", "McGill University"]);
  });

  it("prefers the live option list over the empty scan-time one", () => {
    // A react-select scans with no options at all: that is the whole reason the
    // snapshot re-reads them.
    const c = buildAutofillTelemetry(
      [field({ options: [] })], ctx, { ...base, capture: { snapshot } }
    ).fieldCaptures![0];
    expect(c.options.length).toBe(2);
  });

  it("records the markup, which is what makes a fixture possible", () => {
    const c = built().fieldCaptures![0];
    expect(c.dom).toContain('role="combobox"');
    expect(c.selector).toBe("#school--0");
  });

  it("records the outcome and the failure reason", () => {
    const c = built().fieldCaptures![0];
    expect(c.outcome).toBe("failed");
    expect(c.reason).toContain("No option matches");
  });
});

describe("secrets are redacted even in diagnostic mode", () => {
  it("never stores a password", () => {
    const c = buildAutofillTelemetry(
      [field({ id: "p", category: "accountPassword", proposedValue: "hunter2" })],
      ctx,
      {
        ...base,
        reports: [{ fieldId: "p", ok: true }] as never,
        intended: [{ fieldId: "p", value: "hunter2" }],
        observed: [{ fieldId: "p", value: "hunter2" }],
        capture: { snapshot },
      }
    ).fieldCaptures![0];
    expect(c.proposedValue).toBe("<password>");
    expect(c.redacted).toBe(true);
  });

  it("never stores something shaped like a national ID", () => {
    const c = buildAutofillTelemetry(
      [field({ id: "s", category: "unknown", proposedValue: "123-456-789" })],
      ctx,
      {
        ...base,
        reports: [{ fieldId: "s", ok: true }] as never,
        intended: [{ fieldId: "s", value: "123-456-789" }],
        observed: [{ fieldId: "s", value: "123-456-789" }],
        capture: { snapshot },
      }
    ).fieldCaptures![0];
    expect(c.proposedValue).toBe("<redacted-id>");
    // Flagged, so an empty-looking answer is never chased as a fill bug.
    expect(c.redacted).toBe(true);
  });
});

describe("demographic answers never leave the device, capture or not", () => {
  // This is not a capture setting. The store listing states it outright
  // ("Demographic (EEO) answers never leave your device"), and it is why the AI
  // pass has never been shown these fields either. Opting into diagnostics
  // opts an account into sending ITS ANSWERS; it must not reopen this.
  const eeo = () =>
    buildAutofillTelemetry(
      [field({ id: "g", category: "eeoGender", label: "Gender", sensitive: true, proposedValue: "Male" })],
      ctx,
      {
        ...base,
        reports: [{ fieldId: "g", ok: true }] as never,
        intended: [{ fieldId: "g", value: "Male" }],
        observed: [{ fieldId: "g", value: "Male" }],
        capture: { snapshot },
      }
    ).fieldCaptures![0];

  it("withholds the proposed demographic answer", () => {
    expect(eeo().proposedValue).toBe("<demographic>");
    expect(eeo().redacted).toBe(true);
  });

  it("withholds what the page ended up holding, too", () => {
    // Sending `observed` while withholding `proposed` would protect nothing:
    // for a demographic field they are the same answer.
    expect(eeo().observedValue).not.toBe("Male");
  });

  it("nothing in the whole record spells the answer out", () => {
    expect(JSON.stringify(eeo())).not.toContain("Male");
  });

  it("still records everything a fix would need", () => {
    // The EEO dropdowns have real, telemetry-confirmed bugs. Withholding the
    // ANSWER must not cost the ability to debug the WIDGET.
    const c = eeo();
    expect(c.category).toBe("eeoGender");
    expect(c.controlType).toBe("combobox");
    expect(c.options.length).toBeGreaterThan(0);
    expect(c.outcome).toBe("filled");
  });
});

describe("rankForCapture keeps the interesting fields when the cap bites", () => {
  const rec = (outcome: string, fieldId: string) =>
    ({ outcome, fieldId } as FieldCaptureRecord);

  it("puts failures ahead of successes", () => {
    const ranked = rankForCapture([
      rec("filled", "a"), rec("failed", "b"), rec("reverted", "c"), rec("dropped", "d"),
    ]);
    expect(ranked.map((r) => r.fieldId)).toEqual(["b", "c", "d", "a"]);
  });

  it("still keeps successes, which is how a silent wrong answer is found", () => {
    expect(rankForCapture([rec("filled", "a")])).toHaveLength(1);
  });
});
