import { describe, it, expect } from "vitest";
import {
  addItem,
  addSection,
  moveSection,
  removeItem,
  removeSection,
  updateHeader,
  updateItem,
  updateSection,
} from "../lib/resumeEdit";
import { DEFAULT_THEME, type ResumeDocument } from "../lib/resumeDocument";

const base = (): ResumeDocument => ({
  header: { name: "Jane", email: "", phone: "", location: "", linkedin_url: "", github_url: "", other_link: "" },
  sections: [
    {
      id: "s1",
      type: "experience",
      title: "WORK EXPERIENCE",
      text: "",
      skills: [],
      groups: {},
      items: [
        { id: "i1", title: "Engineer", subtitle: "Acme", location: "", start_date: "", end_date: "", detail: "", link: "", bullets: ["did a thing"] },
      ],
    },
    { id: "s2", type: "skills", title: "SKILLS", text: "", skills: ["Python"], groups: {}, items: [] },
  ],
  theme: DEFAULT_THEME,
});

describe("resumeEdit helpers (visual editor core)", () => {
  it("updates a header field immutably", () => {
    const doc = base();
    const next = updateHeader(doc, "name", "John");
    expect(next.header.name).toBe("John");
    expect(doc.header.name).toBe("Jane"); // original untouched
  });

  it("adds and removes items in an item-section", () => {
    const added = addItem(base(), "s1");
    expect(added.sections[0].items).toHaveLength(2);
    const removed = removeItem(added, "s1", "i1");
    expect(removed.sections[0].items).toHaveLength(1);
  });

  it("updates item bullets without touching facts", () => {
    const next = updateItem(base(), "s1", "i1", { bullets: ["x", "y"] });
    expect(next.sections[0].items[0].bullets).toEqual(["x", "y"]);
    expect(next.sections[0].items[0].title).toBe("Engineer");
  });

  it("adds a typed section (item-types seed one entry)", () => {
    const next = addSection(base(), "projects");
    expect(next.sections).toHaveLength(3);
    expect(next.sections[2].type).toBe("projects");
    expect(next.sections[2].items).toHaveLength(1);
    const skills = addSection(base(), "skills");
    expect(skills.sections[2].items).toHaveLength(0);
  });

  it("reorders sections and clamps at the edges", () => {
    expect(moveSection(base(), "s2", -1).sections.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(moveSection(base(), "s1", -1).sections.map((s) => s.id)).toEqual(["s1", "s2"]); // no-op at top
  });

  it("removes a section and edits skills", () => {
    expect(removeSection(base(), "s1").sections.map((s) => s.id)).toEqual(["s2"]);
    const next = updateSection(base(), "s2", { skills: ["Python", "Go"] });
    expect(next.sections[1].skills).toEqual(["Python", "Go"]);
  });
});
