/**
 * Regression tests against REAL application pages, captured from jobs in the
 * Tailrd app on 2026-10-03 (test/e2e/capture.mjs → test/fixtures/real/).
 * The rendered DOM is loaded into jsdom and scanned with the real-shaped
 * SPARSE_CANADIAN profile; each assertion is a field the live baseline run got
 * WRONG (or missed) on that exact markup.
 *
 * What is asserted is the PROPOSAL (what the extension would write), which is
 * where every one of those bugs originated. Custom widgets need the page's own
 * JavaScript to commit; that half is covered by the real-browser harness
 * (test/e2e).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { getAdapter } from "../src/content/adapters";
import { setResolveContext } from "../src/content/fieldResolver";
import type { DetectedField } from "../src/shared/types";
import { stubLayout } from "./helpers/layout";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";

const REAL = path.resolve(__dirname, "fixtures", "real");

// A real page is 20-750 KB of markup; jsdom scans it in seconds, so each page
// is loaded and scanned once and every assertion reads the same scan.
const scans = new Map<string, DetectedField[]>();
function load(ats: string, slug: string): DetectedField[] {
  const key = `${ats}/${slug}`;
  const hit = scans.get(key);
  if (hit) return hit;
  const html = readFileSync(path.join(REAL, ats, `${slug}.html`), "utf8");
  const meta = JSON.parse(readFileSync(path.join(REAL, ats, `${slug}.fields.json`), "utf8")) as { finalUrl: string };
  document.documentElement.innerHTML = html.replace(/^<!doctype html>\s*/i, "").replace(/^<html[^>]*>|<\/html>\s*$/gi, "");
  const url = new URL(meta.finalUrl);
  const fields = scanPage(SPARSE_CANADIAN, false, getAdapter(url.hostname, url.href)).fields;
  scans.set(key, fields);
  return fields;
}

vi.setConfig({ testTimeout: 60000 });

const byLabel = (fields: DetectedField[], text: string): DetectedField => {
  const f = fields.find((x) => x.label.toLowerCase().includes(text.toLowerCase()));
  if (!f) throw new Error(`no field labelled ~"${text}" (have: ${fields.map((x) => x.label.slice(0, 40)).join(" | ")})`);
  return f;
};

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
afterEach(() => setResolveContext({ jobCountry: null, company: "" }));

describe("Ashby (jobs.ashbyhq.com, real markup)", () => {
  it("a <fieldset> radio question takes its own <label>, not the previous question's", () => {
    const fields = load("ashby", "ashby-interplay-intern");
    const ai = fields.find((f) => f.controlType === "radioGroup" && f.options?.includes("Maybe So"))!;
    expect(ai.label).toBe("Do you think AI will take over the world?");
    // An opinion question: nothing on a profile answers it.
    expect(ai.proposedValue).toBeNull();
  });

  it("'Where are you located?' (regions) → North America for a Toronto applicant", () => {
    const fields = load("ashby", "ashby-interplay-intern");
    expect(byLabel(fields, "Where are you located").proposedValue).toBe("North America");
  });

  it("US work authorization is left blank for a Canadian citizen (and kept from the backend)", () => {
    const fields = load("ashby", "ashby-pangram-swe");
    const f = byLabel(fields, "authorized to work in the United States");
    expect(f.proposedValue).toBeNull();
    expect(f.deviceAbstained).toBe(true);
  });
});

describe("Greenhouse (job-boards.greenhouse.io, real markup)", () => {
  it("never answers 'authorized to work in the United States?' Yes for a Canadian citizen", () => {
    const fields = load("greenhouse", "gh-oneimaging-fullstack");
    const f = byLabel(fields, "authorized to work in the United States");
    expect(f.proposedValue).toBeNull();
    expect(f.deviceAbstained).toBe(true);
  });

  it("derives the Country from the location string", () => {
    const fields = load("greenhouse", "gh-oneimaging-fullstack");
    expect(fields.find((f) => f.id && f.category === "country" && f.controlType === "combobox")?.proposedValue).toBe("Canada");
  });

  it("answers 'attending or a recent graduate of the University of F…?' No from the education list", () => {
    const fields = load("greenhouse", "gh-oneimaging-fullstack");
    expect(byLabel(fields, "recent graduate of the University").proposedValue).toBe("No");
  });

  it("leaves a conditional 'If Other selected…' field blank", () => {
    const fields = load("greenhouse", "gh-garnerhealth-applied-scientist");
    expect(byLabel(fields, "If 'Other' selected").proposedValue).toBeNull();
  });

  it("'Where did you complete your undergraduate degree?' gets the SCHOOL, never the degree title", () => {
    const fields = load("greenhouse", "gh-bertram-fde");
    const f = byLabel(fields, "undergraduate degree");
    expect(f.proposedValue).toBe("University of Waterloo");
  });

  it("the free-text US sponsorship question stays blank (not a guessed Yes/No)", () => {
    const fields = load("greenhouse", "gh-bertram-fde");
    expect(byLabel(fields, "require employer sponsorship").proposedValue).toBeNull();
  });
});

describe("Lever (jobs.lever.co, real markup)", () => {
  it("a background-check question never receives the degree title", () => {
    const fields = load("lever", "lever-eqbank-intern");
    expect(byLabel(fields, "background check").proposedValue).toBeNull();
  });

  it("'legally entitled to work in Canada?' → Yes for a Canadian citizen", () => {
    const fields = load("lever", "lever-eqbank-intern");
    expect(byLabel(fields, "legally entitled to work in Canada").proposedValue).toBe("Yes");
  });

  it("'school you are currently attending' → the school in progress", () => {
    const fields = load("lever", "lever-eqbank-intern");
    expect(byLabel(fields, "school you are currently attending").proposedValue).toBe("University of Waterloo");
  });

  it("Current company → the employer of the row ending 'Present'", () => {
    const fields = load("lever", "lever-eqbank-intern");
    expect(byLabel(fields, "Current company").proposedValue).toBe("Kinaxis");
  });

  it("years of software development experience → the bucket containing the computed total", () => {
    const fields = load("lever", "lever-rover-swe");
    expect(byLabel(fields, "years of professional software development").proposedValue).toBe("1-3 years");
  });

  it("US sponsorship stays blank for a Canadian citizen", () => {
    const fields = load("lever", "lever-rover-swe");
    expect(byLabel(fields, "require sponsorship in the future").proposedValue).toBeNull();
  });

  it("'legally able to work in Canada according to…' → Yes", () => {
    const fields = load("lever", "lever-kepler-intern");
    expect(byLabel(fields, "legally able to work in Canada").proposedValue).toBe("Yes");
  });
});

describe("Workable (apply.workable.com, real markup)", () => {
  it("'Do you live in the United States?' → NO for a Toronto applicant (never 'Toronto')", () => {
    const fields = load("workable", "workable-mindex-coop");
    const live = fields.filter((f) => f.label.includes("Do you live in the United States"));
    expect(live.length).toBeGreaterThan(0);
    for (const f of live) expect(f.proposedValue).toBe("NO");
  });

  it("'eligible to work in Canada without sponsorship?' → YES for a Canadian citizen", () => {
    const fields = load("workable", "workable-financeit-ds");
    const f = fields.filter((x) => x.label.includes("eligible to work in Canada without sponsorship"));
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) expect(x.proposedValue).toBe("YES");
  });

  it("US authorization stays blank on both the native and the ARIA radio twin", () => {
    const fields = load("workable", "workable-mindex-coop");
    for (const f of fields.filter((x) => x.label.includes("authorized to work in the United States"))) {
      expect(f.proposedValue).toBeNull();
    }
  });
});

describe("BambooHR (*.bamboohr.com, real markup)", () => {
  it("City gets the city alone; Address (street) stays blank without a street", () => {
    const fields = load("bamboohr", "bamboo-armstrong-coop");
    expect(byLabel(fields, "City").proposedValue).toBe("Toronto");
    expect(fields.find((f) => f.label === "Address")?.proposedValue ?? null).toBeNull();
  });

  it("'legally entitled to work in Canada?' → Yes", () => {
    const fields = load("bamboohr", "bamboo-armstrong-coop");
    const f = fields.filter((x) => x.label.includes("legally entitled to work in Canada"));
    expect(f.some((x) => x.proposedValue === "Yes")).toBe(true);
    for (const x of f) expect([null, "Yes"]).toContain(x.proposedValue);
  });

  it("never fills the honeypot", () => {
    const fields = load("bamboohr", "bamboo-armstrong-coop");
    const pot = fields.find((f) => f.label.toLowerCase().includes("leave this field blank"));
    expect(pot?.proposedValue ?? null).toBeNull();
  });
});

describe("Jobvite (jobs.jobvite.com, real markup)", () => {
  it("City → Toronto, not the whole location string", () => {
    const fields = load("jobvite", "jobvite-actionet-jrdev");
    expect(byLabel(fields, "City").proposedValue).toBe("Toronto");
  });

  it("'current or past employee of ActioNet?' → Neither, from the employment history", () => {
    const fields = load("jobvite", "jobvite-actionet-jrdev");
    expect(byLabel(fields, "current or past employee of ActioNet").proposedValue).toBe("Neither");
  });

  it("a US State select for a Canadian resident → its explicit 'Not Applicable'", () => {
    const fields = load("jobvite", "jobvite-actionet-jrdev");
    expect(fields.find((f) => f.label.startsWith("State"))?.proposedValue).toBe("Not Applicable");
  });

  it("total years of relevant experience (text) → the computed whole years", () => {
    const fields = load("jobvite", "jobvite-actionet-jrdev");
    expect(byLabel(fields, "total number of years of relevant experience").proposedValue).toBe("1");
  });

  it("'age 18 or older?' stays blank without a date of birth", () => {
    const fields = load("jobvite", "jobvite-actionet-jrdev");
    expect(byLabel(fields, "age 18 or older").proposedValue).toBeNull();
  });

  it("highest education stays blank while the degree is still in progress", () => {
    const fields = load("jobvite", "jobvite-actionet-jrdev");
    expect(byLabel(fields, "highest education").proposedValue).toBeNull();
  });
});
