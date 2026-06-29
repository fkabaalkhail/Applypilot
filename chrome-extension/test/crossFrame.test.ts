import { describe, it, expect, vi } from "vitest";
import { shouldAdoptRemoteHost, makeProxyCallbacks, dispatchFormOp } from "../src/content/crossFrame";
import type { OverlayCallbacks } from "../src/content/overlay";

describe("shouldAdoptRemoteHost", () => {
  it("adopts a child host only when the top frame has no recognized fields", () => {
    expect(shouldAdoptRemoteHost(0, 5)).toBe(true);
    expect(shouldAdoptRemoteHost(3, 5)).toBe(false); // top owns its own form → keep local
    expect(shouldAdoptRemoteHost(0, 0)).toBe(false); // remote has nothing either
  });
});

describe("makeProxyCallbacks", () => {
  it("marshals onAutofill through the transport and unwraps the value", async () => {
    const send = vi.fn(async () => ({ ok: true, value: { ok: 2, fail: 0, total: 2, drafts: [] } }));
    const cb = makeProxyCallbacks(send);
    const res = await cb.onAutofill(["a", "b"]);
    expect(send).toHaveBeenCalledWith("onAutofill", [["a", "b"]]);
    expect(res).toEqual({ ok: 2, fail: 0, total: 2, drafts: [] });
  });

  it("fires void methods (onProfileResolved) through the transport without throwing", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const cb = makeProxyCallbacks(send);
    cb.onProfileResolved(null);
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("onProfileResolved", [null]);
  });

  it("rejects a non-value op when the host reports failure", async () => {
    const send = vi.fn(async () => ({ ok: false, error: "frame gone" }));
    const cb = makeProxyCallbacks(send);
    await expect(cb.onInsertAnswer("f-1", "x")).rejects.toThrow(/frame gone/);
  });
});

describe("dispatchFormOp", () => {
  it("invokes the named callback with the args and wraps the result", async () => {
    const onInsertAnswer = vi.fn(async () => ({ ok: true }));
    const ops = { onInsertAnswer } as unknown as OverlayCallbacks;
    const res = await dispatchFormOp(ops, "onInsertAnswer", ["f-1", "hi"]);
    expect(onInsertAnswer).toHaveBeenCalledWith("f-1", "hi");
    expect(res).toEqual({ ok: true, value: { ok: true } });
  });

  it("wraps a thrown error as ok:false", async () => {
    const ops = { onRescan: () => { throw new Error("boom"); } } as unknown as OverlayCallbacks;
    const res = await dispatchFormOp(ops, "onRescan", []);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });
});
