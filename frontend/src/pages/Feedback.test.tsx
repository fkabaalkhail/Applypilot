import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.fn();
vi.mock("../auth/api", () => ({ default: { post: (...a: any[]) => post(...a) } }));

import Feedback from "./Feedback";

describe("Feedback", () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { status: "submitted", id: 1 } });
  });

  it("does not offer email follow-up", () => {
    render(<Feedback />);

    expect(screen.queryByLabelText(/follow-up/i)).toBeNull();
  });

  it("sends the category and message on their own", async () => {
    // Pins the request body. The POST contract is the fragile part here: a
    // mismatched path or payload fails only in production.
    render(<Feedback />);
    fireEvent.click(screen.getByLabelText("Bug Report"));
    fireEvent.change(screen.getByLabelText(/tell us more/i), {
      target: { value: "autofill filled the wrong box" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit feedback/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/feedback", {
        category: "bug_report",
        message: "autofill filled the wrong box",
      })
    );
  });

  it("thanks the sender once it is stored", async () => {
    render(<Feedback />);
    fireEvent.click(screen.getByLabelText("Bug Report"));
    fireEvent.change(screen.getByLabelText(/tell us more/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /submit feedback/i }));

    expect(await screen.findByText(/thank you for your feedback/i)).toBeInTheDocument();
  });
});
