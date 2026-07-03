import { afterEach, describe, expect, it } from "vitest";
import { promptForMissingFields } from "../src/content/missingInfoModal";

/**
 * The missing-info modal must present a real dropdown (with the field's actual
 * options) for choice fields the AI couldn't answer — not a free-text box that
 * just says "Select". Text/textarea fields keep their inputs.
 */

afterEach(() => {
  document.getElementById("tailrd-missing-info-host")?.remove();
  document.body.innerHTML = "";
});

function modalShadow(): ShadowRoot {
  const host = document.getElementById("tailrd-missing-info-host");
  if (!host?.shadowRoot) throw new Error("modal not mounted");
  return host.shadowRoot;
}

describe("promptForMissingFields — choice fields render options", () => {
  it("renders a <select> of the field's options (not a text box) and returns the picked value", async () => {
    const p = promptForMissingFields([
      { id: "f-1", label: "Country", options: ["United States", "Canada", "United Kingdom"] },
    ]);
    const shadow = modalShadow(); // mounted synchronously

    const select = shadow.querySelector('select[data-i="0"]') as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    expect(shadow.querySelector('input[data-i="0"]')).toBeNull(); // NOT a text box
    const values = Array.from(select!.options).map((o) => o.value);
    expect(values).toContain("Canada");
    expect(values).toContain("United States");

    select!.value = "Canada";
    (shadow.querySelector(".mi-save") as HTMLButtonElement).click();
    expect(await p).toEqual({ "f-1": "Canada" });
  });

  it("keeps a text input for free-text fields (no options)", async () => {
    const p = promptForMissingFields([{ id: "f-2", label: "Why do you want this job?" }]);
    const shadow = modalShadow();
    expect(shadow.querySelector('input[data-i="0"]')).toBeTruthy();
    expect(shadow.querySelector('select[data-i="0"]')).toBeNull();
    (shadow.querySelector(".mi-skip") as HTMLButtonElement).click();
    expect(await p).toBeNull();
  });

  it("uses a textarea for multiline fields", async () => {
    const p = promptForMissingFields([{ id: "f-3", label: "Cover note", multiline: true }]);
    const shadow = modalShadow();
    expect(shadow.querySelector('textarea[data-i="0"]')).toBeTruthy();
    expect(shadow.querySelector('select[data-i="0"]')).toBeNull();
    (shadow.querySelector(".mi-skip") as HTMLButtonElement).click();
    await p;
  });

  it("mixes control types in one modal (dropdown + free text)", async () => {
    const p = promptForMissingFields([
      { id: "c", label: "Country", options: ["Canada", "USA"] },
      { id: "t", label: "Notes" },
    ]);
    const shadow = modalShadow();
    expect(shadow.querySelector('select[data-i="0"]')).toBeTruthy();
    expect(shadow.querySelector('input[data-i="1"], textarea[data-i="1"]')).toBeTruthy();

    (shadow.querySelector('select[data-i="0"]') as HTMLSelectElement).value = "Canada";
    (shadow.querySelector('[data-i="1"]') as HTMLInputElement).value = "Excited";
    (shadow.querySelector(".mi-save") as HTMLButtonElement).click();
    expect(await p).toEqual({ c: "Canada", t: "Excited" });
  });
});
