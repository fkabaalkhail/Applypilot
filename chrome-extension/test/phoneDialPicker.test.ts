/**
 * A phone field split into a dialing-code picker and a number box.
 *
 * Rippling (ats.rippling.com, live 2026-10-05): the picker is a searchable
 * combobox labelled only "Search", preset by the page's locale ("+44 GB" on
 * an en-GB visit). The picker went unread, and "+49 30 12345678" was typed
 * whole into the number box, which kept the digits: "493012345678" under
 * "+44", a number that reaches no one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { dialCodeOf, nationalNumber, phoneCountryName } from "../src/content/phoneNumber";
import { countryFromName } from "../src/content/geo";
import { isDefaultSelected } from "../src/shared/selection";
import type { DetectedField, UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const RIPPLING_PHONE = `
<form>
  <div data-testid="field">
    <div><span id="field-12-label">First name</span></div>
    <input id="field-12" placeholder="First name" aria-labelledby="field-12-label" value="">
  </div>
  <div data-testid="field">
    <div><span id="field-35-label">Phone number</span><span>*</span></div>
    <div><div class="pair">
      <div class="code"><div data-testid="field"><div><div data-testid="phone_number-code"><div>
        <div data-testid="select-controller"><div><div><div data-testid="select-search-input">
          <input data-input="select-search-input" id="field-38" aria-required="true" placeholder="Search"
            aria-label="Search" role="combobox" aria-autocomplete="list" aria-haspopup="listbox"
            aria-expanded="false" value="+44 GB">
        </div></div></div></div>
      </div></div></div></div></div>
      <div data-testid="phone_number">
        <input data-input="phone_number" id="field-35" aria-required="true" inputmode="tel"
          placeholder="Phone number" aria-labelledby="field-35-label" value="">
      </div>
    </div></div>
  </div>
</form>`;

const PLAIN_PHONE = `
<form>
  <label for="ph">Phone number</label><input id="ph" type="tel" value="">
  <label for="fn">First name</label><input id="fn" value="">
</form>`;

/** A native picker that lists only the codes, beside a tel input. */
const SELECT_PHONE = `
<form>
  <div class="phone">
    <label for="tel">Mobile phone</label>
    <select id="code" name="dial">
      <option value="">--</option>
      <option>+1</option><option>+33</option><option>+44</option>
      <option>+49</option><option>+91</option><option>+61</option>
    </select>
    <input id="tel" type="tel" value="">
  </div>
</form>`;

function person(phone: string, country: string, city: string): UserApplicationProfile {
  return {
    firstName: "Test", lastName: "Person", email: "test.person@example.com", phone,
    location: `${city}, ${country}`, addressCity: city, country,
    linkedin: "", github: "", portfolio: "", currentCompany: "", currentTitle: "",
    workAuthorization: "", requiresSponsorship: "", dateOfBirth: "", coverLetter: "", skills: [],
    education: [], experience: [],
  } as unknown as UserApplicationProfile;
}

function scan(html: string, profile: UserApplicationProfile): DetectedField[] {
  document.body.innerHTML = html;
  return scanPage(profile, false, null).fields;
}

describe("phone numbers beside a dialing-code picker", () => {
  it("reads a combobox showing a dialing code as the phone's code picker, and answers it with the phone's country", () => {
    const fields = scan(RIPPLING_PHONE, person("+49 30 12345678", "Germany", "Berlin"));
    const picker = fields.find((f) => f.category === "phoneCountryCode");
    expect(picker, JSON.stringify(fields.map((f) => [f.label, f.category]))).toBeTruthy();
    expect(picker!.proposedValue).toBe("Germany");
  });

  it("types only the national number beside the picker", () => {
    const fields = scan(RIPPLING_PHONE, person("+49 30 12345678", "Germany", "Berlin"));
    const phone = fields.find((f) => f.category === "phone");
    expect(phone!.proposedValue).toBe("30 12345678");
  });

  it("selects the picker for the fill although the page preset a code", () => {
    const fields = scan(RIPPLING_PHONE, person("+49 30 12345678", "Germany", "Berlin"));
    const picker = fields.find((f) => f.category === "phoneCountryCode")!;
    expect(isDefaultSelected(picker)).toBe(true);
  });

  it("sets the picker by the number's own code, not the home country", () => {
    const fields = scan(RIPPLING_PHONE, person("+44 20 7946 0958", "Canada", "Toronto"));
    expect(fields.find((f) => f.category === "phoneCountryCode")!.proposedValue).toBe("United Kingdom");
    expect(fields.find((f) => f.category === "phone")!.proposedValue).toBe("20 7946 0958");
  });

  it("leaves a number written without a code as it is, the picker taking the home country", () => {
    const fields = scan(RIPPLING_PHONE, person("(206) 555-0131", "United States", "Seattle"));
    expect(fields.find((f) => f.category === "phoneCountryCode")!.proposedValue).toBe("United States");
    expect(fields.find((f) => f.category === "phone")!.proposedValue).toBe("(206) 555-0131");
  });

  it("keeps the whole number where there is no picker", () => {
    const fields = scan(PLAIN_PHONE, person("+49 30 12345678", "Germany", "Berlin"));
    expect(fields.find((f) => f.category === "phone")!.proposedValue).toBe("+49 30 12345678");
  });

  it("reads a native list of bare codes as the picker and picks the number's code", () => {
    const fields = scan(SELECT_PHONE, person("+49 30 12345678", "Germany", "Berlin"));
    const picker = fields.find((f) => f.category === "phoneCountryCode");
    expect(picker, JSON.stringify(fields.map((f) => [f.label, f.category]))).toBeTruthy();
    expect(picker!.proposedValue).toBe("+49");
    expect(fields.find((f) => f.category === "phone")!.proposedValue).toBe("30 12345678");
  });
});

describe("phone number parts", () => {
  it("finds the dialing code a number is written with", () => {
    expect(dialCodeOf("+49 30 12345678")).toBe("49");
    expect(dialCodeOf("+4930123456")).toBe("49");
    expect(dialCodeOf("+1 (617) 555-0199")).toBe("1");
    expect(dialCodeOf("+91 98450 12345")).toBe("91");
    expect(dialCodeOf("(206) 555-0131")).toBeNull();
    expect(dialCodeOf("0049 30 1234")).toBeNull();
  });

  it("drops the code and a written trunk zero, keeping the rest as written", () => {
    expect(nationalNumber("+49 30 12345678")).toBe("30 12345678");
    expect(nationalNumber("+44 (0)20 7946 0958")).toBe("20 7946 0958");
    expect(nationalNumber("+1 (617) 555-0199")).toBe("(617) 555-0199");
    expect(nationalNumber("+1-408-555-0172")).toBe("408-555-0172");
    expect(nationalNumber("720.555.0164")).toBe("720.555.0164");
  });

  it("names the number's country, the home country breaking a shared code", () => {
    expect(phoneCountryName("+49 30 12345678", countryFromName("Canada"))).toBe("Germany");
    expect(phoneCountryName("+1 416 555 0142", countryFromName("Canada"))).toBe("Canada");
    expect(phoneCountryName("+1 416 555 0142", countryFromName("United States"))).toBe("United States");
    // +1 is shared: abroad, it says nothing about which country.
    expect(phoneCountryName("+1 416 555 0142", countryFromName("Germany"))).toBeNull();
    expect(phoneCountryName("514 555 0186", countryFromName("Canada"))).toBe("Canada");
    expect(phoneCountryName("514 555 0186", null)).toBeNull();
  });
});
