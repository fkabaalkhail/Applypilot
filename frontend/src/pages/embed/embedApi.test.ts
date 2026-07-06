import { describe, it, expect, vi } from "vitest";
import { createEmbedBridge } from "./embedApi";

describe("createEmbedBridge", () => {
  it("posts {type:'ready'} to parent and resolves ready on init via the port", async () => {
    const postSpy = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((msg: any, _t: any, transfer?: any) => {
        // Simulate the parent: on 'ready' with a transferred port, reply 'init'.
        if (msg?.type === "ready" && transfer?.[0]) {
          const port: MessagePort = transfer[0];
          port.postMessage({
            type: "init",
            token: "T1",
            job: { title: "SWE", company: "Acme", description: "d", url: "u" },
          });
        }
      });

    const bridge = createEmbedBridge("https://www.tailrd.ca");
    const { token, job } = await bridge.ready;
    expect(token).toBe("T1");
    expect(job.company).toBe("Acme");
    expect(bridge.getToken()).toBe("T1");

    postSpy.mockRestore();
  });

  it("resolves requestFreshToken when parent replies with a token", async () => {
    let captured: MessagePort | null = null;
    const postSpy = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((msg: any, _t: any, transfer?: any) => {
        if (msg?.type === "ready" && transfer?.[0]) {
          captured = transfer[0] as MessagePort;
          captured.postMessage({ type: "init", token: "T1", job: { title: "", company: "", description: "", url: "" } });
        }
      });

    const bridge = createEmbedBridge("*");
    await bridge.ready;
    // The bridge posts 'need-token' on its own port; the test channel's other end
    // is held by the bridge internally, so simulate the parent's reply by pushing
    // a 'token' message back through the captured port.
    const p = bridge.requestFreshToken();
    captured!.postMessage({ type: "token", token: "T2" });
    expect(await p).toBe("T2");
    expect(bridge.getToken()).toBe("T2");

    postSpy.mockRestore();
  });
});
