/**
 * Value-commit robustness — the reliability layer that makes typeaheads, masked
 * inputs, validation-on-keyup frameworks and custom/web-component controls
 * actually register a scripted value (Jobright-parity fill cascade).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setNativeValue, dispatchCommitKeys, dispatchInputEvents } from "../src/content/domUtils";
import { writeControl } from "../src/content/writeEngine";
import type { RuntimeControl } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

interface Rec {
  type: string;
  key?: string;
  keyCode?: number;
  composed?: boolean;
  inputType?: string;
}

function record(el: HTMLElement, types: string[]): Rec[] {
  const seen: Rec[] = [];
  for (const t of types) {
    el.addEventListener(t, (e) => {
      seen.push({
        type: e.type,
        key: (e as KeyboardEvent).key,
        keyCode: (e as KeyboardEvent).keyCode,
        composed: e.composed,
        inputType: (e as InputEvent).inputType,
      });
    });
  }
  return seen;
}

describe("dispatchCommitKeys — Enter keydown/keyup that commits typeaheads", () => {
  it("fires Enter down then up with legacy keyCode 13, bubbling and composed", () => {
    const el = document.createElement("input");
    document.body.append(el);
    const seen = record(el, ["keydown", "keyup"]);
    dispatchCommitKeys(el);
    expect(seen.map((s) => s.type)).toEqual(["keydown", "keyup"]);
    expect(seen.every((s) => s.key === "Enter")).toBe(true);
    // Legacy handlers read keyCode/which — the KeyboardEvent constructor drops
    // them, so they must be forced to 13 or "validate on Enter" code never runs.
    expect(seen.every((s) => s.keyCode === 13)).toBe(true);
    expect(seen.every((s) => s.composed === true)).toBe(true);
  });
});

describe("dispatchInputEvents — crosses shadow boundaries", () => {
  it("fires a composed input (insertText) and a change", () => {
    const el = document.createElement("input");
    document.body.append(el);
    const seen = record(el, ["input", "change"]);
    dispatchInputEvents(el, "hi");
    expect(seen.map((s) => s.type)).toEqual(["input", "change"]);
    expect(seen[0].composed).toBe(true);
    expect(seen[0].inputType).toBe("insertText");
  });
});

describe("writeControl text path fires the full commit cascade", () => {
  it("focus → native set → input → change → Enter(down/up)", () => {
    const el = document.createElement("input");
    el.type = "text";
    document.body.append(el);
    const seen = record(el, ["input", "change", "keydown", "keyup"]);
    const control: RuntimeControl = { id: "t", controlType: "text", el };
    const res = writeControl(control, "Ottawa");
    expect(res.written).toBe(true);
    expect(el.value).toBe("Ottawa");
    const types = seen.map((s) => s.type);
    expect(types).toContain("input");
    expect(types).toContain("change");
    expect(types).toContain("keydown");
    expect(types).toContain("keyup");
    // input must precede the Enter commit
    expect(types.indexOf("input")).toBeLessThan(types.indexOf("keydown"));
  });

  it("does NOT fire Enter for a multi-line textarea (Enter = newline there)", () => {
    const el = document.createElement("textarea");
    document.body.append(el);
    const seen = record(el, ["input", "change", "keydown", "keyup"]);
    const control: RuntimeControl = { id: "t", controlType: "textarea", el };
    writeControl(control, "line one");
    const types = seen.map((s) => s.type);
    expect(types).toContain("input");
    expect(types).not.toContain("keydown");
  });
});

describe("setNativeValue — web-component / non-standard value setting", () => {
  it("uses a value setter defined on a custom element's own prototype", () => {
    class FancySelect extends HTMLElement {
      private _v = "";
      set value(v: string) {
        this._v = v;
      }
      get value(): string {
        return this._v;
      }
    }
    customElements.define("fancy-select-a", FancySelect);
    const el = new FancySelect();
    document.body.append(el);
    setNativeValue(el as unknown as HTMLElement, "Canada");
    expect(el.value).toBe("Canada");
  });

  it("falls back to setAttribute for an element exposing value only as an attribute", () => {
    const el = document.createElement("div"); // no value property/setter at all
    document.body.append(el);
    setNativeValue(el, "Remote");
    expect(el.getAttribute("value")).toBe("Remote");
  });

  it("still drives a standard input through the React-aware prototype setter", () => {
    const el = document.createElement("input");
    document.body.append(el);
    setNativeValue(el, "hello");
    expect(el.value).toBe("hello");
  });
});
