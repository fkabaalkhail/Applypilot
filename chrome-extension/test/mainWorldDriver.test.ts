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

/** react-select container with a mock Fiber exposing selectOption(). */
function reactSelectWithFiber(fieldId: string, options: string[]): { display: HTMLElement } {
  const container = document.createElement("div");
  container.className = "rs__container";
  container.setAttribute(FIELD_ID_ATTR, fieldId);
  const control = document.createElement("div");
  control.className = "rs__control";
  const single = document.createElement("div");
  single.className = "rs__single-value";
  const input = document.createElement("input");
  input.id = "react-select-9-input";
  input.setAttribute("role", "combobox");
  control.append(single, input);
  container.append(control);
  document.body.append(container);

  const opts = options.map((label) => ({ label, value: label }));
  const instance = {
    props: { options: opts, getOptionLabel: (o: { label: string }) => o.label },
    selectOption: (o: { label: string }) => { single.textContent = o.label; },
  };
  const fiber = { return: null, stateNode: instance, memoizedProps: instance.props };
  (container as unknown as Record<string, unknown>)["__reactFiber$abc"] = fiber;
  return { display: single };
}

describe("fillReactSelect via Fiber", () => {
  it("calls selectOption for the matching option and reports committed text", async () => {
    installDriver(window);
    const { display } = reactSelectWithFiber("rs-1", ["United States", "Canada", "Mexico"]);
    const res = await drive("rs-1", "Canada", "react-select");
    expect(res.ok).toBe(true);
    expect(display.textContent).toBe("Canada");
    expect(res.committed).toBe("Canada");
  });

  it("reports no-match when the option is absent", async () => {
    installDriver(window);
    reactSelectWithFiber("rs-2", ["United States", "Canada"]);
    const res = await drive("rs-2", "Atlantis", "react-select");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-match");
  });
});
