import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import JobDetailView from "../components/JobDetailView";
import type { ReactElement } from "react";
import { ApplyTrackingProvider } from "../context/ApplyTracking";

function renderWithProviders(ui: ReactElement) {
  return render(<ApplyTrackingProvider>{ui}</ApplyTrackingProvider>);
}

const mockJob = {
  id: 1,
  title: "Senior Software Engineer",
  company: "TechCorp",
  location: "San Francisco, CA",
  url: "https://example.com/job/1",
  description: "We are looking for a senior engineer...",
  match_score: 85,
  match_label: "STRONG MATCH",
  experience_score: 90,
  skill_score: 80,
  industry_score: 85,
  applicant_count: 42,
  source_platform: "linkedin",
  scraped_at: new Date(Date.now() - 3600000).toISOString(),
  salary_range: "$150k-$200k",
  status: "new",
};

const mockJobNoMatch = {
  ...mockJob,
  id: 2,
  match_score: 0,
  match_label: "",
  experience_score: 0,
  skill_score: 0,
  industry_score: 0,
};

describe("JobDetailView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders job details with full match breakdown", () => {
    renderWithProviders(<JobDetailView job={mockJob} />);

    expect(screen.getByText("Senior Software Engineer")).toBeInTheDocument();
    expect(screen.getByText("TechCorp")).toBeInTheDocument();
    expect(screen.getByText("San Francisco, CA")).toBeInTheDocument();
    expect(screen.getByText("We are looking for a senior engineer...")).toBeInTheDocument();
    expect(screen.getByText("View Original Posting")).toBeInTheDocument();
    expect(screen.getByText("👥 42 applicants")).toBeInTheDocument();
  });

  it("renders match breakdown bars", () => {
    renderWithProviders(<JobDetailView job={mockJob} />);

    expect(screen.getByText("Match Breakdown")).toBeInTheDocument();
    expect(screen.getByText("Experience")).toBeInTheDocument();
    expect(screen.getByText("Skill Match")).toBeInTheDocument();
    expect(screen.getByText("Industry Experience")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("displays correct match label for strong match", () => {
    renderWithProviders(<JobDetailView job={mockJob} />);
    expect(screen.getByText("STRONG MATCH")).toBeInTheDocument();
  });

  it("displays correct match label for good match", () => {
    const goodMatchJob = { ...mockJob, match_score: 65, match_label: "GOOD MATCH", experience_score: 65, skill_score: 60, industry_score: 70 };
    renderWithProviders(<JobDetailView job={goodMatchJob} />);
    expect(screen.getByText("GOOD MATCH")).toBeInTheDocument();
  });

  it("displays correct match label for fair match", () => {
    const fairMatchJob = { ...mockJob, match_score: 45, match_label: "FAIR MATCH", experience_score: 40, skill_score: 50, industry_score: 45 };
    renderWithProviders(<JobDetailView job={fairMatchJob} />);
    expect(screen.getByText("FAIR MATCH")).toBeInTheDocument();
  });

  it("triggers match analysis when match_score is 0", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        experience_score: 75,
        skill_score: 70,
        industry_score: 65,
        overall_score: 70,
        match_label: "GOOD MATCH",
      }),
    });
    global.fetch = mockFetch;

    renderWithProviders(<JobDetailView job={mockJobNoMatch} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/ai/match-breakdown/2", { method: "POST" });
    });
  });

  it("shows loading state during analysis", () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // Never resolves

    renderWithProviders(<JobDetailView job={mockJobNoMatch} />);
    expect(screen.getByText("Analyzing match...")).toBeInTheDocument();
  });
});
