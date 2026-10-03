import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { controlVisibility, formLooksHidden, waitForFormReveal } from "../src/content/hiddenForm";

// jsdom has no layout: give every element a box UNLESS it sits under a
// display:none ancestor, which is what a browser's getClientRects() reports.
let original: typeof HTMLElement.prototype.getClientRects;
beforeAll(() => {
  original = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function (this: HTMLElement): DOMRectList {
    for (let a: HTMLElement | null = this; a; a = a.parentElement) {
      if (getComputedStyle(a).display === "none") return [] as unknown as DOMRectList;
    }
    return [{ width: 100, height: 20 }] as unknown as DOMRectList;
  };
});
afterAll(() => {
  HTMLElement.prototype.getClientRects = original;
});

/** BambooHR's job page right after "Apply for This Job": the application form
 *  is mounted, but its container stays display:none while the site loads
 *  (2.5-5 s, live 2026-10-03). Only the read-only "Link to This Job" shows. */
function bambooHiddenForm(): HTMLElement {
  document.body.innerHTML = `
    <div class="job"><label>Link to This Job <input readonly value="https://x.bamboohr.com/careers/64"></label></div>
    <div id="sheet" style="display:none">
      <form>
        <input id="nickname_hp" type="text">
        <input id="firstName" type="text"><input id="lastName" type="text">
        <input id="email" type="text"><input id="phone" type="text">
        <input type="text" aria-label="Address"><input type="text" aria-label="City">
        <select aria-label="Province"><option>Ontario</option></select>
        <input type="file"><input type="checkbox"><input type="radio" name="r">
        <input type="hidden" name="token"><button type="submit">Submit</button>
        <textarea aria-label="Cover letter"></textarea>
      </form>
    </div>`;
  return document.getElementById("sheet")!;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("controlVisibility", () => {
  it("counts typeable controls only, rendered vs mounted-but-hidden", () => {
    const sheet = bambooHiddenForm();
    // 1 shown (the read-only link); 9 hidden typeable controls (7 inputs, the
    // select, the textarea). File, checkbox, radio, hidden and the button are
    // not counted.
    expect(controlVisibility()).toEqual({ shown: 1, hidden: 9 });
    sheet.style.display = "block";
    expect(controlVisibility()).toEqual({ shown: 10, hidden: 0 });
  });
});

describe("formLooksHidden", () => {
  it("needs several hidden controls, outnumbering the rendered ones", () => {
    expect(formLooksHidden({ shown: 1, hidden: 17 })).toBe(true);
    expect(formLooksHidden({ shown: 0, hidden: 2 })).toBe(false); // a couple of hidden twins
    expect(formLooksHidden({ shown: 12, hidden: 5 })).toBe(false); // a rendered form with hidden extras
    expect(formLooksHidden({ shown: 0, hidden: 0 })).toBe(false); // a page with no form at all
  });
});

describe("waitForFormReveal", () => {
  /** A fake clock: sleep() advances it and runs `onTick` (the site's timeline). */
  function clock(onTick: (t: number) => void = () => {}) {
    let t = 0;
    let sleeps = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps++;
        t += ms;
        onTick(t);
      },
      sleeps: () => sleeps,
    };
  }

  it("rescans once the hidden form shows, and stops there (BambooHR, live 2026-10-03)", async () => {
    const sheet = bambooHiddenForm();
    const c = clock((t) => {
      if (t >= 3000) sheet.style.display = "block"; // revealed 3 s after the click
    });
    let rescans = 0;
    const found = await waitForFormReveal(
      { measure: () => controlVisibility(), rescan: async () => (++rescans, true), sleep: c.sleep, now: c.now },
      undefined,
      10000,
      300
    );
    expect(found).toBe(true);
    expect(rescans).toBe(1);
    expect(c.now()).toBe(3000); // waited exactly until the reveal, not to the cap
  });

  it("returns at once, without sleeping, when the page's form is not hidden", async () => {
    document.body.innerHTML = `<form><input id="a"><input id="b"><input id="c"></form>`;
    const c = clock();
    let rescans = 0;
    const found = await waitForFormReveal(
      { measure: () => controlVisibility(), rescan: async () => (++rescans, true), sleep: c.sleep, now: c.now }
    );
    expect(found).toBe(false);
    expect(c.sleeps()).toBe(0);
    expect(rescans).toBe(0);
  });

  it("gives up at the cap when the form never shows, without rescanning", async () => {
    bambooHiddenForm();
    const c = clock();
    let rescans = 0;
    const found = await waitForFormReveal(
      { measure: () => controlVisibility(), rescan: async () => (++rescans, true), sleep: c.sleep, now: c.now },
      undefined,
      3000,
      300
    );
    expect(found).toBe(false);
    expect(rescans).toBe(0);
    expect(c.now()).toBe(3000);
  });

  it("keeps waiting when a partial reveal still has nothing to fill", async () => {
    const sheet = bambooHiddenForm();
    const link = document.querySelector<HTMLInputElement>("input[readonly]")!;
    const c = clock((t) => {
      if (t === 600) link.insertAdjacentHTML("afterend", '<input id="search" type="search">'); // unrelated control
      if (t >= 1500) sheet.style.display = "block";
    });
    const results = [false, true]; // the first rescan (search box) has no work
    let rescans = 0;
    const found = await waitForFormReveal(
      { measure: () => controlVisibility(), rescan: async () => results[rescans++], sleep: c.sleep, now: c.now },
      undefined,
      10000,
      300
    );
    expect(found).toBe(true);
    expect(rescans).toBe(2);
    expect(c.now()).toBe(1500);
  });

  it("stops promptly when the fill is cancelled", async () => {
    bambooHiddenForm();
    const abort = new AbortController();
    const c = clock((t) => {
      if (t >= 600) abort.abort();
    });
    const found = await waitForFormReveal(
      { measure: () => controlVisibility(), rescan: async () => true, sleep: c.sleep, now: c.now },
      abort.signal,
      10000,
      300
    );
    expect(found).toBe(false);
    expect(c.now()).toBe(600);
  });
});
