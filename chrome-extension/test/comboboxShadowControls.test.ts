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
