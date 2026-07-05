import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import {
  rowsNeeded,
  rowsPresent,
  findAddButton,
  planExpansion,
  MAX_ROWS,
} from "../src/content/repeatingSections";
import { scanPage } from "../src/content/formScanner";
import type { DetectedField, UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const profile = (expN: number, eduN: number): UserApplicationProfile =>
  ({
    experience: Array.from({ length: expN }, (_, i) => ({
      company: `Co${i}`,
      title: `T${i}`,
      startDate: "",
      endDate: "",
      description: "",
    })),
    education: Array.from({ length: eduN }, (_, i) => ({ school: `S${i}`, degree: `D${i}`, graduationYear: "" })),
  }) as unknown as UserApplicationProfile;

const field = (id: string, category: string, groupIndex: number | null): DetectedField =>
  ({ id, category, groupIndex } as unknown as DetectedField);

/** Build a work-experience section with `rows` rows and an add button. */
function expForm(rows: number, addLabel: string) {
  const section = document.createElement("div");
  const fields: DetectedField[] = [];
  const els = new Map<string, HTMLElement>();
  for (let i = 0; i < rows; i++) {
    const c = document.createElement("input");
    c.setAttribute("name", `experience[${i}][company]`);
    const t = document.createElement("input");
    t.setAttribute("name", `experience[${i}][title]`);
    section.append(c, t);
    fields.push(field(`c${i}`, "currentCompany", rows > 1 ? i : null));
    fields.push(field(`t${i}`, "currentTitle", rows > 1 ? i : null));
    els.set(`c${i}`, c);
    els.set(`t${i}`, t);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = addLabel;
  section.append(add);
  document.body.append(section);
  return { fields, getEl: (id: string) => els.get(id), add };
}

describe("rowsNeeded", () => {
  it("counts non-empty profile entries per section", () => {
    expect(rowsNeeded(profile(3, 2), "experience")).toBe(3);
    expect(rowsNeeded(profile(3, 2), "education")).toBe(2);
  });
  it("ignores empty entries", () => {
    const p = { experience: [{ company: "", title: "" }, { company: "X", title: "Y" }], education: [] } as unknown as UserApplicationProfile;
    expect(rowsNeeded(p, "experience")).toBe(1);
  });
});

describe("rowsPresent", () => {
  it("is (max group index + 1) across the section's fields", () => {
    const fields = [field("a", "currentCompany", 0), field("b", "currentTitle", 0), field("c", "currentCompany", 1)];
    expect(rowsPresent(fields, "experience")).toBe(2);
  });
  it("is 1 when the section's fields have no index", () => {
    expect(rowsPresent([field("a", "currentCompany", null)], "experience")).toBe(1);
  });
  it("is 0 when the section is absent", () => {
    expect(rowsPresent([field("a", "email", null)], "experience")).toBe(0);
  });
});

describe("findAddButton", () => {
  it("finds a section-specific add button by text", () => {
    const { fields, getEl } = expForm(1, "Add another employment");
    expect(findAddButton(fields, "experience", getEl)?.textContent).toBe("Add another employment");
  });
  it("finds a generic 'Add another' inside the section container", () => {
    const { fields, getEl } = expForm(1, "+ Add Another");
    expect(findAddButton(fields, "experience", getEl)).toBeTruthy();
  });
  it("does not match an unrelated 'Submit' button", () => {
    const { fields, getEl } = expForm(1, "Submit application");
    expect(findAddButton(fields, "experience", getEl)).toBeNull();
  });
});

describe("planExpansion", () => {
  it("plans (needed − present) clicks when the profile has more rows", () => {
    const { fields, getEl } = expForm(1, "Add another employment");
    const steps = planExpansion(profile(3, 0), fields, getEl);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("experience");
    expect(steps[0].clicks).toBe(2);
  });
  it("plans nothing when rows already cover the profile", () => {
    const { fields, getEl } = expForm(3, "Add another employment");
    expect(planExpansion(profile(2, 0), fields, getEl)).toHaveLength(0);
  });
  it("plans nothing when the section is not on the page", () => {
    document.body.innerHTML = "";
    expect(planExpansion(profile(3, 3), [], () => undefined)).toHaveLength(0);
  });
});

describe("expansion loop (end-to-end, real scan + interactive add button)", () => {
  it("expands a 1-row form to the profile's 3 rows", () => {
    document.body.innerHTML = "";
    const section = document.createElement("div");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add another employment";
    let rows = 0;
    const addRow = () => {
      const c = document.createElement("input");
      c.setAttribute("name", `experience[${rows}][company]`);
      const t = document.createElement("input");
      t.setAttribute("name", `experience[${rows}][title]`);
      section.insertBefore(c, add);
      section.insertBefore(t, add);
      rows++;
    };
    add.addEventListener("click", addRow);
    section.append(add);
    document.body.append(section);
    addRow(); // start with one row, like a fresh application form

    const prof = profile(3, 0);
    // Replicate contentScript.expandRepeatingSections's loop.
    for (let guard = 0; guard < MAX_ROWS; guard++) {
      const { fields, registry } = scanPage(prof, false);
      const present = rowsPresent(fields, "experience");
      if (present === 0) break;
      if (present >= Math.min(rowsNeeded(prof, "experience"), MAX_ROWS)) break;
      const btn = findAddButton(fields, "experience", (id) => registry.get(id)?.el);
      if (!btn) break;
      btn.click();
      if (rowsPresent(scanPage(prof, false).fields, "experience") <= present) break;
    }

    expect(rows).toBe(3);
    // and the resolver fills each created row from experience[N]
    const { fields } = scanPage(prof, false);
    const companies = fields.filter((f) => f.category === "currentCompany");
    expect(companies.map((f) => f.proposedValue).sort()).toEqual(["Co0", "Co1", "Co2"]);
  });
});
