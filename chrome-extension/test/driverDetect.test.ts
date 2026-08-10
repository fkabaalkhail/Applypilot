import { describe, it, expect, beforeEach } from "vitest";
import { detectFillDriver } from "../src/content/driverDetect";

beforeEach(() => { document.body.innerHTML = ""; });

function reactSelectInput(): HTMLInputElement {
  const container = document.createElement("div");
  container.className = "myselect__container";
  const control = document.createElement("div");
  control.className = "myselect__control";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.id = "react-select-5-input";
  control.append(input);
  container.append(control);
  document.body.append(container);
  return input;
}

describe("detectFillDriver", () => {
  it("tags a react-select input (container + react-select id)", () => {
    expect(detectFillDriver(reactSelectInput(), "boards.greenhouse.io")).toBe("react-select");
  });

  it("tags a Workday widget on a Workday host by data-automation-id", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-automation-id", "multiSelectContainer");
    document.body.append(btn);
    expect(detectFillDriver(btn, "acme.wd5.myworkdayjobs.com")).toBe("workday");
  });

  it("does NOT tag a Workday-looking widget off a Workday host", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-automation-id", "multiSelectContainer");
    document.body.append(btn);
    expect(detectFillDriver(btn, "example.com")).toBeNull();
  });

  it("returns null for a plain native select", () => {
    const sel = document.createElement("select");
    document.body.append(sel);
    expect(detectFillDriver(sel, "boards.greenhouse.io")).toBeNull();
  });

  it("returns null for a plain ARIA combobox with no react-select signature", () => {
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "lb1");
    document.body.append(input);
    expect(detectFillDriver(input, "example.com")).toBeNull();
  });

  it("does NOT tag a Bootstrap select inside a generic *-container wrapper", () => {
    document.body.innerHTML = `<div class="page-container"><select class="form-control"></select></div>`;
    const sel = document.querySelector("select") as HTMLElement;
    expect(detectFillDriver(sel, "boards.greenhouse.io")).toBeNull();
  });

  it("does NOT tag a hand-rolled ARIA combobox with generic BEM classes (no react-select id)", () => {
    document.body.innerHTML = `<div class="dropdown__container"><input role="combobox" class="dropdown__control" aria-controls="lb" /></div>`;
    const input = document.querySelector("input") as HTMLElement;
    expect(detectFillDriver(input, "example.com")).toBeNull();
  });

  // Greenhouse job-boards passes a custom inputId ("country", "605"…), so the
  // input id carries no react-select marker, but the generated placeholder /
  // live-region ids still do. Regression: these fields must route to the driver
  // (they previously fell to the ARIA engine and failed).
  it("tags react-select v5 with a custom inputId via its generated internal ids", () => {
    document.body.innerHTML = `
      <div class="select-shell remix-css-b62m3t-container">
        <span id="react-select-country-live-region"></span>
        <div><div class="select__control">
          <div class="select__value-container">
            <div class="select__placeholder" id="react-select-country-placeholder"></div>
            <div class="select__input-container">
              <input class="select__input" id="country" type="text" role="combobox"
                     aria-describedby="react-select-country-placeholder country-error" />
            </div>
          </div>
        </div></div>
      </div>`;
    const input = document.getElementById("country") as HTMLElement;
    expect(detectFillDriver(input, "job-boards.greenhouse.io")).toBe("react-select");
  });

  it("tags custom-inputId react-select even without aria-describedby (marker in wrapper)", () => {
    document.body.innerHTML = `
      <div class="select-shell">
        <div class="select__control">
          <div class="select__value-container">
            <div class="select__placeholder" id="react-select-609-placeholder">Select...</div>
            <div class="select__input-container">
              <input class="select__input" id="609" type="text" role="combobox" />
            </div>
          </div>
        </div>
      </div>`;
    const input = document.getElementById("609") as HTMLElement;
    expect(detectFillDriver(input, "job-boards.greenhouse.io")).toBe("react-select");
  });
});
