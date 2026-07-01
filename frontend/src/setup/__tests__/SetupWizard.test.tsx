import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SetupWizard from "../SetupWizard";
import { AuthContext } from "../../auth/AuthContext";

const putMock = vi.fn().mockResolvedValue({ data: {} });
const navigateMock = vi.fn();
vi.mock("../../auth/api", () => ({ default: { put: (...a: unknown[]) => putMock(...a), post: vi.fn() } }));
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock,
}));

function renderWizard() {
  const setSetupComplete = vi.fn().mockResolvedValue(undefined);
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

describe("SetupWizard", () => {
  beforeEach(() => { localStorage.clear(); putMock.mockClear(); navigateMock.mockClear(); });

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

    // Step 1: welcome (name pre-filled) -> Next
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    // Step 2: role preferences
    fireEvent.click(screen.getByText("Software Engineering"));
    const countrySelect = screen.getByText("Select country").closest("select") as HTMLSelectElement;
    fireEvent.change(countrySelect, { target: { value: "CA" } });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    // Step 3: experience
    fireEvent.click(screen.getByText("Intern/New Grad"));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    // Step 4: target titles (optional) -> Next
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    // Step 5: resume (final) -> Start Matching
    fireEvent.click(screen.getByRole("button", { name: /start matching/i }));

    await waitFor(() => expect(setSetupComplete).toHaveBeenCalledWith(true));

    expect(putMock).toHaveBeenCalledWith(
      "/settings",
      expect.objectContaining({ job_title: "Software Engineering", regions: ["CA"] }),
    );

    const stored = JSON.parse(localStorage.getItem("job-aggregator-filters") as string);
    expect(stored.country).toBe("CA");
    expect(stored.role_category).toContain("Software Engineering");

    expect(navigateMock).toHaveBeenCalledWith("/app");
  });
});
