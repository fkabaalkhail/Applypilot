import { describe, it, expect } from "vitest";
import { getAdapter } from "../src/content/adapters";
import { detectSite } from "../src/content/siteRegistry";

// ---------------------------------------------------------------------------
// Newly added Jobright-parity vendor adapters resolve by host and carry a label.
// ---------------------------------------------------------------------------
describe("vendor adapters (full Jobright parity set)", () => {
  const cases: Array<[string, string, string]> = [
    ["careers.kula.ai", "kula", "Kula"],
    ["acme.dover.com", "dover", "Dover"],
    ["acme.zohorecruit.eu", "zohorecruit", "Zoho Recruit"],
    ["jobs.gem.com", "gem", "Gem"],
    ["acme.hiringthing.com", "hiringthing", "HiringThing"],
    ["acme.oasisrecruit.com", "hiringthing", "HiringThing"],
    ["acme.catsone.com", "catsone", "CATS"],
    ["acme.ripplehire.com", "ripplehire", "RippleHire"],
    ["acme.careers-page.com", "careerspage", "CareersPage"],
    ["acme.careerplug.com", "careerplug", "CareerPlug"],
    ["acme.sfagentjobs.com", "careerplug", "CareerPlug"],
    ["acme.isolvedhire.com", "isolved", "isolved"],
    ["acme.jobdiva.com", "jobdiva", "JobDiva"],
    ["app.gohire.io", "gohire", "GoHire"],
    ["hire.trakstar.com", "trakstar", "Trakstar"],
    ["acme.freshteam.com", "freshteam", "Freshteam"],
    ["acme.pinpointhq.com", "pinpointhq", "Pinpoint"],
    ["app.trinethire.com", "trinethire", "TriNet Hire"],
    ["acme.jobscore.com", "jobscore", "JobScore"],
    ["acme.comeet.co", "comeet", "Comeet"],
    ["jobs.polymer.co", "polymer", "Polymer"],
    ["acme.recruiterflow.com", "recruiterflow", "Recruiterflow"],
  ];

  it.each(cases)("%s → %s (%s)", (host, id, label) => {
    const adapter = getAdapter(host, `https://${host}/apply`);
    expect(adapter?.id).toBe(id);
    expect(adapter?.label).toBe(label);
  });

  it("does not match look-alike hosts of the new vendors", () => {
    expect(getAdapter("notdover.com.evil.com", "")).toBeNull();
    expect(getAdapter("jobscore.com.attacker.net", "")).toBeNull();
    expect(getAdapter("fakecatsone.com", "")).toBeNull();
  });

  // Broadened to match the registry's full host set (was .net / .com-only).
  it("covers the registry's extra Paycom/UKG sub-hosts", () => {
    expect(getAdapter("www.paycomonline.com", "https://www.paycomonline.com/x")?.id).toBe("paycom");
    expect(getAdapter("recruiting.ultipro.ca", "https://recruiting.ultipro.ca/x")?.id).toBe("ukg");
  });
});

// ---------------------------------------------------------------------------
// Company portals are NOT thin adapters (a bare host match would be too broad);
// they are recognized precisely by detectSite on their real application URLs.
// ---------------------------------------------------------------------------
describe("company portals via detectSite (path-gated)", () => {
  const cases: Array<[string, string, string]> = [
    ["careers.adobe.com", "https://careers.adobe.com/us/en/apply", "adobe"],
    ["www.amazon.jobs", "https://www.amazon.jobs/en/jobs/12345/apply", "amazon"],
    ["www.google.com", "https://www.google.com/about/careers/applications/apply/", "google"],
    ["careers.walmart.com", "https://careers.walmart.com/us/en/apply", "walmart"],
  ];

  it.each(cases)("%s → %s", (host, url, id) => {
    expect(detectSite(host, url)?.id).toBe(id);
  });

  it("a portal's non-application page is not detected", () => {
    // Adobe marketing path (no /.../apply) must not resolve.
    expect(detectSite("careers.adobe.com", "https://careers.adobe.com/us/en/search")).toBeNull();
  });

  it("portals are not exposed as fill adapters (host-only)", () => {
    // Bare google.com must never resolve as an ATS fill adapter.
    expect(getAdapter("www.google.com", "https://www.google.com/search?q=x")).toBeNull();
  });
});
