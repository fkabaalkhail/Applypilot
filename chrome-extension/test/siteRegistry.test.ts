import { describe, it, expect } from "vitest";
import { matchPattern } from "../src/content/siteRegistry";

describe("matchPattern", () => {
  it("matches scheme wildcard + subdomain wildcard", () => {
    expect(
      matchPattern("*://*.avature.net/*/ApplicationForm*", "https://careers.avature.net/x/ApplicationForm?y")
    ).toBe(true);
    // `*.` also matches the apex domain
    expect(
      matchPattern("*://*.avature.net/*/ApplicationForm*", "https://avature.net/foo/ApplicationForm")
    ).toBe(true);
  });

  it("respects path anchoring (org/id required)", () => {
    expect(matchPattern("*://jobs.lever.co/*/*", "https://jobs.lever.co/acme/1234")).toBe(true);
    expect(matchPattern("*://jobs.lever.co/*/*", "https://jobs.lever.co/acme")).toBe(false);
  });

  it("rejects a look-alike host in the path", () => {
    expect(matchPattern("*://*.avature.net/*", "https://evil.com/avature.net")).toBe(false);
  });
});
