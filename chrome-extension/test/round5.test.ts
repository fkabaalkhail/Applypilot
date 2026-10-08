/**
 * Round 5 (2026-10-08, night): open bugs from round 4 and new ground. Each
 * test is a write a live page got wrong, or a blank a stated fact answers;
 * labels and markup are verbatim from the live pages.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { setResolveContext } from "../src/content/fieldResolver";
import { AutofillReconciler } from "../src/content/reconciler";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import { revertedFields } from "../src/content/telemetry";
import { resolveQuestion, type QuestionInput } from "../src/content/questionResolver";
import { profileFacts } from "../src/content/profileFacts";
import * as P from "./e2e/profiles.mjs";
import type { UserApplicationProfile } from "../src/shared/types";
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

describe("a radio the page re-renders when chosen still counts as chosen (Paylocity's How did you hear)", () => {
  // Choosing an option replaces that radio's element (Paylocity, live
  // 2026-10-08: the old one detached, a new one checked). The registry's
  // copy of the group lacked the chosen option, the check read it unchosen,
  // and the retry reported "No option matches" for an answer the page held.
  const option = (value: string) => `
    <label class="css-1hpmm7n" aria-labelledby="${value}-for-labelledby"><div class="css-k008qs"><div class="css-1v994a0">
      <input class="css-ingxr6" aria-checked="false" label="${value}" name="info.howDidYouHearAboutUs" type="radio" value="${value}">
    </div><div class="css-0" id="${value}-for-labelledby">${value}</div></div></label>`;
  const PAYLOCITY_HEAR = `
    <form>
      <label class="css-asocq5" for="info.howDidYouHearAboutUs"><span class="radio">How did you hear about us?</span>
        <div aria-required="true" role="radiogroup" data-automation-id="info.howDidYouHearAboutUs">
          ${["Online Job Board (LinkedIn, Indeed, etc.)", "Choice Website", "Friend or Family Member", "Other"].map(option).join("")}
        </div>
      </label>
    </form>`;
  const rerenderOnChoose = (e: Event) => {
    const r = e.target as HTMLInputElement;
    if (!(r instanceof HTMLInputElement) || r.type !== "radio") return;
    const wrap = r.parentElement as HTMLElement;
    queueMicrotask(() => {
      const fresh = wrap.cloneNode(true) as HTMLElement;
      const box = fresh.querySelector("input") as HTMLInputElement;
      box.checked = true;
      box.setAttribute("aria-checked", "true");
      wrap.replaceWith(fresh);
    });
  };
  afterEach(() => document.removeEventListener("click", rerenderOnChoose, true));

  it("the answer the page holds is reported filled, not 'No option matches'", async () => {
    document.body.innerHTML = PAYLOCITY_HEAR;
    document.addEventListener("click", rerenderOnChoose, true);
    const { fields, registry } = scanPage(SPARSE_CANADIAN, false, null);
    const hear = fields.find((f) => f.controlType === "radioGroup");
    expect(hear?.options).toContain("Choice Website");
    const engine = new AutofillReconciler({ sleep: async () => {}, observe: false });
    const [report] = await engine.run([{ fieldId: hear!.id, value: "Choice Website" }], registry);
    engine.dispose();
    expect((document.querySelector('input[value="Choice Website"]') as HTMLInputElement).checked).toBe(true);
    expect(report.reason).toBeUndefined();
    expect(report.ok).toBe(true);
  });
});

describe("Paylocity's own State select, as the live widget behaves (Choice Solutions, 2026-10-08)", () => {
  // Measured live: a click on the box only focuses its search input; ArrowDown
  // or typing opens the menu; the menu (the box's aria-owns) is a virtualized
  // list of role-less div.ListItemEven / div.ListItemOdd rows, eight rendered
  // at a time; it lists state CODES and filters them by prefix ("Tex" finds
  // "No Results Found"). Round 4's replica opened on click, had ARIA roles and
  // full names, and filled while the live page stayed on "Select a state".
  const CODES = ["AL", "AK", "AR", "AS", "AZ", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "TN", "TX", "UT"];
  function pctyLive(): HTMLElement {
    document.body.innerHTML = `
      <form><label class="css-asocq5" for="st"><span>State</span>
        <div class="pcty-input-select-full-container css-1zb4bw" id="st-wrap" aria-expanded="false" aria-haspopup="listbox" aria-owns="st-list" required="">
          <div class="pcty-input-select-input-container css-cw0yvh"><div class="css-6jkhxl" id="st-action"></div>
            <div class="css-n6sh4p"><div class="input-select-input-single-value css-1jybxfd">Select a state</div>
              <div class="pcty-input-select__input css-1je6tb3"><input aria-autocomplete="list" class="css-8nrzws" id="st" maxlength="250" type="text" value=""></div></div></div>
          <div class="css-1mj2ldx" aria-hidden="true"><div><span class="pcty-input-select__indicator-separator"></span><div class="pcty-input-select__dropdown-icon" aria-hidden="true" tabindex="0"></div></div></div>
        </div></label></form>`;
    const wrap = document.getElementById("st-wrap")!;
    const input = document.getElementById("st") as HTMLInputElement;
    const display = wrap.querySelector(".input-select-input-single-value")!;
    const render = (): void => {
      document.getElementById("st-list")?.remove();
      const q = input.value.trim().toLowerCase();
      const hits = CODES.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8);
      const box = document.createElement("div");
      box.id = "st-list";
      box.tabIndex = -1;
      box.innerHTML = `<div class="css-1ftq1i8 pcty-input-select__menu-list"><div style="height: 280px; width: 100%;"></div></div>`;
      const inner = box.querySelector("div > div") as HTMLElement;
      (hits.length ? hits : ["No Results Found"]).forEach((label, i) => {
        const row = document.createElement("div");
        row.className = `${i % 2 ? "ListItemOdd" : "ListItemEven"} css-1duv7c3`;
        row.textContent = label;
        if (hits.length) {
          row.addEventListener("click", () => {
            display.textContent = label;
            input.value = "";
            wrap.setAttribute("aria-expanded", "false");
            document.getElementById("st-list")?.remove();
          });
        }
        inner.append(row);
      });
      document.body.append(box);
      wrap.setAttribute("aria-expanded", "true");
    };
    wrap.addEventListener("click", () => input.focus());
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") render();
    });
    input.addEventListener("input", render);
    return wrap;
  }
  const fast = { sleep: async () => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

  it("a state named in full is found by its code and chosen", async () => {
    const wrap = pctyLive();
    const res = await fillAriaCombobox(wrap, "Texas", fast);
    expect(res).toMatchObject({ filled: true });
    expect(wrap.querySelector(".input-select-input-single-value")?.textContent).toBe("TX");
  });

  it("a state given as its code is chosen", async () => {
    const wrap = pctyLive();
    expect(await fillAriaCombobox(wrap, "TX", fast)).toMatchObject({ filled: true });
    expect(wrap.querySelector(".input-select-input-single-value")?.textContent).toBe("TX");
  });

  it("a place the list does not hold is a miss that leaves the box as it was", async () => {
    const wrap = pctyLive();
    const res = await fillAriaCombobox(wrap, "Ontario", fast);
    expect(res.filled).toBe(false);
    expect(wrap.querySelector(".input-select-input-single-value")?.textContent).toBe("Select a state");
    expect((document.getElementById("st") as HTMLInputElement).value).toBe("");
  });
});

describe("a state read back as its code is the state that was written (Paylocity's State)", () => {
  it("'Texas' showing as 'TX' is no revert, and another state still is", () => {
    expect(revertedFields([{ fieldId: "s", value: "Texas" }], [{ fieldId: "s", value: "TX" }], new Set(["s"]))).toEqual([]);
    expect(revertedFields([{ fieldId: "s", value: "TX" }], [{ fieldId: "s", value: "Texas" }], new Set(["s"]))).toEqual([]);
    expect(revertedFields([{ fieldId: "s", value: "Texas" }], [{ fieldId: "s", value: "TN" }], new Set(["s"]))).toEqual([{ fieldId: "s", cleared: false }]);
  });
});

describe("Dayforce's preferred contact method and dial codes (Eclipse, live 2026-10-05 and 10-08)", () => {
  const askChoice = (label: string, options: string[]) => {
    const q: QuestionInput = { label, controlType: "select", options, category: "unknown", kind: "choice" };
    const r = resolveQuestion(q, profileFacts(SPARSE_CANADIAN, TEST_TODAY), SPARSE_CANADIAN, { jobCountry: "CA", company: "Eclipse" });
    return r && r.status === "answer" ? r.value : (r?.status ?? null);
  };

  it("'Preferred Contact Method' is the email the application gives, when the list offers it", () => {
    expect(askChoice("Preferred Contact Method", ["Email", "Mobile Phone", "Home Phone"])).toBe("Email");
    expect(askChoice("How would you prefer we contact you?", ["Phone call", "Text message", "E-mail"])).toBe("E-mail");
  });

  it("a list without email is left to the applicant", () => {
    expect(askChoice("Preferred Contact Method", ["Mobile Phone", "Home Phone"])).not.toBe("Mobile Phone");
    expect(askChoice("Preferred Contact Method", ["Mobile Phone", "Home Phone"])).not.toBe("Home Phone");
  });

  it("a dial-code picker showing the flag and code of the country written is no revert", () => {
    expect(revertedFields([{ fieldId: "d", value: "Canada" }], [{ fieldId: "d", value: "🇨🇦 +1" }], new Set(["d"]))).toEqual([]);
    // The flag decides: +1 is not enough when the flag is another country's.
    expect(revertedFields([{ fieldId: "d", value: "United States" }], [{ fieldId: "d", value: "🇨🇦 +1" }], new Set(["d"]))).toEqual([{ fieldId: "d", cleared: false }]);
  });
});

describe("a start date between two of the list's ranges takes the later one (Striveworks, question bank)", () => {
  // "What is your earliest available start date…?" with ranges from offer
  // acceptance. Available in 11 days fell between "Immediately" (a week) and
  // "2 to 4 weeks" and was left blank (bank re-run 2026-10-08). The later
  // range is still true; an earlier one would promise a start they cannot make.
  const STRIVEWORKS = ["Immediately", "2 to 4 weeks from offer acceptance", "4-8 weeks from offer acceptance", "8-12 weeks from offer acceptance", "12+ weeks from offer acceptance"];
  const startIn = (isoDate: string) => {
    const profile = { ...SPARSE_CANADIAN, earliestStartDate: isoDate };
    const q: QuestionInput = { label: "What is your earliest available start date for full-time employment in Austin, Texas?", controlType: "select", options: STRIVEWORKS, category: "unknown", kind: "choice" };
    const r = resolveQuestion(q, profileFacts(profile, TEST_TODAY), profile, { jobCountry: "US", company: "Striveworks" });
    return r && r.status === "answer" ? r.value : (r?.status ?? null);
  };

  it("11 days away: '2 to 4 weeks', never 'Immediately'", () => {
    expect(startIn("2026-10-14")).toBe("2 to 4 weeks from offer acceptance");
  });
  it("a range that holds the days still wins", () => {
    expect(startIn("2026-10-03")).toBe("Immediately");
    expect(startIn("2026-10-24")).toBe("2 to 4 weeks from offer acceptance");
    expect(startIn("2027-03-01")).toBe("12+ weeks from offer acceptance");
  });
});

describe("lists that tell living there from moving there (Ashby question bank, 2026-10-08)", () => {
  // Iambic, Pryzm, Zip, Vital Lyfe (Ashby bank): the first "Yes" was taken for
  // anyone willing to move, so people in Toronto, Berlin and Bengaluru said
  // "Yes, I live in San Diego" and "In Boston".
  const ask = (persona: UserApplicationProfile, label: string, options: string[], ctx: { jobCountry: string; jobCity: string; company: string }) => {
    const q: QuestionInput = { label, controlType: "select", options, category: "unknown", kind: "choice" };
    const r = resolveQuestion(q, profileFacts(persona, TEST_TODAY), persona, ctx);
    return r && r.status === "answer" ? r.value : (r?.status ?? null);
  };
  const SD = ["Yes, I live in San Diego", "I do not live in San Diego but I am willing to relocate", "No, I do not live in San Diego and am not willing to relocate"];
  const iambic = { jobCountry: "US", jobCity: "San Diego", company: "Iambic Therapeutics" };
  it("Iambic: someone elsewhere who will move says so; someone who will not, says that", () => {
    expect(ask(P.COMPLETE_CANADIAN, "Do you live in San Diego or are you willing to relocate?", SD, iambic)).toBe(SD[1]);
    expect(ask(P.BERLIN_STAFF, "Do you live in San Diego or are you willing to relocate?", SD, iambic)).toBe(SD[1]);
    expect(ask(P.US_H1B_SENIOR, "Do you live in San Diego or are you willing to relocate?", SD, iambic)).toBe(SD[2]);
  });
  const pryzm = { jobCountry: "US", jobCity: "Boston", company: "Belisar" };
  const BOS = "This is an on-site position in our Boston office. Are you located in Boston or willing to relocate?";
  it("Pryzm: 'In Boston' only for someone in Boston", () => {
    expect(ask(P.US_OPT_ANALYST, BOS, ["In Boston", "Planning to Relocate"], pryzm)).toBe("In Boston");
    expect(ask(P.COMPLETE_CANADIAN, BOS, ["In Boston", "Planning to Relocate"], pryzm)).toBe("Planning to Relocate");
    expect(ask(P.US_H1B_SENIOR, BOS, ["In Boston", "Planning to Relocate"], pryzm)).not.toBe("In Boston");
  });
  const ZIP = ["Yes and I am local to the San Francisco Bay Area", "Yes but I would need to relocate", "No I am not willing to come into the office"];
  const zip = { jobCountry: "US", jobCity: "San Francisco", company: "Zip" };
  it("Zip: a willing mover 'would need to relocate'; a San Jose resident is not decided for them", () => {
    expect(ask(P.US_OPT_ANALYST, "Are you willing and able to come into our downtown SF office 3 days per week?", ZIP, zip)).toBe(ZIP[1]);
    expect(ask(P.INDIA_NEW_GRAD, "Are you willing and able to come into our downtown SF office 3 days per week?", ZIP, zip)).toBe(ZIP[1]);
    expect(ask(P.US_GREENCARD_STUDENT, "Are you willing and able to come into our downtown SF office 3 days per week?", ZIP, zip)).not.toBe(ZIP[1]);
  });
  it("Vital Lyfe: a plain Yes beside 'Yes, but require relocation' means no move", () => {
    const opts = ["Yes", "No", "Yes, but require relocation"];
    const vl = { jobCountry: "US", jobCity: "Los Angeles", company: "Vital Lyfe" };
    expect(ask(P.COMPLETE_CANADIAN, "Are you open to working out of our Torrance (LA) Office 5 Days a Week?", opts, vl)).toBe("Yes, but require relocation");
    expect(ask(P.BOOTCAMP_CAREER_GAP, "Are you open to working out of our Torrance (LA) Office 5 Days a Week?", opts, vl)).toBe("No");
  });
  it("Teleskope: 'currently based, or planning to be based in NYC' is Yes for someone moving there", () => {
    const tk = { jobCountry: "US", jobCity: "New York", company: "Teleskope" };
    const q = "Are you currently based, or planning to be based in NYC and able to work on-site (hybrid) in the Financial District?";
    expect(ask(P.COMPLETE_CANADIAN, q, ["Yes", "No"], tk)).toBe("Yes");
    expect(ask(P.BERLIN_STAFF, q, ["Yes", "No"], tk)).toBe("Yes");
    expect(ask(P.US_H1B_SENIOR, q, ["Yes", "No"], tk)).toBe("No");
  });
});

describe("living there, read across every place and time zone a question names (bank re-run, 2026-10-08)", () => {
  const ask = (persona: UserApplicationProfile, label: string, options: string[], ctx: { jobCountry: string; jobCity: string; company: string }) => {
    const q: QuestionInput = { label, controlType: "select", options, category: "unknown", kind: "choice" };
    const r = resolveQuestion(q, profileFacts(persona, TEST_TODAY), persona, ctx);
    return r && r.status === "answer" ? r.value : (r?.status ?? null);
  };
  const MTL_Q = "This position is required to work out of a Lyft Office in Montreal, if you do not reside within the country and within commutable proximity to the office, are you open to relocating?";
  const MTL = ["I am willing to relocate before starting employment.", "I am not willing to relocate before starting employment.", "I already reside within commutable distance to Montreal and am able to work at an On-site Office."];
  const lyft = { jobCountry: "CA", jobCity: "Montreal", company: "Lyft" };
  it("Lyft: Toronto is no commute to Montreal, though Ontario borders Quebec", () => {
    expect(ask(P.COMPLETE_CANADIAN, MTL_Q, MTL, lyft)).toBe(MTL[0]);
    expect(ask(P.MONTREAL_CHANGER, MTL_Q, MTL, lyft)).toBe(MTL[2]);
  });
  const JERSEY = { ...P.US_H1B_SENIOR, location: "Jersey City, NJ", addressStreet: "", addressCity: "Jersey City", addressState: "NJ", postalCode: "07302" };
  it("two places named: No only when the applicant is at neither; a neighbouring state is not decided", () => {
    const mx = { jobCountry: "US", jobCity: "San Francisco", company: "Mixpanel" };
    const q = "Are you currently located in the San Francisco Bay Area or New York City?";
    expect(ask(P.US_OPT_ANALYST, q, ["Yes", "No"], mx)).toBe("No");
    expect(ask(JERSEY, q, ["Yes", "No"], mx)).not.toBe("No");
  });
  it("a time zone named beside the place counts: Seattle is in the Pacific time zone", () => {
    const amp = { jobCountry: "US", jobCity: "San Francisco", company: "Amplitude" };
    const q = "Are you currently based in the San Francisco Bay Area or within the Pacific time zone?";
    expect(ask(P.US_H1B_SENIOR, q, ["Yes", "No"], amp)).toBe("Yes");
    expect(ask(P.BOOTCAMP_CAREER_GAP, q, ["Yes", "No"], amp)).toBe("No");
  });
  it("an answer that is one checkbox's whole text is that box alone (Vital Lyfe's checkboxes)", () => {
    document.body.innerHTML = `<form><fieldset class="field"><legend>Are you open to working out of our Torrance (LA) Office 5 Days a Week?</legend>
      <label><input type="checkbox" name="q[]" value="0"> Yes</label><label><input type="checkbox" name="q[]" value="1"> No</label>
      <label><input type="checkbox" name="q[]" value="2"> Yes, but require relocation</label></fieldset></form>`;
    setResolveContext({ jobCountry: "US", jobCity: "Los Angeles", company: "Vital Lyfe" });
    const f = scanPage(P.COMPLETE_CANADIAN as UserApplicationProfile, false, null).fields.find((x) => x.controlType === "checkboxGroup");
    expect(f?.proposedValue).toBe("Yes, but require relocation");
    setResolveContext({ jobCountry: null, jobCity: null, company: "" });
  });
});
