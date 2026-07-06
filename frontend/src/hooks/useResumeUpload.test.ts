import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useResumeUpload, isValidResumeFile } from "./useResumeUpload";

vi.mock("./useAuthFetch", () => ({
  default: { post: vi.fn() },
}));
import api from "./useAuthFetch";

function pdf(name = "cv.pdf") {
  return new File(["x"], name, { type: "application/pdf" });
}

describe("useResumeUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects non-pdf/docx before calling the API", async () => {
    const { result } = renderHook(() => useResumeUpload());
    await act(async () => { await result.current.upload(new File(["x"], "a.txt", { type: "text/plain" })); });
    expect(result.current.fileError).toBeTruthy();
    expect(result.current.state).toBe("upload");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("posts to /resumes/upload and lands on success with the result", async () => {
    (api.post as any).mockResolvedValue({ data: { id: 7, profile: { name: "Jane" } } });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useResumeUpload({ onSuccess }));
    await act(async () => { await result.current.upload(pdf()); });
    await waitFor(() => expect(result.current.state).toBe("success"));
    expect(api.post).toHaveBeenCalledWith("/resumes/upload", expect.any(FormData));
    expect(result.current.result).toEqual({ id: 7, profile: { name: "Jane" } });
    expect(onSuccess).toHaveBeenCalledWith({ id: 7, profile: { name: "Jane" } });
  });

  it("surfaces server errors and resets back to upload", async () => {
    (api.post as any).mockRejectedValue({ response: { data: { detail: "boom" } } });
    const { result } = renderHook(() => useResumeUpload());
    await act(async () => { await result.current.upload(pdf()); });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.apiError).toBe("boom");
    act(() => result.current.reset());
    expect(result.current.state).toBe("upload");
  });

  it("isValidResumeFile accepts .docx by extension", () => {
    expect(isValidResumeFile(new File(["x"], "r.docx", { type: "" }))).toBe(true);
    expect(isValidResumeFile(new File(["x"], "r.png", { type: "image/png" }))).toBe(false);
  });
});
