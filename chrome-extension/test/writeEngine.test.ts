import { describe, it, expect, beforeEach } from "vitest";
import { writeControl, verifyControl } from "../src/content/writeEngine";
import type { RuntimeControl } from "../src/content/formScanner";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

function textControl(el: HTMLInputElement | HTMLTextAreaElement): RuntimeControl {
  return { id: "t-1", controlType: el instanceof HTMLTextAreaElement ? "textarea" : "text", el };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("writeControl — text inputs", () => {
  it("fires focus → input → change → blur in that exact order", () => {
    const el = mount(`<input type="text" />`) as HTMLInputElement;
    const seen: string[] = [];
    for (const type of ["focus", "input", "change", "blur"]) {
      el.addEventListener(type, () => seen.push(type));
    }

    writeControl(textControl(el), "Wissam");

    expect(seen).toEqual(["focus", "input", "change", "blur"]);
  });

  it("sets the value through the native setter (bypasses an instance override)", () => {
    const el = mount(`<input type="text" />`) as HTMLInputElement;
    // Emulate React's value tracker: an own-property setter that swallows writes.
    let swallowed = "";
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        return swallowed;
      },
      set(v: string) {
        swallowed = ""; // framework rejects programmatic instance writes
      },
    });

    const res = writeControl(textControl(el), "Wissam");

    expect(res.written).toBe(true);
    // The native prototype setter wrote the real value even though the
    // instance setter would have swallowed `el.value = "..."`.
    const real = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.get!.call(el);
    expect(real).toBe("Wissam");
  });

  it("verifyControl is true after a successful write, false on mismatch", () => {
    const el = mount(`<input type="text" />`) as HTMLInputElement;
    const control = textControl(el);
    writeControl(control, "hello@x.com");
    expect(verifyControl(control, "hello@x.com")).toBe(true);
    expect(verifyControl(control, "different")).toBe(false);
  });

  it("reports written:false for a stale (disconnected) element", () => {
    const el = document.createElement("input");
    const res = writeControl(textControl(el), "x");
    expect(res.written).toBe(false);
  });
});

describe("writeControl — select", () => {
  it("selects an option by visible text and verifies", () => {
    const el = mount(
      `<select><option value="">Pick…</option><option value="ca">Canada</option><option value="us">United States</option></select>`
    ) as HTMLSelectElement;
    const control: RuntimeControl = { id: "s-1", controlType: "select", el };

    const res = writeControl(control, "Canada");

    expect(res.written).toBe(true);
    expect(el.value).toBe("ca");
    expect(verifyControl(control, "Canada")).toBe(true);
  });

  it("verifyControl false when no option matches", () => {
    const el = mount(
      `<select><option value="ca">Canada</option></select>`
    ) as HTMLSelectElement;
    const control: RuntimeControl = { id: "s-2", controlType: "select", el };
    const res = writeControl(control, "Atlantis");
    expect(res.written).toBe(false);
    expect(verifyControl(control, "Atlantis")).toBe(false);
  });
});

describe("writeControl — checkbox", () => {
  it("checks for an affirmative value and verifies", () => {
    const el = mount(`<input type="checkbox" />`) as HTMLInputElement;
    const control: RuntimeControl = { id: "c-1", controlType: "checkbox", el };
    writeControl(control, "Yes");
    expect(el.checked).toBe(true);
    expect(verifyControl(control, "Yes")).toBe(true);
  });
});

describe("writeControl — radio group", () => {
  it("selects the matching radio by label and verifies", () => {
    mount(
      `<fieldset>
         <label><input type="radio" name="auth" value="yes" /> Yes</label>
         <label><input type="radio" name="auth" value="no" /> No</label>
       </fieldset>`
    );
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="auth"]')
    );
    const control: RuntimeControl = { id: "r-1", controlType: "radioGroup", radios };

    writeControl(control, "No");

    expect(radios[1].checked).toBe(true);
    expect(verifyControl(control, "No")).toBe(true);
  });
});

describe("writeControl — unfillable controls", () => {
  it("never writes file inputs", () => {
    const el = mount(`<input type="file" />`) as HTMLInputElement;
    const res = writeControl({ id: "f-1", controlType: "file", el }, "x");
    expect(res.written).toBe(false);
  });
});

describe("idempotency", () => {
  it("verifyControl stays true when the same value is written twice", () => {
    const el = mount(`<input type="text" />`) as HTMLInputElement;
    const control = textControl(el);
    writeControl(control, "stable");
    writeControl(control, "stable");
    expect(verifyControl(control, "stable")).toBe(true);
  });
});

describe("writeControl — never scrolls the page", () => {
  it("focuses text inputs with preventScroll", () => {
    const el = mount(`<input type="text" />`) as HTMLInputElement;
    let opts: FocusOptions | undefined = "untouched" as unknown as FocusOptions;
    const orig = el.focus.bind(el);
    el.focus = (o?: FocusOptions) => {
      opts = o;
      orig(o);
    };
    writeControl(textControl(el), "Wissam");
    expect(opts).toEqual({ preventScroll: true });
  });

  it("focuses selects with preventScroll", () => {
    const el = mount(
      `<select><option value="">Pick…</option><option value="ca">Canada</option></select>`
    ) as HTMLSelectElement;
    let opts: FocusOptions | undefined = "untouched" as unknown as FocusOptions;
    const orig = el.focus.bind(el);
    el.focus = (o?: FocusOptions) => {
      opts = o;
      orig(o);
    };
    writeControl({ id: "s-1", controlType: "select", el }, "Canada");
    expect(opts).toEqual({ preventScroll: true });
  });

  it("focuses contenteditable with preventScroll", () => {
    const el = mount(`<div contenteditable="true"></div>`) as HTMLElement;
    let opts: FocusOptions | undefined = "untouched" as unknown as FocusOptions;
    const orig = el.focus.bind(el);
    el.focus = (o?: FocusOptions) => {
      opts = o;
      orig(o);
    };
    // Mock execCommand since jsdom doesn't support it
    const doc = el.ownerDocument;
    doc.execCommand = () => false;
    writeControl({ id: "ce-1", controlType: "contenteditable", el }, "hello");
    expect(opts).toEqual({ preventScroll: true });
  });
});
