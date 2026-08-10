import { describe, it, expect } from "vitest";
import { buildAutofillTelemetry, revertedFields } from "../src/content/telemetry";
import type { DetectedField } from "../src/shared/types";
import type { FieldReport } from "../src/content/reconciler";

const f = (id: string, label: string, category = "unknown"): DetectedField =>
  ({ id, label, category } as unknown as DetectedField);

const rep = (fieldId: string, ok: boolean, reason?: string): FieldReport => ({
  fieldId,
  ok,
  status: ok ? "stable" : "drifted",
  reason,
  attempts: 1,
});

describe("buildAutofillTelemetry", () => {
  it("summarizes filled vs failed with labels + reasons", () => {
    const fields = [f("a", "First Name", "firstName"), f("b", "Work Authorization")];
    const reports = [rep("a", true), rep("b", false, "No option matches")];

    const t = buildAutofillTelemetry(
      fields,
      { host: "boards.greenhouse.io", url: "https://x/y", atsType: "greenhouse" },
      { reports, outcomes: [] }
    );

    expect(t.totalFields).toBe(2);
    expect(t.filled).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.failedFields).toEqual([
      { label: "Work Authorization", category: "unknown", reason: "No option matches" },
    ]);
    expect(t.host).toBe("boards.greenhouse.io");
    expect(t.atsType).toBe("greenhouse");
  });

  it("counts a field ok if ANY pass filled it (local miss, later hit)", () => {
    const fields = [f("a", "Country", "country")];
    const reports = [rep("a", false, "No option matches")]; // local pass missed
    const outcomes = [{ fieldId: "a", ok: true }]; // combobox/AI pass filled it

    const t = buildAutofillTelemetry(fields, { host: "h", url: "u", atsType: "" }, { reports, outcomes });

    expect(t.filled).toBe(1);
    expect(t.failed).toBe(0);
    expect(t.failedFields).toEqual([]);
  });

  it("threads a combobox/driver outcome's reason into failedFields", () => {
    // Previously outcome failures were logged with an empty reason (""), the
    // exact SF/Workday dropdown blind spot. The reason must now survive.
    const fields = [f("g", "Please state your gender:", "eeoGender")];
    const outcomes = [{ fieldId: "g", ok: false, reason: "Selection didn't stick. Select it manually" }];
    const t = buildAutofillTelemetry(
      fields,
      { host: "career2.successfactors.eu", url: "u", atsType: "successfactors" },
      { reports: [], outcomes }
    );
    expect(t.failed).toBe(1);
    expect(t.failedFields[0].reason).toBe("Selection didn't stick. Select it manually");
  });

  it("emits only label/category/reason, never user values", () => {
    const fields = [f("a", "Some Question")];
    const t = buildAutofillTelemetry(
      fields,
      { host: "h", url: "u", atsType: "" },
      { reports: [rep("a", false, "cannot be scripted")], outcomes: [] }
    );
    expect(Object.keys(t.failedFields[0]).sort()).toEqual(["category", "label", "reason"]);
  });
});

describe("successes are recorded too", () => {
  it("logs a per-field record for a field that filled, not just for failures", () => {
    const fields = [f("a", "First Name", "firstName")];
    const t = buildAutofillTelemetry(
      fields,
      { host: "h", url: "u", atsType: "" },
      {
        reports: [rep("a", true)],
        outcomes: [],
        provenance: new Map([["a", { tier: "profile" }]]),
        intended: [{ fieldId: "a", value: "Ada" }],
        observed: [{ fieldId: "a", value: "Ada" }],
      }
    );
    expect(t.fieldOutcomes).toEqual([
      {
        label: "First Name",
        category: "firstName",
        tier: "profile",
        pass: "",
        expectedValuePresent: true,
        observedValuePresent: true,
        outcome: "filled",
      },
    ]);
  });

  it("names the tier and pass responsible for a value", () => {
    const fields = [f("a", "Are you 18 or older?")];
    const t = buildAutofillTelemetry(
      fields,
      { host: "h", url: "u", atsType: "" },
      {
        reports: [rep("a", true)],
        outcomes: [],
        provenance: new Map([["a", { tier: "backend", pass: "rule" }]]),
        intended: [{ fieldId: "a", value: "No" }],
        observed: [{ fieldId: "a", value: "No" }],
      }
    );
    expect(t.fieldOutcomes?.[0].tier).toBe("backend");
    expect(t.fieldOutcomes?.[0].pass).toBe("rule");
  });

  it("carries no answer text in any per-field record", () => {
    const t = buildAutofillTelemetry(
      [f("a", "Salary expectation")],
      { host: "h", url: "u", atsType: "" },
      {
        reports: [rep("a", true)],
        outcomes: [],
        intended: [{ fieldId: "a", value: "SECRET-90000" }],
        observed: [{ fieldId: "a", value: "SECRET-90000" }],
      }
    );
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });

  it("records a gate drop as its own outcome, with the reason", () => {
    const t = buildAutofillTelemetry(
      [f("a", "Are you 18 or older?")],
      { host: "h", url: "u", atsType: "" },
      {
        reports: [],
        outcomes: [],
        dropped: [{ fieldId: "a", reason: "contradicts_profile:age_gate", source: "rule" }],
      }
    );
    expect(t.fieldOutcomes?.[0].outcome).toBe("dropped");
    expect(t.fieldOutcomes?.[0].reason).toBe("contradicts_profile:age_gate");
    expect(t.failedFields[0].reason).toBe("contradicts_profile:age_gate");
  });
});

describe("revertedFields", () => {
  it("catches a value the framework cleared after the write verified", () => {
    const out = revertedFields(
      [{ fieldId: "a", value: "Yes" }],
      [{ fieldId: "a", value: "" }],
      new Set(["a"])
    );
    expect(out).toEqual([{ fieldId: "a", cleared: true }]);
  });

  it("catches a value the framework replaced with a different one", () => {
    const out = revertedFields(
      [{ fieldId: "a", value: "Yes" }],
      [{ fieldId: "a", value: "Select One" }],
      new Set(["a"])
    );
    expect(out).toEqual([{ fieldId: "a", cleared: false }]);
  });

  it("tolerates the control normalizing case, spacing or punctuation", () => {
    const out = revertedFields(
      [{ fieldId: "a", value: "Yes, I am" }],
      [{ fieldId: "a", value: "yes i am" }],
      new Set(["a"])
    );
    expect(out).toEqual([]);
  });

  it("does not report a field whose write already failed", () => {
    // That is a failure, not a revert, conflating them hides the interesting
    // case behind the ordinary one.
    const out = revertedFields(
      [{ fieldId: "a", value: "Yes" }],
      [{ fieldId: "a", value: "" }],
      new Set()
    );
    expect(out).toEqual([]);
  });

  it("does not report a field that left the DOM between fill and re-scan", () => {
    const out = revertedFields([{ fieldId: "a", value: "Yes" }], [], new Set(["a"]));
    expect(out).toEqual([]);
  });
});

describe("a revert is a failure, not a fill", () => {
  it("counts a reverted field as failed and names it in the record", () => {
    const t = buildAutofillTelemetry(
      [f("a", "Are you 18 or older?")],
      { host: "h", url: "u", atsType: "" },
      {
        reports: [rep("a", true)], // the write verified at write time
        outcomes: [],
        provenance: new Map([["a", { tier: "backend", pass: "ai" }]]),
        intended: [{ fieldId: "a", value: "Yes" }],
        observed: [{ fieldId: "a", value: "" }], // …and the page does not hold it
      }
    );
    expect(t.filled).toBe(0);
    expect(t.failed).toBe(1);
    expect(t.reverted).toBe(1);
    expect(t.fieldOutcomes?.[0].outcome).toBe("reverted");
    expect(t.fieldOutcomes?.[0].observedValuePresent).toBe(false);
    expect(t.failedFields[0].reason).toBe("value_cleared_after_write");
  });

  it("reports a value the page swapped for something else", () => {
    const t = buildAutofillTelemetry(
      [f("a", "Country", "country")],
      { host: "h", url: "u", atsType: "" },
      {
        reports: [rep("a", true)],
        outcomes: [],
        intended: [{ fieldId: "a", value: "Canada" }],
        observed: [{ fieldId: "a", value: "United States" }],
      }
    );
    expect(t.fieldOutcomes?.[0].outcome).toBe("reverted");
    expect(t.fieldOutcomes?.[0].observedValuePresent).toBe(true);
    expect(t.failedFields[0].reason).toBe("value_changed_after_write");
  });

  it("leaves the counts alone when no re-scan was possible", () => {
    const t = buildAutofillTelemetry(
      [f("a", "First Name", "firstName")],
      { host: "h", url: "u", atsType: "" },
      { reports: [rep("a", true)], outcomes: [], intended: [{ fieldId: "a", value: "Ada" }] }
    );
    expect(t.filled).toBe(1);
    expect(t.reverted).toBe(0);
  });
});
