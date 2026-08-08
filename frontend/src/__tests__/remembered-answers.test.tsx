/**
 * The Remembered Answers section on /app/profile — the web-app half of the
 * extension's answer bank. Both surfaces read and write the same rows, so this
 * covers the three affordances the extension also offers: see, edit, forget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock("../auth/api", () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import { RememberedAnswers } from "../pages/Profile";

const ROWS = [
  { id: 1, question_raw: "Are you willing to relocate?", answer: "Yes", times_reused: 7 },
  { id: 2, question_raw: "Years of experience with Python", answer: "5", times_reused: 0 },
];

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  del.mockReset();
  get.mockResolvedValue({ data: ROWS });
  put.mockResolvedValue({ data: {} });
  del.mockResolvedValue({ data: {} });
});

const toast = () => vi.fn();

describe("RememberedAnswers", () => {
  it("lists the answers from the bank", async () => {
    render(<RememberedAnswers onToast={toast()} />);
    expect(await screen.findByText("Are you willing to relocate?")).toBeTruthy();
    expect(screen.getByText("Years of experience with Python")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("/api/answers");
  });

  it("shows how often an answer has been reused, and hides a zero count", async () => {
    render(<RememberedAnswers onToast={toast()} />);
    expect(await screen.findByText("used 7×")).toBeTruthy();
    expect(screen.queryByText("used 0×")).toBeNull();
  });

  it("saves an edited answer on blur", async () => {
    render(<RememberedAnswers onToast={toast()} />);
    const input = (await screen.findByLabelText("Are you willing to relocate?")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "No" } });
    fireEvent.blur(input);
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/answers/1", { answer: "No" }));
  });

  it("does not save when the answer is unchanged", async () => {
    render(<RememberedAnswers onToast={toast()} />);
    const input = await screen.findByLabelText("Are you willing to relocate?");
    fireEvent.blur(input);
    expect(put).not.toHaveBeenCalled();
  });

  it("restores the previous answer rather than storing a blank one", async () => {
    render(<RememberedAnswers onToast={toast()} />);
    const input = (await screen.findByLabelText("Are you willing to relocate?")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(put).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("Yes"));
  });

  it("forgets an answer and drops it from the list", async () => {
    render(<RememberedAnswers onToast={toast()} />);
    const btn = await screen.findByLabelText("Forget answer to Are you willing to relocate?");
    fireEvent.click(btn);
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/answers/1"));
    await waitFor(() => expect(screen.queryByText("Are you willing to relocate?")).toBeNull());
  });

  it("explains the empty state instead of showing a bare heading", async () => {
    get.mockResolvedValue({ data: [] });
    render(<RememberedAnswers onToast={toast()} />);
    expect(await screen.findByText(/Nothing remembered yet/i)).toBeTruthy();
  });

  it("says so when the bank cannot be loaded", async () => {
    get.mockRejectedValue(new Error("offline"));
    render(<RememberedAnswers onToast={toast()} />);
    expect(await screen.findByText(/Could not load your remembered answers/i)).toBeTruthy();
  });

  it("reports a failed save to the user", async () => {
    put.mockRejectedValue(new Error("500"));
    const onToast = toast();
    render(<RememberedAnswers onToast={onToast} />);
    const input = await screen.findByLabelText("Are you willing to relocate?");
    fireEvent.change(input, { target: { value: "No" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("error", expect.stringMatching(/could not update/i))
    );
  });
});
