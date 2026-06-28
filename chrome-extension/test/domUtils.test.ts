import { describe, it, expect, beforeEach } from "vitest";
import { deepQueryAll, reattachIfDetached } from "../src/content/domUtils";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("reattachIfDetached", () => {
  it("re-appends a node the page tore out of the document", () => {
    const node = document.createElement("div");
    document.documentElement.appendChild(node);
    node.remove(); // simulate an SPA re-render removing our overlay host
    expect(node.isConnected).toBe(false);

    const reattached = reattachIfDetached(node, document.documentElement);

    expect(reattached).toBe(true);
    expect(node.isConnected).toBe(true);
  });

  it("leaves an already-attached node alone", () => {
    const node = document.createElement("div");
    document.documentElement.appendChild(node);
    expect(reattachIfDetached(node, document.documentElement)).toBe(false);
    expect(node.isConnected).toBe(true);
    node.remove();
  });
});

describe("deepQueryAll — traversal", () => {
  it("finds controls in the main document", () => {
    document.body.innerHTML = `<input id="top" /><textarea id="ta"></textarea>`;
    const ids = deepQueryAll(document, "input, textarea").map((el) => el.id);
    expect(ids).toContain("top");
    expect(ids).toContain("ta");
  });

  it("descends into open shadow DOM", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input id="shadow-field" />`;
    const ids = deepQueryAll(document, "input").map((el) => el.id);
    expect(ids).toContain("shadow-field");
  });

  it("descends into same-origin iframes", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = `<input id="iframe-field" />`;
    const ids = deepQueryAll(document, "input").map((el) => el.id);
    expect(ids).toContain("iframe-field");
  });

  it("does not throw when an iframe's document is inaccessible", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    // Simulate a cross-origin frame: accessing contentDocument throws.
    Object.defineProperty(iframe, "contentDocument", {
      get() {
        throw new Error("cross-origin");
      },
    });
    expect(() => deepQueryAll(document, "input")).not.toThrow();
  });
});
