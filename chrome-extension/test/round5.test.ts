/**
 * Round 5 (2026-10-08, night): open bugs from round 4 and new ground. Each
 * test is a write a live page got wrong, or a blank a stated fact answers;
 * labels and markup are verbatim from the live pages.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { liveControlFor } from "../src/content/staleControl";
import type { RuntimeControl } from "../src/shared/types";
import { SPARSE_CANADIAN } from "./fixtures/profiles";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

describe("a popup's hide-others mark does not hide the form (Ashby's school menu, Superhuman)", () => {
  // While Ashby's school typeahead is open, Floating UI's "hide others" marks
  // every other field block aria-hidden="true" data-aria-hidden="true" (37
  // nodes, live 2026-10-08), and removes the marks when the menu closes. A
  // scan taken while the first school's menu was open lost the second school,
  // which then failed as "Field no longer found" (regressions 2 and 3).
  const ASHBY_OPEN_MENU = `
    <form>
      <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" aria-hidden="true" data-aria-hidden="true">
        <label class="_heading_101oc_53" for="_systemfield_email">Email</label>
        <input id="_systemfield_email" type="email" name="_systemfield_email" />
      </div>
      <div class="_fieldEntry_1e3gg_28">
        <label>School</label>
        <input role="combobox" aria-expanded="true" aria-controls=":r3:" placeholder="Search schools..." value="Univ" />
      </div>
      <div class="_fieldEntry_1e3gg_28" aria-hidden="true" data-aria-hidden="true">
        <label>School</label>
        <input role="combobox" aria-expanded="false" placeholder="Search schools..." />
      </div>
    </form>
    <div data-floating-ui-portal="" aria-hidden="false"><div id=":r3:" role="listbox"><div role="option">Concordia University</div></div></div>`;

  it("a field outside the open menu is still scanned, under its own label", () => {
    document.body.innerHTML = ASHBY_OPEN_MENU;
    const { fields } = scanPage(SPARSE_CANADIAN, false, null);
    const email = fields.find((f) => f.category === "email");
    expect(email?.label).toBe("Email");
    expect(fields.filter((f) => f.label === "School")).toHaveLength(2);
  });

  it("markup hidden from screen readers for good (no hide-others mark) is still skipped", () => {
    document.body.innerHTML = `
      <form>
        <label for="a">Email</label><input id="a" type="email" />
        <div aria-hidden="true"><label for="b">Email</label><input id="b" type="email" /></div>
      </form>`;
    const { fields } = scanPage(SPARSE_CANADIAN, false, null);
    expect(fields.filter((f) => f.category === "email")).toHaveLength(1);
  });

  it("a field hidden for good inside a block a menu marked is still skipped", () => {
    document.body.innerHTML = `
      <form>
        <label for="a">Email</label><input id="a" type="email" />
        <div aria-hidden="true" data-aria-hidden="true">
          <div aria-hidden="true"><label for="b">Email</label><input id="b" type="email" /></div>
        </div>
      </form>`;
    const { fields } = scanPage(SPARSE_CANADIAN, false, null);
    expect(fields.filter((f) => f.category === "email")).toHaveLength(1);
  });
});

describe("a dropdown the last scan lost is looked up again before it fails", () => {
  const control = (el: HTMLElement): RuntimeControl => ({ id: "f1", controlType: "combobox", el });

  it("a control still in the page is used as is, without a rescan", async () => {
    const el = document.createElement("input");
    document.body.append(el);
    let rescans = 0;
    const got = await liveControlFor("f1", () => control(el), async () => void rescans++);
    expect(got?.el).toBe(el);
    expect(rescans).toBe(0);
  });

  it("a control missing from the registry is found by the rescan (a scan taken while a menu hid it)", async () => {
    const el = document.createElement("input");
    document.body.append(el);
    const registry = new Map<string, RuntimeControl>();
    let rescans = 0;
    const got = await liveControlFor("f1", (id) => registry.get(id), async () => {
      rescans++;
      registry.set("f1", control(el));
    });
    expect(got?.el).toBe(el);
    expect(rescans).toBe(1);
  });

  it("a control whose element left the page is taken from the rescan, never written to detached", async () => {
    const gone = document.createElement("input");
    const fresh = document.createElement("input");
    document.body.append(fresh);
    const registry = new Map<string, RuntimeControl>([["f1", control(gone)]]);
    const got = await liveControlFor("f1", (id) => registry.get(id), async () => {
      registry.set("f1", control(fresh));
    });
    expect(got?.el).toBe(fresh);
  });

  it("a field the rescan cannot find either is reported missing, after one rescan", async () => {
    const gone = document.createElement("input");
    let rescans = 0;
    const got = await liveControlFor("f1", () => control(gone), async () => void rescans++);
    expect(got).toBeUndefined();
    expect(rescans).toBe(1);
  });

  it("a radio group is live while its first radio is in the page", async () => {
    const radio = document.createElement("input");
    radio.type = "radio";
    document.body.append(radio);
    let rescans = 0;
    const got = await liveControlFor("g1", () => ({ id: "g1", controlType: "radioGroup", radios: [radio] }), async () => void rescans++);
    expect(got?.radios?.[0]).toBe(radio);
    expect(rescans).toBe(0);
  });
});
