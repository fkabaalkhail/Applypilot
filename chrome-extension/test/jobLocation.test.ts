/**
 * The job's country, used to answer "authorized to work in THIS country?".
 * Workday application steps show no location, but the URL keeps it.
 * URLs below are real ones from jobs in the app (prod scraped_jobs, 2026-10-03).
 */
import { describe, expect, it } from "vitest";
import { countryFromWorkdayUrl, detectJobCountry, detectJobPlace } from "../src/content/jobLocation";

describe("countryFromWorkdayUrl", () => {
  it("reads the location slug of real Workday URLs", () => {
    expect(countryFromWorkdayUrl("https://capitalone.wd12.myworkdayjobs.com/en-US/capital_one/job/Cambridge-MA/Part-Time-Applied-Data-Scientist_R1000592")).toBe("US");
    expect(countryFromWorkdayUrl("https://graco.wd501.myworkdayjobs.com/en-US/graco_careers/job/Dayton-Minnesota-USA-French-Lake/AI-Intern_R0023511-1")).toBe("US");
    expect(countryFromWorkdayUrl("https://tmhcc.wd108.myworkdayjobs.com/en-US/external/job/Texas---Houston-Corporate-Office/Data-Engineering-Intern---Summer-2027_2026-908")).toBe("US");
    expect(countryFromWorkdayUrl("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/Toronto-ON/Software-Engineer_R1/apply")).toBe("CA");
  });
  it("a bare city is not evidence", () => {
    expect(countryFromWorkdayUrl("https://aimco.wd10.myworkdayjobs.com/en-US/aimcocareers/job/Calgary/New-Grad-Analyst_JR100915")).toBeNull();
  });
  it("ignores non-Workday hosts", () => {
    expect(countryFromWorkdayUrl("https://example.com/en-US/x/job/Toronto-ON/y")).toBeNull();
  });
});

describe("detectJobCountry", () => {
  it("reads schema.org JobPosting JSON-LD", () => {
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Toronto", addressCountry: "CA" } },
    })}</script>`;
    document.body.innerHTML = "";
    expect(detectJobCountry(document)).toBe("CA");
  });
  it("disagreeing signals give null", () => {
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify([
      { "@type": "JobPosting", jobLocation: { address: { addressCountry: "US" } } },
      { "@type": "JobPosting", jobLocation: { address: { addressCountry: "CA" } } },
    ])}</script>`;
    expect(detectJobCountry(document)).toBeNull();
  });
});

describe("detectJobPlace (country + city)", () => {
  const ld = (posting: Record<string, unknown>) => {
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", ...posting })}</script>`;
    document.body.innerHTML = "";
  };

  it("a TELECOMMUTE posting's applicantLocationRequirements (Brex on Greenhouse, live 2026-10-03)", () => {
    ld({
      jobLocationType: "TELECOMMUTE",
      title: "Brex Rotational Program",
      applicantLocationRequirements: { "@type": "Country", name: "Salt Lake City, Utah, United States" },
    });
    expect(detectJobPlace(document)).toEqual({ country: "US", city: "Salt Lake City" });
  });

  it("jobLocation's locality is the city", () => {
    ld({ jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Toronto", addressRegion: "ON", addressCountry: "CA" } } });
    expect(detectJobPlace(document)).toEqual({ country: "CA", city: "Toronto" });
  });

  it("several offices: the country when they agree, never a city", () => {
    ld({
      jobLocation: [
        { address: { addressLocality: "New York", addressRegion: "NY", addressCountry: "US" } },
        { address: { addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } },
      ],
    });
    expect(detectJobPlace(document)).toEqual({ country: "US", city: null });
  });

  it("the posting's location line, one anchored place only", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="job__location">San Francisco, CA</div>`;
    expect(detectJobPlace(document)).toEqual({ country: "US", city: "San Francisco" });
    document.body.innerHTML = `<div class="job__location">New York, NY; San Francisco, CA</div>`;
    expect(detectJobPlace(document)).toEqual({ country: "US", city: null });
    document.body.innerHTML = `<div class="job__location">Remote - US</div>`;
    expect(detectJobPlace(document)).toEqual({ country: "US", city: null });
    document.body.innerHTML = `<div class="job__location">Calgary</div>`;
    expect(detectJobPlace(document)).toEqual({ country: null, city: null });
  });

  it("a form's own location field is the applicant's, not the job's", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<form><div class="location">Toronto, ON</div></form>`;
    expect(detectJobPlace(document)).toEqual({ country: null, city: null });
  });
});
