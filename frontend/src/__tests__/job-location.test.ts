import { describe, expect, it } from "vitest";
import { displayLocation } from "../lib/jobLocation";

describe("displayLocation", () => {
  it("renders city, region, country from locations_json", () => {
    expect(
      displayLocation({
        location: "Ottawa,Ontario,Canada",
        locations_json: [{ city: "Ottawa", region: "ON", region_name: "Ontario", country: "Canada" }],
      }),
    ).toBe("Ottawa, ON, Canada");
  });

  it("summarizes multi-location jobs", () => {
    expect(
      displayLocation({
        location: "Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland",
        locations_json: [
          { city: "Ottawa", region: "ON", region_name: "Ontario", country: "Canada" },
          { city: "Kraków", region: "", region_name: "", country: "Poland" },
          { city: "Łódź", region: "", region_name: "", country: "Poland" },
        ],
      }),
    ).toBe("Ottawa, ON, Canada · +2 more");
  });

  it("falls back to the first raw segment for legacy rows", () => {
    expect(
      displayLocation({ location: "Ottawa, Ontario, Canada; Kraków, Poland", locations_json: [] }),
    ).toBe("Ottawa, Ontario, Canada");
    expect(displayLocation({ location: "", locations_json: [] })).toBe("");
    expect(displayLocation({ location: "Toronto, ON", locations_json: null })).toBe("Toronto, ON");
  });
});
