/**
 * Listing lifecycle helpers shared by the job feed and the job detail panel:
 * closed-listing state, the click-time live check, posted-date labels and the
 * source label.
 *
 * The backend keeps every row (saved jobs and applications reference them) and
 * soft-closes dead ones through listing_status: active | stale | removed |
 * expired. The feed only lists active and stale rows, but removed and expired
 * ones still reach the UI through the Liked tab, deep links, or a live check.
 */
import api from "../auth/api";
import { parseServerDate } from "./datetime";

export const CLOSED_LISTING_STATUSES = new Set(["removed", "expired"]);

/** True when the listing no longer accepts applications. */
export function isListingClosed(status?: string | null): boolean {
  return CLOSED_LISTING_STATUSES.has((status || "").toLowerCase());
}

export interface LiveCheckResult {
  id: number;
  listing_status: string;
  verdict: "alive" | "dead" | "unknown";
}

// One check per job per session: reopening a job reuses the first answer.
const liveChecks = new Map<number, Promise<LiveCheckResult | null>>();
// Set once the server shows the endpoint does not exist, so a deploy without
// it costs one failed request per session instead of one per opened job.
let liveCheckUnavailable = false;

async function requestLiveCheck(jobId: number): Promise<LiveCheckResult | null> {
  try {
    const { data } = await api.post(`/jobs/${jobId}/check-live`);
    if (!data || typeof data.listing_status !== "string" || typeof data.verdict !== "string") {
      return null;
    }
    return data as LiveCheckResult;
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
    // FastAPI answers an unknown route with 404 {"detail": "Not Found"} (a
    // missing job says "Job not found.") and a wrong method with 405.
    if (response?.status === 405 || (response?.status === 404 && response.data?.detail === "Not Found")) {
      liveCheckUnavailable = true;
    }
    return null;
  }
}

/**
 * Ask the backend to re-verify a listing against its source (POST
 * /jobs/{id}/check-live). Never rejects: any failure resolves to null, and
 * callers must not block the Apply button on it.
 */
export function checkListingLive(jobId: number): Promise<LiveCheckResult | null> {
  let pending = liveChecks.get(jobId);
  if (!pending) {
    if (liveCheckUnavailable) return Promise.resolve(null);
    pending = requestLiveCheck(jobId);
    liveChecks.set(jobId, pending);
  }
  return pending;
}

/** The listing_status a live-check answer implies ("dead" always reads as closed). */
export function listingStatusFromLiveCheck(result: LiveCheckResult): string {
  if (result.verdict === "dead" && !isListingClosed(result.listing_status)) return "removed";
  return result.listing_status;
}

/** Test hook: forget every cached live check. */
export function resetLiveChecks(): void {
  liveChecks.clear();
  liveCheckUnavailable = false;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function shortDate(date: Date): string {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * "3h ago", "2 days ago", "Sep 4" for a posted/scraped timestamp.
 *
 * A date-only posting can sit up to a day ahead of UTC and still mean today.
 * Anything further out is a real future date (some GitHub lists stamp old
 * postings with next year's dates), so it shows the date, never "Today".
 */
export function postedAgo(value: string | null | undefined): string {
  const date = parseServerDate(value);
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return -diff < DAY_MS ? "Today" : shortDate(date);
  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return shortDate(date);
}

export type SourceKind = "github" | "linkedin" | "other";

const ATS_LABELS: Record<string, string> = {
  ashby: "Ashby",
  bamboohr: "BambooHR",
  breezy: "Breezy HR",
  eightfold: "Eightfold",
  greenhouse: "Greenhouse",
  icims: "iCIMS",
  indeed: "Indeed",
  jobvite: "Jobvite",
  lever: "Lever",
  linkedin: "LinkedIn",
  oracle: "Oracle Cloud",
  phenom: "Phenom",
  recruitee: "Recruitee",
  smartrecruiters: "SmartRecruiters",
  successfactors: "SuccessFactors",
  talentplatform: "Talent Platform",
  taleo: "Taleo",
  workable: "Workable",
  workday: "Workday",
};

// Board hosts for ATS rows stored without an ats_type.
const ATS_HOSTS: [string, string][] = [
  ["myworkdayjobs.com", "workday"],
  ["greenhouse.io", "greenhouse"],
  ["lever.co", "lever"],
  ["ashbyhq.com", "ashby"],
  ["smartrecruiters.com", "smartrecruiters"],
  ["icims.com", "icims"],
  ["taleo.net", "taleo"],
  ["successfactors.", "successfactors"],
  ["linkedin.com", "linkedin"],
  ["indeed.com", "indeed"],
];

function atsFromUrl(url?: string | null): string {
  let host = "";
  try {
    host = new URL(url || "").hostname.toLowerCase();
  } catch {
    return "";
  }
  const hit = ATS_HOSTS.find(([suffix]) => host.includes(suffix));
  return hit ? hit[1] : "";
}

/** Where a listing came from, for the detail panel's source tag. */
export function sourceLabel(job: {
  source_platform?: string | null;
  ats_type?: string | null;
  url?: string | null;
}): { label: string; kind: SourceKind } {
  const platform = (job.source_platform || "").toLowerCase();
  if (platform === "github") return { label: "GitHub", kind: "github" };
  if (platform === "linkedin") return { label: "LinkedIn", kind: "linkedin" };
  if (platform === "indeed") return { label: "Indeed", kind: "other" };
  if (platform === "ats" || !platform) {
    const ats = (job.ats_type || "").toLowerCase() || atsFromUrl(job.url);
    if (ats === "linkedin") return { label: "LinkedIn", kind: "linkedin" };
    return { label: ATS_LABELS[ats] || "Company site", kind: "other" };
  }
  return { label: platform.charAt(0).toUpperCase() + platform.slice(1), kind: "other" };
}
