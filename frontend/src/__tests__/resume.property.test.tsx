// Feature: resume-upload-analysis, Property 2: Resume list rendering faithfulness
// **Validates: Requirements 1.1, 1.2, 1.3, 7.3, 7.4**

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as fc from "fast-check";
import Resume from "../pages/Resume";

interface ResumeListItem {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

// Generator for ResumeListItem objects
const resumeListItemArb: fc.Arbitrary<ResumeListItem> = fc.record({
  id: fc.nat({ max: 10000 }),
  name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  target_job_title: fc.oneof(
    fc.constant(null),
    fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0)
  ),
  is_primary: fc.boolean(),
  status: fc.oneof(fc.constant("analyzed"), fc.constant("pending")),
  created_at: fc.integer({ min: 1577836800000, max: 1767225600000 }).map((ts) => new Date(ts).toISOString()),
  updated_at: fc.integer({ min: 1577836800000, max: 1767225600000 }).map((ts) => new Date(ts).toISOString()),
});

// Generator for lists of 0-10 items with unique ids
const resumeListArb: fc.Arbitrary<ResumeListItem[]> = fc
  .array(resumeListItemArb, { minLength: 0, maxLength: 10 })
  .map((items) =>
    items.map((item, idx) => ({ ...item, id: idx + 1 }))
  );

let originalFetch: typeof global.fetch;

describe("Property 2: Resume list rendering faithfulness", () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it(
    "renders one row per item with correct name, target job title, PRIMARY badge, and Analysis Complete badge",
    { timeout: 60000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(resumeListArb, async (items) => {
          global.fetch = async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url === "/resumes" || url.endsWith("/resumes")) {
              return new Response(JSON.stringify(items), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("Not found", { status: 404 });
          };

          const { unmount } = render(
            <MemoryRouter>
              <Resume />
            </MemoryRouter>
          );

          try {
            if (items.length === 0) {
              // Empty state: verify empty state message appears
              await waitFor(() => {
                expect(
                  screen.getByText(/No resumes yet/i)
                ).toBeInTheDocument();
              });
            } else {
              // Wait for loading to finish and table to appear
              await waitFor(() => {
                expect(screen.getByRole("table")).toBeInTheDocument();
              });

              // 1. Number of table body rows equals number of items
              const tbody = screen.getByRole("table").querySelector("tbody");
              expect(tbody).not.toBeNull();
              const rows = tbody!.querySelectorAll("tr");
              expect(rows.length).toBe(items.length);

              // 2-5. Verify each row's content
              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const row = rows[i];

                // 2. Each row shows the correct name
                expect(row.textContent).toContain(item.name);

                // 3. Each row shows target_job_title or "Not set" if null
                if (item.target_job_title) {
                  expect(row.textContent).toContain(item.target_job_title);
                } else {
                  expect(row.textContent).toContain("Not set");
                }

                // 4. PRIMARY badge appears iff is_primary is true
                const primaryBadge = row.querySelector(".badge-primary");
                if (item.is_primary) {
                  expect(primaryBadge).not.toBeNull();
                  expect(primaryBadge!.textContent).toContain("PRIMARY");
                } else {
                  expect(primaryBadge).toBeNull();
                }

                // 5. "Analysis Complete" badge appears iff status is "analyzed"
                const analyzedBadge = row.querySelector(".badge-analyzed");
                if (item.status === "analyzed") {
                  expect(analyzedBadge).not.toBeNull();
                  expect(analyzedBadge!.textContent).toContain("Analysis Complete");
                } else {
                  expect(analyzedBadge).toBeNull();
                }
              }
            }
          } finally {
            unmount();
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});

// Feature: resume-upload-analysis, Property 3: Editor rendering faithfulness
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**

import { Routes, Route } from "react-router-dom";
import ResumeDetail from "../pages/ResumeDetail";

/* ===== Interfaces for ResumeDetail response ===== */

interface ExperienceItem {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface EducationItem {
  school: string;
  degree: string;
  start_date: string;
  end_date: string;
  gpa: string;
  achievements: string[];
  coursework: string[];
}

interface ProjectItem {
  name: string;
  link: string;
  organization: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface ResumeProfile {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  github_url: string;
  other_link: string;
  skills: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  projects: ProjectItem[];
  technologies: Record<string, string[]>;
}

interface ResumeDetailResponse {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  profile: ResumeProfile;
  analysis_report: null;
  created_at: string;
  updated_at: string;
}

/* ===== Generators ===== */

const educationItemArb: fc.Arbitrary<EducationItem> = fc.record({
  school: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  degree: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  start_date: fc.constant("2020-01"),
  end_date: fc.constant("2024-05"),
  gpa: fc.oneof(fc.constant(""), fc.constant("3.8")),
  achievements: fc.array(fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0), { minLength: 0, maxLength: 2 }),
  coursework: fc.array(fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0), { minLength: 0, maxLength: 2 }),
});

const experienceItemArb: fc.Arbitrary<ExperienceItem> = fc.record({
  company: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  title: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  location: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  start_date: fc.constant("2021-06"),
  end_date: fc.constant("2023-12"),
  bullets: fc.array(fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0), { minLength: 0, maxLength: 3 }),
});

const projectItemArb: fc.Arbitrary<ProjectItem> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  link: fc.constant("https://example.com"),
  organization: fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
  location: fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
  start_date: fc.constant("2022-01"),
  end_date: fc.constant("2022-06"),
  bullets: fc.array(fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0), { minLength: 0, maxLength: 3 }),
});

// Generate a technologies dict with 0-3 categories, each with 1-3 skills
const technologiesArb: fc.Arbitrary<Record<string, string[]>> = fc
  .array(
    fc.tuple(
      fc.stringMatching(/^[A-Z][a-z]{2,8}$/).filter((s) => s.length >= 3),
      fc.array(fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0), { minLength: 1, maxLength: 3 })
    ),
    { minLength: 0, maxLength: 3 }
  )
  .map((entries) => {
    const result: Record<string, string[]> = {};
    for (const [key, skills] of entries) {
      result[key] = skills;
    }
    return result;
  });

const resumeProfileArb: fc.Arbitrary<ResumeProfile> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  email: fc.emailAddress(),
  phone: fc.stringMatching(/^\d{3}-\d{3}-\d{4}$/),
  location: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  linkedin_url: fc.constant("https://linkedin.com/in/test"),
  github_url: fc.constant("https://github.com/test"),
  other_link: fc.constant("https://example.com"),
  skills: fc.constant([]),
  experience: fc.array(experienceItemArb, { minLength: 0, maxLength: 3 }),
  education: fc.array(educationItemArb, { minLength: 0, maxLength: 3 }),
  projects: fc.array(projectItemArb, { minLength: 0, maxLength: 3 }),
  technologies: technologiesArb,
});

const resumeDetailArb: fc.Arbitrary<ResumeDetailResponse> = resumeProfileArb.map((profile) => ({
  id: 1,
  name: "Test Resume",
  target_job_title: "Software Engineer",
  is_primary: false,
  profile,
  analysis_report: null,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
}));

describe("Property 3: Editor rendering faithfulness", () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it(
    "renders header fields, education entries, experience entries, project entries, and technology categories matching the profile",
    { timeout: 60000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(resumeDetailArb, async (detail) => {
          global.fetch = async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.match(/\/resumes\/\d+$/)) {
              return new Response(JSON.stringify(detail), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("Not found", { status: 404 });
          };

          const { unmount, container } = render(
            <MemoryRouter initialEntries={["/app/resume/1"]}>
              <Routes>
                <Route path="/app/resume/:id" element={<ResumeDetail />} />
              </Routes>
            </MemoryRouter>
          );

          try {
            // Wait for loading to finish
            await waitFor(() => {
              expect(container.querySelector(".settings-loading")).toBeNull();
            });

            const profile = detail.profile;

            // 1. Header fields: verify input values match profile personal info
            const inputs = container.querySelectorAll<HTMLInputElement>("input");
            const inputValues = Array.from(inputs).map((input) => input.value);

            expect(inputValues).toContain(profile.name);
            expect(inputValues).toContain(profile.email);
            expect(inputValues).toContain(profile.phone);
            expect(inputValues).toContain(profile.location);
            expect(inputValues).toContain(profile.linkedin_url);
            expect(inputValues).toContain(profile.github_url);
            expect(inputValues).toContain(profile.other_link);

            // 2. Number of education entries matches profile.education.length
            // Each education entry has a "School" input - count them
            const schoolInputs = Array.from(inputs).filter(
              (input) => {
                const label = input.closest("div")?.querySelector("label");
                return label?.textContent === "School";
              }
            );
            expect(schoolInputs.length).toBe(profile.education.length);

            // 3. Number of experience entries matches profile.experience.length
            const companyInputs = Array.from(inputs).filter(
              (input) => {
                const label = input.closest("div")?.querySelector("label");
                return label?.textContent === "Company";
              }
            );
            expect(companyInputs.length).toBe(profile.experience.length);

            // 4. Number of project entries matches profile.projects.length
            const projectNameInputs = Array.from(inputs).filter(
              (input) => {
                const label = input.closest("div")?.querySelector("label");
                return label?.textContent === "Project Name";
              }
            );
            expect(projectNameInputs.length).toBe(profile.projects.length);

            // 5. Number of technology category groups matches Object.keys(profile.technologies).length
            const techKeys = Object.keys(profile.technologies);
            // Each category renders a label with the category name inside the Technologies section card
            const sectionCards = container.querySelectorAll(".section-card");
            // Technologies is the last section card (after analysis, personal info, education, experience, projects)
            const techCard = Array.from(sectionCards).find((card) => {
              const h3 = card.querySelector("h3");
              return h3?.textContent === "Technologies";
            });

            if (techKeys.length === 0) {
              // No category groups should be rendered (only the "+ Add Category" button)
              if (techCard) {
                const categoryLabels = techCard.querySelectorAll("label");
                expect(categoryLabels.length).toBe(0);
              }
            } else {
              expect(techCard).not.toBeUndefined();
              const categoryLabels = techCard!.querySelectorAll("label");
              expect(categoryLabels.length).toBe(techKeys.length);
            }
          } finally {
            unmount();
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});


// Feature: resume-upload-analysis, Property 4: Add entry grows section
// **Validates: Requirements 4.7, 4.8**

describe("Property 4: Add entry grows section", () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it(
    "clicking '+ Add' buttons increases section length by exactly 1, and '+ Bullet Points' increases bullet count by 1",
    { timeout: 60000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(resumeDetailArb, async (detail) => {
          global.fetch = async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.match(/\/resumes\/\d+$/)) {
              return new Response(JSON.stringify(detail), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("Not found", { status: 404 });
          };

          const { unmount, container } = render(
            <MemoryRouter initialEntries={["/app/resume/1"]}>
              <Routes>
                <Route path="/app/resume/:id" element={<ResumeDetail />} />
              </Routes>
            </MemoryRouter>
          );

          try {
            // Wait for loading to finish
            await waitFor(() => {
              expect(container.querySelector(".settings-loading")).toBeNull();
            });

            const profile = detail.profile;

            // Helper: count inputs by their associated label text
            const countInputsByLabel = (labelText: string): number => {
              const inputs = container.querySelectorAll<HTMLInputElement>("input");
              return Array.from(inputs).filter((input) => {
                const label = input.closest("div")?.querySelector("label");
                return label?.textContent === labelText;
              }).length;
            };

            // Helper: find a button by its text content
            const findButton = (text: string): HTMLButtonElement | null => {
              const buttons = container.querySelectorAll<HTMLButtonElement>("button");
              return Array.from(buttons).find((btn) => btn.textContent?.trim() === text) || null;
            };

            // --- Test 1: Click "+ Add Education" → education count increases by 1 ---
            const initialEducationCount = countInputsByLabel("School");
            expect(initialEducationCount).toBe(profile.education.length);

            const addEducationBtn = findButton("+ Add Education");
            expect(addEducationBtn).not.toBeNull();
            fireEvent.click(addEducationBtn!);

            const newEducationCount = countInputsByLabel("School");
            expect(newEducationCount).toBe(initialEducationCount + 1);

            // --- Test 2: Click "+ Add Experience" → experience count increases by 1 ---
            const initialExperienceCount = countInputsByLabel("Company");
            expect(initialExperienceCount).toBe(profile.experience.length);

            const addExperienceBtn = findButton("+ Add Experience");
            expect(addExperienceBtn).not.toBeNull();
            fireEvent.click(addExperienceBtn!);

            const newExperienceCount = countInputsByLabel("Company");
            expect(newExperienceCount).toBe(initialExperienceCount + 1);

            // --- Test 3: Click "+ Add Project" → project count increases by 1 ---
            const initialProjectCount = countInputsByLabel("Project Name");
            expect(initialProjectCount).toBe(profile.projects.length);

            const addProjectBtn = findButton("+ Add Project");
            expect(addProjectBtn).not.toBeNull();
            fireEvent.click(addProjectBtn!);

            const newProjectCount = countInputsByLabel("Project Name");
            expect(newProjectCount).toBe(initialProjectCount + 1);

            // --- Test 4: Click "+ Bullet Points" on experience entry → bullet count increases by 1 ---
            // After adding experience above, there's at least 1 experience entry
            // Count all bullet inputs in the Experience section before clicking
            const experienceSection = Array.from(container.querySelectorAll(".section-card")).find((card) => {
              const h3 = card.querySelector("h3");
              return h3?.textContent === "Experience";
            });
            expect(experienceSection).not.toBeUndefined();

            // Find all "+ Bullet Points" buttons in the experience section
            const bulletBtns = Array.from(experienceSection!.querySelectorAll<HTMLButtonElement>("button")).filter(
              (btn) => btn.textContent?.trim() === "+ Bullet Points"
            );
            expect(bulletBtns.length).toBeGreaterThan(0);

            // Count bullet inputs in experience section (inputs under "Bullet Points" label)
            const countBulletInputs = (): number => {
              const bulletLabels = Array.from(experienceSection!.querySelectorAll("label")).filter(
                (label) => label.textContent === "Bullet Points"
              );
              let count = 0;
              for (const label of bulletLabels) {
                const parentDiv = label.closest("div");
                if (parentDiv) {
                  count += parentDiv.querySelectorAll("input[type='text']").length;
                }
              }
              return count;
            };

            const initialBulletCount = countBulletInputs();

            // Click the first "+ Bullet Points" button in experience section
            fireEvent.click(bulletBtns[0]);

            const newBulletCount = countBulletInputs();
            expect(newBulletCount).toBe(initialBulletCount + 1);
          } finally {
            unmount();
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});


// Feature: resume-upload-analysis, Property 5: Save payload matches editor state
// **Validates: Requirements 4.9**

describe("Property 5: Save payload matches editor state", () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it(
    "clicking Save sends a PUT request whose body contains the complete current profile state",
    { timeout: 60000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(resumeDetailArb, async (detail) => {
          let capturedBody: any = null;

          global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.match(/\/resumes\/\d+$/) && init?.method === "PUT") {
              capturedBody = JSON.parse(init.body as string);
              return new Response(JSON.stringify(detail), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            if (url.match(/\/resumes\/\d+$/)) {
              return new Response(JSON.stringify(detail), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("Not found", { status: 404 });
          };

          const { unmount, container } = render(
            <MemoryRouter initialEntries={["/app/resume/1"]}>
              <Routes>
                <Route path="/app/resume/:id" element={<ResumeDetail />} />
              </Routes>
            </MemoryRouter>
          );

          try {
            // Wait for loading to finish
            await waitFor(() => {
              expect(container.querySelector(".settings-loading")).toBeNull();
            });

            // Click the "Save Changes" button
            const saveButton = Array.from(
              container.querySelectorAll<HTMLButtonElement>("button")
            ).find((btn) => btn.textContent?.trim() === "Save Changes");
            expect(saveButton).not.toBeUndefined();
            fireEvent.click(saveButton!);

            // Wait for the PUT request to be captured
            await waitFor(() => {
              expect(capturedBody).not.toBeNull();
            });

            // Verify the PUT body contains a `profile` field
            expect(capturedBody).toHaveProperty("profile");

            // Verify the profile in the PUT body matches the loaded profile
            // Since we didn't modify anything, the PUT body should contain the exact same profile
            const sentProfile = capturedBody.profile;
            const expectedProfile = detail.profile;

            expect(sentProfile.name).toBe(expectedProfile.name);
            expect(sentProfile.email).toBe(expectedProfile.email);
            expect(sentProfile.phone).toBe(expectedProfile.phone);
            expect(sentProfile.location).toBe(expectedProfile.location);
            expect(sentProfile.linkedin_url).toBe(expectedProfile.linkedin_url);
            expect(sentProfile.github_url).toBe(expectedProfile.github_url);
            expect(sentProfile.other_link).toBe(expectedProfile.other_link);

            // Verify education entries match
            expect(sentProfile.education.length).toBe(expectedProfile.education.length);
            for (let i = 0; i < expectedProfile.education.length; i++) {
              expect(sentProfile.education[i].school).toBe(expectedProfile.education[i].school);
              expect(sentProfile.education[i].degree).toBe(expectedProfile.education[i].degree);
              expect(sentProfile.education[i].start_date).toBe(expectedProfile.education[i].start_date);
              expect(sentProfile.education[i].end_date).toBe(expectedProfile.education[i].end_date);
              expect(sentProfile.education[i].gpa).toBe(expectedProfile.education[i].gpa);
              expect(sentProfile.education[i].achievements).toEqual(expectedProfile.education[i].achievements);
              expect(sentProfile.education[i].coursework).toEqual(expectedProfile.education[i].coursework);
            }

            // Verify experience entries match
            expect(sentProfile.experience.length).toBe(expectedProfile.experience.length);
            for (let i = 0; i < expectedProfile.experience.length; i++) {
              expect(sentProfile.experience[i].company).toBe(expectedProfile.experience[i].company);
              expect(sentProfile.experience[i].title).toBe(expectedProfile.experience[i].title);
              expect(sentProfile.experience[i].location).toBe(expectedProfile.experience[i].location);
              expect(sentProfile.experience[i].start_date).toBe(expectedProfile.experience[i].start_date);
              expect(sentProfile.experience[i].end_date).toBe(expectedProfile.experience[i].end_date);
              expect(sentProfile.experience[i].bullets).toEqual(expectedProfile.experience[i].bullets);
            }

            // Verify project entries match
            expect(sentProfile.projects.length).toBe(expectedProfile.projects.length);
            for (let i = 0; i < expectedProfile.projects.length; i++) {
              expect(sentProfile.projects[i].name).toBe(expectedProfile.projects[i].name);
              expect(sentProfile.projects[i].link).toBe(expectedProfile.projects[i].link);
              expect(sentProfile.projects[i].organization).toBe(expectedProfile.projects[i].organization);
              expect(sentProfile.projects[i].location).toBe(expectedProfile.projects[i].location);
              expect(sentProfile.projects[i].start_date).toBe(expectedProfile.projects[i].start_date);
              expect(sentProfile.projects[i].end_date).toBe(expectedProfile.projects[i].end_date);
              expect(sentProfile.projects[i].bullets).toEqual(expectedProfile.projects[i].bullets);
            }

            // Verify technologies match
            expect(sentProfile.technologies).toEqual(expectedProfile.technologies);

            // Verify skills match
            expect(sentProfile.skills).toEqual(expectedProfile.skills);
          } finally {
            unmount();
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});


// Feature: resume-upload-analysis, Property 10: Analysis report rendering
// **Validates: Requirements 5.3, 5.4, 5.5, 5.6, 10.5**

interface AnalysisReportData {
  overall_grade: "EXCELLENT" | "GOOD" | "FAIR";
  urgent_fix_count: number;
  critical_fix_count: number;
  optional_fix_count: number;
  summary: string;
  highlights: string[];
}

interface ResumeDetailWithAnalysis {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  profile: ResumeProfile;
  analysis_report: AnalysisReportData;
  created_at: string;
  updated_at: string;
}

/* ===== Generators for Property 10 ===== */

const analysisReportArb: fc.Arbitrary<AnalysisReportData> = fc.record({
  overall_grade: fc.oneof(
    fc.constant("EXCELLENT" as const),
    fc.constant("GOOD" as const),
    fc.constant("FAIR" as const)
  ),
  urgent_fix_count: fc.nat({ max: 50 }),
  critical_fix_count: fc.nat({ max: 50 }),
  optional_fix_count: fc.nat({ max: 50 }),
  summary: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
  highlights: fc.array(
    fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    { minLength: 1, maxLength: 5 }
  ),
});

const resumeDetailWithAnalysisArb: fc.Arbitrary<ResumeDetailWithAnalysis> = fc
  .tuple(resumeProfileArb, analysisReportArb)
  .map(([profile, analysisReport]) => ({
    id: 1,
    name: "Test Resume",
    target_job_title: "Software Engineer",
    is_primary: false,
    profile,
    analysis_report: analysisReport,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
  }));

describe("Property 10: Analysis report rendering", () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it(
    "renders grade badge with correct CSS class, fix counts, summary text, and all highlights",
    { timeout: 60000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(resumeDetailWithAnalysisArb, async (detail) => {
          global.fetch = async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.match(/\/resumes\/\d+$/)) {
              return new Response(JSON.stringify(detail), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("Not found", { status: 404 });
          };

          const { unmount, container } = render(
            <MemoryRouter initialEntries={["/app/resume/1"]}>
              <Routes>
                <Route path="/app/resume/:id" element={<ResumeDetail />} />
              </Routes>
            </MemoryRouter>
          );

          try {
            // Wait for loading to finish
            await waitFor(() => {
              expect(container.querySelector(".settings-loading")).toBeNull();
            });

            const report = detail.analysis_report;

            // 1. Grade badge has correct CSS class
            const gradeBadge = container.querySelector(".grade-badge");
            expect(gradeBadge).not.toBeNull();

            const expectedClassMap: Record<string, string> = {
              EXCELLENT: "grade-excellent",
              GOOD: "grade-good",
              FAIR: "grade-fair",
            };
            const expectedClass = expectedClassMap[report.overall_grade];
            expect(gradeBadge!.classList.contains(expectedClass)).toBe(true);

            // 2. Grade badge text contains the grade string
            expect(gradeBadge!.textContent).toContain(report.overall_grade);

            // 3. Fix counts are displayed (urgent, critical, optional numbers visible)
            const analysisSection = container.querySelector(".analysis-report");
            expect(analysisSection).not.toBeNull();
            const analysisText = analysisSection!.textContent || "";
            expect(analysisText).toContain(String(report.urgent_fix_count));
            expect(analysisText).toContain(String(report.critical_fix_count));
            expect(analysisText).toContain(String(report.optional_fix_count));

            // 4. Summary text is rendered
            const summaryEl = container.querySelector(".analysis-summary");
            expect(summaryEl).not.toBeNull();
            expect(summaryEl!.textContent).toBe(report.summary);

            // 5. All highlights are rendered (one li per highlight)
            const highlightsList = container.querySelector(".analysis-highlights");
            expect(highlightsList).not.toBeNull();
            const highlightItems = highlightsList!.querySelectorAll("li");
            expect(highlightItems.length).toBe(report.highlights.length);
            for (let i = 0; i < report.highlights.length; i++) {
              expect(highlightItems[i].textContent).toBe(report.highlights[i]);
            }
          } finally {
            unmount();
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});
