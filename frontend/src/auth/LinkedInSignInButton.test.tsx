import { test, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LinkedInSignInButton } from "./LinkedInSignInButton";

afterEach(() => vi.unstubAllEnvs());

test("hidden when VITE_LINKEDIN_ENABLED is not 'true'", () => {
  vi.stubEnv("VITE_LINKEDIN_ENABLED", "");
  const { container } = render(<MemoryRouter><LinkedInSignInButton /></MemoryRouter>);
  expect(container).toBeEmptyDOMElement();
});

test("renders a link to the backend start endpoint when enabled", () => {
  vi.stubEnv("VITE_LINKEDIN_ENABLED", "true");
  render(
    <MemoryRouter initialEntries={["/sign-in?next=%2Fapp"]}>
      <LinkedInSignInButton />
    </MemoryRouter>
  );
  const link = screen.getByRole("link", { name: /continue with linkedin/i });
  expect(link.getAttribute("href")).toContain("/auth/linkedin/start");
});
