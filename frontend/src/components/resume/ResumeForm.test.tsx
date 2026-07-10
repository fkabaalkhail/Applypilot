import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ResumeForm from "./ResumeForm";
import { emptyProfile } from "../../lib/resumeProfile";
import type { ResumeProfile } from "../../lib/resumeProfile";

const make = (over: Partial<ResumeProfile> = {}): ResumeProfile => ({
  ...emptyProfile(), name: "Ada Lovelace", summary: "Engineer.", ...over,
});

describe("ResumeForm — shell, basics, summary", () => {
  it("shows the name and edits it through onChange", () => {
    const onChange = vi.fn();
    render(<ResumeForm profile={make()} report={null} onChange={onChange} onFlagClick={() => {}} />);
    const name = screen.getByLabelText("Your name") as HTMLInputElement;
    expect(name.value).toBe("Ada Lovelace");
    fireEvent.change(name, { target: { value: "Ada L" } });
    expect(onChange).toHaveBeenCalledWith({ name: "Ada L" });
  });

  it("titles the summary section from summary_title", () => {
    render(<ResumeForm profile={make({ summary_title: "Objective" })} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    expect(screen.getByRole("heading", { name: "Objective" })).toBeTruthy();
  });

  it("reorders a section with the down control", () => {
    const onChange = vi.fn();
    const profile = make({ summary: "S", skills: ["ts"], section_order: ["summary", "skills"] });
    render(<ResumeForm profile={profile} report={null} onChange={onChange} onFlagClick={() => {}} />);
    fireEvent.click(screen.getByLabelText("Move Professional Summary down"));
    expect(onChange).toHaveBeenCalledWith({ section_order: ["skills", "summary"] });
  });
});

describe("ResumeForm — experience & education", () => {
  it("renders a role and edits its title", () => {
    const onChange = vi.fn();
    const profile = make({
      experience: [{ company: "Acme", title: "Engineer", location: "NYC", start_date: "2022", end_date: "2024", bullets: ["Shipped X"] }],
    });
    render(<ResumeForm profile={profile} report={null} onChange={onChange} onFlagClick={() => {}} />);
    const title = screen.getByLabelText("Job title 1") as HTMLInputElement;
    expect(title.value).toBe("Engineer");
    fireEvent.change(title, { target: { value: "Senior Engineer" } });
    expect(onChange).toHaveBeenCalledWith({
      experience: [expect.objectContaining({ title: "Senior Engineer" })],
    });
  });

  it("shows the full degree in a full-width input (no size cap)", () => {
    const profile = make({
      education: [{ school: "University of Ottawa", degree: "Honours BSc. Translation and Interpretation", location: "Ottawa, ON", start_date: "2025", end_date: "2027", gpa: "3.9", achievements: [], coursework: [] }],
    });
    render(<ResumeForm profile={profile} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    const degree = screen.getByLabelText("Degree 1") as HTMLInputElement;
    expect(degree.value).toBe("Honours BSc. Translation and Interpretation");
    expect(degree.getAttribute("size")).toBeNull(); // width comes from CSS, never a char cap
  });

  it("adds a school", () => {
    const onChange = vi.fn();
    const profile = make({ education: [{ school: "MIT", degree: "BSc", location: "", start_date: "", end_date: "", gpa: "", achievements: [], coursework: [] }] });
    render(<ResumeForm profile={profile} report={null} onChange={onChange} onFlagClick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a school/i }));
    expect(onChange).toHaveBeenCalledWith({ education: expect.arrayContaining([expect.objectContaining({ school: "MIT" }), expect.objectContaining({ school: "" })]) });
  });
});

describe("ResumeForm — projects, skills, technologies, custom", () => {
  it("edits a skill chip list", () => {
    const onChange = vi.fn();
    render(<ResumeForm profile={make({ skills: ["TypeScript"] })} report={null} onChange={onChange} onFlagClick={() => {}} />);
    expect(screen.getByText("TypeScript")).toBeTruthy();
    const add = screen.getByLabelText("Add to skills");
    fireEvent.change(add, { target: { value: "React" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ skills: ["TypeScript", "React"] });
  });

  it("renders a technologies group and a project", () => {
    const profile = make({
      technologies: { Languages: ["Python"] },
      projects: [{ name: "Tailrd", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: ["Built it"] }],
    });
    render(<ResumeForm profile={profile} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    expect(screen.getByText("Languages")).toBeTruthy();
    expect((screen.getByLabelText("Project 1") as HTMLInputElement).value).toBe("Tailrd");
  });

  it("renders a custom section's items", () => {
    const profile = make({
      custom_sections: [{ id: "certs", title: "Certifications", kind: "certifications", text: "", bullets: [], items: [{ title: "AWS SAA", subtitle: "Amazon", location: "", start_date: "2024", end_date: "", detail: "", link: "", bullets: [] }] }],
      section_order: ["summary", "custom:certs"],
    });
    render(<ResumeForm profile={profile} report={null} onChange={() => {}} onFlagClick={() => {}} />);
    expect(screen.getByRole("heading", { name: "Certifications" })).toBeTruthy();
    expect((screen.getByLabelText("Certifications entry 1") as HTMLInputElement).value).toBe("AWS SAA");
  });
});
