/**
 * Structural guards on the panel's markup. collectRefs() throws on the first
 * missing selector, and that throw aborts the whole overlay mount — the panel
 * then never opens on any page. These assert that the elements the sign-ins
 * modal and the branded edge tab depend on actually exist in buildHTML().
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildHTML } from "../src/content/overlay";

let root: HTMLElement;

beforeAll(() => {
  root = document.createElement("div");
  root.innerHTML = buildHTML();
});

describe("saved sign-ins", () => {
  it("is a section row that opens a modal, not a <details> accordion", () => {
    expect(root.querySelector("#ap-section-signins")).not.toBeNull();
    expect(root.querySelector("details#ap-signins")).toBeNull();
  });

  it("exposes the refs collectRefs() queries", () => {
    for (const sel of ["#ap-signins-modal", "#ap-signins-body", "#ap-signins-count"]) {
      expect(root.querySelector(sel), sel).not.toBeNull();
    }
  });

  it("renders the modal as a backdrop that starts hidden", () => {
    const modal = root.querySelector("#ap-signins-modal")!;
    expect(modal.classList.contains("ap-modal-backdrop")).toBe(true);
    expect(modal.classList.contains("visible")).toBe(false);
  });

  it("gives the modal a close button", () => {
    expect(root.querySelector("#ap-signins-close")).not.toBeNull();
  });

  it("keeps the count badge hidden until there is a credential to count", () => {
    expect(root.querySelector<HTMLElement>("#ap-signins-count")!.style.display).toBe("none");
  });
});

describe("unanswered questions", () => {
  it("exposes the refs collectRefs() queries", () => {
    for (const sel of [
      "#ap-gaps-card",
      "#ap-gaps-text",
      "#ap-gaps-modal",
      "#ap-gaps-body",
      "#ap-gaps-error",
      "#ap-gaps-save",
    ]) {
      expect(root.querySelector(sel), sel).not.toBeNull();
    }
  });

  it("hides the panel card until a fill has run", () => {
    expect(root.querySelector<HTMLElement>("#ap-gaps-card")!.style.display).toBe("none");
  });

  it("offers Skip alongside Save, so answering is never forced", () => {
    expect(root.querySelector("#ap-gaps-skip")).not.toBeNull();
    expect(root.querySelector("#ap-gaps-close")).not.toBeNull();
  });

  it("starts hidden", () => {
    const modal = root.querySelector("#ap-gaps-modal")!;
    expect(modal.classList.contains("ap-modal-backdrop")).toBe(true);
    expect(modal.classList.contains("visible")).toBe(false);
  });
});

describe("autofill information", () => {
  it("has a Remembered answers category", () => {
    expect(root.querySelector('.ap-modal-sidebar-item[data-cat="remembered"]')).not.toBeNull();
  });
});

describe("edge tab", () => {
  it("carries the brand mark plus a chevron for the strict-CSP fallback", () => {
    const tab = root.querySelector(".ap-edge-tab")!;
    expect(tab.querySelector("img.ap-edge-mark")).not.toBeNull();
    expect(tab.querySelector("svg")).not.toBeNull();
  });

  it("leaves the mark's src unset in markup — wireBrandLogo sets it after the error listener", () => {
    expect(root.querySelector(".ap-edge-mark")!.getAttribute("src")).toBeNull();
  });
});
