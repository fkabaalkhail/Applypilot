import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pingExtension } from "./extensionBridge";

const KNOWN_ID = "apgogjfdpleeajnngkfkfekbddcpodkl";

type SendMessage = (id: string, msg: unknown, cb: (r: unknown) => void) => void;

/** Install a fake chrome.runtime. `lastError` mimics "no receiving end". */
function setChrome(sendMessage: SendMessage, lastError?: { message: string }) {
  (window as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError },
  };
}

describe("pingExtension", () => {
  beforeEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
  });
  afterEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
  });

  it("resolves not-installed when chrome.runtime is absent (non-Chromium)", async () => {
    await expect(pingExtension()).resolves.toBe("not-installed");
  });

  it("sends TAILRD_PING to the known extension id", async () => {
    const send = vi.fn<SendMessage>((_id, _msg, cb) => cb({ ok: true, connected: true }));
    setChrome(send);
    await pingExtension();
    expect(send).toHaveBeenCalledWith(
      KNOWN_ID,
      { type: "TAILRD_PING" },
      expect.any(Function)
    );
  });

  it("resolves connected when the extension replies ok + connected", async () => {
    setChrome((_id, _msg, cb) => cb({ ok: true, connected: true }));
    await expect(pingExtension()).resolves.toBe("connected");
  });

  it("resolves installed when the extension replies ok but not connected", async () => {
    setChrome((_id, _msg, cb) => cb({ ok: true, connected: false }));
    await expect(pingExtension()).resolves.toBe("installed");
  });

  it("resolves not-installed when chrome reports lastError", async () => {
    setChrome((_id, _msg, cb) => cb(undefined), { message: "Receiving end does not exist." });
    await expect(pingExtension()).resolves.toBe("not-installed");
  });

  it("resolves not-installed on timeout rather than hanging or rejecting", async () => {
    setChrome(() => {
      /* never invokes the callback */
    });
    await expect(pingExtension(30)).resolves.toBe("not-installed");
  });
});
