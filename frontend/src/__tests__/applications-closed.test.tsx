import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiGet = vi.fn();
vi.mock("../auth/api", () => ({
  default: { get: (...args: unknown[]) => apiGet(...args) },
}));

vi.mock("../onboarding", () => ({ PageIntro: () => null }));

import Applications from "../pages/Applications";

const base = {
  platform: "workday",
  company: "Acme",
  status: "applied",
  applied_at: "2026-09-01T12:00:00",
  notes: null,
  resume_version: "original",
};

describe("Applications closed state", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("marks an application whose posting is gone and never links the dead posting", async () => {
    apiGet.mockResolvedValue({
      data: [
        { ...base, id: 1, role: "Closed Role", url: "https://dead.example/1", listing_status: "removed" },
        { ...base, id: 2, role: "Open Role", url: "https://live.example/2", listing_status: "active" },
        { ...base, id: 3, role: "External Role", url: "https://ext.example/3", listing_status: null },
      ],
    });
    const { container } = render(<Applications />);
    await screen.findByText("Closed Role");

    const cards = Array.from(container.querySelectorAll(".job-card"));
    const closedCard = cards.find((c) => c.textContent?.includes("Closed Role")) as HTMLElement;
    const openCard = cards.find((c) => c.textContent?.includes("Open Role")) as HTMLElement;
    const externalCard = cards.find((c) => c.textContent?.includes("External Role")) as HTMLElement;

    expect(closedCard.querySelector(".listing-closed-badge")?.textContent).toContain(
      "No longer accepting applications",
    );
    expect(closedCard.querySelector("a[href='https://dead.example/1']")).toBeNull();
    const viewPosting = closedCard.querySelector("button.btn-outline-detail") as HTMLButtonElement;
    expect(viewPosting.textContent).toContain("View Posting");
    expect(viewPosting.disabled).toBe(true);

    expect(openCard.querySelector(".listing-closed-badge")).toBeNull();
    expect(openCard.querySelector("a[href='https://live.example/2']")).not.toBeNull();
    expect(externalCard.querySelector(".listing-closed-badge")).toBeNull();
    expect(externalCard.querySelector("a[href='https://ext.example/3']")).not.toBeNull();
    expect(openCard.querySelector("a[href='https://live.example/2']")?.getAttribute("title")).toBeNull();
  });

  it("keeps the link to a posting closed on age alone, with a warning", async () => {
    // "expired" comes from the posting's age, never from a check of the
    // posting itself, so the page may still be up.
    apiGet.mockResolvedValue({
      data: [{ ...base, id: 4, role: "Aged Role", url: "https://aged.example/4", listing_status: "expired" }],
    });
    const { container } = render(<Applications />);
    await screen.findByText("Aged Role");

    const card = container.querySelector(".job-card") as HTMLElement;
    expect(card.querySelector(".listing-closed-badge")?.textContent).toContain(
      "No longer accepting applications",
    );
    const viewPosting = card.querySelector("a[href='https://aged.example/4']") as HTMLAnchorElement;
    expect(viewPosting.textContent).toContain("View Posting");
    expect(viewPosting.getAttribute("title")).toBe("This posting may be closed");
    expect(viewPosting.target).toBe("_blank");
    expect(card.querySelector("button.btn-outline-detail")).toBeNull();
  });
});
