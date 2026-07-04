import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";

// jsdom reports zero rects for everything; comboboxes get NO relaxed-visibility
// pass (an invisible combobox is not operable — see formScanner), so give every
// element a real box the way a browser would. See helpers/layout.ts.
let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = stubLayout();
});
afterAll(() => restoreLayout());

beforeEach(() => {
  document.body.innerHTML = "";
});

/** A combobox with a mounted listbox and an aria-label. */
function labeledCombobox(
  options: string[],
  opts: { label: string; value?: string }
): void {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", opts.label);
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-controls", lbId);
  if (opts.value) {
    const sv = document.createElement("div");
    sv.className = "select__single-value";
    sv.textContent = opts.value;
    wrap.append(sv);
  }
  const lb = document.createElement("div");
  lb.id = lbId;
  lb.setAttribute("role", "listbox");
  for (const label of options) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    lb.append(o);
  }
  wrap.append(input, lb);
  document.body.append(wrap);
}

describe("scanPage — custom dropdowns", () => {
  it("surfaces a combobox's options and committed value", () => {
    labeledCombobox(["United States", "Canada"], { label: "Country", value: "Canada" });
    const { fields } = scanPage(null, false);
    const combo = fields.find((f) => f.controlType === "combobox");
    expect(combo).toBeDefined();
    expect(combo!.options).toEqual(["United States", "Canada"]);
    expect(combo!.currentValue).toBe("Canada");
  });

  it("reads options for an empty combobox and leaves currentValue undefined", () => {
    labeledCombobox(["Yes", "No"], { label: "Authorized to work?" });
    const { fields } = scanPage(null, false);
    const combo = fields.find((f) => f.controlType === "combobox");
    expect(combo).toBeDefined();
    expect(combo!.options).toEqual(["Yes", "No"]);
    expect(combo!.currentValue).toBeUndefined();
  });
});

describe("driver tagging", () => {
  it("tags a react-select control and marks it fillable", () => {
    document.body.innerHTML = `
      <label for="react-select-2-input">Country</label>
      <div class="rs__container"><div class="rs__control">
        <input id="react-select-2-input" role="combobox" aria-controls="lb" aria-expanded="false" />
      </div></div>`;
    const { fields, registry } = scanPage(null, false);
    const field = fields.find((f) => f.controlType === "combobox");
    expect(field).toBeTruthy();
    const control = registry.get(field!.id);
    expect(control?.driver).toBe("react-select");
    expect(field!.fillable).toBe(true);
  });

  it("leaves a plain ARIA combobox untagged", () => {
    document.body.innerHTML = `
      <label for="c">City</label>
      <input id="c" role="combobox" aria-controls="lb2" aria-expanded="false" />`;
    const { fields, registry } = scanPage(null, false);
    const field = fields.find((f) => f.controlType === "combobox");
    const control = field ? registry.get(field.id) : undefined;
    expect(control?.driver).toBeUndefined();
  });
});

describe("scanPage — field page context", () => {
  it("carries the native input type and nearby help text on the detected field", () => {
    document.body.innerHTML = `
      <form>
        <label for="d">Start date
          <span class="help">When can you begin?</span>
        </label>
        <input id="d" name="start_date" type="date" />
      </form>`;
    const { fields } = scanPage(null, false);
    const field = fields.find((f) => f.label.includes("Start date"));
    expect(field).toBeDefined();
    expect(field!.inputType).toBe("date");
    expect(field!.helpText).toContain("When can you begin?");
  });
});

describe("scanPage — widget-internal controls are not fields (Greenhouse job-boards regression)", () => {
  it("skips react-select's aria-hidden required companion input", () => {
    document.body.innerHTML = `
      <div class="select__container">
        <label id="q-label" for="q">Country</label>
        <div class="select-shell">
          <div class="select__control">
            <div class="select__input-container">
              <input id="q" type="text" role="combobox" aria-expanded="false" aria-controls="lbq"
                     aria-labelledby="q-label" />
            </div>
          </div>
          <input required tabindex="-1" aria-hidden="true" class="requiredInput" value="" />
        </div>
      </div>`;
    const { fields } = scanPage(null, false);
    // Exactly one field for the question: the combobox. The companion must not
    // become a text twin that the reconciler types into / the modal prompts for.
    expect(fields).toHaveLength(1);
    expect(fields[0].controlType).toBe("combobox");
  });

  it("skips a zero-area input even without aria-hidden", () => {
    document.body.innerHTML = `<label for="ghost">Ghost</label><input id="ghost" type="text" />`;
    const ghost = document.getElementById("ghost") as HTMLElement;
    // Rendered box exists but is 0px tall — a validation shim, not a field.
    ghost.getClientRects = () => [{ width: 100, height: 0 }] as unknown as DOMRectList;
    const { fields } = scanPage(null, false);
    expect(fields).toHaveLength(0);
  });

  it("skips a bot-trap honeypot input (Workday beecatcher: clipped, sub-pixel box)", () => {
    // Real Workday markup: a labelled text input hidden with the sr-only clip
    // trick and a ~1px×fractional box. Filling it flags the submission as a bot,
    // so Workday silently refuses to create the account — it must never be filled.
    document.body.innerHTML = `
      <label for="hp">Website</label>
      <input id="hp" name="website" data-automation-id="beecatcher" type="text"
             style="position:absolute;left:0;top:0;clip:rect(1px,1px,1px,1px);clip-path:polygon(0 0,0 0,0 0,0 0)" />`;
    const hp = document.getElementById("hp") as HTMLElement;
    hp.getClientRects = () => [{ width: 1, height: 0.4 }] as unknown as DOMRectList;
    const { fields } = scanPage(null, false);
    expect(fields).toHaveLength(0);
  });

  it("skips a clip-hidden honeypot even with a full-size layout box", () => {
    // Some honeypots hide purely with the clip trick (normal-sized box). The
    // clip/clip-path signal must exclude them independently of box dimensions.
    document.body.innerHTML = `
      <label for="trap">Homepage</label>
      <input id="trap" name="url" type="text" style="clip:rect(1px,1px,1px,1px)" />`;
    const { fields } = scanPage(null, false); // default stub box is 100x20
    expect(fields).toHaveLength(0);
  });

  it("skips a combobox hidden inside a closed widget subtree (intl-tel-input dial-code search)", () => {
    document.body.innerHTML = `
      <label for="phone">Phone</label><input id="phone" type="tel" />
      <div class="iti__dropdown-content" role="dialog">
        <input id="iti-search" type="search" role="combobox" aria-expanded="true"
               aria-label="Search" aria-controls="iti-lb" aria-autocomplete="list" />
        <ul id="iti-lb" role="listbox"><li role="option">Afghanistan +93</li></ul>
      </div>`;
    // The closed dial-code dialog isn't rendered: no client rects anywhere inside.
    const dialog = document.querySelector(".iti__dropdown-content") as HTMLElement;
    for (const el of [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>("*"))]) {
      el.getClientRects = () => [] as unknown as DOMRectList;
    }
    const { fields } = scanPage(null, false);
    expect(fields.map((f) => f.controlType)).toEqual(["text"]); // just the phone
  });
});

describe("scanPage — malformed profile robustness", () => {
  it("does not throw when the profile is missing education/experience/skills arrays", () => {
    document.body.innerHTML = `
      <label for="s">School</label><input id="s" name="education[0][school]" />
      <label for="c">Company</label><input id="c" name="company" />
      <label for="n">Full name</label><input id="n" name="name" />`;
    const malformed = { firstName: "A", email: "a@b.com" } as unknown as import("../src/shared/types").UserApplicationProfile;
    expect(() => scanPage(malformed, false)).not.toThrow();
  });
});
