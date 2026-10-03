/**
 * Vue's v-model (and many hand-rolled React forms) render a radio question with
 * NO `name` attribute: the framework, not the browser, ties the options
 * together. The scanner grouped radios by name only, so every option became a
 * one-option "group" that no answer could select (the Vue 3 harness page,
 * 2026-10-03: "Are you legally authorized to work in Canada?" stayed blank).
 * Name-less radios group by their question container instead.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TEST_TODAY);
});
afterAll(() => {
  restore();
  vi.useRealTimers();
});

describe("radios without a name attribute", () => {
  it("group by their fieldset and get answered", () => {
    document.body.innerHTML = `<form>
      <fieldset><legend>Are you legally authorized to work in Canada?</legend>
        <label><input type="radio" value="Yes"> Yes</label><label><input type="radio" value="No"> No</label></fieldset>
      <fieldset><legend>Do you live in the United States?</legend>
        <label><input type="radio" value="YES"> YES</label><label><input type="radio" value="NO"> NO</label></fieldset>
    </form>`;
    const radios = scanPage(SPARSE_CANADIAN, false, null).fields.filter((f) => f.controlType === "radioGroup");
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.options)).toEqual([["Yes", "No"], ["YES", "NO"]]);
    expect(radios.map((r) => r.proposedValue)).toEqual(["Yes", "NO"]);
  });

  it("group by their closest option container when there is no fieldset", () => {
    document.body.innerHTML = `<form>
      <div class="q"><p>Are you legally authorized to work in Canada?</p>
        <div><label><input type="radio" value="Yes"> Yes</label></div><div><label><input type="radio" value="No"> No</label></div></div>
      <div class="q"><label for="city">City</label><input id="city"></div>
    </form>`;
    const radios = scanPage(SPARSE_CANADIAN, false, null).fields.filter((f) => f.controlType === "radioGroup");
    expect(radios).toHaveLength(1);
    expect(radios[0].options).toEqual(["Yes", "No"]);
    expect(radios[0].proposedValue).toBe("Yes");
  });
});
