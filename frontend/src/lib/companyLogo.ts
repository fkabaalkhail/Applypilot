/**
 * Unified company-logo resolution for the dashboard.
 *
 * Goal: never show a broken image. We resolve the most accurate logo we can
 * (preferring the backend-resolved `company_domain`, then a known-company map,
 * then a name heuristic) and always provide a deterministic letter-avatar
 * fallback for when no logo image is available.
 *
 * This mirrors backend/services/logo_resolver.py so frontend and backend agree.
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

const NAME_NOISE =
  /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|group|holdings|technologies|technology|tech|solutions|solution|systems|labs|laboratories|services|service|software|the|and|of)\b/gi;

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

/** Best-effort domain from a company name (known map first, then heuristic). */
export function domainFromName(company?: string | null): string | null {
  if (!company) return null;
  const normalized = normalizeName(company);
  if (!normalized) return null;
  if (KNOWN_DOMAINS[normalized]) return KNOWN_DOMAINS[normalized];
  let token = normalized.replace(NAME_NOISE, " ").replace(/[^a-z0-9]/g, "");
  if (token.length < 2) token = normalized.replace(/[^a-z0-9]/g, "");
  if (token.length < 2) return null;
  return `${token}.com`;
}

/**
 * Extract a domain from a legacy stored logo URL (icon.horse, clearbit,
 * apistemic, google favicons). Lets us salvage older rows.
 */
function domainFromLegacyLogo(logo?: string | null): string | null {
  if (!logo) return null;
  if (logo.includes("logo.clearbit.com/")) return logo.split("logo.clearbit.com/")[1] || null;
  if (logo.includes("icon.horse/icon/")) return (logo.split("icon.horse/icon/")[1] || "").replace(/\?.*$/, "") || null;
  if (logo.includes("apistemic.com/domain:")) return logo.match(/domain:([^?]+)/)?.[1] || null;
  if (logo.includes("hunter.io/")) return logo.split("hunter.io/")[1]?.replace(/\?.*$/, "") || null;
  const favicon = logo.match(/[?&]domain=([^&]+)/);
  if (favicon) return favicon[1];
  return null;
}

/** Build a logo image URL for a resolved domain. */
export function logoUrlForDomain(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

export interface JobLike {
  company: string;
  company_logo?: string | null;
  company_domain?: string | null;
  company_url?: string | null;
}

/**
 * Resolve the best logo image URL for a job, or null if none is available
 * (caller should render the letter avatar).
 */
export function resolveLogoUrl(job: JobLike): string | null {
  // 1. A direct, non-generated logo URL (e.g. jobright CDN, LinkedIn CDN).
  const stored = job.company_logo || "";
  const isGenerated =
    stored.includes("clearbit") ||
    stored.includes("icon.horse") ||
    stored.includes("google.com/s2") ||
    stored.includes("apistemic") ||
    stored.includes("hunter.io");
  if (stored.startsWith("http") && !isGenerated) return stored;

  // 2. Backend-resolved domain (most accurate).
  let domain = (job.company_domain || "").trim();

  // 3. Known map / website URL / legacy logo / name heuristic.
  if (!domain) domain = domainFromUrl(job.company_url) || "";
  if (!domain) domain = domainFromName(job.company) || "";
  if (!domain) domain = domainFromLegacyLogo(stored) || "";

  return domain ? logoUrlForDomain(domain) : null;
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
  const s = company || "?";
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** First letter (uppercased) for the letter avatar. */
export function avatarLetter(company: string): string {
  const c = (company || "").trim();
  return c ? c.charAt(0).toUpperCase() : "?";
}
