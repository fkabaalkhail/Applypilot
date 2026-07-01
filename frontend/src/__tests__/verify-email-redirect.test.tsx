import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// --- Mocks ---------------------------------------------------------------
// api default export — the pending page polls GET /auth/me.
const apiGet = vi.fn();
vi.mock("../auth/api", () => ({ default: { get: (...a: unknown[]) => apiGet(...a), post: vi.fn() } }));

// useAuth — pending page only reads user.email + resendVerification.
vi.mock("../auth/useAuth", () => ({
  useAuth: () => ({ user: { email: "test@example.com" }, resendVerification: vi.fn() }),
}));

import VerifyEmailPage from "../pages/VerifyEmail";

// A controllable in-memory BroadcastChannel so the broadcast path is deterministic.
class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  name: string;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.channels.push(this);
  }
  postMessage(data: unknown) {
    for (const ch of FakeBroadcastChannel.channels) {
      if (ch !== this && !ch.closed && ch.name === this.name) ch.onmessage?.({ data });
    }
  }
  close() {
    this.closed = true;
  }
}

function renderPending() {
  // No ?token → the component starts in the "pending" (Check your inbox) state.
  return render(
    <MemoryRouter initialEntries={["/verify-email"]}>
      <VerifyEmailPage />
    </MemoryRouter>,
  );
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  apiGet.mockReset();
  FakeBroadcastChannel.channels = [];
  (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = FakeBroadcastChannel;
  // Replace window.location with a spon-able stub.
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("VerifyEmail auto-redirect on the waiting tab", () => {
  it("does NOT redirect while the user is still unverified", async () => {
    apiGet.mockResolvedValue({ data: { email_verified: false } });
    renderPending();

    await vi.advanceTimersByTimeAsync(4000); // one poll tick
    await vi.advanceTimersByTimeAsync(4000); // another
    expect(apiGet).toHaveBeenCalledWith("/auth/me");
    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects to /app once polling sees the email verified", async () => {
    apiGet.mockResolvedValue({ data: { email_verified: true } });
    renderPending();

    await vi.advanceTimersByTimeAsync(4000); // first poll → verified
    expect(assign).toHaveBeenCalledWith("/app");
  });

  it("redirects instantly when another tab broadcasts 'verified'", async () => {
    apiGet.mockResolvedValue({ data: { email_verified: false } });
    renderPending();

    // Simulate the verifying tab announcing success.
    const announcer = new FakeBroadcastChannel("email-verification");
    announcer.postMessage("verified");

    await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenCalledWith("/app");
  });

  it("redirects only once even if poll and broadcast both fire", async () => {
    apiGet.mockResolvedValue({ data: { email_verified: true } });
    renderPending();

    const announcer = new FakeBroadcastChannel("email-verification");
    announcer.postMessage("verified");
    await vi.advanceTimersByTimeAsync(8000);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/app");
  });
});
