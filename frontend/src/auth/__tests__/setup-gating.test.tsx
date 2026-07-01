import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProtectedRoute } from "../ProtectedRoute";
import * as useAuthMod from "../useAuth";

function mockAuth(over: Record<string, unknown>) {
  vi.spyOn(useAuthMod, "useAuth").mockReturnValue({
    isAuthenticated: true, isLoading: false, isEmailVerified: true,
    user: { id: 1, email: "a@b.c", first_name: "A", last_name: "B", email_verified: true, has_completed_setup: true },
    ...over,
  } as never);
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<ProtectedRoute><div>DASHBOARD</div></ProtectedRoute>} />
        <Route path="/setup" element={<div>SETUP</div>} />
        <Route path="/verify-email" element={<div>VERIFY</div>} />
        <Route path="/sign-in" element={<div>SIGNIN</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute setup gate", () => {
  it("redirects a verified user who has not completed setup to /setup", () => {
    mockAuth({ user: { id: 1, email: "a@b.c", email_verified: true, has_completed_setup: false } });
    renderApp();
    expect(screen.getByText("SETUP")).toBeInTheDocument();
  });

  it("allows a verified user who completed setup into the dashboard", () => {
    mockAuth({});
    renderApp();
    expect(screen.getByText("DASHBOARD")).toBeInTheDocument();
  });
});
