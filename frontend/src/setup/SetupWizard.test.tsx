import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const post = vi.fn();
const put = vi.fn();
vi.mock("../auth/api", () => ({ default: { post: (...a: any) => post(...a), put: (...a: any) => put(...a) } }));

const setSetupComplete = vi.fn().mockResolvedValue(undefined);
vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({ user: { first_name: "A", last_name: "B" }, setSetupComplete }),
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...((await orig()) as object),
  useNavigate: () => navigate,
}));

// Collapse the config steps to a single no-validation step so a single "Next"
// click lands on the appended resume step.
vi.mock("./setupConfig", () => ({
  SETUP_STEPS: [{ id: "welcome", headline: "hi", Component: () => null }],
}));

import SetupWizard from "./SetupWizard";

function renderWizard() {
  return render(<MemoryRouter><SetupWizard /></MemoryRouter>);
}

function gotoResumeStep() {
  const next = screen.getByRole("button", { name: /^Next$/ });
  fireEvent.click(next);
}

describe("SetupWizard resume step", () => {
  beforeEach(() => {
    post.mockReset();
    put.mockReset();
    put.mockResolvedValue({});
    navigate.mockReset();
  });

  it("has no 'I'll do this later' skip button", () => {
    renderWizard();
    gotoResumeStep();
    expect(screen.queryByText(/i'll do this later/i)).toBeNull();
  });

  it("disables Start Matching until a resume is uploaded", () => {
    renderWizard();
    gotoResumeStep();
    const finish = screen.getByRole("button", { name: /Start Matching/i });
    expect(finish).toBeDisabled();
  });

  it("uploads via /resumes/upload (not /settings/resume) and enables finish", async () => {
    post.mockResolvedValue({ data: { id: 42, profile: { name: "Jane" } } });
    renderWizard();
    gotoResumeStep();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "cv.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/resumes/upload", expect.any(FormData)));
    expect(post).not.toHaveBeenCalledWith("/settings/resume", expect.anything());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Start Matching/i })).not.toBeDisabled(),
    );
  });
});
