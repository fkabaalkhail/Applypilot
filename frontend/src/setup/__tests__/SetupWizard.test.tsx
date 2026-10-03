import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SetupWizard from "../SetupWizard";
import { AuthContext } from "../../auth/AuthContext";

const putMock = vi.fn().mockResolvedValue({ data: {} });
const postMock = vi.fn().mockResolvedValue({ data: { id: 1, profile: { name: "Jane Doe" } } });
const navigateMock = vi.fn();
vi.mock("../../auth/api", () => ({ default: { put: (...a: unknown[]) => putMock(...a), post: (...a: unknown[]) => postMock(...a) } }));
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock,
}));

function renderWizard(setSetupCompleteOverride?: ReturnType<typeof vi.fn>) {
  const setSetupComplete = setSetupCompleteOverride ?? vi.fn().mockResolvedValue(undefined);
  const value: any = {
    isAuthenticated: true, isLoading: false, logout: vi.fn(),
    user: { id: 1, email: "a@b.c", first_name: "Jane", last_name: "Doe", email_verified: true, has_completed_setup: false },
    setSetupComplete,
  };
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <AuthContext.Provider value={value}>
        <SetupWizard />
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { setSetupComplete };
}

function advanceToFinalStep() {
  // Step 1: welcome (name pre-filled) -> Next
  fireEvent.click(screen.getByRole("button", { name: /next/i }));

  // Step 2: role preferences
  fireEvent.click(screen.getByText("Software Engineering"));
  const countrySelect = screen.getByText("Select country").closest("select") as HTMLSelectElement;
  fireEvent.change(countrySelect, { target: { value: "CA" } });
  fireEvent.click(screen.getByRole("button", { name: /next/i }));

  // Step 3: experience level + job type
  fireEvent.click(screen.getByText("Internship / Co-op"));
  fireEvent.click(screen.getByText("Full-time"));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
}

// The final resume step now requires a real upload before finishing.
async function uploadResumeOnFinalStep() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "cv.pdf", { type: "application/pdf" })] } });
  await waitFor(() => expect(postMock).toHaveBeenCalledWith("/resumes/upload", expect.any(FormData)));
  await waitFor(() => expect(screen.getByRole("button", { name: /start matching/i })).not.toBeDisabled());
}

describe("SetupWizard", () => {
  beforeEach(() => {
    localStorage.clear();
    putMock.mockClear();
    navigateMock.mockClear();
    postMock.mockClear();
    postMock.mockResolvedValue({ data: { id: 1, profile: { name: "Jane Doe" } } });
  });

  it("has no 'I'll do this later' skip button on the resume step", () => {
    renderWizard();
    advanceToFinalStep();
    expect(screen.queryByText(/i'll do this later/i)).toBeNull();
  });

  it("keeps Start Matching disabled until a resume is uploaded", () => {
    renderWizard();
    advanceToFinalStep();
    expect(screen.getByRole("button", { name: /start matching/i })).toBeDisabled();
  });

  it("blocks advancing past a step that fails validation", () => {
    renderWizard();
    // welcome step has name pre-filled from user, so it passes; role step is next
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i })); // role step, nothing selected
    expect(screen.getByText(/at least one job function/i)).toBeInTheDocument();
  });

  it("prefills name from the authenticated user", () => {
    renderWizard();
    expect((screen.getByPlaceholderText("Jane") as HTMLInputElement).value).toBe("Jane");
  });

  it("completing all steps persists settings, seeds filters, flips flag, and navigates", async () => {
    const { setSetupComplete } = renderWizard();

    advanceToFinalStep();

    // Step 4: resume (final, required) -> upload -> Start Matching
    await uploadResumeOnFinalStep();
    fireEvent.click(screen.getByRole("button", { name: /start matching/i }));

    await waitFor(() => expect(setSetupComplete).toHaveBeenCalledWith(true));

    expect(putMock).toHaveBeenCalledWith(
      "/settings",
      expect.objectContaining({
        regions: ["CA"],
        // Canonical value: the spelling scraped_jobs actually stores.
        experience_levels: ["internship"],
        prefilled_answers: expect.objectContaining({ job_types: "full_time" }),
      }),
    );
    // The job FUNCTION is not the current job title the extension types (2026-10-03).
    const settingsPut = putMock.mock.calls.find((c) => c[0] === "/settings")![1] as Record<string, unknown>;
    expect(settingsPut).not.toHaveProperty("job_title");
    // The resume is uploaded inline via the real pipeline, not the old /settings/resume.
    expect(postMock).toHaveBeenCalledWith("/resumes/upload", expect.any(FormData));
    expect(postMock).not.toHaveBeenCalledWith("/settings/resume", expect.anything());

    const stored = JSON.parse(localStorage.getItem("job-aggregator-filters") as string);
    expect(stored.country).toBe("CA");
    expect(stored.role_category).toContain("Software Engineering");
    expect(stored.experience_level).toEqual(["internship"]);

    expect(navigateMock).toHaveBeenCalledWith("/app");
  });

  it("saves the work-authorization and graduation answers to the application profile the extension fills from", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /next/i })); // welcome -> role
    fireEvent.click(screen.getByText("Software Engineering"));
    const countrySelect = screen.getByText("Select country").closest("select") as HTMLSelectElement;
    fireEvent.change(countrySelect, { target: { value: "CA" } });
    const yesCanada = document.querySelector('input[name="authorized_canada"]') as HTMLInputElement; // first = Yes
    fireEvent.click(yesCanada);
    const noUs = document.querySelectorAll('input[name="authorized_us"]')[1] as HTMLInputElement; // second = No
    fireEvent.click(noUs);
    fireEvent.click(screen.getByText("I will need visa sponsorship"));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByText("Internship / Co-op"));
    fireEvent.change(screen.getByLabelText(/expected graduation/i), { target: { value: "2027-04" } });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await uploadResumeOnFinalStep();
    fireEvent.click(screen.getByRole("button", { name: /start matching/i }));
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith("/api/user/application-profile", {
        authorizedCanada: "Yes",
        authorizedUS: "No",
        expectedGraduation: "2027-04",
        requiresSponsorship: "Yes",
      })
    );
  });

  it("writes no application-profile answers the user did not give", async () => {
    renderWizard();
    advanceToFinalStep();
    await uploadResumeOnFinalStep();
    fireEvent.click(screen.getByRole("button", { name: /start matching/i }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/app"));
    expect(putMock).not.toHaveBeenCalledWith("/api/user/application-profile", expect.anything());
  });

  it("offers only levels the job catalogue actually has, in student language", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /next/i })); // welcome -> role

    // Job Type has moved off the role step onto the experience step.
    expect(screen.queryByText("Job Type")).toBeNull();

    fireEvent.click(screen.getByText("Software Engineering"));
    const countrySelect = screen.getByText("Select country").closest("select") as HTMLSelectElement;
    fireEvent.change(countrySelect, { target: { value: "CA" } });
    fireEvent.click(screen.getByRole("button", { name: /next/i })); // role -> experience

    expect(screen.getByText("Internship / Co-op")).toBeInTheDocument();
    expect(screen.getByText("New Grad / Entry Level")).toBeInTheDocument();
    // Job Type now lives here, alongside experience.
    expect(screen.getByText("Job Type")).toBeInTheDocument();
    expect(screen.getByText("Full-time")).toBeInTheDocument();

    // The corporate-ladder options the catalogue has no jobs for are gone.
    for (const dead of ["Director/Executive", "Lead/Staff", "Senior", "Mid Level", "Entry Level"]) {
      expect(screen.queryByText(dead)).toBeNull();
    }
  });

  it("goes straight from experience to the resume step (no target-titles page)", () => {
    renderWizard();
    advanceToFinalStep();
    expect(screen.queryByText(/target roles or industries/i)).toBeNull();
    expect(screen.getByRole("button", { name: /start matching/i })).toBeInTheDocument();
  });

  it("shows an error and re-enables Start Matching when setSetupComplete fails, allowing retry", async () => {
    const setSetupComplete = vi.fn().mockRejectedValue(new Error("boom"));
    renderWizard(setSetupComplete);

    advanceToFinalStep();
    await uploadResumeOnFinalStep();

    const startButton = screen.getByRole("button", { name: /start matching/i });
    fireEvent.click(startButton);

    await waitFor(() => expect(setSetupComplete).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /start matching/i })).not.toBeDisabled();
    expect(navigateMock).not.toHaveBeenCalledWith("/app");
  });
});
