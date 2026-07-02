import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { writeControl, verifyControl } from "../src/content/writeEngine";
import { isAiCandidate } from "../src/content/aiFillPlanner";
import { isDefaultSelected } from "../src/shared/selection";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

function signupForm(): void {
  document.body.innerHTML = `
    <form>
      <label>Email <input type="email" name="email" /></label>
      <label>Password <input type="password" name="password" id="pw" /></label>
      <label>Verify Password <input type="password" name="confirm" /></label>
    </form>`;
}

describe("scanPage — password fields", () => {
  it("surfaces passwords as accountPassword, never fillable, never AI-eligible", () => {
    signupForm();
    const { fields } = scanPage(null, false);
    const pws = fields.filter((f) => f.controlType === "password");
    expect(pws).toHaveLength(2);
    for (const f of pws) {
      expect(f.category).toBe("accountPassword");
      expect(f.fillable).toBe(false);
      expect(f.proposedValue).toBeNull();
      expect(isAiCandidate(f)).toBe(false);
      expect(isDefaultSelected(f)).toBe(false);
    }
  });

  it("masks any pre-existing value as 'filled'", () => {
    signupForm();
    (document.getElementById("pw") as HTMLInputElement).value = "hunter2";
    const { fields } = scanPage(null, false);
    const pw = fields.find((f) => f.controlType === "password" && f.currentValue);
    expect(pw?.currentValue).toBe("filled");
  });
});

describe("writeControl / verifyControl — password", () => {
  it("writes and verifies with exact matching", () => {
    signupForm();
    const el = document.getElementById("pw") as HTMLInputElement;
    const control = { id: "x", controlType: "password" as const, el };
    expect(writeControl(control, "S3cure!Pass").written).toBe(true);
    expect(verifyControl(control, "S3cure!Pass")).toBe(true);
    expect(verifyControl(control, "s3cure!pass")).toBe(false); // never fuzzy
  });
});
