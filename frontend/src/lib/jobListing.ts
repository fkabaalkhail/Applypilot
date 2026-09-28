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
// Answers that have arrived, so an Apply click can tell a settled check from a
// pending one without waiting on it.
const settledChecks = new Map<number, LiveCheckResult | null>();
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
 * callers must not block the Apply button on it (an Apply click waits at most
 * APPLY_CHECK_WAIT_MS, see openApplyAfterLiveCheck).
 */
export function checkListingLive(jobId: number): Promise<LiveCheckResult | null> {
  let pending = liveChecks.get(jobId);
  if (!pending) {
    if (liveCheckUnavailable) return Promise.resolve(null);
    const request = requestLiveCheck(jobId);
    pending = request;
    liveChecks.set(jobId, request);
    request.then((result) => {
      // A reset while the request was out drops its answer too.
      if (liveChecks.get(jobId) === request) settledChecks.set(jobId, result);
    });
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
  settledChecks.clear();
  liveCheckUnavailable = false;
}

/**
 * How long an Apply click waits for the live check before opening the link
 * anyway. Most checks answer from the database or the session cache well
 * inside this; a slow source must not hold the user back for long.
 */
export const APPLY_CHECK_WAIT_MS = 1500;

/**
 * Links the live check can never verify. The backend answers Indeed rows with
 * an immediate "unknown" (indeed_unprobeable), so Apply never waits on them.
 */
export function isUnprobeableApplyUrl(url?: string | null): boolean {
  let host = "";
  try {
    host = new URL(url || "").hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "indeed.com" || host.endsWith(".indeed.com");
}

export type ApplyOutcome =
  /** The new tab was sent to the job's link. */
  | { kind: "opened" }
  /** The listing is closed: the tab was closed and the link never opened. */
  | { kind: "closed"; listingStatus: string }
  /** The user closed the new tab before the check answered. */
  | { kind: "cancelled" };

/**
 * Open a job's apply link in a new tab, after a short live check.
 *
 * Call it synchronously from the Apply click handler. It opens an about:blank
 * tab right away, inside the user gesture, so popup blockers allow it. Then it
 * waits for the live check, but no longer than APPLY_CHECK_WAIT_MS. A "dead"
 * verdict closes the tab, and the stored link is never opened. Any other
 * outcome (alive, unknown, an error, the timeout) sends the tab to `url`.
 *
 * Returns null when the click should just follow the link as usual: nothing
 * to wait for (an unprobeable link, or a check that already answered with
 * anything but dead) or the browser refused the new tab. Otherwise the caller
 * must preventDefault() the click and act on the resolved outcome.
 */
export function openApplyAfterLiveCheck(jobId: number, url: string): Promise<ApplyOutcome> | null {
  if (isUnprobeableApplyUrl(url) || liveCheckUnavailable) return null;
  if (settledChecks.has(jobId)) {
    const known = settledChecks.get(jobId);
    if (known?.verdict !== "dead") return null;
    return Promise.resolve({ kind: "closed", listingStatus: listingStatusFromLiveCheck(known) });
  }

  let tab: Window | null = null;
  try {
    tab = window.open("about:blank", "_blank");
  } catch {
    tab = null;
  }
  if (!tab) return null;
  const opened = tab;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), APPLY_CHECK_WAIT_MS);
  });
  return Promise.race([checkListingLive(jobId), timeout]).then((result): ApplyOutcome => {
    clearTimeout(timer);
    if (result?.verdict === "dead") {
      try {
        opened.close();
      } catch {
        // Already gone.
      }
      return { kind: "closed", listingStatus: listingStatusFromLiveCheck(result) };
    }
    if (opened.closed) return { kind: "cancelled" };
    // What rel="noopener" gave the plain link: the job's page must not be able
    // to script this one through window.opener.
    try {
      opened.opener = null;
    } catch {
      // Nothing more to detach.
    }
    opened.location.href = url;
    return { kind: "opened" };
  });
}

/** The parts of a click event (React or DOM) that an Apply click handler reads. */
interface ApplyClickEvent {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * onClick for an Apply link (an `<a href target="_blank">`): opens it through
 * openApplyAfterLiveCheck. `onOpened` runs once the job's page is opening,
 * which is where the apply gets registered; `onClosed` runs instead, with the
 * closed listing_status, when the check found the listing dead. A "dead" that
 * arrives after the wait gave up still calls `onClosed` (the tab is open by
 * then), so the listing shows closed. A modified click (new window,
 * background tab) keeps the browser's own handling.
 */
export function handleApplyLinkClick(
  event: ApplyClickEvent,
  jobId: number,
  url: string,
  handlers: { onOpened: () => void; onClosed: (listingStatus: string) => void },
): void {
  const plainClick =
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const pending = plainClick && !event.defaultPrevented ? openApplyAfterLiveCheck(jobId, url) : null;
  if (!pending) {
    handlers.onOpened();
    return;
  }
  event.preventDefault();
  void pending.then((outcome) => {
    if (outcome.kind === "closed") {
      handlers.onClosed(outcome.listingStatus);
      return;
    }
    if (outcome.kind === "opened") handlers.onOpened();
    // Same cached request, so no second call to the server.
    void checkListingLive(jobId).then((result) => {
      if (result?.verdict === "dead") handlers.onClosed(listingStatusFromLiveCheck(result));
    });
  });
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// A calendar date with no time of day. Date-only sources are stored at
// midnight and serialized without an offset ("2026-08-04T00:00:00").
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}(?:[T ]00:00(?::00(?:\.0+)?)?)?$/;

function shortDate(date: Date, dateOnly: boolean): string {
  // A date-only value parses as UTC midnight, which is the previous evening
  // west of UTC: read its calendar day in UTC. A real timestamp shows the
  // viewer's own day.
  const year = dateOnly ? date.getUTCFullYear() : date.getFullYear();
  const sameYear = year === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : {}),
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
  const dateOnly = DATE_ONLY.test((value || "").trim());
  const diff = Date.now() - date.getTime();
  if (diff < 0) return -diff < DAY_MS ? "Today" : shortDate(date, dateOnly);
  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return shortDate(date, dateOnly);
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
