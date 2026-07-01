import { describe, it, expect, beforeEach } from "vitest";
import { installDriver, pickOption } from "../src/content/mainWorldDriver";
import { MW_FILL_EVENT, MW_RESULT_EVENT, type MwResultDetail } from "../src/content/mainWorldBridge";
import { FIELD_ID_ATTR } from "../src/shared/constants";

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__tailrdMWInstalled;
});

function drive(fieldId: string, value: string, kind: "react-select" | "workday"): Promise<MwResultDetail> {
  return new Promise((resolve) => {
    const onResult = (e: Event): void => {
      const d = (e as CustomEvent<MwResultDetail>).detail;
      if (d.id !== 99) return;
      window.removeEventListener(MW_RESULT_EVENT, onResult);
      resolve(d);
    };
    window.addEventListener(MW_RESULT_EVENT, onResult);
    window.dispatchEvent(new CustomEvent(MW_FILL_EVENT, { detail: { id: 99, fieldId, value, kind } }));
  });
}

describe("pickOption", () => {
  it("prefers exact, then contains, then token overlap", () => {
    expect(pickOption(["United States", "Canada"], "Canada")).toBe(1);
    expect(pickOption(["Yes", "No"], "Yes, I am authorized")).toBe(0);
    expect(pickOption(["Bachelor of Science", "Master of Science"], "master science")).toBe(1);
    expect(pickOption(["A", "B"], "Zorp")).toBe(-1);
  });
});

describe("installDriver", () => {
  it("installs once (guard) and ignores a second install", () => {
    installDriver(window);
    installDriver(window); // must not double-register
    expect((window as unknown as Record<string, unknown>).__tailrdMWInstalled).toBe(true);
  });

  it("replies not-ok when the field id is missing", async () => {
    installDriver(window);
    const res = await drive("nope-1", "Canada", "react-select");
    expect(res.ok).toBe(false);
  });
});
