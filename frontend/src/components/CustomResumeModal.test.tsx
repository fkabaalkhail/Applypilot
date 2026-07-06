import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../auth/api", () => ({ default: { post: (...a: any) => post(...a), get: (...a: any) => get(...a) } }));
// Stub heavy children so the test stays about wiring.
vi.mock("./ResumeRenderer", () => ({ FittedResume: () => <div /> }));
vi.mock("./ResumeEditor", () => ({ default: () => <div /> }));
vi.mock("./AtsPanel", () => ({ default: () => <div /> }));
vi.mock("./VersionsPanel", () => ({ default: () => <div /> }));

import CustomResumeModal from "./CustomResumeModal";

const analysis = {
  overall_score: 70, ats_score: 65, match_label: "GOOD MATCH", keyword_coverage: 50,
  matched_keywords: ["python"], missing_keywords: ["k8s"], strengths: [], weaknesses: [], suggestions: [],
};

describe("CustomResumeModal", () => {
  beforeEach(() => { post.mockReset(); get.mockReset(); });

  it("uses the default /ai/custom-resume-analysis/:id endpoint when no analyze prop", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    post.mockResolvedValue({ data: analysis });
    render(<CustomResumeModal job={{ id: 9, title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} />);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/ai/custom-resume-analysis/9", { resume_id: 3 }));
  });

  it("calls a provided analyze() instead of the default endpoint", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    const analyze = vi.fn().mockResolvedValue(analysis);
    render(<CustomResumeModal job={{ title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} analyze={analyze} generate={vi.fn()} jobId={null} />);
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(3));
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/ai/custom-resume-analysis"), expect.anything());
  });

  it("shows 'Attach to application' instead of 'Apply Now' at review when onAttach is provided", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    const analyze = vi.fn().mockResolvedValue(analysis);
    const rewrite = {
      document: { header: {}, sections: [], theme: {} },
      original_document: { header: {}, sections: [], theme: {} },
      tailored_text: "t", original_text: "o", diff_summary: "",
      original_overall_score: 60, new_overall_score: 75, new_ats_score: 70, new_keyword_coverage: 80,
      version_id: null,
    };
    const generate = vi.fn().mockResolvedValue(rewrite);
    render(<CustomResumeModal job={{ title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} analyze={analyze} generate={generate} jobId={null} onAttach={vi.fn()} />);
    // Step 1 → 2 → 3
    fireEvent.click(await screen.findByRole("button", { name: /Improve My Resume/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Generate My New Resume/i }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /Attach to application/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Apply Now/i })).toBeNull();
  });

  it("renders honest gaps and figures-to-verify at review", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    const analyze = vi.fn().mockResolvedValue(analysis);
    const rewrite = {
      document: { header: {}, sections: [], theme: {} },
      original_document: { header: {}, sections: [], theme: {} },
      tailored_text: "t", original_text: "o", diff_summary: "",
      original_overall_score: 60, new_overall_score: 75, new_ats_score: 70, new_keyword_coverage: 80,
      version_id: null,
      changes: ["Reordered sections to lead with the most relevant experience"],
      gaps: ["Role requires Kubernetes; not shown"],
      figures_to_verify: ["50%"],
    };
    const generate = vi.fn().mockResolvedValue(rewrite);
    render(<CustomResumeModal job={{ title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} analyze={analyze} generate={generate} jobId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Improve My Resume/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Generate My New Resume/i }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(await screen.findByText(/Gaps to consider/i)).toBeTruthy();
    expect(screen.getByText(/Role requires Kubernetes/i)).toBeTruthy();
    expect(screen.getByText(/Verify these figures/i)).toBeTruthy();
    expect(screen.getByText(/Reordered sections/i)).toBeTruthy();
  });
});
