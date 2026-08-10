import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";

const get = vi.fn();
vi.mock("../auth/api", () => ({
  default: { get: (...a: any) => get(...a), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
// The real renderer measures layout; stub it for this wiring test. The default
// export is the off-screen print node and receives a ref, so forwardRef keeps
// React from logging a "Function components cannot be given refs" warning.
vi.mock("../components/ResumeRenderer", () => ({
  default: React.forwardRef(() => <div data-testid="print-node" />),
  FittedResume: () => <div data-testid="live-preview" />,
}));

import ResumeDetail from "./ResumeDetail";
import { emptyProfile } from "../lib/resumeProfile";

const detail = {
  id: 1, name: "My CV", target_job_title: null, is_primary: true,
  profile: { ...emptyProfile(), name: "Ada Lovelace", summary: "Engineer." },
  analysis_report: null, created_at: "", updated_at: "",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/app/resume/1"]}>
      <Routes><Route path="/app/resume/:id" element={<ResumeDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe("ResumeDetail: two-pane workspace", () => {
  beforeEach(() => get.mockReset());

  it("shows the form and the live preview side by side", async () => {
    get.mockResolvedValue({ data: detail });
    renderPage();
    expect(await screen.findByLabelText("Your name")).toBeTruthy();
    expect(screen.getByTestId("live-preview")).toBeTruthy();
  });

  it("toggles the visible pane via data-pane", async () => {
    get.mockResolvedValue({ data: detail });
    const { container } = renderPage();
    await screen.findByLabelText("Your name");
    const ws = container.querySelector(".rd-workspace")!;
    expect(ws.getAttribute("data-pane")).toBe("edit");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(ws.getAttribute("data-pane")).toBe("preview"));
  });
});
