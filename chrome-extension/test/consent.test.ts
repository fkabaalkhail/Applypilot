import { describe, it, expect, beforeEach } from "vitest";
import { isConsentField } from "../src/content/consent";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isConsentField", () => {
  it("flags OneTrust category toggles by their ot- id prefix", () => {
    document.body.innerHTML = `<input id="ot-group-id-C0002" type="checkbox" />`;
    expect(isConsentField(document.getElementById("ot-group-id-C0002")!)).toBe(true);
  });

  it("flags controls inside the OneTrust preference-center container", () => {
    // Mirrors the real Databricks DOM: a search box + select-all toggles whose
    // own ids have no ot- prefix, but which live inside #onetrust-pc-sdk.
    document.body.innerHTML = `
      <div id="onetrust-consent-sdk">
        <div id="onetrust-pc-sdk">
          <input id="vendor-search-handler" type="text" aria-label="Cookie list search" />
          <input id="select-all-vendor-groups-handler" type="checkbox" />
          <input id="chkbox-id" type="checkbox" />
        </div>
      </div>`;
    expect(isConsentField(document.getElementById("vendor-search-handler")!)).toBe(true);
    expect(isConsentField(document.getElementById("select-all-vendor-groups-handler")!)).toBe(true);
    expect(isConsentField(document.getElementById("chkbox-id")!)).toBe(true);
  });

  it("flags controls inside the OneTrust banner", () => {
    document.body.innerHTML = `<div id="onetrust-banner-sdk"><input type="checkbox" id="banner-cb" /></div>`;
    expect(isConsentField(document.getElementById("banner-cb")!)).toBe(true);
  });

  it("flags a Cookiebot dialog control", () => {
    document.body.innerHTML = `<div id="CybotCookiebotDialog"><input type="checkbox" id="cb" /></div>`;
    expect(isConsentField(document.getElementById("cb")!)).toBe(true);
  });

  it("flags a generic cookie-consent dialog control", () => {
    document.body.innerHTML = `<div class="cookie-consent-banner"><input type="checkbox" id="g" /></div>`;
    expect(isConsentField(document.getElementById("g")!)).toBe(true);
  });

  it("does NOT flag an ordinary application field", () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input id="first_name" name="first_name" aria-label="First Name" autocomplete="given-name" />
      </form>`;
    expect(isConsentField(document.getElementById("first_name")!)).toBe(false);
  });

  it("does NOT flag a field whose id merely contains 'ot' mid-word", () => {
    // Guard against an overly-greedy /ot/ match: only the ot- PREFIX is consent.
    document.body.innerHTML = `<input id="robot_check_note" name="total_years" />`;
    expect(isConsentField(document.getElementById("robot_check_note")!)).toBe(false);
  });
});
