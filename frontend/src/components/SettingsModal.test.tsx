import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CHROME_STORE_URL } from "../lib/extensionStore";
import type { ExtensionState } from "../lib/extensionBridge";

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

// `auth_provider` is optional on UserProfile, so the mock user has to be settable
// per test — the undefined case falls back to "Email & password".
interface MockUser {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  email_verified: boolean;
  auth_provider?: string;
}
const BASE_USER: MockUser = {
  id: 1,
  email: "you@school.edu",
  first_name: "Wissam",
  last_name: "Elmasry",
  email_verified: true,
  auth_provider: "google",
};
let currentUser: MockUser = { ...BASE_USER };

// The factories below are hoisted above the imports, so they must only *close
// over* these bindings — never read them at factory time.
vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({ user: currentUser, logout: vi.fn() }),
}));

vi.mock("../onboarding", () => ({ useOnboarding: () => ({ restart: vi.fn() }) }));

const ping = vi.fn();
vi.mock("../lib/extensionBridge", () => ({ pingExtension: () => ping() }));

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

const setExtState = (state: ExtensionState) => ping.mockResolvedValue(state);

describe("SettingsModal", () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    navigate.mockReset();
    ping.mockReset();
    currentUser = { ...BASE_USER };
    setExtState("connected");
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

  // jsdom resolves the accessible name from the visible label text and ignores the
  // ≤768px rule that hides it, so the role-name queries above would still pass with
  // no aria-label at all. Assert the attribute directly, or the icon-only phone nav
  // could silently lose its accessible names again.
  it("names the nav buttons with aria-label, not the (phone-hidden) label text", async () => {
    renderModal();
    expect(await screen.findByRole("button", { name: "Account" })).toHaveAttribute(
      "aria-label",
      "Account"
    );
    expect(screen.getByRole("button", { name: "Extension" })).toHaveAttribute("aria-label", "Extension");
    expect(screen.getByRole("button", { name: "Security" })).toHaveAttribute("aria-label", "Security");
    expect(screen.getByRole("button", { name: "Log Out" })).toHaveAttribute("aria-label", "Log Out");
    expect(screen.getByRole("button", { name: "Privacy Policy" })).toHaveAttribute(
      "aria-label",
      "Privacy Policy"
    );
  });

  it("marks the open tab with aria-current, not colour alone", async () => {
    renderModal();
    const account = await screen.findByRole("button", { name: "Account" });
    const extension = screen.getByRole("button", { name: "Extension" });
    expect(account).toHaveAttribute("aria-current", "page");
    expect(extension).not.toHaveAttribute("aria-current");

    fireEvent.click(extension);
    expect(extension).toHaveAttribute("aria-current", "page");
    expect(account).not.toHaveAttribute("aria-current");
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

  it("falls back to Email & password when auth_provider is absent", async () => {
    currentUser = { ...BASE_USER, auth_provider: undefined };
    renderModal();
    expect(await screen.findByText("Email & password")).toBeInTheDocument();
    expect(screen.queryByText("Google")).toBeNull();
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

  it("keeps the save bar mounted when an unsaved toggle survives a tab switch", async () => {
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Extension" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Smooth scrolling" }));

    // Switching away must not strand the pending change: without the save bar the
    // edit is silently dropped when the modal closes.
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByText("you@school.edu")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: /save changes/i });
    expect(save).toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("offers Add to Chrome when the extension is not installed", async () => {
    setExtState("not-installed");
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Extension" }));

    expect(await screen.findByText("Not installed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add to chrome/i })).toHaveAttribute(
      "href",
      CHROME_STORE_URL
    );
  });

  it("offers Finish setup when the extension is installed but not signed in", async () => {
    setExtState("installed");
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Extension" }));

    expect(await screen.findByText("Installed — not signed in")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    expect(navigate).toHaveBeenCalledWith("/extension/connect");
  });

  it("offers no action when the extension is already connected", async () => {
    renderModal(); // beforeEach pings "connected"
    fireEvent.click(await screen.findByRole("button", { name: "Extension" }));

    expect(await screen.findByText("Installed and connected")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /add to chrome/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /finish setup/i })).toBeNull();
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
