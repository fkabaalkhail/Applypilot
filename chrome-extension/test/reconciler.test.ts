import { describe, it, expect, beforeEach } from "vitest";
import { AutofillReconciler } from "../src/content/reconciler";
import type { RuntimeControl } from "../src/content/formScanner";

/** Instant settle window so cycle logic is exercised without real waiting. */
const instant = async (): Promise<void> => {};

function reg(controls: RuntimeControl[]): Map<string, RuntimeControl> {
  return new Map(controls.map((c) => [c.id, c]));
}

function input(id: string, value = ""): { control: RuntimeControl; el: HTMLInputElement } {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  document.body.appendChild(el);
  return { control: { id, controlType: "text", el }, el };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AutofillReconciler — happy path", () => {
  it("fills mapped fields and marks them stable", async () => {
    const a = input("f-1");
    const b = input("f-2");
    const engine = new AutofillReconciler({ sleep: instant, observe: false });

    const reports = await engine.run(
      [
        { fieldId: "f-1", value: "Wissam" },
        { fieldId: "f-2", value: "Elmasry" },
      ],
      reg([a.control, b.control])
    );
    engine.dispose();

    expect(a.el.value).toBe("Wissam");
    expect(b.el.value).toBe("Elmasry");
    expect(reports.every((r) => r.status === "stable" && r.ok)).toBe(true);
  });
});

describe("AutofillReconciler — drift reconciliation", () => {
  it("re-applies a field the framework wipes during the settle window", async () => {
    const a = input("f-1");
    let wiped = false;
    const sleep = async (): Promise<void> => {
      if (!wiped) {
        wiped = true;
        a.el.value = ""; // framework overwrites the value after our first fill
      }
    };
    const engine = new AutofillReconciler({ sleep, observe: false });

    const reports = await engine.run([{ fieldId: "f-1", value: "Wissam" }], reg([a.control]));
    engine.dispose();

    expect(a.el.value).toBe("Wissam");
    expect(reports[0].status).toBe("stable");
    expect(reports[0].attempts).toBeGreaterThanOrEqual(2);
  });

  it("gives up after the cycle budget and reports drift honestly", async () => {
    const a = input("f-1");
    // A field whose value is wiped on every settle window — can never stabilize.
    const sleep = async (): Promise<void> => {
      a.el.value = "";
    };
    const engine = new AutofillReconciler({ sleep, observe: false, maxCycles: 3 });

    const reports = await engine.run([{ fieldId: "f-1", value: "Wissam" }], reg([a.control]));
    engine.dispose();

    expect(reports[0].ok).toBe(false);
    expect(reports[0].status).toBe("drifted");
  });
});

describe("AutofillReconciler — idempotency", () => {
  it("re-running an already-filled form writes nothing and stays stable", async () => {
    const a = input("f-1", "Wissam"); // already correct
    let writes = 0;
    a.el.addEventListener("input", () => writes++);
    const engine = new AutofillReconciler({ sleep: instant, observe: false });

    const reports = await engine.run([{ fieldId: "f-1", value: "Wissam" }], reg([a.control]));
    engine.dispose();

    expect(writes).toBe(0); // verify-before-write => no events fired
    expect(reports[0].status).toBe("stable");
    expect(a.el.value).toBe("Wissam");
  });
});

describe("AutofillReconciler — fills around CAPTCHA (never suspends the form)", () => {
  it("fills the normal fields even when a reCAPTCHA widget is on the page", async () => {
    // A reCAPTCHA widget present on the page must NOT stop the rest of the form
    // from filling — we skip the captcha itself and fill everything else.
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="abc"></div>`;
    const a = input("f-1");
    const engine = new AutofillReconciler({ sleep: instant, observe: false });

    const reports = await engine.run([{ fieldId: "f-1", value: "Wissam" }], reg([a.control]));
    engine.dispose();

    expect(a.el.value).toBe("Wissam");
    expect(reports[0].status).toBe("stable");
  });
});

describe("AutofillReconciler — targeted reapply", () => {
  it("reapplies only the drifted field on reconcileNow", async () => {
    const a = input("f-1");
    const b = input("f-2");
    let bWrites = 0;
    b.el.addEventListener("input", () => bWrites++);
    const engine = new AutofillReconciler({ sleep: instant, observe: false });

    await engine.run(
      [
        { fieldId: "f-1", value: "A" },
        { fieldId: "f-2", value: "B" },
      ],
      reg([a.control, b.control])
    );
    expect(bWrites).toBe(1); // initial fill wrote b once

    a.el.value = ""; // framework wipes ONLY field A
    const reports = await engine.reconcileNow();
    engine.dispose();

    expect(a.el.value).toBe("A"); // reapplied
    expect(b.el.value).toBe("B"); // untouched
    expect(bWrites).toBe(1); // field B was NOT rewritten
    expect(reports.find((r) => r.fieldId === "f-1")?.status).toBe("stable");
  });
});

describe("AutofillReconciler — removed field", () => {
  it("reports a field removed from the DOM as not ok", async () => {
    const a = input("f-1");
    const engine = new AutofillReconciler({ sleep: instant, observe: false });
    a.el.remove();

    const reports = await engine.run([{ fieldId: "f-1", value: "X" }], reg([a.control]));
    engine.dispose();

    expect(reports[0].ok).toBe(false);
  });
});

describe("AutofillReconciler — observer-driven background reconciliation", () => {
  it("restores a wiped value after a DOM mutation while observing", async () => {
    const a = input("f-1");
    const engine = new AutofillReconciler({ sleep: instant, observerDebounceMs: 5 });

    await engine.run([{ fieldId: "f-1", value: "Z" }], reg([a.control]));
    expect(a.el.value).toBe("Z");

    a.el.value = ""; // framework wipes value (a bare property change MO can't see)
    document.body.appendChild(document.createElement("div")); // structural mutation MO DOES see

    await new Promise((r) => setTimeout(r, 40)); // let debounce + reconcile run
    engine.dispose();

    expect(a.el.value).toBe("Z"); // observer-driven reconciliation restored it
  });
});

describe("addTargets — merges without resetting existing tracking", () => {
  it("fills new targets and keeps prior fields in the engine state", async () => {
    document.body.innerHTML = `<input id="a" /><input id="b" />`;
    const a = document.getElementById("a") as HTMLInputElement;
    const b = document.getElementById("b") as HTMLInputElement;
    const registry = new Map<string, RuntimeControl>([
      ["a", { id: "a", controlType: "text", el: a }],
      ["b", { id: "b", controlType: "text", el: b }],
    ]);
    const engine = new AutofillReconciler({ sleep: async () => {}, settleWindowMs: 0, observe: false });

    const first = await engine.run([{ fieldId: "a", value: "alpha" }], registry);
    expect(first.find((r) => r.fieldId === "a")?.ok).toBe(true);

    const second = await engine.addTargets([{ fieldId: "b", value: "beta" }], registry);

    // Only the new target is reported back…
    expect(second.map((r) => r.fieldId)).toEqual(["b"]);
    expect(second[0].ok).toBe(true);
    expect(b.value).toBe("beta");
    // …and the original field is still filled (not wiped).
    expect(a.value).toBe("alpha");
  });
});
