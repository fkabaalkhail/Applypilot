import { describe, it, expect, vi } from "vitest";
import { handleBridgeMessage } from "../src/content/aiModalBridge";

const baseCtx = () => ({
  job: { title: "SWE", company: "Acme", description: "d", url: "u" },
  token: "T1",
  refreshToken: vi.fn().mockResolvedValue("T2"),
  onAttach: vi.fn().mockResolvedValue(undefined),
  postInit: vi.fn(),
  postToken: vi.fn(),
  close: vi.fn(),
});

describe("handleBridgeMessage", () => {
  it("posts init with token + job on port-open", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage({ type: "port-open" }, ctx);
    expect(ctx.postInit).toHaveBeenCalledWith({ type: "init", token: "T1", job: ctx.job });
  });

  it("refreshes token on need-token and posts it back", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage({ type: "need-token" }, ctx);
    expect(ctx.refreshToken).toHaveBeenCalled();
    expect(ctx.postToken).toHaveBeenCalledWith("T2");
    expect(ctx.token).toBe("T2");
  });

  it("attaches on attach message", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage(
      { type: "attach", kind: "resume", dataBase64: "AAAA", filename: "r.pdf", contentType: "application/pdf" },
      ctx,
    );
    expect(ctx.onAttach).toHaveBeenCalledWith("resume", {
      dataBase64: "AAAA", filename: "r.pdf", contentType: "application/pdf",
    });
  });

  it("closes on close message", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage({ type: "close" }, ctx);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("ignores unknown messages", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage({ type: "whatever" }, ctx);
    expect(ctx.postInit).not.toHaveBeenCalled();
    expect(ctx.onAttach).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
  });
});
