import { describe, it, expect, beforeEach } from "vitest";
import { observePage, openShadowRoots } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("openShadowRoots", () => {
  it("collects open shadow roots, including nested ones", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const innerHost = document.createElement("div");
    sr.appendChild(innerHost);
    const nested = innerHost.attachShadow({ mode: "open" });

    const roots = openShadowRoots(document);
    expect(roots).toContain(sr);
    expect(roots).toContain(nested);
  });

  it("returns nothing for a tree with no shadow roots", () => {
    document.body.innerHTML = `<div><input /></div>`;
    expect(openShadowRoots(document)).toEqual([]);
  });
});

describe("observePage — shadow reach", () => {
  it("fires a rescan when a field is added inside an open shadow root", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    sr.appendChild(document.createElement("span")); // shadow root exists at observe time

    let calls = 0;
    const observer = observePage(() => {
      calls++;
    });
    sr.appendChild(document.createElement("input")); // mutate INSIDE the shadow root
    await new Promise((r) => setTimeout(r, 650)); // MutationObserver + 500ms debounce
    observer.disconnect();
    expect(calls).toBeGreaterThan(0);
  });

  it("still fires for top-document mutations", async () => {
    let calls = 0;
    const observer = observePage(() => {
      calls++;
    });
    document.body.appendChild(document.createElement("div"));
    await new Promise((r) => setTimeout(r, 650));
    observer.disconnect();
    expect(calls).toBeGreaterThan(0);
  });
});
