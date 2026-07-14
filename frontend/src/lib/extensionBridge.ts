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

// Every known extension id: the dev/unpacked id (pinned via the manifest "key",
// which the Web Store strips) and the store-assigned id (live since 2026-07-14).
// They are DIFFERENT — the Store does not honour the manifest key — so both must
// be here or store users are invisible to us: pingExtension() would never hear
// back from a store install, and the banner would tell someone who already has
// the extension to go install it.
//
// Sends are fire-and-forget no-ops for ids that aren't installed, so notifying
// every known id is safe. VITE_EXTENSION_IDS (comma-separated) still overrides,
// but the defaults below mean a forgotten env var cannot break this.
const EXTENSION_IDS = (
  (import.meta.env.VITE_EXTENSION_IDS as string | undefined) ??
  (import.meta.env.VITE_EXTENSION_ID as string | undefined) ??
  "apgogjfdpleeajnngkfkfekbddcpodkl,dadbhjlflnljgailcpgehdainjdmjeej"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
  for (const extensionId of EXTENSION_IDS) {
    try {
      rt.sendMessage(
        extensionId,
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
}

/** Installed-and-signed-in state of the extension, as reported by TAILRD_PING. */
export type ExtensionState = "unknown" | "not-installed" | "installed" | "connected";

interface PingResponse {
  ok?: boolean;
  connected?: boolean;
}

/**
 * Ask the extension whether it is installed and signed in.
 *
 * The service worker's onMessageExternal handler answers TAILRD_PING with
 * {ok, connected}. We ask every known id and take the first real answer.
 * Resolves "not-installed" when chrome.runtime is absent (non-Chromium), every
 * send errors, or nothing answers within `timeoutMs`.
 *
 * Never rejects: the only caller is UI, and a messaging failure must not break a
 * page render.
 *
 * The extension's externally_connectable.matches covers only
 * https://(www.)tailrd.ca, so on localhost this always resolves "not-installed".
 * ExtensionBanner has a dev-only ?extState= override for that reason.
 *
 * The 1500ms default is load-bearing, and every caller needs it — so it lives
 * here rather than being passed in, where two call sites drifted apart once
 * already. An MV3 service worker that has gone idle must be woken to answer, and
 * a cold start can outrun a short timeout. Answering late is free: callers render
 * nothing until the ping resolves, so a longer timeout only delays the answer and
 * can never flash the wrong one. Answering *wrong* is not free — callers ping once
 * and never retry, so one slow wake pins "Add to Chrome" on a user who already has
 * the extension for their whole session.
 */
export function pingExtension(timeoutMs = 1500): Promise<ExtensionState> {
  const rt = runtime();
  // Type check, not truthiness: a truthy non-function `sendMessage` would survive a
  // truthiness guard and then throw out of `.bind()` below — synchronously, outside
  // the promise and every try — breaking the never-rejects contract.
  if (typeof rt?.sendMessage !== "function" || EXTENSION_IDS.length === 0) {
    return Promise.resolve("not-installed");
  }
  // Hoist the narrowed method: TS drops the `rt.sendMessage` narrowing inside the
  // executor closure below, and binding keeps `this` on chrome.runtime.
  const send = rt.sendMessage.bind(rt);

  return new Promise<ExtensionState>((resolve) => {
    let settled = false;
    let outstanding = EXTENSION_IDS.length;

    const finish = (state: ExtensionState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };

    const timer = setTimeout(() => finish("not-installed"), timeoutMs);

    const miss = () => {
      outstanding -= 1;
      if (outstanding <= 0) finish("not-installed");
    };

    for (const extensionId of EXTENSION_IDS) {
      try {
        send(extensionId, { type: "TAILRD_PING" }, (response: unknown) => {
          // Reading lastError suppresses Chrome's "Unchecked runtime.lastError"
          // console warning when no extension answered.
          const errored = Boolean(rt.lastError);
          const res = response as PingResponse | undefined;
          if (!errored && res?.ok) {
            finish(res.connected ? "connected" : "installed");
            return;
          }
          miss();
        });
      } catch {
        // chrome.runtime present but messaging blocked.
        miss();
      }
    }
  });
}
