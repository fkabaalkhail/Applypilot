// chrome-extension/src/content/siteRegistry.ts
/**
 * The single source of truth for "which site am I on". A typed port of
 * Jobright's `SITE_REGISTRY`: one data table keyed by site id, each entry
 * carrying any of domains / url patterns / path gate / iframe markers /
 * page-source keyword. `detectSite()` resolves a page to at most one entry.
 *
 * Detection is intentionally pure (host + url + a couple of ambient flags) so
 * it is trivially unit-testable and can run identically in the top document and
 * inside an embedded application iframe.
 */

/** Chrome match-pattern → RegExp. `*` scheme = http/https; a `*.` host also
 *  matches the apex; path `*` matches any run of characters (incl. `/`). */
export function matchPatternToRegex(pattern: string): RegExp {
  const m = /^(\*|https?|file):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)?$/.exec(pattern);
  if (!m) return /(?!)/; // structurally invalid → never matches (not even "")
  const [, scheme, host = "*", path = "/*"] = m;
  // Escape every regex metachar INCLUDING `*`, so the `\*` → `.*` pass below is
  // the only thing that can reintroduce a wildcard.
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
  const schemeRe = scheme === "*" ? "https?" : scheme;
  let hostRe: string;
  if (host === "*") hostRe = "[^/]+";
  else if (host.startsWith("*.")) hostRe = "(?:[^/]+\\.)?" + esc(host.slice(2));
  else hostRe = esc(host);
  const pathRe = esc(path).replace(/\\\*/g, ".*");
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, "i");
}

/** True when `url` satisfies the Chrome match-pattern `pattern`. */
export function matchPattern(pattern: string, url: string): boolean {
  try {
    return matchPatternToRegex(pattern).test(url);
  } catch {
    return false;
  }
}

export interface SiteEntry {
  /** Stable id: matches the adapter id and Jobright's registry key. */
  id: string;
  /** Human label for the panel ("Workday", "iCIMS"). */
  label: string;
  /** vendor = reusable ATS (covers many employers); portal = one employer. */
  tier: "vendor" | "portal";
  /** Anchored hostname suffixes (host === d || host endsWith "."+d). */
  domains?: string[];
  /** Chrome match-pattern globs, tested against the full URL. */
  patterns?: string[];
  /** When embedded, the iframe is served from one of these hosts. */
  iframeDomains?: string[];
  /** Only operate inside the application iframe (iCIMS). */
  iframeOnly?: boolean;
  /** Gate: the URL path must also match this to count as an application page. */
  pathRegex?: RegExp;
  /** Detect by a keyword in page source (ATS on the employer's own domain). */
  pageSourceKeyword?: string;
  pageSourceDomain?: string;
}

/** Ported verbatim (order-preserved) from Jobright 1.15.0's SITE_REGISTRY.
 *  Source of truth: docs/superpowers/reference/jobright-site-registry.json. */
export const SITE_REGISTRY: SiteEntry[] = [
  {
    id: "greenhouse",
    label: "Greenhouse",
    tier: "vendor",
    domains: ["greenhouse.io"],
    iframeDomains: ["greenhouse.io"],
    pathRegex: new RegExp("^/(?:[^/]+/jobs/\\d+|embed/job_app)"),
  },
  {
    id: "xcompany",
    label: "X (Alphabet)",
    tier: "portal",
    patterns: ["*://x.company/*"],
    pathRegex: new RegExp("^/careers/[^/]+/?$"),
  },
  {
    id: "walmart",
    label: "Walmart",
    tier: "portal",
    patterns: ["*://careers.walmart.com/*"],
    pathRegex: new RegExp("^/(us/en/(home|jobs?/[^/]+|apply(?:/.*)?|application(?:/.*)?)|content/careers/us/en/.*)$"),
  },
  {
    id: "workday",
    label: "Workday",
    tier: "vendor",
    domains: ["myworkdayjobs.com","myworkdayjobs-impl.com","myworkdaysite.com","myworkday.com"],
  },
  {
    id: "jibe",
    label: "Jibe",
    tier: "vendor",
    patterns: ["*://*.jibeapply.com/jobs/*"],
  },
  {
    id: "welcometothejungle",
    label: "Welcome to the Jungle",
    tier: "vendor",
    patterns: ["*://app.welcometothejungle.com/jobs*", "*://app.welcometothejungle.com/dashboard/jobs*"],
  },
  {
    id: "kula",
    label: "Kula",
    tier: "vendor",
    domains: ["careers.kula.ai"],
    pathRegex: new RegExp("^/[^/]+/[^/]+"),
  },
  {
    id: "icims",
    label: "iCIMS",
    tier: "vendor",
    domains: ["icims.com"],
    iframeDomains: ["icims.com"],
    iframeOnly: true,
    pathRegex: new RegExp("^/jobs/\\d+(?!.*/job$)"),
  },
  {
    id: "dover",
    label: "Dover",
    tier: "vendor",
    domains: ["dover.com"],
  },
  {
    id: "adobe",
    label: "Adobe",
    tier: "portal",
    domains: ["careers.adobe.com"],
    pathRegex: new RegExp("^/[^/]+/[^/]+/apply"),
  },
  {
    id: "zohorecruit",
    label: "Zoho Recruit",
    tier: "vendor",
    domains: ["zohorecruit.com","zohorecruit.ca","zohorecruit.eu"],
    iframeDomains: ["zohorecruit.com","zohorecruit.ca","zohorecruit.eu"],
    pathRegex: new RegExp("^/jobs/Careers/.+"),
  },
  {
    id: "gem",
    label: "Gem",
    tier: "vendor",
    domains: ["jobs.gem.com"],
    pathRegex: new RegExp("^/[\\w-]+/[\\w-]+/?$"),
  },
  {
    id: "gusto",
    label: "Gusto",
    tier: "portal",
    patterns: ["*://jobs.gusto.com/postings/*/applicants/new*"],
  },
  {
    id: "hiringthing",
    label: "HiringThing",
    tier: "vendor",
    domains: ["hiringthing.com","oasisrecruit.com","elevate-ats.com","prismhr-hire.com","gnahiring.com","rippling-ats.com"],
    pathRegex: new RegExp("^/job/\\d+/"),
  },
  {
    id: "hubspot",
    label: "HubSpot",
    tier: "portal",
    patterns: ["*://www.hubspot.com/careers/jobs/*"],
  },
  {
    id: "paycomonline",
    label: "Paycom",
    tier: "vendor",
    domains: ["paycomonline.com","paycomonline.net"],
  },
  {
    id: "teamtailor",
    label: "Teamtailor",
    tier: "vendor",
    domains: ["teamtailor.com","careers.blueorange.digital","careers.totalperform.com"],
    pathRegex: new RegExp("^/jobs/.+"),
    pageSourceKeyword: "teamtailor-cdn.com",
    pageSourceDomain: "teamtailor.com",
  },
  {
    id: "catsone",
    label: "CATS",
    tier: "vendor",
    domains: ["catsone.com"],
    pathRegex: new RegExp("/apply/?$"),
  },
  {
    id: "metacareers",
    label: "Meta",
    tier: "portal",
    domains: ["metacareers.com"],
    pathRegex: new RegExp("^/profile/(create_application|job_details)/[^/]+"),
  },
  {
    id: "ycombinator",
    label: "Y Combinator",
    tier: "portal",
    domains: ["www.ycombinator.com"],
  },
  {
    id: "ripplehire",
    label: "RippleHire",
    tier: "vendor",
    domains: ["ripplehire.com"],
  },
  {
    id: "personio",
    label: "Personio",
    tier: "vendor",
    domains: ["personio.de","personio.com"],
  },
  {
    id: "careerspage",
    label: "CareersPage",
    tier: "vendor",
    domains: ["careers-page.com"],
  },
  {
    id: "careerplug",
    label: "CareerPlug",
    tier: "vendor",
    domains: ["careerplug.com","sfagentjobs.com","sfagentcareers.com","apscareerportal.com"],
    pathRegex: new RegExp("^/jobs/\\d+/apps/new"),
  },
  {
    id: "careerswithwaymo",
    label: "Waymo",
    tier: "portal",
    patterns: ["*://careers.withwaymo.com/jobs/*"],
    pathRegex: new RegExp("^/jobs/(?!search(?:/|$))[^/]+"),
  },
  {
    id: "successfactors",
    label: "SuccessFactors",
    tier: "vendor",
    domains: ["successfactors.eu","successfactors.com","sapsf.com"],
  },
  {
    id: "clearcompany",
    label: "ClearCompany",
    tier: "vendor",
    domains: ["clearcompany.com"],
  },
  {
    id: "ashby",
    label: "Ashby",
    tier: "vendor",
    patterns: ["*://*.ashbyhq.com/*/*"],
    iframeDomains: ["jobs.ashbyhq.com","ashby_jid"],
    pathRegex: new RegExp("^/[^/]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
  },
  {
    id: "isolved",
    label: "isolved",
    tier: "vendor",
    domains: ["isolvedhire.com"],
    pathRegex: new RegExp("^/(?:apply/|jobs/|iframe/mobile/|account/)"),
  },
  {
    id: "jobdiva",
    label: "JobDiva",
    tier: "vendor",
    patterns: ["*://*.jobdiva.com/portal/*"],
  },
  {
    id: "intuit",
    label: "Intuit",
    tier: "portal",
    domains: ["intuit-quiz.app.intuit.com"],
    iframeDomains: ["intuit-quiz.app.intuit.com"],
  },
  {
    id: "jacobs",
    label: "Jacobs",
    tier: "portal",
    patterns: ["*://careers.jacobs.com/en_US/careers/*"],
    pathRegex: new RegExp("^/en_US/careers/(Register|ApplicationForm|ApplicationReview)(?:/|$)"),
  },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    tier: "vendor",
    domains: ["smartr.me"],
    patterns: ["*://jobs.smartrecruiters.com/oneclick-ui/company/*"],
  },
  {
    id: "phenom",
    label: "Phenom",
    tier: "vendor",
    patterns: ["*://jobs.bswhealth.com/*/apply*","*://careers.uvahealth.org/*/apply*","*://careers.dukehealth.org/*/apply*","*://www.jobs.abbott/*/apply*","*://careers.aspendental.com/*/apply*","*://careers.fivebelow.com/*/apply*","*://careers.fourseasons.com/*/apply*","*://careers.kbr.com/*/apply*","*://jobs.kuehne-nagel.com/*/apply*","*://careers.mastercard.com/*/apply*","*://careers.mcafee.com/*/apply*","*://jobs-cee.pwc.com/*/apply*","*://careers.roche.com/*/apply*","*://www.vcacareers.com/*/apply*","*://careers.wasteconnections.com/*/apply*"],
    pageSourceKeyword: "APPLY_form_renderer.js",
    pageSourceDomain: "phenompeople.com",
  },
  {
    id: "cisco",
    label: "Cisco",
    tier: "portal",
    patterns: ["*://careers.cisco.com/*/apply*"],
  },
  {
    id: "tesla",
    label: "Tesla",
    tier: "portal",
    patterns: ["*://*.jobs.tesla.com/*","*://*.tesla.com/careers/*"],
    pathRegex: new RegExp("/apply"),
  },
  {
    id: "amazon",
    label: "Amazon",
    tier: "portal",
    patterns: ["*://*.amazon.jobs/*"],
    pathRegex: new RegExp("/jobs/[\\w-]+/apply"),
  },
  {
    id: "amazonuniversity",
    label: "Amazon University",
    tier: "portal",
    patterns: ["*://*.amazonuniversity.jobs/profile*"],
  },
  {
    id: "uber",
    label: "Uber",
    tier: "portal",
    domains: ["uber.com"],
    pathRegex: new RegExp("^/(?:(?:[^/]+/){1,2})?careers/(?:apply(?:/|$)|list/[^/?#]+)"),
  },
  {
    id: "tiktok",
    label: "TikTok",
    tier: "portal",
    patterns: ["*://*.lifeattiktok.com/resume*"],
  },
  {
    id: "bytedance",
    label: "ByteDance",
    tier: "portal",
    patterns: ["*://*.jobs.bytedance.com/en/resume*","*://jobs.bytedance.com/*/*/*/detail*","*://jobs.bytedance.com/*/*/*/apply*","*://jobs.bytedance.com/*/*/applied*","*://joinbytedance.com/search/*"],
  },
  {
    id: "google",
    label: "Google",
    tier: "portal",
    patterns: ["*://google.com/about/careers/*","*://*.google.com/about/careers/*"],
    pathRegex: new RegExp("^/about/careers/applications(/u/\\d+)?/apply/"),
  },
  {
    id: "lever",
    label: "Lever",
    tier: "vendor",
    patterns: ["*://jobs.lever.co/*/*","*://jobs.eu.lever.co/*/*"],
    iframeDomains: ["lever.co"],
    pathRegex: new RegExp("^/[^/]+/[^/]+(?:/apply)?/?$"),
  },
  {
    id: "jobvite",
    label: "Jobvite",
    tier: "vendor",
    patterns: ["*://jobs.jobvite.com/*/apply*"],
    iframeDomains: ["jobs.jobvite.com"],
  },
  {
    id: "breezy",
    label: "Breezy",
    tier: "vendor",
    patterns: ["*://*.breezy.hr/p/*","*://*.breezy.hr/*/apply*"],
  },
  {
    id: "workable",
    label: "Workable",
    tier: "vendor",
    domains: ["careers.arbor-education.com"],
    patterns: ["*://apply.workable.com/*","*://jobs.workable.com/*"],
    iframeDomains: ["workable.com"],
    pathRegex: new RegExp("^/(?:[^/]+/j/[^/]+(?:/apply)?/?$|(?:[a-z]{2}/)?(?:view|company)/[\\w-]+)"),
  },
  {
    id: "gohire",
    label: "GoHire",
    tier: "vendor",
    patterns: ["*://jobs.gohire.io/*/*"],
    iframeDomains: ["app.gohire.io/widget/"],
    pathRegex: new RegExp("^/[^/]+/.+-\\d+/?$"),
  },
  {
    id: "bamboohr",
    label: "BambooHR",
    tier: "vendor",
    patterns: ["*://*.bamboohr.com/jobs*","*://*.bamboohr.com/careers*"],
    iframeDomains: ["bamboohr.com"],
    pathRegex: new RegExp("^/(?:jobs|careers/[\\w-]*\\d)"),
  },
  {
    id: "brassring",
    label: "BrassRing",
    tier: "vendor",
    patterns: ["*://*.brassring.com/TGnewUI/*"],
    iframeDomains: ["brassring.com"],
  },
  {
    id: "adp",
    label: "ADP",
    tier: "vendor",
    domains: ["workforcenow.adp.com"],
    patterns: ["*://recruiting.adp.com/srccar/public/*","*://myjobs.adp.com/*/cx/*"],
  },
  {
    id: "oraclecloud",
    label: "Oracle Cloud",
    tier: "vendor",
    patterns: ["*://*.oraclecloud.com/*/CandidateExperience/*/sites/*/job/*","*://*.oraclecloud.com/*/CandidateExperience/*/sites/*/*/preview/*","*://*/*/CandidateExperience/*/sites/*/job/*","*://*/*/CandidateExperience/*/sites/*/*/preview/*","*://*/*/sites/*/jobs/preview/*/apply/*"],
    pathRegex: new RegExp("(?:/CandidateExperience/.*/sites/[^/]+/job/[^/]+(?:/apply(?:/.*)?)?/?$|/apply)"),
  },
  {
    id: "ultipro",
    label: "UKG Pro",
    tier: "vendor",
    patterns: ["*://*.ultipro.com/*/JobBoard/*/OpportunityDetail*","*://*.ultipro.com/*/JobBoard/*/OpportunityApply*","*://*.ultipro.ca/*/JobBoard/*/OpportunityDetail*","*://*.ultipro.ca/*/JobBoard/*/OpportunityApply*","*://*.rec.pro.ukg.net/*/JobBoard/*/OpportunityDetail*","*://*.rec.pro.ukg.net/*/JobBoard/*/OpportunityApply*"],
  },
  {
    id: "rippling",
    label: "Rippling",
    tier: "vendor",
    patterns: ["*://*.rippling-ats.com/job/*/apply*","*://*.rippling-ats.com/jobs/eop_survey/*","*://ats.rippling.com/*/jobs/*/apply*"],
    iframeDomains: ["ats.rippling.com"],
  },
  {
    id: "dayforce",
    label: "Dayforce",
    tier: "vendor",
    patterns: ["*://jobs.dayforcehcm.com/*/jobs/*/apply*"],
  },
  {
    id: "taleo",
    label: "Taleo",
    tier: "vendor",
    patterns: ["*://*.taleo.net/*/application.jss*","*://*.taleo.net/*/flow.jsf*","*://*.taleo.net/*/jobapply*","*://*.taleo.net/*/ats/careers/*","*://*.taleo.net/*/htmlResourceViewer.jss*","*://*.burnsmcd.com/apply*","*://*.burnsmcd.com/careersection/application.jss*","*://*.burnsmcd.com/careersection/flow.jsf*","*://*.burnsmcd.com/careersection/jobapply*","*://*.burnsmcd.com/careersection/htmlResourceViewer.jss*","*://talentacquisition.3ds.com/*/application.jss*","*://talentacquisition.3ds.com/*/flow.jsf*","*://talentacquisition.3ds.com/*/jobapply*","*://talentacquisition.3ds.com/*/ats/careers/*","*://talentacquisition.3ds.com/*/htmlResourceViewer.jss*"],
  },
  {
    id: "eightfold",
    label: "Eightfold",
    tier: "vendor",
    patterns: ["*://*.eightfold.ai/careers*"],
    iframeDomains: ["eightfold.ai"],
    pageSourceKeyword: "eightfold",
    pageSourceDomain: "eightfold.ai",
  },
  {
    id: "jazzhr",
    label: "JazzHR",
    tier: "vendor",
    patterns: ["*://*.applytojob.com/apply/*"],
  },
  {
    id: "trakstar",
    label: "Trakstar",
    tier: "vendor",
    patterns: ["*://*.hire.trakstar.com/jobs/*"],
    pathRegex: new RegExp("^/jobs/[^/]+/?$"),
  },
  {
    id: "freshteam",
    label: "Freshteam",
    tier: "vendor",
    patterns: ["*://*.freshteam.com/jobs/*"],
  },
  {
    id: "pinpointhq",
    label: "Pinpoint",
    tier: "vendor",
    patterns: ["*://*.pinpointhq.com/*/postings/*","*://*.pinpointhq.com/postings/*"],
  },
  {
    id: "recruitee",
    label: "Recruitee",
    tier: "vendor",
    patterns: ["*://*.recruitee.com/*/*"],
    pageSourceKeyword: "recruitee",
    pageSourceDomain: "recruitee.com",
  },
  {
    id: "trinethire",
    label: "TriNet Hire",
    tier: "vendor",
    patterns: ["*://app.trinethire.com/companies/*/jobs/*"],
  },
  {
    id: "jobscore",
    label: "JobScore",
    tier: "vendor",
    patterns: ["*://careers.jobscore.com/apply_flow/*","*://careers.jobscore.com/careers/*/jobs/*"],
    iframeDomains: ["jobscore.com"],
  },
  {
    id: "paylocity",
    label: "Paylocity",
    tier: "vendor",
    patterns: ["*://*.paylocity.com/recruiting/*","*://*.paylocity.com/Recruiting/*"],
    iframeDomains: ["paylocity.com"],
  },
  {
    id: "avature",
    label: "Avature",
    tier: "vendor",
    patterns: ["*://*.avature.net/*/ApplicationForm*","*://*.avature.net/*/ApplicationMethods*","*://*.avature.net/*/ApplicationQuestions*","*://*.avature.net/*/ApplicationReview*","*://*.avature.net/*/Register*","*://*.avature.net/LinkedInApplicationForm*","*://*.avature.net/*/LinkedInApplicationForm*","*://*.avature.net/*/YourInformation*","*://*.avature.net/campusApply*","*://*.avature.net/*/GeneralInfo*","*://*.avature.net/careers/JobDetail*","*://*.avature.net/careers/JobDetail/*","*://*.avature.net/*/careers/JobDetail/*","*://*.avature.net/*/External/JobDetail*","*://*.avature.net/careers/LocationAndProfile/*","*://*.avature.net/*/careers/LocationAndProfile/*","*://careers.arcb.com/careersmarketplace/ApplicationForm*","*://careers.arcb.com/careersmarketplace/ApplicationMethods*","*://careers.arcb.com/careersmarketplace/ApplicationQuestions*","*://careers.arcb.com/careersmarketplace/ApplicationReview*","*://careers.arcb.com/careersmarketplace/Register*","*://careers.arcb.com/careersmarketplace/GeneralInfo*","*://careers.arcb.com/careersmarketplace/JobDetail*","*://careers.arcb.com/careersmarketplace/ApplicationDotKnockedOutWizard*","*://apply.deloitte.com/*/careers/ApplicationForm*","*://apply.deloitte.com/*/careers/ApplicationMethods*","*://apply.deloitte.com/*/careers/ApplicationQuestions*","*://apply.deloitte.com/*/careers/ApplicationReview*","*://apply.deloitte.com/*/careers/Register*","*://apply.deloitte.com/*/careers/InviteToApply*","*://apply.deloitte.com/*/careers/GeneralInfo*","*://apply.deloitte.com/*/careers/JobDetail*","*://apply.deloitte.com/*/careers/JobDetail/*","*://apply.deloitte.com/*/careers/LocationAndProfile/*","*://apply.deloitte.com/*/External/JobDetail*","*://careers.cbre.com/*/careers/ApplicationForm*","*://careers.cbre.com/*/careers/ApplicationMethods*","*://careers.cbre.com/*/careers/ApplicationQuestions*","*://careers.cbre.com/*/careers/ApplicationReview*","*://careers.cbre.com/*/careers/Register*","*://careers.cbre.com/*/careers/InviteToApply*","*://careers.cbre.com/*/careers/GeneralInfo*","*://careers.cbre.com/*/careers/JobDetail*","*://careers.cbre.com/*/careers/JobDetail/*","*://careers.cbre.com/*/careers/LocationAndProfile/*","*://careers.cbre.com/*/External/JobDetail*","*://careers.mantech.com/*/careers/ApplicationForm*","*://careers.mantech.com/*/careers/ApplicationMethods*","*://careers.mantech.com/*/careers/ApplicationQuestions*","*://careers.mantech.com/*/careers/ApplicationReview*","*://careers.mantech.com/*/careers/Register*","*://careers.mantech.com/*/careers/InviteToApply*","*://careers.mantech.com/*/careers/GeneralInfo*","*://careers.mantech.com/*/careers/JobDetail*","*://careers.mantech.com/*/careers/JobDetail/*","*://careers.mantech.com/*/careers/LocationAndProfile/*","*://careers.mantech.com/*/External/JobDetail*","*://careers.ibm.com/*/careers/JobDetail*","*://careers.ibm.com/*/careers/ApplicationMethods*","*://careers.ibm.com/*/careers/JobApplication*","*://careers.ibm.com/*/careers/ApplicationForm*","*://careers.ibm.com/*/careers/ApplicationQuestions*","*://careers.ibm.com/*/careers/ApplicationReview*","*://careers.ibm.com/*/careers/Register*","*://careers.ibm.com/*/careers/GeneralInfo*","*://careers.ibm.com/*/careers/YourInformation*","*://careers.tql.com/*/TQLexternalcareers/ApplicationForm*","*://careers.tql.com/*/TQLexternalcareers/ApplicationMethods*","*://careers.tql.com/*/TQLexternalcareers/ApplicationQuestions*","*://careers.tql.com/*/TQLexternalcareers/ApplicationReview*","*://careers.tql.com/*/TQLexternalcareers/Register*","*://careers.tql.com/*/TQLexternalcareers/InviteToApply*","*://careers.tql.com/*/TQLexternalcareers/GeneralInfo*","*://careers.tql.com/*/TQLexternalcareers/JobDetail*","*://careers.tql.com/*/TQLexternalcareers/JobDetail/*","*://careers.tql.com/*/TQLexternalcareers/LocationAndProfile/*","*://careers.tql.com/*/External/JobDetail*"],
    pageSourceKeyword: "avature",
    pageSourceDomain: "avature.net",
  },
  {
    id: "okta",
    label: "Okta",
    tier: "portal",
    patterns: ["*://www.okta.com/company/careers/*/*"],
    pathRegex: new RegExp("^/company/careers/(?!job-listing(?:/|$))"),
  },
  {
    id: "comeet",
    label: "Comeet",
    tier: "vendor",
    patterns: ["*://*.comeet.com/jobs/*/*/*/*","*://*.comeet.co/jobs/*/*/apply*"],
    iframeDomains: ["comeet.co","comeet.com"],
  },
  {
    id: "apple",
    label: "Apple",
    tier: "portal",
    patterns: ["*://jobs.apple.com/app/*/apply/*"],
  },
  {
    id: "polymer",
    label: "Polymer",
    tier: "vendor",
    patterns: ["*://jobs.polymer.co/*/*"],
  },
  {
    id: "recruiterflow",
    label: "Recruiterflow",
    tier: "vendor",
    domains: ["recruiterflow.com"],
    pathRegex: new RegExp("^/[^/]+/jobs/[^/?#]+"),
    pageSourceKeyword: "recruiterflow.com",
    pageSourceDomain: "recruiterflow.com",
  },
  {
    id: "careerstoasttab",
    label: "Toast",
    tier: "portal",
    patterns: ["*://careers.toasttab.com/jobs*"],
  },
];

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith("." + d);
}

export interface DetectOpts {
  /** True when the content script runs inside an embedded iframe (self !== top). */
  inIframe?: boolean;
  /** Page HTML / script srcs, for pageSourceKeyword detection. */
  pageSource?: string;
}

/** Resolve a page to at most one registry entry. Pure; first match wins in
 *  registry (Jobright) order. */
export function detectSite(host: string, url: string, opts: DetectOpts = {}): SiteEntry | null {
  let path = "/";
  try {
    path = new URL(url).pathname;
  } catch {
    /* malformed url, gate on "/" */
  }
  for (const e of SITE_REGISTRY) {
    if (e.iframeOnly && !opts.inIframe) continue;
    const byDomain = e.domains?.some((d) => hostMatches(host, d)) ?? false;
    const byPattern = e.patterns?.some((p) => matchPattern(p, url)) ?? false;
    const byFrame = Boolean(opts.inIframe) && (e.iframeDomains?.some((d) => hostMatches(host, d)) ?? false);
    const bySource = Boolean(e.pageSourceKeyword && opts.pageSource && opts.pageSource.includes(e.pageSourceKeyword));
    if (!(byDomain || byPattern || byFrame || bySource)) continue;
    if (e.pathRegex && !e.pathRegex.test(path)) continue;
    return e;
  }
  return null;
}
