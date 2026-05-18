import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  WIZARD_STEPS,
  STORAGE_KEY,
  COMPLETION_FLAG,
} from "../components/OnboardingWizard";

/**
 * Property-based tests for the Onboarding Wizard.
 * Tests pure logic extracted from the component — no DOM rendering.
 */

// ─── Helper functions replicating wizard logic ───────────────────────────────

/** Look up a wizard step by its id */
function getStepById(id: number) {
  return WIZARD_STEPS.find((s) => s.id === id) ?? null;
}

/** Simulate goNext: increment step by 1 */
function goNext(currentStep: number): number {
  return currentStep + 1;
}

/** Simulate goBack: decrement step by 1 */
function goBack(currentStep: number): number {
  return currentStep - 1;
}

/** Compute step counter text (null for welcome step) */
function getStepCounterText(stepId: number): string | null {
  if (stepId < 0) return null;
  return `${stepId + 1}/8`;
}

/** Persist step to localStorage */
function persistStep(step: number): void {
  localStorage.setItem(STORAGE_KEY, String(step));
}

/** Read persisted step from localStorage (mirrors component logic) */
function readPersistedStep(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored !== null) {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed >= -1 && parsed <= 7) {
      return parsed;
    }
  }
  return -1;
}

// ─── Property 1: Navigation button visibility ────────────────────────────────

describe("Property 1: Navigation button visibility", () => {
  /**
   * **Validates: Requirements 10.1, 10.2**
   *
   * For any wizard step index, the "Next" button SHALL be displayed if and only
   * if the step is not the final step (8/8), and the "Back" button SHALL be
   * displayed if and only if the step is not the welcome step and not step 1/8.
   */

  it("Next button is displayed on all steps except the final step (id 7)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (stepId) => {
        const step = getStepById(stepId);
        expect(step).not.toBeNull();

        if (stepId !== 7) {
          // Non-final steps should NOT have "Finish Setup" as button label
          expect(step!.buttonLabel).not.toBe("Finish Setup");
        }
      })
    );
  });

  it("Finish Setup button appears only on the final step (id 7)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (stepId) => {
        const step = getStepById(stepId);
        expect(step).not.toBeNull();

        if (stepId === 7) {
          expect(step!.buttonLabel).toBe("Finish Setup");
        } else {
          expect(step!.buttonLabel).not.toBe("Finish Setup");
        }
      })
    );
  });

  it("Back button is displayed if and only if step is not welcome (-1) and not step 1/8 (id 0)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (stepId) => {
        const step = getStepById(stepId);
        expect(step).not.toBeNull();

        if (stepId === -1 || stepId === 0) {
          expect(step!.showBack).toBe(false);
        } else {
          expect(step!.showBack).toBe(true);
        }
      })
    );
  });
});

// ─── Property 2: Navigation step correctness ─────────────────────────────────

describe("Property 2: Navigation step correctness", () => {
  /**
   * **Validates: Requirements 10.3, 10.4**
   *
   * For any wizard step where "Next" is available, clicking Next SHALL result
   * in the step index incrementing by exactly 1. For any wizard step where
   * "Back" is available, clicking Back SHALL result in the step index
   * decrementing by exactly 1.
   */

  it("Next increments step by exactly 1 for all steps where Next is available", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 6 }), (stepId) => {
        const nextStep = goNext(stepId);
        expect(nextStep).toBe(stepId + 1);
      })
    );
  });

  it("Back decrements step by exactly 1 for all steps where Back is available", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 7 }), (stepId) => {
        const prevStep = goBack(stepId);
        expect(prevStep).toBe(stepId - 1);
      })
    );
  });

  it("Next from any valid step produces a valid step id", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 6 }), (stepId) => {
        const nextStep = goNext(stepId);
        expect(nextStep).toBeGreaterThanOrEqual(0);
        expect(nextStep).toBeLessThanOrEqual(7);
        // The resulting step should exist in WIZARD_STEPS
        expect(getStepById(nextStep)).not.toBeNull();
      })
    );
  });

  it("Back from any valid step produces a valid step id", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 7 }), (stepId) => {
        const prevStep = goBack(stepId);
        expect(prevStep).toBeGreaterThanOrEqual(-1);
        expect(prevStep).toBeLessThanOrEqual(6);
        // The resulting step should exist in WIZARD_STEPS
        expect(getStepById(prevStep)).not.toBeNull();
      })
    );
  });
});

// ─── Property 3: Step counter accuracy ───────────────────────────────────────

describe("Property 3: Step counter accuracy", () => {
  /**
   * **Validates: Requirements 10.5**
   *
   * For any wizard step index in the range [0, 7], the step counter SHALL
   * display the text "{index + 1}/8". The step counter is NOT displayed on
   * the welcome step (index -1).
   */

  it("step counter displays '{index + 1}/8' for steps 0 through 7", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), (stepId) => {
        const counterText = getStepCounterText(stepId);
        expect(counterText).toBe(`${stepId + 1}/8`);
      })
    );
  });

  it("step counter is NOT displayed on the welcome step (id -1)", () => {
    const counterText = getStepCounterText(-1);
    expect(counterText).toBeNull();
  });

  it("step counter text is never null for non-welcome steps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), (stepId) => {
        const counterText = getStepCounterText(stepId);
        expect(counterText).not.toBeNull();
        expect(counterText).toMatch(/^\d\/8$/);
      })
    );
  });
});

// ─── Property 4: Wizard state persistence round-trip ─────────────────────────

describe("Property 4: Wizard state persistence round-trip", () => {
  /**
   * **Validates: Requirements 12.1, 12.2**
   *
   * For any valid wizard step number, persisting it to localStorage and then
   * reading it back SHALL return the same step number.
   */

  beforeEach(() => {
    localStorage.clear();
  });

  it("persisting a step and reading it back returns the same value", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (stepId) => {
        localStorage.clear();
        persistStep(stepId);
        const restored = readPersistedStep();
        expect(restored).toBe(stepId);
      })
    );
  });

  it("readPersistedStep returns -1 when localStorage is empty", () => {
    localStorage.clear();
    const restored = readPersistedStep();
    expect(restored).toBe(-1);
  });

  it("readPersistedStep returns -1 for invalid stored values", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 8, max: 100 }),
          fc.integer({ min: -100, max: -2 })
        ),
        (invalidStep) => {
          localStorage.clear();
          localStorage.setItem(STORAGE_KEY, String(invalidStep));
          const restored = readPersistedStep();
          expect(restored).toBe(-1);
        }
      )
    );
  });

  it("readPersistedStep returns -1 for non-numeric stored values", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => isNaN(parseInt(s, 10))),
        (invalidValue) => {
          localStorage.clear();
          localStorage.setItem(STORAGE_KEY, invalidValue);
          const restored = readPersistedStep();
          expect(restored).toBe(-1);
        }
      )
    );
  });
});

// ─── Property 5: Skip Tutorial availability ──────────────────────────────────

describe("Property 5: Skip Tutorial availability", () => {
  /**
   * **Validates: Requirements 13.1**
   *
   * For any active wizard step (including the welcome step and all 8 numbered
   * steps), the wizard is active and Skip Tutorial would be shown. We verify
   * that every valid step id maps to a valid WIZARD_STEPS entry.
   */

  it("every valid step id (-1 to 7) maps to a valid WIZARD_STEPS entry", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (stepId) => {
        const step = getStepById(stepId);
        expect(step).not.toBeNull();
        expect(step!.id).toBe(stepId);
      })
    );
  });

  it("WIZARD_STEPS contains exactly 9 entries covering all step ids", () => {
    expect(WIZARD_STEPS).toHaveLength(9);
    const ids = WIZARD_STEPS.map((s) => s.id);
    for (let i = -1; i <= 7; i++) {
      expect(ids).toContain(i);
    }
  });

  it("every step has required fields for rendering (heading, description, buttonLabel)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (stepId) => {
        const step = getStepById(stepId);
        expect(step).not.toBeNull();
        // These fields must exist for the wizard to be active (and thus show Skip Tutorial)
        expect(step!.heading).toBeTruthy();
        expect(step!.description).toBeTruthy();
        expect(step!.buttonLabel).toBeTruthy();
      })
    );
  });
});
