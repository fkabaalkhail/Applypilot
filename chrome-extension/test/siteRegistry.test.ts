import { describe, it, expect } from "vitest";
import { matchPattern, detectSite, SITE_REGISTRY } from "../src/content/siteRegistry";

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

  it("a structurally invalid pattern never matches, not even the empty string", () => {
    expect(matchPattern("not-a-pattern", "")).toBe(false);
    expect(matchPattern("not-a-pattern", "https://x.com/")).toBe(false);
  });
});

describe("detectSite", () => {
  it("domain match (successfactors)", () => {
    expect(
      detectSite("career4.successfactors.com", "https://career4.successfactors.com/career?x")?.id
    ).toBe("successfactors");
  });

  it("iframeOnly icims: only inside a frame, and pathRegex-gated", () => {
    expect(
      detectSite("careers-acme.icims.com", "https://careers-acme.icims.com/jobs/12345/candidate", {
        inIframe: true,
      })?.id
    ).toBe("icims");
    // pathRegex `^/jobs/\d+(?!.*/job$)` rejects the plain posting page
    expect(
      detectSite("careers-acme.icims.com", "https://careers-acme.icims.com/jobs/12345/job", {
        inIframe: true,
      })
    ).toBeNull();
    // iframeOnly: never matches in the top document
    expect(
      detectSite("careers-acme.icims.com", "https://careers-acme.icims.com/jobs/12345/candidate", {
        inIframe: false,
      })
    ).toBeNull();
  });

  it("pattern match (avature ApplicationForm)", () => {
    expect(
      detectSite("careers.avature.net", "https://careers.avature.net/x/ApplicationForm")?.id
    ).toBe("avature");
  });

  it("anchored domain rejects a look-alike host", () => {
    expect(detectSite("notgreenhouse.io.evil.com", "https://notgreenhouse.io.evil.com/")).toBeNull();
  });

  it("registry has all 71 ids, unique, each with a matcher", () => {
    expect(SITE_REGISTRY.length).toBe(71);
    const ids = SITE_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(71);
    for (const e of SITE_REGISTRY) {
      expect(
        Boolean(e.domains || e.patterns || e.iframeDomains || e.pageSourceKeyword)
      ).toBe(true);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
});
