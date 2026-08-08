/**
 * Workday shows Degree and Field of Study as two separate typeahead dropdowns.
 * The matcher folded "field of study" into the degree rule, so both received
 * the degree value and Field of Study matched no option.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import { deriveFieldOfStudy } from "../src/content/fieldMatcher";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

/** Workday's education row: Degree and Field of Study, both selectinput. */
function mountEducationRow(): void {
  document.body.innerHTML = `
    <div data-automation-id="educationSection">
      <label for="education-11--degree">Degree</label>
      <input id="education-11--degree" data-automation-id="searchBox" placeholder="Search"
             data-uxi-widget-type="selectinput" data-uxi-multiselect-id="aaa" autocomplete="off">
      <label for="education-11--fieldOfStudy">Field of Study</label>
      <input id="education-11--fieldOfStudy" data-automation-id="searchBox" placeholder="Search"
             data-uxi-widget-type="selectinput" data-uxi-multiselect-id="bbb" autocomplete="off">
    </div>`;
}

describe("deriveFieldOfStudy", () => {
  it("takes the subject out of a degree string", () => {
    expect(deriveFieldOfStudy("BSc Computer Science")).toBe("Computer Science");
    expect(deriveFieldOfStudy("Bachelor of Science in Computer Science")).toBe("Computer Science");
    expect(deriveFieldOfStudy("Master's Degree in Mechanical Engineering")).toBe("Mechanical Engineering");
    expect(deriveFieldOfStudy("B.S. Electrical Engineering")).toBe("Electrical Engineering");
  });

  it("returns null when the degree names no subject", () => {
    expect(deriveFieldOfStudy("Bachelor's Degree")).toBeNull();
    expect(deriveFieldOfStudy("PhD")).toBeNull();
    expect(deriveFieldOfStudy("")).toBeNull();
  });
});

describe("Workday education row", () => {
  it("classifies Field of Study separately from Degree", () => {
    mountEducationRow();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const fos = fields.find((f) => f.label.toLowerCase().includes("field of study"));
    const deg = fields.find((f) => f.label.toLowerCase() === "degree");
    expect(fos!.category).toBe("fieldOfStudy");
    expect(deg!.category).toBe("degree");
  });

  it("proposes the subject, not the degree, for Field of Study", () => {
    mountEducationRow();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const fos = fields.find((f) => f.category === "fieldOfStudy");
    // MOCK_PROFILE education[0].degree is "BSc Computer Science".
    expect(fos!.proposedValue).toBe("Computer Science");
  });

  it("drives the searchBox through the listbox engine, not as a text input", () => {
    mountEducationRow();
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "fieldOfStudy")!.controlType).toBe("combobox");
  });
});

/**
 * Workday marks its multiselects with `data-uxi-multiselect-id` on the INPUT,
 * which `isMultiSelect` only ever looked for on ancestors. But Workday puts that
 * same attribute on SINGLE-value prompts (a degree, a city), where every pick
 * REPLACES the last one — so treating the marker as proof of multi turned
 * "Toronto, Ontario" into a committed "Ontario" and reported success. The marker
 * therefore only counts alongside corroboration a single-value widget cannot
 * produce: two committed values already on screen.
 */
describe("Workday searchBox multiselect", () => {
  interface BoxOpts {
    /** Workday's `data-uxi-multiselect-id` on the input itself. */
    marker: boolean;
    /** Single-value widgets REPLACE the committed chip; multiselects append. */
    single?: boolean;
    /** Values already committed when the fill starts. */
    seedChips?: string[];
    options?: string[];
  }

  /** A Workday typeahead: no aria-autocomplete, and an EMPTY listbox until a
   *  filter is typed. Committed values show as `selectedItem` chips. */
  function mountSearchBox(opts: BoxOpts): HTMLInputElement {
    const options = opts.options ?? ["React", "TypeScript", "Rust"];
    document.body.innerHTML = `
      <div data-automation-id="educationSection">
        <div class="wd-widget">
          <div id="chips"></div>
          <input id="sb" data-automation-id="searchBox" placeholder="Search"
                 data-uxi-widget-type="selectinput" aria-controls="lb" autocomplete="off"
                 ${opts.marker ? 'data-uxi-multiselect-id="bbb"' : ""}>
          <div id="lb" role="listbox"></div>
        </div>
      </div>`;
    const input = document.getElementById("sb") as HTMLInputElement;
    const listbox = document.getElementById("lb")!;
    const chips = document.getElementById("chips")!;
    const addChip = (label: string): void => {
      if (opts.single) chips.innerHTML = "";
      const chip = document.createElement("div");
      chip.setAttribute("data-automation-id", "selectedItem");
      chip.textContent = label;
      chips.append(chip);
    };
    for (const seed of opts.seedChips ?? []) addChip(seed);
    const render = (): void => {
      const filter = input.value.trim().toLowerCase();
      listbox.innerHTML = "";
      if (!filter) return; // Workday shows nothing until you type
      for (const label of options) {
        if (!label.toLowerCase().includes(filter)) continue;
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = label;
        o.addEventListener("mousedown", () => {
          addChip(label);
          input.value = "";
          listbox.innerHTML = "";
        });
        listbox.append(o);
      }
    };
    input.addEventListener("input", render);
    input.addEventListener("keyup", render);
    return input;
  }

  const chipTexts = (): string[] =>
    Array.from(document.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => c.textContent ?? "");

  const fast = { sleep: async (): Promise<void> => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

  it("never splits a single-value widget that merely carries the marker", async () => {
    // The measured regression: splitting selects Toronto, then REPLACES it with
    // Ontario — the wrong value, banked as a successful fill.
    const input = mountSearchBox({
      marker: true,
      single: true,
      options: ["Toronto", "Ontario", "Ottawa"],
    });
    const r = await fillAriaCombobox(input, "Toronto, Ontario", fast);
    expect(r.filled).toBe(true);
    expect(chipTexts()).toEqual(["Toronto"]);
  });

  it("splits a multi-item answer when the widget already shows two committed values", async () => {
    const input = mountSearchBox({ marker: true, seedChips: ["Rust", "Go"] });
    const r = await fillAriaCombobox(input, "React, TypeScript", fast);
    expect(r.filled).toBe(true);
    expect(chipTexts()).toEqual(["Rust", "Go", "React", "TypeScript"]);
  });

  it("leaves a widget without the marker single-select", async () => {
    const input = mountSearchBox({ marker: false });
    await fillAriaCombobox(input, "React, TypeScript", fast);
    // A single-select widget commits at most one value — never a second chip.
    expect(chipTexts().length).toBeLessThan(2);
  });
});
