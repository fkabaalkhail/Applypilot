import { describe, it, expect, beforeEach } from "vitest";
import {
  fillAriaCombobox,
  isAriaCombobox,
  readComboboxOptions,
  readComboboxValue,
} from "../src/content/comboboxEngine";

const instant = async (): Promise<void> => {};
/** Deterministic, fast options for the engine's bounded polling. */
const fast = { sleep: instant, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * A react-select-style combobox: an <input role="combobox"> whose menu is
 * rendered (optionally in a body portal) on mousedown, commits the choice on
 * option mousedown, then shows it in `.select__single-value` and unmounts the
 * menu — the exact lifecycle that defeats a plain `.value =` write.
 */
function reactSelect(
  options: string[],
  opts: { portal?: boolean; async?: boolean; initial?: string } = {}
): HTMLInputElement {
  const control = document.createElement("div");
  control.className = "select__control";
  const single = document.createElement("div");
  single.className = "select__single-value";
  if (opts.initial) single.textContent = opts.initial;
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  const listboxId = `lb-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-controls", listboxId);
  control.append(single, input);
  document.body.append(control);

  const render = (): void => {
    if (input.getAttribute("aria-expanded") !== "true") return;
    if (input.ownerDocument.getElementById(listboxId)) return;
    const lb = document.createElement("div");
    lb.id = listboxId;
    lb.setAttribute("role", "listbox");
    for (const label of options) {
      const o = document.createElement("div");
      o.setAttribute("role", "option");
      o.setAttribute("aria-selected", "false");
      o.textContent = label;
      o.addEventListener("mousedown", () => {
        single.textContent = label;
        input.value = "";
        input.setAttribute("aria-expanded", "false");
        lb.remove(); // react-select unmounts the menu on select
      });
      lb.append(o);
    }
    (opts.portal ? document.body : control).append(lb);
  };

  input.addEventListener("mousedown", () => {
    input.setAttribute("aria-expanded", "true");
    if (opts.async) setTimeout(render, 0);
    else render();
  });
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      input.setAttribute("aria-expanded", "false");
      input.ownerDocument.getElementById(listboxId)?.remove();
    }
  });
  return input;
}

/** A Workday-style trigger: a <button aria-haspopup="listbox"> that opens a
 *  sibling listbox on click and writes the chosen label back into itself. */
function buttonListbox(options: string[]): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "Select…";
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  btn.setAttribute("aria-controls", lbId);
  document.body.append(btn);

  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") return;
    btn.setAttribute("aria-expanded", "true");
    const lb = document.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    for (const label of options) {
      const o = document.createElement("div");
      o.setAttribute("role", "option");
      o.textContent = label;
      o.addEventListener("click", () => {
        btn.textContent = label;
        btn.setAttribute("aria-expanded", "false");
        lb.remove();
      });
      lb.append(o);
    }
    document.body.append(lb);
  });
  return btn;
}

/** A combobox whose listbox is ALREADY mounted (optionally hidden), referenced
 *  by aria-controls — what readComboboxOptions reads without opening. */
function staticCombobox(
  options: string[],
  opts: { value?: string; hidden?: boolean } = {}
): HTMLInputElement {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-controls", lbId);
  if (opts.value) {
    const sv = document.createElement("div");
    sv.className = "select__single-value";
    sv.textContent = opts.value;
    wrap.append(sv);
  }
  const lb = document.createElement("div");
  lb.id = lbId;
  lb.setAttribute("role", "listbox");
  if (opts.hidden) lb.setAttribute("hidden", "");
  for (const label of options) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    lb.append(o);
  }
  wrap.append(input, lb);
  document.body.append(wrap);
  return input;
}

describe("isAriaCombobox", () => {
  it("detects role=combobox inputs that toggle a listbox", () => {
    const el = reactSelect(["A", "B"]);
    expect(isAriaCombobox(el)).toBe(true);
  });

  it("detects button[aria-haspopup=listbox]", () => {
    const el = buttonListbox(["A", "B"]);
    expect(isAriaCombobox(el)).toBe(true);
  });

  it("detects a div[role=combobox] with aria-controls", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "combobox");
    el.setAttribute("aria-controls", "x");
    expect(isAriaCombobox(el)).toBe(true);
  });

  it("ignores a plain text input", () => {
    const el = document.createElement("input");
    el.type = "text";
    expect(isAriaCombobox(el)).toBe(false);
  });

  it("ignores a non-combobox div", () => {
    const el = document.createElement("div");
    expect(isAriaCombobox(el)).toBe(false);
  });
});

describe("fillAriaCombobox — react-select style", () => {
  it("opens the menu and selects the matching option", async () => {
    const el = reactSelect(["United States", "Canada", "Mexico"]);
    const res = await fillAriaCombobox(el, "Canada", fast);
    expect(res.filled).toBe(true);
    expect(document.querySelector(".select__single-value")?.textContent).toBe("Canada");
  });

  it("finds a menu rendered in a body portal", async () => {
    const el = reactSelect(["United States", "Canada"], { portal: true });
    const res = await fillAriaCombobox(el, "Canada", fast);
    expect(res.filled).toBe(true);
    expect(document.querySelector(".select__single-value")?.textContent).toBe("Canada");
  });

  it("waits for a menu that mounts asynchronously", async () => {
    const el = reactSelect(["United States", "Canada"], { portal: true, async: true });
    // real timers so the setTimeout(0) menu mount is observed
    const res = await fillAriaCombobox(el, "Canada", { openWaitMs: 500, commitWaitMs: 300, pollMs: 20 });
    expect(res.filled).toBe(true);
    expect(document.querySelector(".select__single-value")?.textContent).toBe("Canada");
  });

  it("matches fuzzily (full value vs short option label)", async () => {
    const el = reactSelect(["Yes", "No"]);
    const res = await fillAriaCombobox(el, "Yes, I am authorized to work", fast);
    expect(res.filled).toBe(true);
    expect(document.querySelector(".select__single-value")?.textContent).toBe("Yes");
  });

  it("is idempotent when the value is already chosen (never opens the menu)", async () => {
    const el = reactSelect(["United States", "Canada"], { initial: "Canada" });
    const res = await fillAriaCombobox(el, "Canada", fast);
    expect(res.filled).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull(); // menu never opened
  });

  it("reports failure and closes the menu when no option matches", async () => {
    const el = reactSelect(["United States", "Canada"]);
    const res = await fillAriaCombobox(el, "Atlantis", fast);
    expect(res.filled).toBe(false);
    expect(res.reason).toMatch(/no option|match/i);
    expect(el.getAttribute("aria-expanded")).toBe("false"); // left closed, not stuck open
  });
});

describe("fillAriaCombobox — button[aria-haspopup=listbox]", () => {
  it("opens and selects via the button trigger", async () => {
    const btn = buttonListbox(["United States", "Canada", "Mexico"]);
    const res = await fillAriaCombobox(btn, "Mexico", fast);
    expect(res.filled).toBe(true);
    expect(btn.textContent).toBe("Mexico");
  });
});

describe("fillAriaCombobox — guards", () => {
  it("reports failure for a disconnected trigger", async () => {
    const el = document.createElement("input");
    el.setAttribute("role", "combobox");
    el.setAttribute("aria-expanded", "false");
    const res = await fillAriaCombobox(el, "Canada", fast);
    expect(res.filled).toBe(false);
  });

  it("reports failure (without hanging) when the menu never opens", async () => {
    const el = document.createElement("input");
    el.setAttribute("role", "combobox");
    el.setAttribute("aria-expanded", "false");
    document.body.append(el); // connected but inert — no listbox ever appears
    const res = await fillAriaCombobox(el, "Canada", fast);
    expect(res.filled).toBe(false);
  });
});

describe("readComboboxOptions", () => {
  it("reads options from a mounted listbox without opening", () => {
    const el = staticCombobox(["United States", "Canada", "Mexico"]);
    expect(readComboboxOptions(el)).toEqual(["United States", "Canada", "Mexico"]);
    expect(el.getAttribute("aria-expanded")).toBe("false"); // never opened
  });

  it("reads options even when the listbox is hidden", () => {
    const el = staticCombobox(["A", "B"], { hidden: true });
    expect(readComboboxOptions(el)).toEqual(["A", "B"]);
  });

  it("returns undefined when the menu is not mounted (react-select, closed)", () => {
    const el = reactSelect(["A", "B"]); // listbox only renders on open
    expect(readComboboxOptions(el)).toBeUndefined();
    expect(el.getAttribute("aria-expanded")).toBe("false");
  });

  it("skips aria-disabled options", () => {
    const el = staticCombobox(["A", "B"]);
    el.ownerDocument.querySelectorAll('[role="option"]')[1].setAttribute("aria-disabled", "true");
    expect(readComboboxOptions(el)).toEqual(["A"]);
  });
});

describe("readComboboxValue", () => {
  it("reads a committed single-value", () => {
    const el = staticCombobox(["A", "B"], { value: "B" });
    expect(readComboboxValue(el)).toBe("B");
  });

  it("ignores a button placeholder (no real selection)", () => {
    const btn = buttonListbox(["A", "B"]); // textContent is the 'Select…' placeholder
    expect(readComboboxValue(btn)).toBeUndefined();
  });

  it("returns undefined when nothing is selected", () => {
    const el = staticCombobox(["A", "B"]);
    expect(readComboboxValue(el)).toBeUndefined();
  });
});
