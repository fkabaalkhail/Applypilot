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

/**
 * REGRESSION: after the extension is reloaded/updated, a content script already
 * injected in an open tab is ORPHANED. The teardown used to only disconnect
 * observers, leaving the panel fully rendered — Autofill enabled, clicking it
 * silently doing nothing, no flow able to start (the background is
 * unreachable). Indistinguishable from "the extension is broken".
 */
describe("orphaned panel tells the user to reload", () => {
  it("disables Autofill, hides the flow controls and shows the reason", async () => {
    const { buildHTML, installRefs, showReloadRequired, updateFlowProgress } = await import(
      "../src/content/overlay"
    );
    const host = document.createElement("div");
    host.className = "ap-root";
    host.innerHTML = buildHTML();
    document.body.append(host);
    installRefs(host as HTMLDivElement);

    // A parked flow is on screen: gate visible, Autofill live.
    updateFlowProgress({ phase: "ready", step: 1, filledOk: 4, filledFail: 0, nextLabel: "Next" });
    expect((host.querySelector(".ap-flow-next-wrap") as HTMLElement).style.display).toBe("flex");

    showReloadRequired();

    expect((host.querySelector("#ap-btn-autofill") as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector(".ap-flow-next-wrap") as HTMLElement).style.display).toBe("none");
    expect((host.querySelector("#ap-flow") as HTMLElement).style.display).toBe("none");
    const banner = host.querySelector("#ap-banner") as HTMLElement;
    expect(banner.style.display).toBe("block");
    expect(banner.textContent).toMatch(/reload this page/i);
  });
});
