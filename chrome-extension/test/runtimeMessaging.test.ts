import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isExtensionContextValid,
  postToRuntime,
  sendToRuntime,
  onExtensionContextInvalidated,
  __resetInvalidationHandlerForTests,
} from "../src/content/runtimeMessaging";

function stubChrome(runtime: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime };
}

beforeEach(() => {
  __resetInvalidationHandlerForTests();
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("isExtensionContextValid", () => {
  it("is true while chrome.runtime.id is present (live context)", () => {
    stubChrome({ id: "abc", sendMessage: vi.fn() });
    expect(isExtensionContextValid()).toBe(true);
  });
  it("is false when the content script is orphaned (no runtime.id)", () => {
    stubChrome({ sendMessage: vi.fn() });
    expect(isExtensionContextValid()).toBe(false);
  });
  it("is false when chrome is absent entirely", () => {
    delete (globalThis as { chrome?: unknown }).chrome;
    expect(isExtensionContextValid()).toBe(false);
  });
});

describe("postToRuntime", () => {
  it("sends the message when the context is valid", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    stubChrome({ id: "abc", sendMessage });
    postToRuntime({ type: "FIELDS_UPDATED" });
    expect(sendMessage).toHaveBeenCalledWith({ type: "FIELDS_UPDATED" });
  });

  it("does not send, and fires the teardown handler, when orphaned", () => {
    const sendMessage = vi.fn();
    stubChrome({ sendMessage }); // no id → invalidated
    const teardown = vi.fn();
    onExtensionContextInvalidated(teardown);
    postToRuntime({ type: "FIELDS_UPDATED" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("swallows a synchronous 'Extension context invalidated' throw and fires teardown", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("Extension context invalidated.");
    });
    stubChrome({ id: "abc", sendMessage }); // id present but the send throws
    const teardown = vi.fn();
    onExtensionContextInvalidated(teardown);
    expect(() => postToRuntime({ type: "FIELDS_UPDATED" })).not.toThrow();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("ignores a normal no-receiver rejection (popup closed) while the context stays valid", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("Could not establish connection."));
    stubChrome({ id: "abc", sendMessage });
    const teardown = vi.fn();
    onExtensionContextInvalidated(teardown);
    postToRuntime({ type: "FIELDS_UPDATED" });
    await Promise.resolve();
    await Promise.resolve();
    expect(teardown).not.toHaveBeenCalled();
  });

  it("fires the teardown handler at most once across calls", () => {
    stubChrome({ sendMessage: vi.fn() }); // no id → invalidated
    const teardown = vi.fn();
    onExtensionContextInvalidated(teardown);
    postToRuntime({ type: "A" });
    postToRuntime({ type: "B" });
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

describe("sendToRuntime", () => {
  it("resolves the response when the context is valid", async () => {
    stubChrome({ id: "abc", sendMessage: vi.fn().mockResolvedValue({ ok: true }) });
    await expect(sendToRuntime({ type: "GET_STATUS" })).resolves.toEqual({ ok: true });
  });

  it("resolves undefined (never throws) and fires teardown when orphaned", async () => {
    stubChrome({ sendMessage: vi.fn() }); // no id
    const teardown = vi.fn();
    onExtensionContextInvalidated(teardown);
    await expect(sendToRuntime({ type: "GET_STATUS" })).resolves.toBeUndefined();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined when sendMessage throws synchronously", async () => {
    stubChrome({
      id: "abc",
      sendMessage: vi.fn(() => {
        throw new Error("Extension context invalidated.");
      }),
    });
    await expect(sendToRuntime({ type: "GET_STATUS" })).resolves.toBeUndefined();
  });
});
