import { describe, it, expect } from "vitest";
import { resolveCheckboxIntent } from "../src/content/checkboxIntent";

// The labels below are verbatim from production autofill_reports failures
// (SuccessFactors + Workday) where a single checkbox was fed a text value and
// rejected as "Ambiguous checkbox value".

describe("resolveCheckboxIntent", () => {
  it("checks a clear application-consent / agreement box", () => {
    expect(resolveCheckboxIntent("I agree to the above", null)).toBe("yes");
    expect(resolveCheckboxIntent("I certify that the information provided is true", null)).toBe("yes");
    expect(resolveCheckboxIntent("I have read and accept the Privacy Policy", null)).toBe("yes");
    expect(resolveCheckboxIntent("I consent to the processing of my personal data", null)).toBe("yes");
  });

  it("never opts the user into marketing / notifications (skips → null)", () => {
    expect(resolveCheckboxIntent("Notification:", "user@example.com")).toBeNull();
    expect(resolveCheckboxIntent("Hear more about career opportunities", "user@example.com")).toBeNull();
    expect(resolveCheckboxIntent("Subscribe to our newsletter", null)).toBeNull();
    // marketing wins even when phrased as an agreement
    expect(resolveCheckboxIntent("I agree to receive marketing emails", null)).toBeNull();
  });

  it("does not feed a misclassified text value into a checkbox (skips → null)", () => {
    // "I have a preferred name" was classified firstName → value was the name.
    expect(resolveCheckboxIntent("I have a preferred name", "John")).toBeNull();
    expect(resolveCheckboxIntent("I am fluent in this language.", "")).toBeNull();
  });

  it("honors a genuine boolean value on a non-consent, non-marketing box", () => {
    expect(resolveCheckboxIntent("Are you legally authorized to work?", "Yes")).toBe("Yes");
    expect(resolveCheckboxIntent("Do you require sponsorship?", "No")).toBe("No");
  });
});

/**
 * Robinhood on Greenhouse, live 2026-10-03: "By checking this box, I consent to
 * Robinhood collecting, storing, and processing my responses to the demographic
 * data surveys above." It was briefly never ticked (bug #36). The policy since
 * the "answer all questions" instruction: every application consent is given,
 * because every demographic question is now answered (the user's own answer, or
 * "decline"), so the consent covers exactly that and a REQUIRED box no longer
 * blocks the submit. Marketing opt-ins are still never ticked.
 */
describe("resolveCheckboxIntent: demographic-data consent", () => {
  const ROBINHOOD =
    "By checking this box, I consent to Robinhood collecting, storing, and processing my responses to the demographic data surveys above.";

  it("is given like every application consent", () => {
    expect(resolveCheckboxIntent(ROBINHOOD, null)).toBe("yes");
  });

  it("a marketing opt-in phrased as consent is still never ticked", () => {
    expect(resolveCheckboxIntent("I consent to receive marketing emails about future events", null)).toBeNull();
  });

  it("still takes the user's own yes/no answer", () => {
    expect(resolveCheckboxIntent("I identify as LGBTQ+", "Yes")).toBe("Yes");
  });
});
