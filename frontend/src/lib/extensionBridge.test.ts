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

  it("resolves not-installed when chrome reports lastError, even if a response is passed", async () => {
    // A reply that would otherwise mean "connected". If the implementation stopped
    // reading lastError, this would resolve "connected", that is the regression
    // this test exists to catch. (Reading lastError is what suppresses Chrome's
    // "Unchecked runtime.lastError" console warning for users with no extension.)
    setChrome((_id, _msg, cb) => cb({ ok: true, connected: true }), {
      message: "Receiving end does not exist.",
    });
    await expect(pingExtension()).resolves.toBe("not-installed");
  });

  it("resolves not-installed on timeout rather than hanging or rejecting", async () => {
    setChrome(() => {
      /* never invokes the callback */
    });
    await expect(pingExtension(30)).resolves.toBe("not-installed");
  });
});

describe("pingExtension with several extension ids", () => {
  // EXTENSION_IDS is built once, at module-evaluation time, so the env has to be
  // stubbed before a *fresh* copy of the module is imported.
  async function importWithIds(ids: string): Promise<typeof pingExtension> {
    vi.stubEnv("VITE_EXTENSION_IDS", ids);
    vi.resetModules();
    return (await import("./extensionBridge")).pingExtension;
  }

  beforeEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
  });
  afterEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps waiting after the first id misses and takes the second id's answer", async () => {
    const ping = await importWithIds("id-one,id-two");
    setChrome((id, _msg, cb) => {
      if (id === "id-one") {
        cb(undefined); // nothing installed behind this id
        return;
      }
      cb({ ok: true, connected: false });
    });
    // Pins the `outstanding` counter: one miss out of two ids must NOT settle the
    // ping. An implementation that resolved on the first miss says "not-installed"
    // here and hides an extension the user really has installed.
    await expect(ping()).resolves.toBe("installed");
  });

  it("takes the first real answer and ignores a late reply from another id", async () => {
    const ping = await importWithIds("id-one,id-two");
    let replyLate: ((r: unknown) => void) | undefined;
    setChrome((id, _msg, cb) => {
      if (id === "id-one") {
        cb({ ok: true, connected: true }); // first real answer wins
        return;
      }
      replyLate = cb; // id-two answers only after the ping has settled
    });

    const pending = ping();
    await expect(pending).resolves.toBe("connected");

    // A contradicting late reply must not downgrade the settled state.
    expect(replyLate).toBeTypeOf("function");
    replyLate?.({ ok: true, connected: false });
    await expect(pending).resolves.toBe("connected");
  });

  it("never rejects when every id misses", async () => {
    const ping = await importWithIds("id-one,id-two");
    setChrome((_id, _msg, cb) => cb(undefined));
    await expect(ping()).resolves.toBe("not-installed");
  });
});
