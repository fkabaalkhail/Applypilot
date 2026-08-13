// chrome-extension/test/domCapture.test.ts
/**
 * Diagnostic DOM snapshots. The contract these pin is a workflow, not a format:
 * a snapshot pasted into test/fixtures/ must still scan the same way the live
 * page did, or the capture is not worth storing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { captureFieldDom, captureOptions, fieldContainer, redactCaptureValue } from "../src/content/domCapture";

beforeEach(() => { document.body.innerHTML = ""; });

const el = (id: string) => document.getElementById(id) as HTMLElement;

describe("fieldContainer", () => {
  it("climbs to the block that holds the field's label", () => {
    document.body.innerHTML = `
      <form><div class="input-wrapper"><label for="a">School</label>
        <span><input id="a"/></span>
      </div></form>`;
    expect(fieldContainer(el("a")).className).toBe("input-wrapper");
  });

  it("never climbs out to the form itself", () => {
    // Capturing the whole form would drag in every OTHER field's markup.
    document.body.innerHTML = `<form id="f"><input id="a"/></form>`;
    expect(fieldContainer(el("a")).tagName).not.toBe("FORM");
  });
});

describe("captureFieldDom keeps what the scanner reads", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="input-wrapper" data-automation-id="formField-school">
        <label for="school--0" class="label">School</label>
        <input id="school--0" name="school" type="text" role="combobox"
               aria-autocomplete="list" aria-labelledby="school--0-label"
               aria-required="true" style="color:red" data-reactid="17"/>
        <svg viewBox="0 0 24 24"><path d="M11.45 16.06L5.9 9.13c-.36-.45.9-1.13.55-1.13z"/></svg>
        <script>window.x = 1</script>
      </div>`;
  });

  it("keeps role, aria-*, name, id, class and test-ids", () => {
    const html = captureFieldDom(el("school--0"));
    for (const kept of [
      'role="combobox"', 'aria-autocomplete="list"', 'aria-required="true"',
      'id="school--0"', 'name="school"', 'class="label"',
      'data-automation-id="formField-school"',
    ]) {
      expect(html, kept).toContain(kept);
    }
  });

  it("keeps the label text, which is the field's identity", () => {
    expect(captureFieldDom(el("school--0"))).toContain("School");
  });

  it("drops scripts, SVG paths and inline styles", () => {
    const html = captureFieldDom(el("school--0"));
    expect(html).not.toContain("window.x");
    expect(html).not.toContain("M11.45");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("data-reactid");
  });

  it("caps a single attribute so one data: URI cannot dominate", () => {
    document.body.innerHTML =
      `<div class="input-wrapper"><label for="b">L</label><input id="b" title="${"x".repeat(9000)}"/></div>`;
    expect(captureFieldDom(el("b")).length).toBeLessThan(700);
  });

  it("caps the whole snapshot and says so", () => {
    // The realistic overflow: a big container (a listbox with 500 options),
    // not one long attribute.
    const opts = Array.from({ length: 500 }, (_, i) => `<div role="option">Option number ${i}</div>`).join("");
    document.body.innerHTML =
      `<div class="input-wrapper"><label for="b">L</label><input id="b"/><div role="listbox">${opts}</div></div>`;
    const html = captureFieldDom(el("b"), { maxChars: 1000 });
    expect(html.length).toBeLessThan(1100);
    expect(html).toContain("truncated");
  });
});

describe("captureFieldDom and typed values", () => {
  beforeEach(() => {
    document.body.innerHTML =
      `<div class="input-wrapper"><label for="c">Email</label><input id="c" value="a@b.com"/></div>`;
  });

  it("blanks serialised values by default", () => {
    expect(captureFieldDom(el("c"))).not.toContain("a@b.com");
  });

  it("keeps them only when the caller opts in", () => {
    expect(captureFieldDom(el("c"), { keepValues: true })).toContain("a@b.com");
  });

  it("never carries a live .value that was set as a property", () => {
    // The common case: the engine typed into the control. outerHTML does not
    // serialise the property, so a snapshot is naturally value-free.
    const input = el("c") as HTMLInputElement;
    input.removeAttribute("value");
    input.value = "secret@example.com";
    expect(captureFieldDom(el("c"), { keepValues: true })).not.toContain("secret@example.com");
  });
});

describe("structure-only capture, for demographic fields", () => {
  beforeEach(() => {
    // A filled react-select renders its committed choice as ordinary text, so
    // markup alone leaks the answer that the value column withheld.
    document.body.innerHTML = `
      <div class="input-wrapper">
        <label for="g">Gender</label>
        <div class="select__single-value">Male</div>
        <input id="g" role="combobox" aria-controls="m"/>
      </div>`;
  });

  it("keeps the answer out of the markup", () => {
    expect(captureFieldDom(el("g"), { stripText: true })).not.toContain("Male");
  });

  it("keeps every structural signal the fill engine reads", () => {
    const html = captureFieldDom(el("g"), { stripText: true });
    for (const kept of ['role="combobox"', 'id="g"', 'class="select__single-value"', "label"]) {
      expect(html, kept).toContain(kept);
    }
  });

  it("leaves ordinary fields' text alone", () => {
    expect(captureFieldDom(el("g"))).toContain("Male");
  });
});

describe("redactCaptureValue", () => {
  it("withholds a demographic answer whatever its category is called", () => {
    // Driven by the field's `sensitive` flag, not by a category allowlist: a
    // new EEO category must be protected the day it is added, not the day
    // somebody remembers to add it here.
    expect(redactCaptureValue("eeoSomethingNew", "Male", true)).toEqual(["<demographic>", true]);
  });

  it("passes an ordinary answer through", () => {
    expect(redactCaptureValue("school", "University of Ottawa")).toEqual(
      ["University of Ottawa", false]
    );
  });

  it("still withholds passwords and ID-shaped values", () => {
    expect(redactCaptureValue("accountPassword", "hunter2")[0]).toBe("<password>");
    expect(redactCaptureValue("unknown", "123-45-6789")[0]).toBe("<redacted-id>");
  });
});

describe("captureOptions reads the list the widget is offering NOW", () => {
  it("reads a native select", () => {
    document.body.innerHTML = `
      <div class="input-wrapper"><label for="d">Degree</label>
        <select id="d"><option>Bachelor's Degree</option><option>Master's Degree</option></select>
      </div>`;
    expect(captureOptions(el("d"))).toEqual(["Bachelor's Degree", "Master's Degree"]);
  });

  it("follows aria-controls to a portaled listbox", () => {
    // react-select renders its menu outside the field's own container.
    document.body.innerHTML = `
      <div class="input-wrapper"><label for="e">School</label>
        <input id="e" role="combobox" aria-controls="menu"/>
      </div>
      <div id="menu" role="listbox">
        <div role="option">University of Ottawa</div><div role="option">McGill University</div>
      </div>`;
    expect(captureOptions(el("e"))).toEqual(["University of Ottawa", "McGill University"]);
  });

  it("returns nothing for a widget whose list has not mounted", () => {
    document.body.innerHTML =
      `<div class="input-wrapper"><label for="f">School</label><input id="f" role="combobox"/></div>`;
    expect(captureOptions(el("f"))).toEqual([]);
  });
});
