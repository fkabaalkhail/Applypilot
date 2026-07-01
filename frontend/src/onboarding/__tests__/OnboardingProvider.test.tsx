import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OnboardingProvider } from "../OnboardingProvider";
import { AuthContext } from "../../auth/AuthContext";

function renderWith(hasCompleted: boolean) {
  const setOnboardingComplete = vi.fn().mockResolvedValue(undefined);
  const value: any = {
    isAuthenticated: true,
    user: { id: 1, email: "a@b.c", first_name: "A", last_name: "", email_verified: true, has_completed_onboarding: hasCompleted },
    isLoading: false,
    setOnboardingComplete,
  };
  render(
    <MemoryRouter initialEntries={["/app"]}>
      <AuthContext.Provider value={value}>
        <OnboardingProvider>
          <div data-tour="jobs-list">jobs</div>
        </OnboardingProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { setOnboardingComplete };
}

describe("OnboardingProvider auto-start", () => {
  beforeEach(() => localStorage.clear());

  it("auto-starts the tour for a first-time user", async () => {
    renderWith(false);
    expect(await screen.findByText(/Welcome to Tailrd/i)).toBeInTheDocument();
  });

  it("does not start for a user who has completed onboarding", async () => {
    renderWith(true);
    await waitFor(() => {}, { timeout: 50 });
    expect(screen.queryByText(/Welcome to Tailrd/i)).not.toBeInTheDocument();
  });
});
