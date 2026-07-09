// Feature: resume-upload-analysis — rendering faithfulness of the resume
// workspace: the list, the document canvas, the save payload, and the report.
//
// Both pages talk to the API through the shared axios instance (`auth/api`), so
// that module is what these tests stub. An earlier version of this file mocked
// `global.fetch`, which axios never calls — every request fell through to the
// page's error state and the assertions never ran against real markup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as fc from "fast-check";

import type { AnalysisReport, ResumeProfile } from "../lib/resumeProfile";
import { emptyProfile } from "../lib/resumeProfile";

const api = { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() };

vi.mock("../auth/api", () => ({ default: api, isEmbedded: () => false }));
vi.mock("../hooks/useAuthFetch", () => ({ default: api, api }));
// The resume list renders the onboarding intro, which needs an AuthProvider it
// has nothing to do with. Stub it out rather than wrap every render.
vi.mock("../onboarding", () => ({ PageIntro: () => null }));

// Imported after the mock so both pages pick up the stub.
const { default: Resume } = await import("../pages/Resume");
const { default: ResumeDetail } = await import("../pages/ResumeDetail");

/* ===== Generators ===== */

const text = (max = 24) =>
  fc.string({ minLength: 1, maxLength: max }).filter((s) => s.trim().length > 0 && s.trim() === s);

const isoDate = fc
  .integer({ min: 1577836800000, max: 1767225600000 })
  .map((ts) => new Date(ts).toISOString());

interface ResumeListItem {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

const resumeListArb: fc.Arbitrary<ResumeListItem[]> = fc
  .array(
    fc.record({
      id: fc.nat({ max: 10000 }),
      name: text(30),
      target_job_title: fc.oneof(fc.constant(null), text(30)),
      is_primary: fc.boolean(),
      status: fc.constantFrom("analyzed", "pending"),
      created_at: isoDate,
      updated_at: isoDate,
    }),
    { minLength: 0, maxLength: 6 },
  )
  .map((items) => items.map((item, i) => ({ ...item, id: i + 1 })));

const profileArb: fc.Arbitrary<ResumeProfile> = fc.record({
  name: text(),
  email: fc.constant("a@b.com"),
  phone: fc.constant("555"),
  location: text(),
  linkedin_url: fc.constant(""),
  github_url: fc.constant(""),
  other_link: fc.constant(""),
  summary: fc.oneof(fc.constant(""), text(60)),
  summary_title: fc.constant("PROFESSIONAL SUMMARY"),
  skills: fc.array(text(12), { maxLength: 5 }),
  experience: fc.array(
    fc.record({
      company: text(), title: text(), location: text(),
      start_date: text(8), end_date: text(8),
      bullets: fc.array(text(40), { maxLength: 3 }),
    }),
    { maxLength: 3 },
  ),
  education: fc.array(
    fc.record({
      school: text(), degree: text(), location: text(),
      start_date: text(8), end_date: text(8), gpa: text(4),
      achievements: fc.array(text(30), { maxLength: 2 }),
      coursework: fc.array(text(12), { maxLength: 2 }),
    }),
    { maxLength: 2 },
  ),
  projects: fc.array(
    fc.record({
      name: text(), link: fc.constant(""), organization: text(),
      location: text(), start_date: text(8), end_date: text(8),
      bullets: fc.array(text(40), { maxLength: 2 }),
    }),
    { maxLength: 2 },
  ),
  technologies: fc.constant<Record<string, string[]>>({}),
  custom_sections: fc.constant([]),
  section_order: fc.constant<string[]>([]),
});

function detailOf(profile: ResumeProfile, report: AnalysisReport | null = null) {
  return {
    id: 1,
    name: "My_CV",
    target_job_title: null,
    is_primary: false,
    profile,
    analysis_report: report,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/app/resume/1"]}>
      <Routes>
        <Route path="/app/resume/:id" element={<ResumeDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
});
afterEach(() => vi.clearAllMocks());

/* ===== Property 2: Resume list rendering faithfulness ===== */

describe("Property 2: resume list rendering faithfulness", () => {
  it("renders one row per resume with its name and target job title", { timeout: 60000 }, async () => {
    await fc.assert(
      fc.asyncProperty(resumeListArb, async (items) => {
        api.get.mockResolvedValue({ data: items });
        const { container, unmount } = render(<MemoryRouter><Resume /></MemoryRouter>);

        if (items.length === 0) {
          await screen.findByText(/No resumes yet/i);
        } else {
          await waitFor(() => {
            expect(container.querySelectorAll("tbody tr")).toHaveLength(items.length);
          });
          const rows = container.querySelectorAll("tbody tr");
          items.forEach((item, i) => {
            const row = rows[i] as HTMLElement;
            // getAllByText, not getByText: a single-character name also appears
            // in the row's avatar initial, and that is not a rendering fault.
            expect(within(row).getAllByText(item.name).length).toBeGreaterThan(0);
            if (item.target_job_title) {
              expect(within(row).getAllByText(item.target_job_title).length).toBeGreaterThan(0);
            }
            if (item.is_primary) expect(within(row).getByText(/Primary/i)).toBeTruthy();
          });
        }
        unmount();
      }),
      { numRuns: 12 },
    );
  });

  it("never renders a negative relative time for a fresh upload", { timeout: 30000 }, async () => {
    // The bug this guards: naive-UTC timestamps parsed as local time rendered
    // as "-240m ago" for a UTC-4 user.
    const justNow = new Date().toISOString().replace("Z", "");
    api.get.mockResolvedValue({
      data: [{
        id: 1, name: "CV", target_job_title: null, is_primary: false,
        status: "analyzed", created_at: justNow, updated_at: justNow,
      }],
    });

    const { container } = render(<MemoryRouter><Resume /></MemoryRouter>);
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));

    const cells = [...container.querySelectorAll(".resume-date-cell")].map((c) => c.textContent ?? "");
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell).not.toMatch(/-\d/);
      expect(cell).toBe("just now");
    }
  });
});

/* ===== Property 3: Canvas rendering faithfulness ===== */

describe("Property 3: every section the profile has reaches the canvas", () => {
  it("renders each experience, education, and project entry", { timeout: 60000 }, async () => {
    await fc.assert(
      fc.asyncProperty(profileArb, async (profile) => {
        api.get.mockResolvedValue({ data: detailOf(profile) });
        const { container, unmount } = renderDetail();
        await screen.findByRole("textbox", { name: /your name/i });

        const values = [...container.querySelectorAll("input,textarea")].map(
          (el) => (el as HTMLInputElement).value,
        );
        for (const exp of profile.experience) {
          expect(values).toContain(exp.company);
          expect(values).toContain(exp.title);
        }
        for (const edu of profile.education) expect(values).toContain(edu.school);
        for (const proj of profile.projects) expect(values).toContain(proj.name);
        for (const skill of profile.skills) expect(container.textContent).toContain(skill);

        unmount();
      }),
      { numRuns: 10 },
    );
  });

  it("renders custom sections under the user's own heading", async () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      name: "Wissam",
      custom_sections: [{
        id: "c1", title: "CERTIFICATIONS", kind: "certifications", text: "", bullets: [],
        items: [{
          title: "AWS Solutions Architect", subtitle: "Amazon", location: "",
          start_date: "", end_date: "", detail: "", link: "", bullets: [],
        }],
      }],
      section_order: ["custom:c1"],
    };
    api.get.mockResolvedValue({ data: detailOf(profile) });

    renderDetail();
    expect(await screen.findByRole("heading", { name: "CERTIFICATIONS" })).toBeTruthy();
    expect(screen.getByDisplayValue("AWS Solutions Architect")).toBeTruthy();
  });

  it("honors the stored section order", async () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      skills: ["Python"],
      projects: [{ name: "Tailrd", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: [] }],
      section_order: ["skills", "projects"],
    };
    api.get.mockResolvedValue({ data: detailOf(profile) });

    const { container } = renderDetail();
    await screen.findByRole("heading", { name: /Skills/i });

    const headings = [...container.querySelectorAll(".rd-section-title")].map((h) => h.textContent);
    expect(headings).toEqual(["Skills", "Projects"]);
  });

  it("renders no entries for an empty profile", async () => {
    api.get.mockResolvedValue({ data: detailOf({ ...emptyProfile(), name: "W" }) });
    const { container } = renderDetail();
    await screen.findByRole("textbox", { name: /your name/i });
    expect(container.querySelectorAll(".rd-entry")).toHaveLength(0);
  });
});

/* ===== Property 4: Adding an entry grows the section ===== */

describe("Property 4: add entry grows the section", () => {
  it("grows work experience when 'Add a role' is used", async () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      experience: [{ company: "Acme", title: "Dev", location: "", start_date: "", end_date: "", bullets: [] }],
    };
    api.get.mockResolvedValue({ data: detailOf(profile) });

    const { container } = renderDetail();
    await screen.findByDisplayValue("Acme");
    expect(container.querySelectorAll(".rd-entry")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Add a role/i }));
    await waitFor(() => expect(container.querySelectorAll(".rd-entry")).toHaveLength(2));
  });
});

/* ===== Property 5: Save payload matches the canvas ===== */

describe("Property 5: save payload matches editor state", () => {
  it("PUTs the edited profile, preserving custom sections and order", async () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      name: "Wissam",
      experience: [{ company: "Acme", title: "Dev", location: "", start_date: "", end_date: "", bullets: [] }],
      custom_sections: [{ id: "c1", title: "AWARDS", kind: "custom", text: "", bullets: ["Winner"], items: [] }],
      section_order: ["experience", "custom:c1"],
    };
    api.get.mockResolvedValue({ data: detailOf(profile) });
    api.put.mockResolvedValue({ data: detailOf(profile) });

    renderDetail();
    const nameInput = await screen.findByRole("textbox", { name: /your name/i });

    // Save is disabled until something actually changes.
    expect((screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(nameInput, { target: { value: "Wissam E" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe("/resumes/1");
    expect(body.profile.name).toBe("Wissam E");
    expect(body.profile.custom_sections).toHaveLength(1);
    expect(body.profile.section_order).toEqual(["experience", "custom:c1"]);
  });
});

/* ===== Property 10: Analysis report rendering ===== */

const report: AnalysisReport = {
  overall_grade: "GOOD",
  letter_grade: "B+",
  score: 76,
  urgent_fix_count: 3,
  critical_fix_count: 1,
  optional_fix_count: 2,
  summary: "Your resume reads as an early-career developer.",
  highlights: ["Bullets lack metrics"],
  strengths: ["Broad technical stack"],
  analyzed_at: "2026-07-07T10:00:00Z",
  categories: [{
    id: "impact",
    name: "Impact & Achievements",
    score: 60,
    why_it_matters: "Outcomes decide callbacks.",
    issues: [{
      id: "i1",
      title: "Duty-only bullets",
      severity: "urgent",
      count: 3,
      description: "Several bullets describe duties rather than outcomes.",
      evidence: ["Responsible for the regression suite"],
      suggestion: "Cut regression time from [X] to [Y] minutes.",
      section: "Work Experience",
    }],
  }],
};

describe("Property 10: analysis report rendering", () => {
  it("shows the grade, the fix counts, and a proportional severity rail", async () => {
    api.get.mockResolvedValue({ data: detailOf({ ...emptyProfile(), name: "W" }, report) });

    const { container } = renderDetail();
    await screen.findByText("B+");

    const strip = container.querySelector(".rd-score") as HTMLElement;
    expect(within(strip).getByText("3")).toBeTruthy();
    expect(within(strip).getByText("1")).toBeTruthy();
    expect(within(strip).getByText("2")).toBeTruthy();

    // 3 urgent : 1 critical : 2 optional of 6 total → the urgent bar is half.
    const segments = [...strip.querySelectorAll(".rd-rail-seg")] as HTMLElement[];
    expect(segments).toHaveLength(3);
    expect(segments[0].style.width).toBe("50%");
    expect(segments[1].dataset.severity).toBe("critical");
  });

  it("opens the full report with evidence quoted verbatim and a concrete fix", async () => {
    api.get.mockResolvedValue({ data: detailOf({ ...emptyProfile(), name: "W" }, report) });

    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /View full report/i }));

    expect(await screen.findByText(report.summary)).toBeTruthy();
    expect(screen.getByText("Broad technical stack")).toBeTruthy();
    expect(screen.getByText("Duty-only bullets")).toBeTruthy();
    expect(screen.getByText("Responsible for the regression suite")).toBeTruthy();
    expect(screen.getByText(/Cut regression time from \[X\]/)).toBeTruthy();
    expect(screen.getByText(/Start here/i)).toBeTruthy();
  });

  it("prompts for analysis when no report exists", async () => {
    api.get.mockResolvedValue({ data: detailOf({ ...emptyProfile(), name: "W" }, null) });
    renderDetail();
    expect(await screen.findByText(/hasn't been analyzed/i)).toBeTruthy();
  });
});

/* ===== Improve flow ===== */

describe("Improve flow", () => {
  it("previews the rewrite and only saves once the user applies it", async () => {
    const profile = { ...emptyProfile(), name: "W" };
    api.get.mockResolvedValue({ data: detailOf(profile, report) });
    api.post.mockResolvedValue({
      data: {
        profile,
        changes: ["Rewrote 3 entries for stronger impact", "Needs your input: the % failures dropped"],
      },
    });
    api.put.mockResolvedValue({ data: detailOf(profile, report) });

    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /View full report/i }));
    fireEvent.click(screen.getByRole("button", { name: /Improve my resume/i }));

    expect(await screen.findByText(/Rewrote 3 entries/)).toBeTruthy();
    // The metric the model refused to invent is surfaced separately.
    expect(screen.getByText(/the % failures dropped/)).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Apply to my resume/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  });
});
