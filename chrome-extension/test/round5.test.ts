/**
 * Round 5 (2026-10-08, night): open bugs from round 4 and new ground. Each
 * test is a write a live page got wrong, or a blank a stated fact answers;
 * labels and markup are verbatim from the live pages.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { liveControlFor } from "../src/content/staleControl";
import { loadWorkableGuesses, prefilledGuesses, setPageGuesses, workableShortcode } from "../src/content/pageGuesses";
import type { RuntimeControl } from "../src/content/formScanner";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";
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

describe("Workable's Address guessed from the visitor's location is the page's guess (Saalex, DISA)", () => {
  // Workable's public form JSON (GET /api/v1/jobs/<code>/form, Saalex, live
  // 2026-10-08) serves the Address it guessed from the requester's IP, and
  // the page puts that value in the box. The city here is made up.
  const FORM_JSON = [
    {
      name: "Personal information",
      fields: [
        { id: "firstname", required: true, label: "First name", type: "text" },
        {
          id: "address",
          required: true,
          label: "Address",
          helper: "Include your city, region, and country, so that employers can easily manage your application.",
          type: "text",
          value: "Springfield, United States",
          prefilledByLocation: true,
        },
        { id: "phone", required: false, label: "Phone", type: "phone", value: "" },
      ],
    },
  ];
  const WORKABLE_ADDRESS = (value: string) => `
    <form>
      <div class="styles--3IYUq styles--3JEd1"><label class="styles--3aPac"><span class="styles--1-9tY"><span><span class="styles--QTMDv styles--2TdGW" id="address_label"><strong class="styles--2kqW6">Address</strong></span></span></span>
        <div data-role="illustrated-input" class="styles--1tBNa"><div class="styles--3qHIU"><input aria-required="true" id="address" data-ui="address" name="address" aria-labelledby="address_label" aria-describedby="address_helper" required="" type="text" class="styles--2e9Cp" dir="auto" value="${value}"></div></div></label>
        <div class="styles--2v-7u"><div class="styles--1VNPc"><span class="styles--f-uLT" id="address_helper">Include your city, region, and country, so that employers can easily manage your application.</span></div></div>
      </div>
    </form>`;
  afterEach(() => setPageGuesses(new Map()));

  it("reads the guessed values from the form JSON, and only those", () => {
    expect([...prefilledGuesses(FORM_JSON).entries()]).toEqual([["address", "Springfield, United States"]]);
    expect(prefilledGuesses({ unexpected: true }).size).toBe(0);
  });

  it("finds the posting's code in Workable's application addresses", () => {
    expect(workableShortcode("https://apply.workable.com/saalex/j/2534F09970/apply/")).toBe("2534F09970");
    expect(workableShortcode("https://apply.workable.com/j/2534F09970/apply")).toBe("2534F09970");
    expect(workableShortcode("https://boards.greenhouse.io/acme/jobs/123")).toBeNull();
  });

  it("a box still holding the page's guess is empty to the fill, which writes the profile's location", () => {
    setPageGuesses(prefilledGuesses(FORM_JSON));
    document.body.innerHTML = WORKABLE_ADDRESS("Springfield, United States");
    const { fields } = scanPage(SPARSE_CANADIAN, false, null);
    const address = fields.find((f) => f.label === "Address");
    expect(address?.currentValue).toBeUndefined();
    expect(address?.proposedValue).toMatch(/Toronto/);
  });

  it("an Address the person typed is theirs, kept", () => {
    setPageGuesses(prefilledGuesses(FORM_JSON));
    document.body.innerHTML = WORKABLE_ADDRESS("Lyon, France");
    const { fields } = scanPage(SPARSE_CANADIAN, false, null);
    expect(fields.find((f) => f.label === "Address")?.currentValue).toBe("Lyon, France");
  });

  it("without the form JSON (another site, or the read failed) a filled box stays as it is", () => {
    document.body.innerHTML = WORKABLE_ADDRESS("Springfield, United States");
    const { fields } = scanPage(SPARSE_CANADIAN, false, null);
    expect(fields.find((f) => f.label === "Address")?.currentValue).toBe("Springfield, United States");
  });

  it("loads the guesses with one GET of the posting's form, and none when it fails", async () => {
    const asked: string[] = [];
    await loadWorkableGuesses("https://apply.workable.com/saalex/j/2534F09970/apply/", async (url: string) => {
      asked.push(url);
      return { ok: true, json: async () => FORM_JSON } as Response;
    });
    expect(asked).toEqual(["https://apply.workable.com/api/v1/jobs/2534F09970/form"]);
    document.body.innerHTML = WORKABLE_ADDRESS("Springfield, United States");
    expect(scanPage(SPARSE_CANADIAN, false, null).fields.find((f) => f.label === "Address")?.currentValue).toBeUndefined();

    setPageGuesses(new Map());
    await loadWorkableGuesses("https://apply.workable.com/saalex/j/2534F09970/apply/", async () => {
      throw new Error("offline");
    });
    expect(scanPage(SPARSE_CANADIAN, false, null).fields.find((f) => f.label === "Address")?.currentValue).toBe("Springfield, United States");
  });
});

describe("today's date in a signature box is written in the box's own format (Saalex on Workable)", () => {
  // Saalex's react-datepicker boxes show "DD/MM/YYYY" (the browser's en-GB
  // locale). Today went in month-first and the box read it day-first: on
  // 2026-10-08 the signature dates said 10 August (live; round 4's pins had
  // recorded "May" for 5 October the same way).
  const SIGNATURE_BOX = (placeholder: string) => `
    <form>
      <label for="sig"><strong>*</strong>Authorization Signature Date:</label>
      <div class="react-datepicker-wrapper"><div class="react-datepicker__input-container">
        <input id="sig" type="text" name="CA_31168" inputmode="tel" placeholder="${placeholder}" />
      </div></div>
    </form>`;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_TODAY); // 2026-10-03
  });
  afterEach(() => vi.useRealTimers());

  const proposed = (placeholder: string) => {
    document.body.innerHTML = SIGNATURE_BOX(placeholder);
    return scanPage(SPARSE_CANADIAN, false, null).fields.find((f) => f.category === "signatureDate")?.proposedValue;
  };

  it("day first where the box shows DD/MM/YYYY", () => {
    expect(proposed("DD/MM/YYYY")).toBe("03/10/2026");
  });
  it("month first where it shows MM/DD/YYYY", () => {
    expect(proposed("MM/DD/YYYY")).toBe("10/03/2026");
  });
  it("year first where it shows YYYY-MM-DD", () => {
    expect(proposed("YYYY-MM-DD")).toBe("2026-10-03");
  });
});
