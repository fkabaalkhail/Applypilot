import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { ApplyTrackingProvider } from "../context/ApplyTracking";
import JobDetailView from "../components/JobDetailView";
import { resetLiveChecks } from "../lib/jobListing";

const apiPost = vi.fn();
const apiGet = vi.fn();
vi.mock("../auth/api", () => ({
  default: {
    post: (...args: unknown[]) => apiPost(...args),
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

vi.mock("../lib/resumeCoverage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/resumeCoverage")>();
  return { ...actual, getPrimaryResumeText: () => Promise.resolve("") };
});

vi.mock("../components/JobFilterBar", () => ({
  default: () => <div data-testid="job-filter-bar" />,
  normalizeExperienceLevels: (v: unknown) => (Array.isArray(v) ? v : []),
}));

function renderWithProviders(ui: ReactElement) {
  return render(<ApplyTrackingProvider>{ui}</ApplyTrackingProvider>);
}

const baseJob = {
  id: 11,
  title: "Software Engineer, New Grad",
  company: "Acme",
  location: "Toronto, ON",
  url: "https://acme.wd3.myworkdayjobs.com/en-US/careers/job/Toronto/SWE_R123",
  description:
    "Build and ship services used by millions of people. Work with a small team on distributed systems.",
  match_score: 0,
  match_label: "",
  experience_score: 0,
  skill_score: 0,
  industry_score: 0,
  applicant_count: null,
  source_platform: "ats",
  ats_type: "workday",
  scraped_at: new Date(Date.now() - 3_600_000).toISOString(),
  salary_range: "",
  status: "new",
  listing_status: "active",
};

type LiveAnswer = { id: number; listing_status: string; verdict: string } | Error | "pending";

function mockApi(liveAnswer: LiveAnswer) {
  apiPost.mockImplementation((url: string) => {
    if (url.endsWith("/check-live")) {
      if (liveAnswer === "pending") return new Promise(() => {});
      if (liveAnswer instanceof Error) return Promise.reject(liveAnswer);
      return Promise.resolve({ data: liveAnswer });
    }
    if (url.endsWith("/structure-description")) return Promise.resolve({ data: { sections: [], skills: [] } });
    return Promise.resolve({ data: {} });
  });
}

function notFound() {
  return Object.assign(new Error("HTTP 404"), { response: { status: 404, data: { detail: "Not Found" } } });
}

describe("JobDetailView closed state", () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: [] });
    resetLiveChecks();
  });

  it("shows the closed badge and never links a removed listing", () => {
    mockApi("pending");
    renderWithProviders(<JobDetailView job={{ ...baseJob, listing_status: "removed" }} />);
    expect(screen.getByText("No longer accepting applications")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: /Apply with Autofill/i });
    expect(apply).toBeDisabled();
    expect(screen.getByRole("button", { name: /View Original Post/i })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Apply with Autofill/i })).toBeNull();
  });

  it("treats an expired listing as closed too", () => {
    mockApi("pending");
    renderWithProviders(<JobDetailView job={{ ...baseJob, listing_status: "expired" }} />);
    expect(screen.getByText("No longer accepting applications")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply with Autofill/i })).toBeDisabled();
  });

  it("keeps Apply usable while the live check is in flight", () => {
    mockApi("pending");
    renderWithProviders(<JobDetailView job={baseJob} />);
    expect(apiPost).toHaveBeenCalledWith("/jobs/11/check-live");
    const apply = screen.getByRole("link", { name: /Apply with Autofill/i });
    expect(apply).toHaveAttribute("href", baseJob.url);
    expect(screen.queryByText("No longer accepting applications")).toBeNull();
  });

  it("switches to the closed state when the live check says dead", async () => {
    mockApi({ id: 11, listing_status: "removed", verdict: "dead" });
    const onChange = vi.fn();
    renderWithProviders(<JobDetailView job={baseJob} onListingStatusChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByText("No longer accepting applications")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Apply with Autofill/i })).toBeDisabled();
    expect(onChange).toHaveBeenCalledWith(11, "removed");
  });

  it("closes on a dead verdict even if the status came back unchanged", async () => {
    mockApi({ id: 11, listing_status: "active", verdict: "dead" });
    const onChange = vi.fn();
    renderWithProviders(<JobDetailView job={baseJob} onListingStatusChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(11, "removed"));
    expect(screen.getByText("No longer accepting applications")).toBeInTheDocument();
  });

  it("stays open and quiet when the endpoint is missing", async () => {
    mockApi(notFound());
    const onChange = vi.fn();
    renderWithProviders(<JobDetailView job={baseJob} onListingStatusChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("link", { name: /Apply with Autofill/i })).toBeInTheDocument();
    expect(screen.queryByText("No longer accepting applications")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report an alive listing whose status is unchanged", async () => {
    mockApi({ id: 11, listing_status: "active", verdict: "alive" });
    const onChange = vi.fn();
    renderWithProviders(<JobDetailView job={baseJob} onListingStatusChange={onChange} />);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/jobs/11/check-live"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Apply with Autofill/i })).toBeInTheDocument();
  });

  it("labels the source from source_platform, not always LinkedIn", () => {
    mockApi("pending");
    renderWithProviders(<JobDetailView job={baseJob} />);
    expect(screen.getByText("Workday")).toBeInTheDocument();
    expect(screen.queryByText("LinkedIn")).toBeNull();
  });
});

describe("Jobs page", () => {
  const feedJob = { ...baseJob, id: 21, company: "**Tesla**", saved: false };

  beforeEach(() => {
    apiPost.mockReset();
    apiGet.mockReset();
    resetLiveChecks();
    window.history.replaceState({}, "", "/app");
  });

  function mockFeed(jobs: unknown[], deepLinked?: unknown) {
    apiGet.mockImplementation((url: string) => {
      if (url === "/jobs") return Promise.resolve({ data: jobs });
      if (url === "/jobs/stats") {
        return Promise.resolve({ data: { total: 0, applied: 0, new: 0, avg_match_score: 0, saved_count: 0 } });
      }
      if (deepLinked && url.startsWith("/jobs/")) return Promise.resolve({ data: deepLinked });
      return Promise.resolve({ data: [] });
    });
  }

  it(
    "keeps a deep-linked job open when it is not on the current page",
    async () => {
      mockApi("pending");
      const linked = { ...baseJob, id: 99, title: "Deep Linked Role", company: "**Beta**", listing_status: "expired" };
      mockFeed([feedJob], linked);
      window.history.replaceState({}, "", "/app?job=99");
      const { default: Jobs } = await import("../pages/Jobs");
      const { container } = renderWithProviders(<Jobs />);

      await waitFor(() => {
        expect(container.querySelector(".job-detail-title")?.textContent).toBe("Deep Linked Role");
      });
      // The feed loaded without it, and the panel is still open.
      await waitFor(() => expect(container.querySelectorAll(".jobs-feed .job-card")).toHaveLength(1));
      expect(container.querySelector(".job-detail-title")?.textContent).toBe("Deep Linked Role");
      expect(container.querySelector(".job-detail-company")?.textContent).toBe("Beta");
      // Removed/expired deep links render closed.
      expect(container.querySelector(".job-detail-view .listing-closed-badge")).not.toBeNull();
      expect(window.location.search).toBe("");
    },
    20_000,
  );

  it(
    "drops a job the live check finds dead from the feed but keeps its panel on the closed state",
    async () => {
      mockApi({ id: 21, listing_status: "removed", verdict: "dead" });
      const other = { ...baseJob, id: 22, title: "Other Role", company: "Other Co", saved: false };
      mockFeed([feedJob, other]);
      const { default: Jobs } = await import("../pages/Jobs");
      const { container } = renderWithProviders(<Jobs />);

      const card = await screen.findByText("Software Engineer, New Grad", { selector: ".job-title" });
      // Markdown-bold names are cleaned in the feed.
      expect(container.querySelector(".job-company")?.textContent).toContain("Tesla");
      expect(container.querySelector(".job-company")?.textContent).not.toContain("*");

      act(() => {
        card.click();
      });

      await waitFor(() => {
        expect(container.querySelector(".job-detail-view .listing-closed-badge")).not.toBeNull();
      });
      await waitFor(() => {
        expect(container.querySelector(".jobs-feed .job-title")?.textContent).toBe("Other Role");
      });
      expect(container.querySelectorAll(".jobs-feed .job-card")).toHaveLength(1);
      expect(container.querySelector(".job-detail-title")?.textContent).toBe("Software Engineer, New Grad");
      expect(screen.getByRole("button", { name: /Apply with Autofill/i })).toBeDisabled();
    },
    20_000,
  );
});
