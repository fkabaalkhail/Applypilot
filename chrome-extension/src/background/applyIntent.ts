/**
 * Apply-intent store — the dashboard → extension job_id handoff.
 *
 * When the user clicks Apply on a job in the Tailrd web app, the web app messages
 * the extension (externally_connectable → onMessageExternal) with {jobId, url}.
 * We keep the recent intents here; when the user later submits the application on
 * the ATS page, RECORD_APPLICATION matches the page to a recent intent by host
 * and links the recorded application to the real job (backend flips it to
 * Applied). Falls back to plain URL-based tracking when there is no match.
 *
 * Session-scoped (dies with the browser), capped and TTL'd so it never grows.
 */
import type { ApplyIntent } from "../shared/types";

const KEY = "apApplyIntents";
const TTL_MS = 30 * 60 * 1000; // a user applies well within 30 min of clicking Apply
const MAX = 20;

function safeHost(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** All non-expired intents, newest first. */
async function readAll(): Promise<ApplyIntent[]> {
  const got = await chrome.storage.session.get(KEY);
  const list = (got?.[KEY] as ApplyIntent[] | undefined) ?? [];
  const now = Date.now();
  return list.filter((i) => now - i.ts < TTL_MS).sort((a, b) => b.ts - a.ts);
}

/** Remember that the user is applying to `jobId` at `url`. */
export async function recordApplyIntent(intent: Omit<ApplyIntent, "ts">): Promise<void> {
  const list = await readAll();
  const next = [{ ...intent, ts: Date.now() }, ...list].slice(0, MAX);
  await chrome.storage.session.set({ [KEY]: next });
}

/**
 * The jobId of the most-recent unexpired intent whose host matches `pageUrl`.
 * A pathname match breaks ties first, so two open jobs on the same ATS host map
 * correctly; otherwise the most recent same-host intent wins (survives the ATS
 * redirecting the apply URL, since the host is stable). null when nothing fits.
 */
export async function matchApplyIntent(pageUrl: string): Promise<number | null> {
  const host = safeHost(pageUrl);
  if (!host) return null;
  const list = await readAll();
  const sameHost = list.filter((i) => safeHost(i.url) === host);
  if (sameHost.length === 0) return null;
  const path = safePath(pageUrl);
  const byPath = sameHost.filter((i) => safePath(i.url) === path);
  return (byPath.length ? byPath : sameHost)[0]?.jobId ?? null;
}
