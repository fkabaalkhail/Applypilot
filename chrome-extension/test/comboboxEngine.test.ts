import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  fillAriaCombobox,
  harvestComboboxOptions,
  isAriaCombobox,
  readComboboxOptions,
  readComboboxValue,
} from "../src/content/comboboxEngine";
import { stubLayout } from "./helpers/layout";

const instant = async (): Promise<void> => {};
/** Deterministic, fast options for the engine's bounded polling. */
const fast = { sleep: instant, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

// The engine now requires a rendered box (getClientRects) before it trusts a
// listbox — a hidden-subtree listbox (e.g. a closed dial-code picker) must never
// be driven. jsdom has no layout, so give elements real boxes like a browser.
let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = stubLayout();
});
afterAll(() => restoreLayout());

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

/** A SuccessFactors rcmpaginatedselect: an <input role=combobox aria-owns=…>
 *  that opens a <ul role=listbox><li role=option><a> on click and, on select,
 *  commits the label into the input's `title` (NOT its value — SF leaves the
 *  "No Selection" placeholder in place). Reproduces the "didn't stick" false
 *  negative. */
function sfPicklist(options: string[]): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.placeholder = "No Selection";
  const lbId = `sf-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-owns", lbId);
  document.body.append(input);

  input.addEventListener("click", () => {
    if (input.getAttribute("aria-expanded") === "true") return;
    input.setAttribute("aria-expanded", "true");
    const lb = document.createElement("ul");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    for (const label of options) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      const a = document.createElement("a");
      a.setAttribute("role", "menuitem");
      a.textContent = label;
      li.append(a);
      li.addEventListener("click", () => {
        input.setAttribute("title", label); // SF commits into title, not value
        input.setAttribute("aria-expanded", "false");
        lb.remove();
      });
      lb.append(li);
    }
    document.body.append(lb);
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

describe("fillAriaCombobox tolerates a slow commit", () => {
  it("accepts a value that paints only after several poll cycles", async () => {
    const control = document.createElement("div");
    control.className = "select__control";
    const single = document.createElement("div");
    single.className = "select__single-value";
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "lb-slow");
    control.append(single, input);
    document.body.append(control);

    let paintPending = false;
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      if (document.getElementById("lb-slow")) return;
      const lb = document.createElement("div");
      lb.id = "lb-slow";
      lb.setAttribute("role", "listbox");
      for (const label of ["Canada", "United States"]) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = label;
        o.addEventListener("mousedown", () => {
          input.setAttribute("aria-expanded", "false");
          lb.remove();
          paintPending = true; // committed, but the value hasn't painted yet
        });
        lb.append(o);
      }
      control.append(lb);
    });

    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps++;
      if (paintPending && sleeps >= 4) single.textContent = "Canada"; // late paint
    };
    const res = await fillAriaCombobox(input, "Canada", { sleep, openWaitMs: 100, commitWaitMs: 100, pollMs: 10 });
    expect(res.filled).toBe(true);
    expect(sleeps).toBeGreaterThanOrEqual(4); // it actually waited for the paint
  });
});

describe("harvestComboboxOptions avoids cross-dropdown contamination", () => {
  it("reads THIS widget's own menu, not a stale body-portaled one", async () => {
    // A stale, visible listbox from another widget, portaled to <body>.
    const stale = document.createElement("div");
    stale.setAttribute("role", "listbox");
    for (const t of ["Yes", "No"]) {
      const o = document.createElement("div");
      o.setAttribute("role", "option");
      o.textContent = t;
      stale.append(o);
    }
    document.body.append(stale);

    // Our widget: NO aria-controls; its menu mounts inside its own .select wrapper.
    const wrap = document.createElement("div");
    wrap.className = "select";
    const trigger = document.createElement("div");
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.tabIndex = 0;
    wrap.append(trigger);
    document.body.append(wrap);
    trigger.addEventListener("mousedown", () => {
      trigger.setAttribute("aria-expanded", "true");
      if (wrap.querySelector('[role="listbox"]')) return;
      const lb = document.createElement("div");
      lb.setAttribute("role", "listbox");
      for (const t of ["Engineering", "Sales"]) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = t;
        lb.append(o);
      }
      wrap.append(lb);
    });

    const opts = await harvestComboboxOptions(trigger, { sleep: instant, openWaitMs: 100, pollMs: 10 });
    expect(opts).toEqual(["Engineering", "Sales"]);
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

/** A citizenship combobox whose listbox is mounted up front and opens on click;
 *  each option commits its label into the input and collapses on click. Used to
 *  exercise the no-match option harvest. (Reuses the module-level `fast` opts.) */
function citizenshipCombobox(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "lb-cit");
  const lb = document.createElement("div");
  lb.id = "lb-cit";
  lb.setAttribute("role", "listbox");
  for (const label of ["Canadian", "American", "Other"]) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    o.addEventListener("click", () => {
      input.value = label;
      input.setAttribute("aria-expanded", "false");
    });
    lb.append(o);
  }
  input.addEventListener("click", () => input.setAttribute("aria-expanded", "true"));
  wrap.append(input, lb);
  document.body.append(wrap);
  return input;
}

describe("fillAriaCombobox — option harvest on miss", () => {
  it("returns the real options when no option matches the value", async () => {
    const trigger = citizenshipCombobox();
    const res = await fillAriaCombobox(trigger, "Netherlands", fast);
    expect(res.filled).toBe(false);
    expect(res.options).toEqual(["Canadian", "American", "Other"]);
  });

  it("still fills when the (snapped) answer matches, and returns no options", async () => {
    const trigger = citizenshipCombobox();
    const res = await fillAriaCombobox(trigger, "Canadian", fast);
    expect(res.filled).toBe(true);
    expect(res.options).toBeUndefined();
  });
});

describe("fillAriaCombobox — never drives another widget's listbox (dial-code regression)", () => {
  /** A decoy dial-code picker à la intl-tel-input: its own trigger + a mounted
   *  listbox full of countries, all inside one widget container. */
  function itiDecoy(opts: { hidden?: boolean } = {}): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "iti__country-container";
    const btn = document.createElement("button");
    btn.setAttribute("aria-haspopup", "dialog");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const lb = document.createElement("ul");
    lb.setAttribute("role", "listbox");
    for (const label of ["United States +1", "Canada +1", "Mexico +52"]) {
      const o = document.createElement("li");
      o.setAttribute("role", "option");
      o.textContent = label;
      lb.append(o);
    }
    dialog.append(lb);
    wrap.append(btn, dialog);
    document.body.append(wrap);
    if (opts.hidden) {
      for (const el of [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>("*"))]) {
        el.getClientRects = () => [] as unknown as DOMRectList;
      }
    }
    return wrap;
  }

  it("ignores a VISIBLE foreign listbox when our menu never opens", async () => {
    itiDecoy();
    // A broken combobox that never mounts its own menu.
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "never-mounts");
    document.body.append(input);
    const res = await fillAriaCombobox(input, "Canada", fast);
    expect(res.filled).toBe(false);
    // Crucially: the decoy's options must NOT be harvested as this field's options.
    expect(res.options).toBeUndefined();
  });

  it("ignores a HIDDEN foreign listbox (closed dial-code dialog)", async () => {
    itiDecoy({ hidden: true });
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "never-mounts-2");
    document.body.append(input);
    const res = await fillAriaCombobox(input, "Canada", fast);
    expect(res.filled).toBe(false);
    expect(res.options).toBeUndefined();
  });
});

describe("fillAriaCombobox — commit honesty", () => {
  it("reports failure when the click commits nothing, even though the menu closed", async () => {
    // A widget whose option click closes the menu but never writes a value —
    // previously reported as filled because "collapsed" counted as committed.
    const control = document.createElement("div");
    control.className = "select__control";
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    const lbId = "lb-deadclick";
    input.setAttribute("aria-controls", lbId);
    control.append(input);
    document.body.append(control);
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      if (document.getElementById(lbId)) return;
      const lb = document.createElement("div");
      lb.id = lbId;
      lb.setAttribute("role", "listbox");
      const o = document.createElement("div");
      o.setAttribute("role", "option");
      o.textContent = "Canada";
      o.addEventListener("mousedown", () => {
        input.setAttribute("aria-expanded", "false");
        lb.remove(); // closes without committing anything
      });
      lb.append(o);
      document.body.append(lb);
    });
    const res = await fillAriaCombobox(input, "Canada", fast);
    expect(res.filled).toBe(false);
    expect(res.reason).toMatch(/didn't stick/i);
  });
});

describe("fillAriaCombobox — over-filter recovery", () => {
  it("clears the typed filter and matches on the full list when filtering yields nothing", async () => {
    // Substring-filtering widget: "I am not a protected veteran" filters the
    // list to zero options; the engine must clear the text and match the full
    // list by tokens ("No, I am not a veteran").
    const OPTIONS = ["Yes, I am a veteran", "No, I am not a veteran", "I don't wish to answer"];
    const control = document.createElement("div");
    control.className = "select__control";
    const single = document.createElement("div");
    single.className = "select__single-value";
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    const lbId = "lb-filter";
    input.setAttribute("aria-controls", lbId);
    control.append(single, input);
    document.body.append(control);

    const render = (): void => {
      document.getElementById(lbId)?.remove();
      if (input.getAttribute("aria-expanded") !== "true") return;
      const filter = input.value.toLowerCase();
      const lb = document.createElement("div");
      lb.id = lbId;
      lb.setAttribute("role", "listbox");
      for (const label of OPTIONS.filter((l) => l.toLowerCase().includes(filter))) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = label;
        o.addEventListener("mousedown", () => {
          single.textContent = label;
          input.value = "";
          input.setAttribute("aria-expanded", "false");
          lb.remove();
        });
        lb.append(o);
      }
      if (lb.children.length === 0) lb.remove(); // "No options" state
      else document.body.append(lb);
    };
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      render();
    });
    input.addEventListener("input", render);

    const res = await fillAriaCombobox(input, "I am not a protected veteran", fast);
    expect(res.filled).toBe(true);
    expect(single.textContent).toBe("No, I am not a veteran");
  });
});

describe("harvestComboboxOptions", () => {
  it("briefly opens a lazy widget, returns its options, selects nothing, and closes it", async () => {
    const { harvestComboboxOptions } = await import("../src/content/comboboxEngine");
    const trigger = reactSelect(["Yes", "No", "I don't wish to answer"]);
    const options = await harvestComboboxOptions(trigger, fast);
    expect(options).toEqual(["Yes", "No", "I don't wish to answer"]);
    // Nothing selected, menu closed again (Escape path in the fixture).
    const single = document.querySelector(".select__single-value");
    expect(single?.textContent ?? "").toBe("");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reads a mounted listbox without opening anything", async () => {
    const { harvestComboboxOptions } = await import("../src/content/comboboxEngine");
    const trigger = staticCombobox(["A", "B"]);
    const options = await harvestComboboxOptions(trigger, fast);
    expect(options).toEqual(["A", "B"]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("returns undefined when no listbox ever appears", async () => {
    const { harvestComboboxOptions } = await import("../src/content/comboboxEngine");
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "never");
    document.body.append(input);
    expect(await harvestComboboxOptions(input, fast)).toBeUndefined();
  });
});

describe("SuccessFactors rcmpaginatedselect (commits via title)", () => {
  it("counts a selection as filled when the widget shows it in `title`, not value", async () => {
    const input = sfPicklist([
      "No Selection",
      "Asian (not Hispanic or Latino)",
      "White (not Hispanic or Latino)",
      "Decline to self-identify",
    ]);
    const res = await fillAriaCombobox(input, "Asian", fast);
    expect(res.filled).toBe(true);
    expect(input.getAttribute("title")).toBe("Asian (not Hispanic or Latino)");
  });

  it("still fails cleanly (not a false positive) when no option matches", async () => {
    const input = sfPicklist(["Male", "Female", "Decline to self-identify"]);
    const res = await fillAriaCombobox(input, "Nonbinary", fast);
    expect(res.filled).toBe(false);
    // the diagnostic reason now names what the listbox actually offered
    expect(res.reason).toContain("saw:");
    expect(res.reason).toContain("Male");
  });

  it("reads its OWN aria-owns'd listbox, never a lingering neighbour's", async () => {
    // A previous field's menu is still open (gender: Male/Female) while we fill
    // race — whose own listbox mounts a beat later. The engine must wait for
    // race's declared listbox, not grab the visible gender one (the SF bug).
    const genderInput = document.createElement("input");
    genderInput.setAttribute("role", "combobox");
    genderInput.setAttribute("aria-owns", "gender-lb");
    genderInput.setAttribute("aria-expanded", "true");
    document.body.append(genderInput);
    const genderLb = document.createElement("ul");
    genderLb.id = "gender-lb";
    genderLb.setAttribute("role", "listbox");
    for (const label of ["No Selection", "Female", "Male", "I decline to provide this information"]) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = label;
      genderLb.append(li);
    }
    document.body.append(genderLb);

    // Race: its listbox mounts asynchronously on open (after gender's is visible).
    const raceInput = document.createElement("input");
    raceInput.type = "text";
    raceInput.setAttribute("role", "combobox");
    raceInput.setAttribute("aria-owns", "race-lb");
    raceInput.setAttribute("aria-expanded", "false");
    raceInput.placeholder = "No Selection";
    document.body.append(raceInput);
    let clicked = "";
    raceInput.addEventListener("click", () => {
      raceInput.setAttribute("aria-expanded", "true");
      setTimeout(() => {
        const lb = document.createElement("ul");
        lb.id = "race-lb";
        lb.setAttribute("role", "listbox");
        for (const label of ["No Selection", "Asian (not Hispanic or Latino)", "White (not Hispanic or Latino)"]) {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.textContent = label;
          li.addEventListener("click", () => {
            clicked = label;
            raceInput.setAttribute("title", label);
          });
          lb.append(li);
        }
        document.body.append(lb);
      }, 5);
    });

    // Use a real (tiny) sleep so the async listbox actually mounts while polling.
    const res = await fillAriaCombobox(raceInput, "Asian", {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      openWaitMs: 200,
      commitWaitMs: 200,
      pollMs: 10,
    });
    expect(clicked).toContain("Asian"); // clicked race's option, not gender's
    expect(res.filled).toBe(true);
  });
});

describe("multi-select combobox (skills / tags)", () => {
  /** A react-select-style multi-select: aria-multiselectable input; selecting an
   *  option adds a chip and removes it from the open menu (menu stays open). */
  function multiSelect(options: string[]) {
    const control = document.createElement("div");
    control.className = "select__control select__value-container--is-multi";
    const chipsBox = document.createElement("div");
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-multiselectable", "true");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    const lbId = `mlb-${Math.random().toString(36).slice(2)}`;
    input.setAttribute("aria-controls", lbId);
    control.append(chipsBox, input);
    document.body.append(control);
    const render = (): void => {
      if (input.getAttribute("aria-expanded") !== "true") return;
      if (document.getElementById(lbId)) return;
      const lb = document.createElement("div");
      lb.id = lbId;
      lb.setAttribute("role", "listbox");
      for (const label of options) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = label;
        o.addEventListener("mousedown", () => {
          const chip = document.createElement("div");
          chip.className = "select__multi-value";
          chip.textContent = label;
          chipsBox.append(chip);
          input.value = "";
          o.remove(); // remove from the still-open menu
        });
        lb.append(o);
      }
      control.append(lb);
    };
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      render();
    });
    return { input, chips: () => Array.from(chipsBox.querySelectorAll(".select__multi-value")).map((c) => c.textContent) };
  }

  it("adds each item of a multi-select value as its own chip", async () => {
    const { input, chips } = multiSelect(["Python", "Java", "TypeScript", "Go"]);
    const res = await fillAriaCombobox(input, "Python, Java, TypeScript", fast);
    expect(res.filled).toBe(true);
    expect(chips().sort()).toEqual(["Java", "Python", "TypeScript"]);
  });

  it("reports success even if one item has no matching option", async () => {
    const { input, chips } = multiSelect(["Python", "Java"]);
    const res = await fillAriaCombobox(input, "Python, Rust", fast);
    expect(res.filled).toBe(true); // Python added
    expect(chips()).toEqual(["Python"]);
    expect(res.reason).toContain("Rust");
  });
});

describe("fillAriaCombobox — async type-to-filter (paginated picklists)", () => {
  /** An SF-style paginated picklist: mounts page 1 (alphabetical) on open; the
   *  target option only appears after the filter text is typed, and the
   *  filtered options arrive ASYNCHRONOUSLY (server round-trip). Commits the
   *  choice into the input's `title`, like SF's rcmpaginatedselect. */
  function paginatedPicklist(
    firstPage: string[],
    filtered: Record<string, string[]>
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    const lbId = `pp-${Math.random().toString(36).slice(2)}`;
    input.setAttribute("aria-owns", lbId);
    document.body.append(input);

    const renderOptions = (labels: string[]): void => {
      const lb = document.getElementById(lbId);
      if (!lb) return;
      lb.textContent = "";
      for (const label of labels) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = label;
        li.addEventListener("click", () => {
          input.setAttribute("title", label);
          input.setAttribute("aria-expanded", "false");
          lb.remove();
        });
        lb.append(li);
      }
    };

    input.addEventListener("click", () => {
      if (input.getAttribute("aria-expanded") === "true") return;
      input.setAttribute("aria-expanded", "true");
      const lb = document.createElement("ul");
      lb.id = lbId;
      lb.setAttribute("role", "listbox");
      document.body.append(lb);
      renderOptions(firstPage);
    });
    // The filter runs on keyup (like SAP) and repopulates a beat later (server).
    input.addEventListener("keyup", () => {
      const q = input.value.trim();
      setTimeout(() => renderOptions(q ? filtered[q] ?? [] : firstPage), 10);
    });
    return input;
  }

  it("polls past the stale page-1 list for asynchronously filtered options", async () => {
    const input = paginatedPicklist(
      ["No Selection", "Aarhus", "Abaco", "Abidjan"],
      { Quebec: ["Quebec", "Quebec City"] }
    );
    // real timers so the async repopulate is observed
    const res = await fillAriaCombobox(input, "Quebec", { openWaitMs: 500, commitWaitMs: 300, pollMs: 20 });
    expect(res.filled).toBe(true);
    expect(input.getAttribute("title")).toBe("Quebec");
  });

  it("restores the typed filter text when the selection never commits", async () => {
    // Typing surfaces a clickable option, but the widget never commits a value —
    // the typed filter must not remain in the field, where it reads as an answer.
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    const lbId = "inert-lb";
    input.setAttribute("aria-owns", lbId);
    document.body.append(input);
    input.addEventListener("click", () => {
      input.setAttribute("aria-expanded", "true");
      if (!document.getElementById(lbId)) {
        const lb = document.createElement("ul");
        lb.id = lbId;
        lb.setAttribute("role", "listbox");
        document.body.append(lb);
      }
    });
    input.addEventListener("keyup", () => {
      const lb = document.getElementById(lbId);
      if (!lb) return;
      lb.textContent = "";
      if (input.value === "Quebec") {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = "Quebec";
        lb.append(li); // clicking it does nothing — the commit never happens
      }
    });
    const res = await fillAriaCombobox(input, "Quebec", { openWaitMs: 300, commitWaitMs: 200, pollMs: 20 });
    expect(res.filled).toBe(false);
    expect(input.value).toBe(""); // typed filter cleaned up, not left as an "answer"
  });
});

describe("fillAriaCombobox — Workday multiselect (Type to Add Skills)", () => {
  /** Workday's skills widget: input inside a multiselectInputContainer, server
   *  suggestions arrive async after typing ("No Items." when nothing matches),
   *  each selection becomes a chip and clears the input. */
  function workdaySkills(catalog: string[]): { input: HTMLInputElement; chips: () => (string | null)[] } {
    const container = document.createElement("div");
    container.setAttribute("data-automation-id", "multiselectInputContainer");
    const chipsBox = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    const lbId = `wd-${Math.random().toString(36).slice(2)}`;
    input.setAttribute("aria-controls", lbId);
    container.append(chipsBox, input);
    document.body.append(container);

    input.addEventListener("keyup", () => {
      setTimeout(() => {
        let lb = document.getElementById(lbId);
        if (!lb) {
          lb = document.createElement("div");
          lb.id = lbId;
          lb.setAttribute("role", "listbox");
          document.body.append(lb);
        }
        lb.textContent = "";
        const q = input.value.trim().toLowerCase();
        const hits = q ? catalog.filter((s) => s.toLowerCase().includes(q)) : [];
        for (const label of hits.length ? hits : ["No Items."]) {
          const o = document.createElement("div");
          o.setAttribute("role", "option");
          o.textContent = label;
          if (label !== "No Items.") {
            o.addEventListener("click", () => {
              const chip = document.createElement("span");
              chip.className = "chip";
              chip.setAttribute("data-automation-id", "selectedItem");
              chip.textContent = label;
              chipsBox.append(chip);
              input.value = "";
              input.setAttribute("aria-expanded", "false");
              document.getElementById(lbId)?.remove();
            });
          }
          lb.append(o);
        }
      }, 10);
    });
    return {
      input,
      chips: () => Array.from(chipsBox.querySelectorAll(".chip")).map((c) => c.textContent),
    };
  }

  it("detects multi via the automation id and adds one chip per skill", async () => {
    const { input, chips } = workdaySkills(["Python", "Java", "TypeScript"]);
    const res = await fillAriaCombobox(input, "Python, Java", { openWaitMs: 200, commitWaitMs: 300, pollMs: 20 });
    expect(res.filled).toBe(true);
    expect(chips().sort()).toEqual(["Java", "Python"]);
  });

  it("skips skills the catalog doesn't offer and leaves no typed residue", async () => {
    const { input, chips } = workdaySkills(["Python"]);
    const res = await fillAriaCombobox(input, "Python, COBOL", { openWaitMs: 200, commitWaitMs: 300, pollMs: 20 });
    expect(res.filled).toBe(true);
    expect(chips()).toEqual(["Python"]);
    expect(input.value).toBe(""); // the unmatched "COBOL" isn't left in the box
  });
});

describe("fillAriaCombobox — no dead-time on settled filters", () => {
  it("gives up quickly once a filtering widget settles with no match", async () => {
    // A synchronous keyup filter over options that never contain the target:
    // each typed attempt settles immediately, so the engine must NOT burn the
    // full per-attempt budget re-polling a list that already gave its final
    // answer — that dead time is what reads as "types text, stares, erases it".
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    const lbId = "settle-lb";
    input.setAttribute("aria-owns", lbId);
    document.body.append(input);
    const renderOptions = (labels: string[]): void => {
      const lb = document.getElementById(lbId);
      if (!lb) return;
      lb.textContent = "";
      for (const label of labels) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = label;
        lb.append(li);
      }
    };
    input.addEventListener("click", () => {
      input.setAttribute("aria-expanded", "true");
      if (!document.getElementById(lbId)) {
        const lb = document.createElement("ul");
        lb.id = lbId;
        lb.setAttribute("role", "listbox");
        document.body.append(lb);
        renderOptions(["Alpha", "Beta"]);
      }
    });
    input.addEventListener("keyup", () => {
      const q = input.value.trim().toLowerCase();
      renderOptions(["Alpha", "Beta"].filter((o) => o.toLowerCase().includes(q)));
    });

    let sleeps = 0;
    const res = await fillAriaCombobox(input, "Zorp", {
      sleep: async () => {
        sleeps++;
      },
      openWaitMs: 200,
      commitWaitMs: 200,
      pollMs: 10,
    });
    expect(res.filled).toBe(false);
    // Budget-burning behavior would be ~40+ polls (2 attempts × 20); settled
    // early-exits keep the whole failure fast.
    expect(sleeps).toBeLessThan(25);
  });
});
