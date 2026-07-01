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

/**
 * A faithful real-Workday large dropdown (e.g. Country): the button opens a
 * portaled popup containing a SEPARATE, auto-focused search box and a
 * VIRTUALIZED listbox that only renders options matching the current search
 * text. The target option is absent from the DOM until the user types — which
 * is exactly what defeats a filler that only types into the trigger.
 */
function searchableButtonListbox(
  options: string[],
  opts: { initialRender?: number } = {}
): HTMLButtonElement {
  const initialRender = opts.initialRender ?? 0; // Workday renders none until typed
  const btn = document.createElement("button");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "Select One";
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  btn.setAttribute("aria-controls", lbId);
  document.body.append(btn);

  let popup: HTMLDivElement | null = null;
  let lb: HTMLDivElement | null = null;
  let search: HTMLInputElement | null = null;

  const renderOptions = (filter: string): void => {
    if (!lb) return;
    lb.innerHTML = "";
    const q = filter.trim().toLowerCase();
    const matches = q
      ? options.filter((o) => o.toLowerCase().includes(q))
      : options.slice(0, initialRender); // virtualized: only a prefix when unfiltered
    for (const label of matches) {
      const o = document.createElement("div");
      o.setAttribute("role", "option");
      o.textContent = label;
      o.addEventListener("click", () => {
        btn.textContent = label;
        btn.setAttribute("aria-expanded", "false");
        popup?.remove();
        popup = lb = search = null;
      });
      lb.append(o);
    }
  };

  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") return;
    btn.setAttribute("aria-expanded", "true");
    popup = document.createElement("div");
    popup.className = "wd-popup"; // matches findSearchInput's popup scope
    search = document.createElement("input");
    search.type = "text";
    search.setAttribute("aria-autocomplete", "list");
    search.addEventListener("input", () => renderOptions(search!.value));
    lb = document.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    popup.append(search, lb);
    document.body.append(popup); // Workday portals the popup to the body
    renderOptions("");
    search.focus(); // Workday auto-focuses the search box on open
  });

  // Dismiss like a real widget: Escape on the trigger, or a pointer-down outside.
  const dismiss = (): void => {
    if (btn.getAttribute("aria-expanded") !== "true") return;
    btn.setAttribute("aria-expanded", "false");
    popup?.remove();
    popup = lb = search = null;
  };
  btn.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") dismiss();
  });
  document.body.addEventListener("mousedown", (e) => {
    if (popup && !popup.contains(e.target as Node) && e.target !== btn) dismiss();
  });
  return btn;
}

/**
 * A keyboard-only listbox: options render but clicking them does NOT commit
 * (as with a virtualized list whose click target is intercepted). Selection is
 * possible only by ArrowDown (moving aria-activedescendant) then Enter — exactly
 * the path the keyboard fallback must cover.
 */
function keyboardOnlyListbox(options: string[]): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "Select…";
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  btn.setAttribute("aria-controls", lbId);
  document.body.append(btn);
  const ids = options.map((_, i) => `${lbId}-opt-${i}`);
  let active = -1;

  const ensureOpen = (): void => {
    if (btn.getAttribute("aria-expanded") === "true") return;
    btn.setAttribute("aria-expanded", "true");
    const lb = document.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    options.forEach((label, i) => {
      const o = document.createElement("div");
      o.id = ids[i];
      o.setAttribute("role", "option");
      o.setAttribute("aria-selected", "false");
      o.textContent = label;
      // No click handler: clicking never commits (keyboard-only widget).
      lb.append(o);
    });
    document.body.append(lb);
  };

  btn.addEventListener("click", ensureOpen);
  btn.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    ensureOpen();
    const lb = document.getElementById(lbId);
    if (!lb) return;
    if (ke.key === "ArrowDown") {
      active = Math.min(active + 1, options.length - 1);
      btn.setAttribute("aria-activedescendant", ids[active]);
      lb.querySelectorAll('[role="option"]').forEach((o, i) =>
        o.setAttribute("aria-selected", i === active ? "true" : "false")
      );
    } else if (ke.key === "Enter" && active >= 0) {
      btn.textContent = options[active];
      btn.setAttribute("aria-expanded", "false");
      btn.removeAttribute("aria-activedescendant");
      lb.remove();
    }
  });
  return btn;
}

describe("fillAriaCombobox — keyboard fallback", () => {
  it("selects via ArrowDown+Enter when the option cannot be clicked", async () => {
    const btn = keyboardOnlyListbox(["United States", "Canada", "Mexico"]);
    const res = await fillAriaCombobox(btn, "Canada", fast);
    expect(res.filled).toBe(true);
    expect(btn.textContent).toBe("Canada");
  });
});

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

describe("fillAriaCombobox — Workday searchable/virtualized dropdown", () => {
  // ~200 countries; the target isn't rendered until the search box is typed in.
  const COUNTRIES = ["Afghanistan", "Canada", "Germany", "Mexico", "United Kingdom", "United States"];

  it("types into the popup search box to surface a virtualized option", async () => {
    const btn = searchableButtonListbox(COUNTRIES); // initialRender: 0 — nothing shown until typed
    const res = await fillAriaCombobox(btn, "United States", fast);
    expect(res.filled).toBe(true);
    expect(btn.textContent).toBe("United States");
  });

  it("still works when a prefix of options is pre-rendered but the target is not", async () => {
    const btn = searchableButtonListbox(COUNTRIES, { initialRender: 3 }); // shows first 3, not the target
    const res = await fillAriaCombobox(btn, "United States", fast);
    expect(res.filled).toBe(true);
    expect(btn.textContent).toBe("United States");
  });

  it("resolves a full location string by retrying with coarser segments", async () => {
    const btn = searchableButtonListbox(COUNTRIES);
    // Profile location is often "Austin, TX, United States". Typing that whole
    // string into a country search filters to zero matches — the engine must
    // fall back to a coarser segment ("United States") to surface the option.
    // (This is the "Workday country dropdown literal-match bug".)
    const res = await fillAriaCombobox(btn, "Austin, TX, United States", fast);
    expect(res.filled).toBe(true);
    expect(btn.textContent).toBe("United States");
  });

  it("resolves a 'USA' abbreviation to the 'United States' option", async () => {
    const btn = searchableButtonListbox(COUNTRIES);
    // Typing "USA" filters the list to zero (no option contains "usa"); the
    // engine must also try the alias "United States" as a search query.
    const res = await fillAriaCombobox(btn, "San Francisco, CA, USA", fast);
    expect(res.filled).toBe(true);
    expect(btn.textContent).toBe("United States");
  });

  it("reports failure and closes when the typed option truly has no match", async () => {
    const btn = searchableButtonListbox(COUNTRIES);
    const res = await fillAriaCombobox(btn, "Atlantis", fast);
    expect(res.filled).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
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
