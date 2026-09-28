/**
 * Unified company-logo resolution for the dashboard.
 *
 * Goal: never show a broken or misleading image. The backend stores one logo
 * per company: ideally a self-hosted, pre-verified square under /jobs/logo/,
 * otherwise a real hotlinked logo on older rows. When that is missing or
 * unusable we try Google's favicon service for the company's known domain, and
 * always fall back to a deterministic letter avatar.
 *
 * Domains are never guessed from the name here ("Bell Canada" is not bell.com):
 * a guessed domain showed parked-domain icons or wasted requests on
 * nonexistent hosts. Only the backend-verified company_domain, a real company
 * website URL, or the curated KNOWN_DOMAINS map (mirrors
 * backend/services/logo_resolver.py) are trusted.
 */

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "co.kr", "co.in", "co.nz", "co.za",
  "com.br", "com.mx", "com.sg", "com.hk", "com.tr",
]);

const NON_COMPANY_HOSTS = new Set([
  "jobright.ai", "newgrad-jobs.com", "linkedin.com", "indeed.com",
  "glassdoor.com", "github.com", "greenhouse.io", "lever.co",
  "myworkdayjobs.com", "ashbyhq.com", "smartrecruiters.com",
  "icims.com", "taleo.net", "bit.ly", "google.com",
]);

// Companies whose display name does not map cleanly to a domain.
const KNOWN_DOMAINS: Record<string, string> = {
  "pwc": "pwc.com", "pwc canada": "pwc.com",
  "deloitte": "deloitte.com", "deloitte canada": "deloitte.com",
  "kpmg": "kpmg.com", "ey": "ey.com", "ernst young": "ey.com",
  "accenture": "accenture.com", "accenture federal services": "afs.com",
  "mckinsey": "mckinsey.com", "capgemini": "capgemini.com",
  "jp morgan": "jpmorgan.com", "jpmorgan": "jpmorgan.com",
  "jpmorgan chase": "jpmorgan.com", "goldman sachs": "goldmansachs.com",
  "two sigma": "twosigma.com", "de shaw": "deshaw.com",
  "jane street": "janestreet.com", "capital one": "capitalone.com",
  "td bank": "td.com", "td": "td.com",
  "rbc": "rbc.com", "royal bank": "rbc.com", "royal bank of canada": "rbc.com",
  "cibc": "cibc.com", "bmo": "bmo.com", "bank of montreal": "bmo.com",
  "scotiabank": "scotiabank.com",
  "national bank": "nbc.ca", "national bank of canada": "nbc.ca",
  "manulife": "manulife.com", "sun life": "sunlife.com",
  "wealthsimple": "wealthsimple.com",
  "meta": "meta.com", "facebook": "meta.com",
  "google": "google.com", "alphabet": "google.com",
  "amazon": "amazon.com", "aws": "amazon.com", "amazon web services": "amazon.com",
  "electronic arts": "ea.com", "electronic arts ea": "ea.com",
  "bytedance": "bytedance.com", "tiktok": "tiktok.com",
  "twitter": "x.com", "x": "x.com", "snap": "snap.com", "snapchat": "snap.com",
  "hewlett packard enterprise": "hpe.com", "hpe": "hpe.com", "hp": "hp.com",
  "databricks": "databricks.com", "snowflake": "snowflake.com",
  "datadog": "datadoghq.com", "mongodb": "mongodb.com",
  "cockroachdb": "cockroachlabs.com", "cockroach labs": "cockroachlabs.com",
  "dbt labs": "getdbt.com", "elastic": "elastic.co",
  "confluent": "confluent.io", "neon": "neon.tech", "hashicorp": "hashicorp.com",
  "shopify": "shopify.com", "kinaxis": "kinaxis.com", "ciena": "ciena.com",
  "ross video": "rossvideo.com", "trend micro": "trendmicro.com",
  "magnet forensics": "magnetforensics.com",
  "ribbon communications": "ribboncommunications.com",
  "assent compliance": "assentcompliance.com", "assent": "assentcompliance.com",
  "you.i tv": "youi.tv", "youi tv": "youi.tv",
  "cgi": "cgi.com", "blackberry": "blackberry.com", "mitel": "mitel.com",
  "coveo": "coveo.com", "clio": "clio.com", "fullscript": "fullscript.com",
  "solace": "solace.com", "calian": "calian.com",
  "openai": "openai.com", "anthropic": "anthropic.com", "nvidia": "nvidia.com",
  "salesforce": "salesforce.com", "oracle": "oracle.com", "adobe": "adobe.com",
  "intuit": "intuit.com", "spotify": "spotify.com", "discord": "discord.com",
  "figma": "figma.com", "notion": "notion.so", "bloomberg": "bloomberg.com",
  "palantir": "palantir.com", "coinbase": "coinbase.com",
  "robinhood": "robinhood.com", "doordash": "doordash.com",
  "roblox": "roblox.com", "tesla": "tesla.com", "spacex": "spacex.com",
  "ericsson": "ericsson.com", "nokia": "nokia.com", "huawei": "huawei.com",
  "huawei canada": "huawei.com", "fortinet": "fortinet.com",
};

// Logo URLs that are generated from a (possibly guessed) domain rather than
// captured from a real source. Never render them as the stored logo.
const GENERATED_LOGO_HOSTS = [
  "clearbit", "icon.horse", "google.com/s2", "gstatic.com/favicon",
  "apistemic", "hunter.io", "unavatar.io",
];

// Self-hosted logos: the backend downloads, validates and squares them, then
// stores the relative path in company_logo. Served by GET /jobs/logo/{sha}.
const SELF_HOSTED_LOGO_PREFIX = "/jobs/logo/";

// Same base the API client uses, so a split-origin dev setup still resolves.
const API_BASE: string = import.meta.env.VITE_API_URL || "";

// The favicon service serves whatever resolution the site actually has, and
// hotlinked stored logos can be tiny icons; anything narrower than this would
// render as an upscaled blur at our display sizes (40-52px).
export const MIN_NATURAL_WIDTH = 40;

// Wider than this is a social banner or a long wordmark, which shrinks to an
// unreadable strip inside a square tile.
export const MAX_LOGO_ASPECT = 2.2;

const PLAUSIBLE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

function normalizeName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function registrableDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  return MULTI_PART_TLDS.has(lastTwo) ? lastThree : lastTwo;
}

/** Registrable domain from a company website URL, or null for non-company hosts. */
export function domainFromUrl(url?: string | null): string | null {
  if (!url) return null;
  let raw = url.trim();
  if (!raw) return null;
  if (!raw.includes("://")) raw = "http://" + raw;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || !host.includes(".")) return null;
  if (host.startsWith("www.")) host = host.slice(4);
  const registrable = registrableDomain(host);
  if (NON_COMPANY_HOSTS.has(registrable) || NON_COMPANY_HOSTS.has(host)) return null;
  return registrable;
}

/** Curated domain for a well-known company name, or null. Never guesses. */
export function knownDomainForName(company?: string | null): string | null {
  const normalized = normalizeName(cleanCompanyName(company));
  return (normalized && KNOWN_DOMAINS[normalized]) || null;
}

/** True for a logo URL generated from a domain (favicon/logo services). */
export function isGeneratedLogo(url?: string | null): boolean {
  const u = url || "";
  return GENERATED_LOGO_HOSTS.some((host) => u.includes(host));
}

/** True for a backend self-hosted logo path ('/jobs/logo/<sha>.png'). */
export function isSelfHostedLogo(url?: string | null): boolean {
  return (url || "").startsWith(SELF_HOSTED_LOGO_PREFIX);
}

/**
 * Whether a loaded image is fit to show in a square logo tile. A 0 dimension
 * means the browser could not tell (an SVG without an intrinsic size), which
 * is kept rather than guessed at.
 */
export function isUsableLogoImage(naturalWidth: number, naturalHeight: number): boolean {
  if (naturalWidth > 0 && naturalWidth < MIN_NATURAL_WIDTH) return false;
  if (naturalWidth > 0 && naturalHeight > 0 && naturalWidth / naturalHeight > MAX_LOGO_ASPECT) {
    return false;
  }
  return true;
}

export interface JobLike {
  company: string;
  company_logo?: string | null;
  company_domain?: string | null;
  company_url?: string | null;
}

export interface LogoSource {
  src: string;
  // Pre-verified by the backend (self-hosted): render as-is, no size checks.
  verified: boolean;
}

/**
 * Ordered logo-source candidates; CompanyLogo walks them on error or when a
 * loaded image is too small or too wide, then shows the letter avatar.
 * (Clearbit was removed 2026-07-15: logo.clearbit.com no longer resolves.
 * unavatar was removed too: 25 anonymous requests/day per IP, and what it
 * returned was mostly 16px favicons.)
 */
export function logoProviderChain(job: JobLike): LogoSource[] {
  const chain: LogoSource[] = [];
  const stored = (job.company_logo || "").trim();
  if (isSelfHostedLogo(stored)) {
    chain.push({ src: API_BASE + stored, verified: true });
  } else if (/^https?:\/\//i.test(stored) && !isGeneratedLogo(stored)) {
    chain.push({ src: stored, verified: false });
  }

  let domain = (job.company_domain || "").trim().toLowerCase();
  if (!domain) domain = domainFromUrl(job.company_url) || "";
  if (!domain) domain = knownDomainForName(job.company) || "";
  if (domain && PLAUSIBLE_DOMAIN.test(domain)) {
    chain.push({
      src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`,
      verified: false,
    });
  }
  return chain;
}

/**
 * Display form of a company name. Legacy GitHub-list rows wrap the name in
 * markdown emphasis ("**Tesla**"); strip the markers so the name, its letter
 * avatar and its color are the same as the plain spelling.
 */
export function cleanCompanyName(name?: string | null): string {
  let s = (name || "").trim();
  s = s.replace(/^(?:\*{2,}|_{2,})\s*/, "").replace(/\s*(?:\*{2,}|_{2,})$/, "");
  // A balanced single-marker wrap ("*Tesla*") is italics too.
  const italic = s.match(/^([*_])(.+)\1$/);
  if (italic) s = italic[2];
  return s.trim();
}

// Deterministic letter-avatar palette (stable per company name).
const AVATAR_COLORS = [
  "#7C6CFF", "#F97316", "#0EA5E9", "#22C55E", "#E11D48",
  "#A855F7", "#0891B2", "#2563EB", "#DB2777", "#059669",
  "#D97706", "#4F46E5",
];

/** Stable background color for a company's letter avatar. */
export function avatarColor(company: string): string {
  let hash = 0;
  const s = cleanCompanyName(company) || "?";
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** First letter or digit (uppercased) for the letter avatar; "?" when there is none. */
export function avatarLetter(company: string): string {
  const first = cleanCompanyName(company).match(/[\p{L}\p{N}]/u);
  return first ? first[0].toUpperCase() : "?";
}
