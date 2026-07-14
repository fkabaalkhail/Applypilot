import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const get = vi.fn();
const put = vi.fn();
vi.mock("../auth/api", () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    delete: vi.fn(),
    post: vi.fn(),
  },
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));

vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "you@school.edu",
      first_name: "Wissam",
      last_name: "Elmasry",
      email_verified: true,
      auth_provider: "google",
    },
    logout: vi.fn(),
  }),
}));

vi.mock("../onboarding", () => ({ useOnboarding: () => ({ restart: vi.fn() }) }));
vi.mock("../lib/extensionBridge", () => ({ pingExtension: () => Promise.resolve("connected") }));

import SettingsModal from "./SettingsModal";

const SETTINGS = {
  pause_before_submit: true,
  smooth_scrolling: false,
  follow_companies: false,
};

const renderModal = () =>
  render(
    <MemoryRouter>
      <SettingsModal onClose={() => {}} />
    </MemoryRouter>
  );

describe("SettingsModal", () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    navigate.mockReset();
    get.mockImplementation((url: string) =>
      url === "/settings"
        ? Promise.resolve({ data: SETTINGS })
        : Promise.resolve({ data: { sessions: [] } })
    );
  });

  it("has exactly three tabs: Account, Extension, Security", async () => {
    renderModal();
    await screen.findByRole("button", { name: "Account" });
    expect(screen.getByRole("button", { name: "Extension" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Security" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /job preferences/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /autofill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /profile & contact/i })).toBeNull();
  });

  it("no longer edits profile, job-preference or autofill fields", async () => {
    const { container } = renderModal();
    await screen.findByRole("button", { name: "Account" });
    for (const id of ["first_name", "last_name", "phone", "linkedin_url", "website", "job_title", "location"]) {
      expect(container.querySelector(`#${id}`)).toBeNull();
    }
    expect(screen.queryByPlaceholderText("Question")).toBeNull();
    expect(screen.queryByPlaceholderText("Answer")).toBeNull();
    expect(screen.queryByText(/pre-filled answers/i)).toBeNull();
  });

  it("shows the signed-in identity and OAuth provider on the Account tab", async () => {
    renderModal();
    expect(await screen.findByText("you@school.edu")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("sends the Profile link to /app/profile", async () => {
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: /update profile/i }));
    expect(navigate).toHaveBeenCalledWith("/app/profile");
  });

  it("saves ONLY the extension toggles — never the removed profile fields", async () => {
    put.mockResolvedValue({ data: { ...SETTINGS, smooth_scrolling: true } });
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Extension" }));

    const toggle = await screen.findByRole("checkbox", { name: "Smooth scrolling" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings", { smooth_scrolling: true }));
  });

  it("lists connected devices on the Security tab", async () => {
    get.mockImplementation((url: string) =>
      url === "/settings"
        ? Promise.resolve({ data: SETTINGS })
        : Promise.resolve({
            data: {
              sessions: [
                {
                  sid: "s1",
                  client: "extension",
                  created_at: "2026-07-01T00:00:00Z",
                  last_seen_at: "2026-07-13T00:00:00Z",
                  last_ip: null,
                  user_agent: null,
                  is_current: false,
                },
              ],
            },
          })
    );
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Security" }));
    expect(await screen.findByText(/chrome extension/i)).toBeInTheDocument();
  });
});
