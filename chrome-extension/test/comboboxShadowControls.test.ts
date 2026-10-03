/**
 * SmartRecruiters' one-click apply UI is Lit web components: the City input
 * lives in <spl-input>'s shadow root, while the listbox its aria-controls names
 * lives in the PARENT <spl-autocomplete>'s shadow root. The combobox engine
 * resolved aria-controls with document.getElementById, which cannot see into
 * any shadow root, so it never found the menu and City stayed empty (live run,
 * 2026-10-03). Ids must resolve through the trigger's own root and its
 * ancestors' roots, the way the browser's accessibility tree pairs them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

function mountSplAutocomplete(): { input: HTMLInputElement; picked: () => string } {
  document.body.innerHTML = "";
  const outerHost = document.createElement("spl-autocomplete");
  document.body.append(outerHost);
  const outer = outerHost.attachShadow({ mode: "open" });
  const innerHost = document.createElement("spl-input");
  outer.append(innerHost);
  const menu = document.createElement("div");
  menu.id = "menu-spl-form-element_10";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  outer.append(menu);
  const inner = innerHost.attachShadow({ mode: "open" });
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "menu-spl-form-element_10");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  inner.append(input);
  let chosen = "";
  input.addEventListener("input", () => {
    menu.innerHTML = "";
    if (!input.value) return;
    for (const city of ["Toronto, Ontario, Canada", "Toronto, OH, United States"]) {
      if (!city.toLowerCase().startsWith(input.value.toLowerCase().slice(0, 4))) continue;
      const opt = document.createElement("div");
      opt.setAttribute("role", "option");
      opt.textContent = city;
      opt.addEventListener("click", () => {
        chosen = city;
        input.value = city;
        input.setAttribute("aria-expanded", "false");
        menu.hidden = true;
      });
      menu.append(opt);
    }
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
  });
  return { input, picked: () => chosen };
}

describe("comboboxEngine: aria-controls across shadow roots", () => {
  it("finds a listbox that lives in the parent component's shadow root", async () => {
    const { input, picked } = mountSplAutocomplete();
    const r = await fillAriaCombobox(input, "Toronto, Ontario, Canada", { sleep: async () => {}, openWaitMs: 100, commitWaitMs: 100, pollMs: 5 });
    expect(r.reason ?? "").toBe("");
    expect(r.filled).toBe(true);
    expect(picked()).toBe("Toronto, Ontario, Canada");
  });
});

/**
 * SmartRecruiters' option elements are `div[role=option]` inside each
 * <spl-dropdown-item>'s shadow root, and their text arrives through a <slot>:
 * it is the host's light-DOM text, projected in. textContent of the option is
 * EMPTY, so the engine saw a listbox of blank options ("listbox had no
 * options") and City stayed blank (live, 2026-10-03).
 */
describe("comboboxEngine: option text projected through <slot>", () => {
  function mountSlottedOptions(): { input: HTMLInputElement; picked: () => string } {
    document.body.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "menu-slots");
    input.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.id = "menu-slots";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    document.body.append(input, menu);
    let chosen = "";
    input.addEventListener("input", () => {
      menu.innerHTML = "";
      for (const city of ["Toronto, ON, Canada", "Toronto, OH, USA"]) {
        const item = document.createElement("spl-dropdown-item");
        item.textContent = city; // light DOM text, projected by the slot below
        const sr = item.attachShadow({ mode: "open" });
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.append(document.createElement("slot"));
        sr.append(opt);
        opt.addEventListener("click", () => {
          chosen = city;
          input.value = city;
          menu.hidden = true;
          input.setAttribute("aria-expanded", "false");
        });
        menu.append(item);
      }
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
    });
    return { input, picked: () => chosen };
  }

  it("reads the slotted text and picks the right option", async () => {
    const { input, picked } = mountSlottedOptions();
    const r = await fillAriaCombobox(input, "Toronto, ON, Canada", { sleep: async () => {}, openWaitMs: 100, commitWaitMs: 100, pollMs: 5 });
    expect(r.reason ?? "").toBe("");
    expect(picked()).toBe("Toronto, ON, Canada");
  });
});

/**
 * SmartRecruiters, live: the listbox is a div in <spl-dropdown>'s shadow root
 * that holds only a <slot>; the items are the dropdown's LIGHT-DOM children,
 * projected into it, each with its role=option node in its own shadow root.
 */
describe("comboboxEngine: options slotted into a shadow-DOM listbox", () => {
  it("finds and picks options that are projected, not descendants", async () => {
    document.body.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "menu-x");
    input.setAttribute("aria-expanded", "false");
    // spl-autocomplete's shadow root holds spl-input (the input, in its own
    // root) and spl-dropdown (the menu, in ITS own root): siblings.
    const auto = document.createElement("spl-autocomplete");
    document.body.append(auto);
    const asr = auto.attachShadow({ mode: "open" });
    const splInput = document.createElement("spl-input");
    splInput.attachShadow({ mode: "open" }).append(input);
    const dropdown = document.createElement("spl-dropdown");
    const dsr = dropdown.attachShadow({ mode: "open" });
    const menu = document.createElement("div");
    menu.id = "menu-x";
    menu.setAttribute("role", "listbox");
    menu.append(document.createElement("slot"));
    dsr.append(menu);
    asr.append(splInput, dropdown);
    let chosen = "";
    input.addEventListener("input", () => {
      dropdown.innerHTML = "";
      for (const city of ["Toronto, ON, Canada", "Toronto, OH, USA"]) {
        const item = document.createElement("spl-dropdown-item");
        item.textContent = city;
        const isr = item.attachShadow({ mode: "open" });
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.append(document.createElement("slot"));
        isr.append(opt);
        opt.addEventListener("click", () => {
          chosen = city;
          input.value = city;
          input.setAttribute("aria-expanded", "false");
        });
        dropdown.append(item);
      }
      input.setAttribute("aria-expanded", "true");
    });
    const r = await fillAriaCombobox(input, "Toronto, ON, Canada", { sleep: async () => {}, openWaitMs: 100, commitWaitMs: 100, pollMs: 5 });
    expect(r.reason ?? "").toBe("");
    expect(chosen).toBe("Toronto, ON, Canada");
  });
});

/**
 * Place suggestions are chosen as places. With value "Toronto" all three
 * Torontos tie; with the full place, token overlap used to rank "Toronto, OH,
 * US" as a PERFECT match (its only long token is "toronto"). SmartRecruiters
 * lists exactly these (live 2026-10-03).
 */
describe("comboboxEngine: placeHint picks the applicant's place", () => {
  function mountCities(): { input: HTMLInputElement; picked: () => string } {
    document.body.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "cities");
    input.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.id = "cities";
    menu.setAttribute("role", "listbox");
    document.body.append(input, menu);
    let chosen = "";
    input.addEventListener("input", () => {
      menu.innerHTML = "";
      if (!input.value) return;
      for (const c of ["Toronto, OH, US", "Toronto, Ontario, Canada", "Toronto, New South Wales, Australia"]) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = c;
        o.addEventListener("click", () => {
          chosen = c;
          input.value = c;
          input.setAttribute("aria-expanded", "false");
          menu.innerHTML = "";
        });
        menu.append(o);
      }
      input.setAttribute("aria-expanded", "true");
    });
    return { input, picked: () => chosen };
  }
  const fast = { sleep: async () => {}, openWaitMs: 100, commitWaitMs: 100, pollMs: 5 };

  it("picks Toronto, Ontario for a Toronto, ON, Canada applicant", async () => {
    const { input, picked } = mountCities();
    const r = await fillAriaCombobox(input, "Toronto", { ...fast, placeHint: "Toronto, ON, Canada" });
    expect(r.filled).toBe(true);
    expect(picked()).toBe("Toronto, Ontario, Canada");
  });

  it("without a hint, three Torontos are ambiguous: nothing is picked", async () => {
    const { input, picked } = mountCities();
    const r = await fillAriaCombobox(input, "Toronto", fast);
    expect(r.filled).toBe(false);
    expect(picked()).toBe("");
  });
});
