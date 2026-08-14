import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const get = vi.fn();
const del = vi.fn();
vi.mock("../auth/api", () => ({ default: { get: (...a: any[]) => get(...a), delete: (...a: any[]) => del(...a) } }));

import AdminFeedback from "./AdminFeedback";

const row = (over: Record<string, any> = {}) => ({
  id: 1,
  user_id: "12",
  email: "student@school.edu",
  category: "bug_report",
  message: "autofill put my employer in the certification box",
  wants_followup: false,
  created_at: "2026-08-12T10:00:00",
  ...over,
});

const page = (items: any[], total = items.length) => ({ data: { items, total } });

describe("AdminFeedback", () => {
  beforeEach(() => {
    get.mockReset();
    del.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows each submission with its author and message", async () => {
    get.mockResolvedValue(page([row()]));

    render(<AdminFeedback />);

    expect(await screen.findByText("student@school.edu")).toBeInTheDocument();
    expect(screen.getByText(/certification box/)).toBeInTheDocument();
  });

  it("renders a plain not-found for a signed-in non-admin", async () => {
    // The hidden URL is not the protection; the server's 403 is. The page must
    // not confirm that an admin console lives here.
    get.mockRejectedValue({ response: { status: 403 } });

    render(<AdminFeedback />);

    expect(await screen.findByText(/page not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /feedback/i })).toBeNull();
  });

  it("deletes the chosen item and leaves the others", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    get.mockResolvedValue(
      page([row({ id: 1, message: "delete me" }), row({ id: 2, message: "keep me" })])
    );
    del.mockResolvedValue({ data: { status: "deleted", id: 1 } });

    render(<AdminFeedback />);
    await screen.findByText("delete me");
    fireEvent.click(screen.getAllByRole("button", { name: /delete/i })[0]);

    await waitFor(() => expect(del).toHaveBeenCalledWith("/feedback/1"));
    await waitFor(() => expect(screen.queryByText("delete me")).toBeNull());
    expect(screen.getByText("keep me")).toBeInTheDocument();
  });

  it("keeps the item when the confirmation is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    get.mockResolvedValue(page([row({ id: 1, message: "delete me" })]));

    render(<AdminFeedback />);
    await screen.findByText("delete me");
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText("delete me")).toBeInTheDocument();
  });

  it("puts the item back when the delete request fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    get.mockResolvedValue(page([row({ id: 1, message: "delete me" })]));
    del.mockRejectedValue(new Error("network down"));

    render(<AdminFeedback />);
    await screen.findByText("delete me");
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(del).toHaveBeenCalled());
    expect(await screen.findByText("delete me")).toBeInTheDocument();
  });

  it("filters down to submissions awaiting a reply", async () => {
    get.mockResolvedValue(
      page([
        row({ id: 1, message: "wants an answer", wants_followup: true }),
        row({ id: 2, message: "just venting", wants_followup: false }),
      ])
    );

    render(<AdminFeedback />);
    await screen.findByText("just venting");
    fireEvent.click(screen.getByLabelText(/follow-up/i));

    expect(screen.getByText("wants an answer")).toBeInTheDocument();
    expect(screen.queryByText("just venting")).toBeNull();
  });

  it("loads the next page rather than hiding the rest", async () => {
    // The endpoint caps a page. A truncated list that looks complete is the
    // failure mode this guards against.
    get.mockResolvedValueOnce(page([row({ id: 1, message: "first page" })], 2));
    get.mockResolvedValueOnce(page([row({ id: 2, message: "second page" })], 2));

    render(<AdminFeedback />);
    await screen.findByText("first page");
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("second page")).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith("/feedback", { params: { limit: 100, offset: 1 } });
    expect(screen.getByText("first page")).toBeInTheDocument();
  });
});
