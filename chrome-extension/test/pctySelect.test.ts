/**
 * Paylocity's own select (recruiting.paylocity.com, live 2026-10-05): a
 * wrapper with aria-haspopup="listbox" and aria-owns, holding a typeahead
 * <input aria-autocomplete="list"> with no role, and the choice shown in a
 * "single-value" div. Scanned as a text box, "TX" was typed into the State
 * search and the State stayed on "Select a state".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const STATES = ["Alabama", "Alaska", "Arizona", "Tennessee", "Texas", "Utah"];

/** The widget, behaving like the live one: opens on click, filters on input,
 *  commits a click into its single-value display. */
function pctySelect(opts: { lazy?: boolean } = {}): HTMLElement {
  document.body.innerHTML = `
    <form>
      <label for="st"><span>State</span>
        <div class="pcty-input-select-full-container" id="st-wrap" aria-expanded="false" aria-haspopup="listbox" aria-owns="st-list" required="">
          <div class="pcty-input-select-input-container">
            <div class="input-select-input-single-value">Select a state</div>
            <div class="pcty-input-select__input"><input aria-autocomplete="list" id="st" type="text" value=""></div>
          </div>
        </div>
      </label>
    </form>`;
  const wrap = document.getElementById("st-wrap")!;
  const input = document.getElementById("st") as HTMLInputElement;
  const display = wrap.querySelector(".input-select-input-single-value")!;
  const render = (labels: string[]): void => {
    let lb = document.getElementById("st-list");
    if (!lb) {
      lb = document.createElement("ul");
      lb.id = "st-list";
      lb.setAttribute("role", "listbox");
      document.body.append(lb);
    }
    lb.textContent = "";
    for (const label of labels) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = label;
      li.addEventListener("click", () => {
        display.textContent = label;
        input.value = "";
        wrap.setAttribute("aria-expanded", "false");
        document.getElementById("st-list")?.remove();
      });
      lb.append(li);
    }
  };
  // The whole box opens the list, like the live widget's container.
  wrap.addEventListener("click", () => {
    if (wrap.getAttribute("aria-expanded") === "true") return;
    wrap.setAttribute("aria-expanded", "true");
    render(opts.lazy ? [] : STATES);
  });
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    render(STATES.filter((s) => s.toLowerCase().includes(q)));
  });
  return wrap;
}

const person = {
  firstName: "Test", lastName: "Person", email: "test.person@example.com", phone: "512-555-0143",
  location: "Austin, TX", addressCity: "Austin", addressState: "TX", country: "United States",
  skills: [], education: [], experience: [],
} as unknown as UserApplicationProfile;

describe("Paylocity's select", () => {
  it("is ONE dropdown, answered with the state's name, its search box no field of its own", () => {
    pctySelect();
    const states = scanPage(person, false, null).fields.filter((x) => x.category === "addressState");
    expect(states.map((x) => x.controlType)).toEqual(["combobox"]);
    const f = states[0];
    expect(f?.controlType).toBe("combobox");
    expect(f?.proposedValue).toBe("Texas");
    expect(f?.currentValue).toBeUndefined();
  });

  it("is filled from its list and shows the choice", async () => {
    const wrap = pctySelect();
    const res = await fillAriaCombobox(wrap, "Texas", {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      openWaitMs: 300,
      commitWaitMs: 300,
      pollMs: 10,
    });
    expect(res.filled).toBe(true);
    expect(document.querySelector(".input-select-input-single-value")?.textContent).toBe("Texas");
  });

  it("types into its search box when the list only fills from a search", async () => {
    const wrap = pctySelect({ lazy: true });
    const res = await fillAriaCombobox(wrap, "Texas", {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      openWaitMs: 300,
      commitWaitMs: 300,
      pollMs: 10,
    });
    expect(res.filled).toBe(true);
    expect(document.querySelector(".input-select-input-single-value")?.textContent).toBe("Texas");
  });
});
