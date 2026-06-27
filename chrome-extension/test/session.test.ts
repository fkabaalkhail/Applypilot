import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal chrome.storage stub (local + session) backed by plain objects.
function makeStorageArea() {
  const data: Record<string, unknown> = {};
  return {
    _data: data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(data, obj); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
}

beforeEach(() => {
  (globalThis as any).chrome = {
    storage: { local: makeStorageArea(), session: makeStorageArea() },
  };
});

describe("getAccessTokenExp", () => {
  it("returns the persisted expiry epoch", async () => {
    const { saveAuth, getAccessTokenExp } = await import("../src/shared/storage");
    // exp = now + 600s, encoded as a JWT-shaped token (header.payload.sig).
    const exp = Math.floor(Date.now() / 1000) + 600;
    const payload = btoa(JSON.stringify({ sub: "1", exp })).replace(/=+$/, "");
    const token = `h.${payload}.s`;
    await saveAuth({ accessToken: token, refreshToken: "r", email: "u@e.com" });
    expect(await getAccessTokenExp()).toBe(exp);
  });
});

describe("ensureFreshAccessToken", () => {
  it("refreshes when the access token expires within the skew window", async () => {
    const storage = await import("../src/shared/storage");
    const nearExp = Math.floor(Date.now() / 1000) + 30; // < 120s skew
    const payload = btoa(JSON.stringify({ sub: "1", exp: nearExp })).replace(/=+$/, "");
    await storage.saveAuth({ accessToken: `h.${payload}.s`, refreshToken: "r-old", email: "u@e.com" });

    const fresh = Math.floor(Date.now() / 1000) + 900;
    const freshPayload = btoa(JSON.stringify({ sub: "1", exp: fresh })).replace(/=+$/, "");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: `h.${freshPayload}.s`, refresh_token: "r-new" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const client = await import("../src/api/client");
    await client.ensureFreshAccessToken();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await storage.getAccessTokenExp()).toBe(fresh);
  });

  it("does not refresh when the access token is comfortably valid", async () => {
    const storage = await import("../src/shared/storage");
    const farExp = Math.floor(Date.now() / 1000) + 900; // > 120s skew
    const payload = btoa(JSON.stringify({ sub: "1", exp: farExp })).replace(/=+$/, "");
    await storage.saveAuth({ accessToken: `h.${payload}.s`, refreshToken: "r", email: "u@e.com" });

    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const client = await import("../src/api/client");
    await client.ensureFreshAccessToken();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
