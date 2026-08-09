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

  /**
   * REGRESSION: a comma in the proposed value is not cosmetic. comboboxEngine
   * splits a comma-bearing value on any widget under a
   * `multiselectInputContainer` — including the Workday prompts that are
   * single-value in fact, where each pick REPLACES the last. A double major
   * would have proposed "Computer Science, Mathematics" and committed
   * "Mathematics", reported as a successful fill. No comma may leave here.
   */
  it("names one subject for a double major — never a comma-joined list", () => {
    expect(deriveFieldOfStudy("BSc Computer Science, Mathematics")).toBe("Computer Science");
    expect(deriveFieldOfStudy("Bachelor of Arts in Economics, Political Science")).toBe("Economics");
    for (const degree of [
      "BSc Computer Science, Mathematics",
      "Bachelor of Science in Computer Science",
      "Master's Degree in Mechanical Engineering",
    ]) {
      expect(deriveFieldOfStudy(degree), degree).not.toContain(",");
    }
  });

  it("still returns null for a bare subject list that names no degree", () => {
    // No degree prefix to strip — the string is not a degree, so proposing the
    // first half of it would be inventing an answer.
    expect(deriveFieldOfStudy("Computer Science, Mathematics")).toBeNull();
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
 * `data-uxi-multiselect-id` on the input is NOT a multi-select signal, however
 * much it reads like one. Workday puts the same attribute on SINGLE-value
 * prompts — Country Phone Code carries it in this repo's captured production
 * DOM (test/fixtures/workdayReal.ts), and so does `education-N--degree`. On
 * those, every pick REPLACES the last, so splitting "Toronto, Ontario" commits
 * "Ontario" and reports success: the wrong value, banked green.
 *
 * What actually identifies a Workday multiselect is the
 * `multiselectInputContainer` / `multiSelectContainer` ancestor, which the
 * engine's pre-existing `closest()` check already matches. These tests fix that
 * division: the ancestor decides, the marker is ignored.
 */
describe("Workday searchBox multiselect", () => {
  interface BoxOpts {
    /** Workday's `data-uxi-multiselect-id` on the input itself — inert. */
    marker: boolean;
    /** The ancestor that genuinely marks a multiselect, as captured in production. */
    ancestor?: boolean;
    /** Single-value widgets REPLACE the committed chip; multiselects append. */
    single?: boolean;
    options?: string[];
    /** Committed chips on OTHER widgets in the same section — the state a
     *  sequential fill pass leaves behind as it works down a section. */
    siblingChips?: string[];
  }

  /** A Workday typeahead: no aria-autocomplete, and an EMPTY listbox until a
   *  filter is typed. Committed values show as `selectedItem` chips. */
  function mountSearchBox(opts: BoxOpts): HTMLInputElement {
    const options = opts.options ?? ["React", "TypeScript", "Rust"];
    const siblings = (opts.siblingChips ?? [])
      .map(
        (label, i) => `
        <div class="wd-widget">
          <input data-automation-id="searchBox" data-uxi-widget-type="selectinput"
                 data-uxi-multiselect-id="sib${i}" autocomplete="off">
          <div data-automation-id="selectedItem">${label}</div>
        </div>`
      )
      .join("");
    const widget = `
      <div class="wd-widget">
        <div id="chips"></div>
        <input id="sb" data-automation-id="searchBox" placeholder="Search"
               data-uxi-widget-type="selectinput" aria-controls="lb" autocomplete="off"
               ${opts.marker ? 'data-uxi-multiselect-id="bbb"' : ""}>
        <div id="lb" role="listbox"></div>
      </div>`;
    document.body.innerHTML = `
      <div data-automation-id="educationSection">
        ${siblings}
        ${opts.ancestor ? `<div data-automation-id="multiselectInputContainer">${widget}</div>` : widget}
      </div>`;
    const input = document.getElementById("sb") as HTMLInputElement;
    const listbox = document.getElementById("lb")!;
    const chips = document.getElementById("chips")!;
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
          if (opts.single) chips.innerHTML = "";
          const chip = document.createElement("div");
          chip.setAttribute("data-automation-id", "selectedItem");
          chip.textContent = label;
          chips.append(chip);
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

  /** Chips committed on the TARGET widget only (siblings have their own). */
  const chipTexts = (): string[] =>
    Array.from(document.querySelectorAll('#chips [data-automation-id="selectedItem"]')).map(
      (c) => c.textContent ?? ""
    );

  const fast = { sleep: async (): Promise<void> => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

  it("splits a multi-item answer into one chip per item", async () => {
    // The genuine multiselect: identified by its ancestor, exactly as the
    // captured Country Phone Code widget is. The marker rides along, inert.
    const input = mountSearchBox({ marker: true, ancestor: true });
    const r = await fillAriaCombobox(input, "React, TypeScript", fast);
    expect(r.filled).toBe(true);
    expect(chipTexts()).toEqual(["React", "TypeScript"]);
  });

  it("never splits a single-value widget that merely carries the marker", async () => {
    // Splitting here selects Toronto and then REPLACES it with Ontario — the
    // wrong value, banked as a successful fill.
    const input = mountSearchBox({
      marker: true,
      single: true,
      options: ["Toronto", "Ontario", "Ottawa"],
    });
    const r = await fillAriaCombobox(input, "Toronto, Ontario", fast);
    expect(r.filled).toBe(true);
    expect(chipTexts()).toEqual(["Toronto"]);
  });

  it("is not swayed by chips its NEIGHBOURS have already committed", async () => {
    // A sequential fill pass works down a section, so by the time it reaches
    // this widget its siblings are already filled. Counting committed values
    // near the trigger reads those as evidence THIS widget is multi — and
    // Workday's selectinput has no role=combobox / aria-haspopup, so the
    // value-container climb never stops at the widget boundary.
    const input = mountSearchBox({
      marker: true,
      single: true,
      options: ["Toronto", "Ontario", "Ottawa"],
      siblingChips: ["Canada", "Mobile"],
    });
    const r = await fillAriaCombobox(input, "Toronto, Ontario", fast);
    expect(r.filled).toBe(true);
    expect(chipTexts()).toEqual(["Toronto"]);
  });

  it("leaves a widget with no multiselect ancestor single-select", async () => {
    const input = mountSearchBox({ marker: false });
    await fillAriaCombobox(input, "React, TypeScript", fast);
    // A single-select widget commits at most one value — never a second chip.
    expect(chipTexts().length).toBeLessThan(2);
  });
});
