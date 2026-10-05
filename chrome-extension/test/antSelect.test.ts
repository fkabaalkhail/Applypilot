/**
 * Ant Design's Select (rc-select), as Dayforce renders it (live 2026-10-05):
 * a search <input role="combobox"> whose value stays empty, and the choice
 * shown beside it in `.ant-select-selection-item`. Read from the input alone,
 * Country, State/Province and both dial codes were reported "Selection didn't
 * stick" while the page showed Canada, Ontario and "🇨🇦 +1".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { fillAriaCombobox, readComboboxValue } from "../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const PROVINCES = ["Alberta", "British Columbia", "Manitoba", "Ontario", "Quebec", "Saskatchewan"];

/** The widget as captured live, with `shown` as its choice ("" shows the placeholder). */
function antSelect(id: string, label: string, shown: string): HTMLInputElement {
  const display = shown
    ? `<span class="ant-select-selection-item" title="${shown}">${shown}</span>`
    : `<span class="ant-select-selection-placeholder">Select...</span>`;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="ant-form-item"><div class="ant-form-item-label"><label for="${id}">${label}</label></div>
      <div class="ant-form-item-control-input"><div class="ant-form-item-control-input-content">
        <div class="ant-select ant-select-in-form-item w-full ant-select-single ant-select-show-arrow ant-select-show-search">
          <div class="ant-select-selector">
            <span class="ant-select-selection-search"><input type="search" id="${id}" autocomplete="off" class="ant-select-selection-search-input" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="${id}_list" aria-autocomplete="list" aria-controls="${id}_list" value=""></span>
            ${display}
          </div>
          <span class="ant-select-arrow" aria-hidden="true"><span role="img" aria-label="down" class="anticon anticon-down ant-select-suffix"></span></span>
        </div>
      </div></div></div>`
  );
  return document.getElementById(id) as HTMLInputElement;
}

/** Opens on a click like the live widget, and commits a click into its display, the input left empty. */
function wire(input: HTMLInputElement, options: string[]): void {
  const selector = input.closest(".ant-select-selector")!;
  const choose = (label: string): void => {
    selector.querySelector(".ant-select-selection-item, .ant-select-selection-placeholder")?.remove();
    selector.insertAdjacentHTML("beforeend", `<span class="ant-select-selection-item" title="${label}">${label}</span>`);
    input.value = "";
    input.setAttribute("aria-expanded", "false");
    document.getElementById(`${input.id}_list`)?.remove();
  };
  const render = (labels: string[]): void => {
    let lb = document.getElementById(`${input.id}_list`);
    if (!lb) {
      lb = document.createElement("div");
      lb.id = `${input.id}_list`;
      lb.setAttribute("role", "listbox");
      document.body.append(lb);
    }
    lb.textContent = "";
    for (const label of labels) {
      const opt = document.createElement("div");
      opt.setAttribute("role", "option");
      opt.className = "ant-select-item ant-select-item-option";
      opt.title = label;
      opt.textContent = label;
      opt.addEventListener("click", () => choose(label));
      lb.append(opt);
    }
  };
  input.addEventListener("click", () => {
    if (input.getAttribute("aria-expanded") === "true") return;
    input.setAttribute("aria-expanded", "true");
    render(options);
  });
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    render(options.filter((o) => o.toLowerCase().includes(q)));
  });
}

const person = {
  firstName: "Maya", lastName: "Tremblay", email: "maya.tremblay@example.com", phone: "(416) 555-0142",
  location: "Toronto, ON, Canada", addressCity: "Toronto", addressState: "ON", country: "Canada",
  skills: [], education: [], experience: [],
} as unknown as UserApplicationProfile;

describe("Ant Design's select", () => {
  it("reads the choice it shows beside its empty search box", () => {
    const input = antSelect("stateCode", "State/Province", "Ontario");
    expect(readComboboxValue(input)).toBe("Ontario");
  });

  it("reads nothing while it shows its placeholder", () => {
    const input = antSelect("stateCode", "State/Province", "");
    expect(readComboboxValue(input)).toBeUndefined();
  });

  it("keeps a country the page already shows", () => {
    antSelect("countryCode", "Country", "Canada");
    const f = scanPage(person, false, null).fields.find((x) => x.category === "country");
    expect(f?.currentValue).toBe("Canada");
  });

  it("verifies a choice by what it shows, not by the empty search box", async () => {
    const input = antSelect("stateCode", "State/Province", "");
    wire(input, PROVINCES);
    const res = await fillAriaCombobox(input, "Ontario", {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      openWaitMs: 300,
      commitWaitMs: 300,
      pollMs: 10,
    });
    expect(document.querySelector(".ant-select-selection-item")?.textContent).toBe("Ontario");
    expect(res.filled).toBe(true);
  });
});
