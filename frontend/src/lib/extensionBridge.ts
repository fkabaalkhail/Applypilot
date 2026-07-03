/**
 * Bridge to the Tailrd browser extension.
 *
 * When the user applies to a job from the dashboard, we tell the extension which
 * job it is ({jobId, url}) so that when they submit the application on the ATS
 * page, the extension records it against this job (flipping it to Applied on the
 * Applications page). Purely additive and best-effort: the apply link still opens
 * normally, and if the extension isn't installed the extension simply falls back
 * to URL-based tracking. Nothing here can break the apply flow.
 */

// Stable extension id (pinned via the extension manifest "key"). Overridable for
// local/unpacked builds with a different id via VITE_EXTENSION_ID.
const EXTENSION_ID =
  (import.meta.env.VITE_EXTENSION_ID as string | undefined) ||
  "apgogjfdpleeajnngkfkfekbddcpodkl";

interface ChromeRuntimeLike {
  sendMessage?: (
    extensionId: string,
    message: unknown,
    callback?: (response: unknown) => void
  ) => void;
  lastError?: { message?: string };
}

function runtime(): ChromeRuntimeLike | null {
  const c = (window as unknown as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome;
  return c?.runtime ?? null;
}

export interface ApplyIntentJob {
  id: number;
  url?: string | null;
  title?: string | null;
  company?: string | null;
}

/**
 * Fire-and-forget: tell the extension which job this apply is for. Safe to call
 * unconditionally — no-ops when the extension isn't installed. `url` overrides
 * `job.url` when the resolved apply URL differs (e.g. after fetch-details).
 */
export function notifyApplyIntent(job: ApplyIntentJob, url?: string): void {
  const rt = runtime();
  const applyUrl = url ?? job.url ?? "";
  if (!rt?.sendMessage || !applyUrl || !job.id) return;
  try {
    rt.sendMessage(
      EXTENSION_ID,
      {
        type: "TAILRD_APPLY_INTENT",
        jobId: job.id,
        url: applyUrl,
        title: job.title ?? "",
        company: job.company ?? "",
      },
      () => {
        // Reading lastError suppresses the "Unchecked runtime.lastError" console
        // warning that Chrome logs when no extension answered.
        void rt.lastError;
      }
    );
  } catch {
    // chrome.runtime present but messaging blocked — ignore.
  }
}
