/**
 * Application tracking — records a job application the user submitted on an ATS
 * page to their Tailrd account (the web app's Applications page), matching
 * Jobright's submit tracking. The extension never submits a form; it observes
 * the user's real submit click (see content/submitTracker.ts) and calls this.
 *
 * Runs in the background service worker (host-permission contexts bypass CORS).
 */
import { authedRequest } from "./client";
import type { ApplicationLog } from "../shared/types";

interface LoggedApplication {
  id: number;
  company: string;
  role: string;
  url: string | null;
  status: string;
  created: boolean;
}

/** POST /apply/log — deduped by (user, url) on the backend. */
export async function recordApplication(app: ApplicationLog): Promise<{ created: boolean }> {
  const res = await authedRequest<LoggedApplication>("/apply/log", {
    method: "POST",
    body: JSON.stringify({
      company: app.company,
      role: app.role,
      url: app.url,
      ats_type: app.atsType ?? "",
      resume_version: app.resumeVersion ?? "original",
      job_id: app.jobId ?? null,
      platform: "extension",
    }),
  });
  return { created: Boolean(res.created) };
}
