import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { writeControl } from "../src/content/writeEngine";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

function select(name: string, label: string, options: string[]): HTMLSelectElement {
  const wrap = document.createElement("div");
  const lbl = document.createElement("label");
  const id = `sel-${name}`;
  lbl.setAttribute("for", id);
  lbl.textContent = label;
  const sel = document.createElement("select");
  sel.id = id;
  sel.setAttribute("name", name);
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o || "Select…";
    sel.append(opt);
  }
  wrap.append(lbl, sel);
  document.body.append(wrap);
  return sel;
}

const profile = { country: "Canada", addressState: "Quebec" } as unknown as UserApplicationProfile;

describe("cascading Country → State dropdown", () => {
  it("fills State only after Country is set and options repopulate", () => {
    const country = select("country", "Country", ["", "Canada", "United States"]);
    const state = select("state", "State/Province", [""]); // empty until Country chosen
    country.addEventListener("change", () => {
      if (country.value === "Canada" && state.options.length <= 1) {
        for (const s of ["Ontario", "Quebec", "British Columbia"]) {
          const o = document.createElement("option");
          o.value = s;
          o.textContent = s;
          state.append(o);
        }
      }
    });

    // 1. First scan: State can't resolve — its only option is the placeholder.
    let scan = scanPage(profile, false);
    const state0 = scan.fields.find((f) => f.label.toLowerCase().includes("state"));
    expect(state0?.proposedValue).toBeNull();

    // 2. Fill the parent (Country) — this repopulates State's options.
    const countryField = scan.fields.find((f) => f.label.toLowerCase().includes("country"))!;
    writeControl(scan.registry.get(countryField.id)!, countryField.proposedValue as string);
    expect(country.value).toBe("Canada");

    // 3. Cascade retry: rescan re-reads the repopulated options and re-resolves
    //    State's proposedValue against them, so it now fills.
    scan = scanPage(profile, false);
    const stateField = scan.fields.find((f) => f.label.toLowerCase().includes("state"))!;
    expect(stateField.proposedValue).toBe("Quebec");
    writeControl(scan.registry.get(stateField.id)!, stateField.proposedValue as string);
    expect(state.value).toBe("Quebec");
  });
});
