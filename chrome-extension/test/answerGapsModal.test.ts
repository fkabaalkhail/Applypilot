/**
 * The modal must offer the SAME control the page offers. Rendering every
 * question as a <select> meant a radio group's answer was picked from a
 * dropdown, and a combobox with no harvested options became a free-text box
 * whose typed answer the widget then rejected.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { gapControlHTML, gapInputHTML, harvestGapOptions, readGapAnswer } from "../src/content/overlay";
import { isBlindConstrainedGap, type AnswerGap } from "../src/content/answerGaps";
import type { ControlType } from "../src/shared/types";

const gap = (extra: Partial<AnswerGap> = {}): AnswerGap => ({
  fieldId: "f1",
  question: "Are you legally authorized to work in Canada?",
  controlType: "text",
  category: "unknown",
  options: [],
  required: true,
  sensitive: false,
  ...extra,
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("gapInputHTML", () => {
  it("renders a radio group as real radios, one per option", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(3); // "No answer" escape hatch + one per option
    expect([...radios].map((r) => r.value)).toEqual(["", "Yes", "No"]);
    expect(root.querySelector("select")).toBeNull();
  });

  it("renders an ARIA radio group the same way", () => {
    const root = mount(gapInputHTML(gap({ controlType: "ariaRadioGroup", options: ["A", "B"] }), 0));
    expect(root.querySelectorAll('input[type="radio"]').length).toBe(3); // + "No answer"
  });

  it("renders a checkbox group as checkboxes", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y", "Z"] }), 0));
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(3);
  });

  it("renders a dropdown for a select and a combobox with known options", () => {
    for (const controlType of ["select", "combobox", "customDropdown"] as const) {
      const root = mount(gapInputHTML(gap({ controlType, options: ["One", "Two"] }), 0));
      const sel = root.querySelector("select");
      expect(sel, controlType).not.toBeNull();
      expect(sel!.options.length).toBe(3); // placeholder + 2
      root.remove();
    }
  });

  it("renders a bare checkbox as a Yes/No pair", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkbox" }), 0));
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect([...radios].map((r) => r.value)).toEqual(["", "Yes", "No"]); // + "No answer"
  });

  it("honours a date / number input hint", () => {
    const root = mount(gapInputHTML(gap({ inputType: "date" }), 0));
    expect(root.querySelector("input")!.getAttribute("type")).toBe("date");
  });
});

describe("readGapAnswer", () => {
  it("reads the checked radio", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    // index 0 is the "No answer" escape hatch, so the options start at 1
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2].checked = true;
    expect(readGapAnswer(root, 0)).toBe("No");
  });

  it("joins the ticked checkboxes", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y", "Z"] }), 0));
    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes[0].checked = true;
    boxes[2].checked = true;
    expect(readGapAnswer(root, 0)).toBe("X, Z");
  });

  it("returns empty when nothing is chosen", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    expect(readGapAnswer(root, 0)).toBe("");
  });

  it("reads a select and a text input", () => {
    const sel = mount(gapInputHTML(gap({ controlType: "select", options: ["One", "Two"] }), 0));
    sel.querySelector("select")!.value = "Two";
    expect(readGapAnswer(sel, 0)).toBe("Two");

    const txt = mount(gapInputHTML(gap({ controlType: "text" }), 1));
    txt.querySelector("input")!.value = "  Ottawa  ";
    expect(readGapAnswer(txt, 1)).toBe("Ottawa");
  });
});

/**
 * A radio, unlike the <select> it replaced, cannot be deselected — and the modal
 * offers no reset, only "Skip for now", which throws away EVERY answer. So a
 * mis-click on a sponsorship question was unrecoverable, and (see
 * answersWorthRemembering) then remembered forever.
 */
describe("gapInputHTML — a radio group stays un-answerable", () => {
  it("prepends a default 'No answer' radio so a mis-click can be undone", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(["", "Yes", "No"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(readGapAnswer(root, 0)).toBe("");

    radios[1].checked = true; // the user answers…
    expect(readGapAnswer(root, 0)).toBe("Yes");
    radios[0].checked = true; // …and takes it back
    expect(readGapAnswer(root, 0)).toBe("");
  });

  it("gives the bare-checkbox Yes/No pair the same escape hatch", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkbox" }), 0));
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(["", "Yes", "No"]);
    expect(radios[0].checked).toBe(true);
    expect(readGapAnswer(root, 0)).toBe("");
  });

  it("leaves a checkbox GROUP alone — a checkbox already un-ticks", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y"] }), 0));
    expect(root.querySelectorAll('input[type="radio"]').length).toBe(0);
    expect([...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((c) => c.value))
      .toEqual(["X", "Y"]);
  });

  it("stays pure and idempotent with the escape hatch in place", () => {
    const g = gap({ controlType: "radioGroup", options: ["Yes", "No"] });
    expect(gapInputHTML(g, 0)).toBe(gapInputHTML(g, 0));
    expect(g.options).toEqual(["Yes", "No"]);
  });
});

describe("harvestGapOptions", () => {
  const combo = (fieldId: string): AnswerGap =>
    gap({ fieldId, controlType: "combobox", options: [], question: `Q ${fieldId}` });

  it("asks only about constrained controls with no known options", async () => {
    const asked: string[][] = [];
    const gaps = [
      combo("a"),
      gap({ fieldId: "b", controlType: "text" }),                      // free text — never asked
      gap({ fieldId: "c", controlType: "select", options: ["Yes"] }),  // already known — never asked
    ];
    await harvestGapOptions(gaps, async (ids) => { asked.push(ids); return {}; });
    expect(asked).toEqual([["a"]]);
  });

  it("writes the harvested options back onto the gap", async () => {
    const gaps = [combo("a")];
    await harvestGapOptions(gaps, async () => ({ a: ["Canada", "United States"] }));
    expect(gaps[0].options).toEqual(["Canada", "United States"]);
  });

  it("leaves a widget that yields nothing as free text", async () => {
    const gaps = [combo("a")];
    await harvestGapOptions(gaps, async () => ({}));
    expect(gaps[0].options).toEqual([]);
  });

  it("survives a harvest that throws", async () => {
    const gaps = [combo("a")];
    await expect(
      harvestGapOptions(gaps, async () => { throw new Error("frame gone"); })
    ).resolves.toBeUndefined();
    expect(gaps[0].options).toEqual([]);
  });

  it("does not call out at all when nothing needs harvesting", async () => {
    let calls = 0;
    await harvestGapOptions([gap({ controlType: "text" })], async () => { calls++; return {}; });
    expect(calls).toBe(0);
  });
});

/**
 * The placeholder must be transient. Keying it purely on "constrained + no
 * options" would leave a widget that yielded nothing showing "Loading choices…"
 * forever, with no way to answer — the opposite of the free-text fallback.
 */
describe("gapControlHTML", () => {
  const combo = gap({ controlType: "combobox", options: [] });

  it("shows a placeholder while the harvest is still running", () => {
    const root = mount(gapControlHTML(combo, 0, true));
    expect(root.querySelector(".ap-gap-loading")).not.toBeNull();
    expect(root.querySelector("input")).toBeNull();
  });

  it("falls back to free text once the harvest has finished empty-handed", () => {
    const root = mount(gapControlHTML(combo, 0, false));
    expect(root.querySelector(".ap-gap-loading")).toBeNull();
    expect(root.querySelector<HTMLInputElement>("input.ap-gap-input")!.type).toBe("text");
  });

  it("renders the real control as soon as options are known, harvest or not", () => {
    for (const pending of [true, false]) {
      const root = mount(gapControlHTML(gap({ controlType: "combobox", options: ["A", "B"] }), 0, pending));
      expect(root.querySelector("select"), String(pending)).not.toBeNull();
      root.remove();
    }
  });

  it("never delays a control whose options are already in the DOM", () => {
    const root = mount(gapControlHTML(gap({ controlType: "text" }), 0, true));
    expect(root.querySelector(".ap-gap-loading")).toBeNull();
  });
});

/**
 * Drift guard. isBlindConstrainedGap decides whether a failed answer may be
 * remembered; gapInputHTML decides what the user was actually offered. If the
 * two ever disagree, a real answer gets silently dropped or an unusable one
 * gets stored forever — so pin them to each other rather than to a hand-written
 * list of control types.
 */
describe("isBlindConstrainedGap agrees with what the modal renders", () => {
  const everyType: ControlType[] = [
    "text", "textarea", "select", "checkbox", "radioGroup", "checkboxGroup",
    "file", "contenteditable", "combobox", "ariaRadioGroup", "customDropdown", "password",
  ];

  it("flags exactly the option-less constrained controls", () => {
    const blind = everyType.filter((t) => isBlindConstrainedGap(gap({ controlType: t, options: [] })));
    expect(blind.sort()).toEqual(
      ["ariaRadioGroup", "checkboxGroup", "combobox", "customDropdown", "radioGroup", "select"].sort()
    );
  });

  it("every flagged control is one the modal could only offer as a bare text box", () => {
    for (const t of everyType) {
      if (!isBlindConstrainedGap(gap({ controlType: t, options: [] }))) continue;
      const root = mount(gapControlHTML(gap({ controlType: t, options: [] }), 0, false));
      expect(root.querySelector<HTMLInputElement>("input.ap-gap-input")?.type, t).toBe("text");
      root.remove();
    }
  });

  it("is false once the options are known — the user picked a real choice", () => {
    for (const t of ["select", "combobox", "customDropdown", "radioGroup", "ariaRadioGroup", "checkboxGroup"] as const) {
      expect(isBlindConstrainedGap(gap({ controlType: t, options: ["A"] })), t).toBe(false);
    }
  });

  it("is false for a bare checkbox — it renders a real Yes/No pair, not a text box", () => {
    expect(isBlindConstrainedGap(gap({ controlType: "checkbox", options: [] }))).toBe(false);
    const root = mount(gapControlHTML(gap({ controlType: "checkbox", options: [] }), 0, false));
    expect(root.querySelectorAll('input[type="radio"]').length).toBe(3);
  });
});
