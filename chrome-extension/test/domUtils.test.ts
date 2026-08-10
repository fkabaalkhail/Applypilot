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

describe("deepQueryAll, traversal", () => {
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

  it("never descends into the extension's own UI host (the panel)", () => {
    // A genuine page field must still be found.
    document.body.innerHTML = `<input id="page-field" />`;
    // The panel lives in a shadow root on our host and has its own form controls
    // (e.g. the cover-letter tone <select>), those must NEVER be scanned as page
    // fields, or a bare job posting reads as a form and the flow won't click Apply.
    for (const id of ["applypilot-overlay-host"]) {
      const host = document.createElement("div");
      host.id = id;
      document.body.appendChild(host);
      host.attachShadow({ mode: "open" }).innerHTML =
        `<select id="sel-${id}"></select><input id="inp-${id}" />`;
    }
    const ids = deepQueryAll(document, "input, select").map((el) => el.id);
    expect(ids).toContain("page-field");
    expect(ids.some((id) => id.startsWith("sel-") || id.startsWith("inp-"))).toBe(false);
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

describe("bestDisplayLabel, placeholder filler is never the question", () => {
  it("falls past 'Select...' to a usable attribute name", async () => {
    const { bestDisplayLabel } = await import("../src/content/domUtils");
    expect(
      bestDisplayLabel({
        label: "",
        ariaLabel: "",
        placeholder: "Select...",
        nearby: "",
        nameAttr: "candidate_country",
        idAttr: "",
        autocomplete: "",
        typeHint: "",
        testId: "",
      })
    ).toBe("candidate_country");
  });

  it("keeps a real label that merely STARTS with 'Select'", async () => {
    const { bestDisplayLabel } = await import("../src/content/domUtils");
    expect(
      bestDisplayLabel({
        label: "Select your country of residence",
        ariaLabel: "",
        placeholder: "",
        nearby: "",
        nameAttr: "",
        idAttr: "",
        autocomplete: "",
        typeHint: "",
        testId: "",
      })
    ).toBe("Select your country of residence");
  });

  it("returns 'Unlabeled field' when every signal is filler or empty", async () => {
    const { bestDisplayLabel } = await import("../src/content/domUtils");
    expect(
      bestDisplayLabel({
        label: "Select...",
        ariaLabel: "",
        placeholder: "Choose an option",
        nearby: "",
        nameAttr: "",
        idAttr: "",
        autocomplete: "",
        typeHint: "",
        testId: "",
      })
    ).toBe("Unlabeled field");
  });
});

describe("collectSignals, aria-labelledby pointing INSIDE the control", () => {
  it("ignores the widget's own value span (react-aria trigger pattern)", async () => {
    const { collectSignals } = await import("../src/content/domUtils");
    // <button aria-labelledby="val"> where #val is the button's own value text,
    // its "Select an option" must not become the label.
    document.body.innerHTML = `
      <div class="field">
        <span>Gender</span>
        <div class="dropdown">
          <button aria-haspopup="listbox" aria-labelledby="val">
            <span id="val">Select an option</span>
          </button>
        </div>
      </div>`;
    const btn = document.querySelector("button") as HTMLElement;
    const signals = collectSignals(btn);
    expect(signals.label).not.toMatch(/select an option/i);
    expect(signals.label).toBe("Gender"); // promoted from the text beside the widget
  });
});
