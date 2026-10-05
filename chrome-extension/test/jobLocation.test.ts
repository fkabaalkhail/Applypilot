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
    expect(detectJobPlace(document)).toEqual({ country: "CA", city: "Toronto", places: ["Toronto, ON, Canada"] });
  });

  it("several offices: the country when they agree, never a city", () => {
    ld({
      jobLocation: [
        { address: { addressLocality: "New York", addressRegion: "NY", addressCountry: "US" } },
        { address: { addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } },
      ],
    });
    expect(detectJobPlace(document)).toEqual({ country: "US", city: null, places: ["New York, NY, United States", "San Francisco, CA, United States"] });
  });

  it("the posting's location line, one anchored place only", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="job__location">San Francisco, CA</div>`;
    expect(detectJobPlace(document)).toEqual({ country: "US", city: "San Francisco", places: ["San Francisco, CA, United States"] });
    document.body.innerHTML = `<div class="job__location">New York, NY; San Francisco, CA</div>`;
    expect(detectJobPlace(document)).toEqual({ country: "US", city: null, places: ["New York, NY, United States", "San Francisco, CA, United States"] });
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

describe("location lines written 'Country - City' (Veeva on Lever, live 2026-10-03)", () => {
  it("read like 'City, Country'; an office name is never the city", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="posting-categories"><div class="location">Canada - Toronto</div></div>`;
    expect(detectJobPlace(document)).toEqual({ country: "CA", city: "Toronto", places: ["Toronto, Canada"] });
    document.body.innerHTML = `<div class="posting-categories"><div class="location">North Vancouver, Canada - Head Office</div></div>`;
    expect(detectJobPlace(document)).toEqual({ country: "CA", city: null });
  });
});

describe("every place a posting lists (Anthropic on Greenhouse, live 2026-10-03)", () => {
  it("a line of offices is one place per city, beside no single city", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="job__location">San Francisco, CA | New York City, NY | Washington, DC</div>`;
    expect(detectJobPlace(document)).toEqual({
      country: "US",
      city: null,
      places: ["San Francisco, CA, United States", "New York City, NY, United States", "Washington, DC, United States"],
    });
  });
  it("JSON-LD offices too", () => {
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      jobLocation: [
        { address: { addressLocality: "New York", addressRegion: "NY", addressCountry: "US" } },
        { address: { addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } },
      ],
    })}</script>`;
    document.body.innerHTML = "";
    expect(detectJobPlace(document).places).toEqual(["New York, NY, United States", "San Francisco, CA, United States"]);
  });
});

describe("a location element with no place in it does not hide the job's", () => {
  it("reads on to the element that names one", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="location"><span>Location</span></div><div data-ui="job-location">Rochester, New York, United States</div>`;
    expect(detectJobPlace(document).places).toEqual(["Rochester, NY, United States"]);
  });
});

describe("a career site's 'Location' label and its value (Epic Games, live 2026-10-05)", () => {
  it("<strong>Location</strong><p>Cary, United States</p> is the job's place", () => {
    // Unread, the job had no country, and "Do you have legal authorization to
    // work in the geographic region specified?" and the sponsorship question
    // stayed blank for a US citizen.
    document.head.innerHTML = "";
    document.body.innerHTML = `<h1>Engine Programmer Intern</h1><div><span><strong>Department</strong><p>Engineering</p><strong>Location</strong><p>Cary, United States</p><strong>Product</strong><p>Fortnite</p></span></div>`;
    expect(detectJobPlace(document)).toMatchObject({ country: "US", city: "Cary" });
    // dt/dd too, and never the applicant's own location box in a form.
    document.body.innerHTML = `<dl><dt>Location:</dt><dd>Toronto, ON</dd></dl>`;
    expect(detectJobCountry(document)).toBe("CA");
    document.body.innerHTML = `<form><label>Location</label><input value="Toronto, ON"><p>Toronto, ON</p></form>`;
    expect(detectJobCountry(document)).toBeNull();
    document.body.innerHTML = "";
  });
});

describe("the places under the job title (Databricks' career site, live 2026-10-05)", () => {
  it("'Bellevue, Washington; Mountain View, California; San Francisco, California' after the h1 is a US job", () => {
    // Unread, an India-based applicant's work-right and sponsorship questions
    // stayed blank.
    document.head.innerHTML = "";
    document.body.innerHTML = `<section data-cy="Hero"><div><h1><span>Product Management Intern (Summer 2027)</span></h1><div>Bellevue, Washington; Mountain View, California; San Francisco, California<p><button type="button">Apply now</button></p></div></div></section><main><p>P-982</p><p>At Databricks, we are passionate…</p></main>`;
    expect(detectJobCountry(document)).toBe("US");
    // A subtitle that is no place names nothing.
    document.body.innerHTML = `<h1>Engineer</h1><div>Platform team, full time</div>`;
    expect(detectJobCountry(document)).toBeNull();
    document.body.innerHTML = "";
  });
});
