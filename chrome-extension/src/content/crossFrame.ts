/**
 * Pure cross-frame helpers — no chrome.* and no DOM, so they unit-test cleanly.
 * The chrome-messaging plumbing that uses these lives in contentScript.ts.
 *
 * When a job-application form lives in a cross-origin iframe (e.g. Databricks'
 * embedded Greenhouse form), the panel stays in the top frame and every overlay
 * operation is marshaled to the owning frame as a generic {op, args} message.
 */
import type { FormOpName, FormOpResult } from "../shared/types";
import type { OverlayCallbacks } from "./overlay";

/** Void callbacks: the proxy fires them and does not wait for a value. */
const VOID_OPS: ReadonlySet<FormOpName> = new Set<FormOpName>(["onRescan", "onProfileResolved"]);

/** All OverlayCallbacks method names, in one place for the proxy factory. */
const ALL_OPS: FormOpName[] = [
  "onAutofill",
  "onInsertAnswer",
  "onSaveAnswer",
  "onRescan",
  "onListResumes",
  "onUploadResume",
  "onTailorResume",
  "onAttachTailored",
  "onDownloadTailored",
  "onGenerateCoverLetter",
  "onInsertCoverLetter",
  "onDownloadCoverLetter",
  "onCopyCoverLetter",
  "onProfileResolved",
];

/** The top frame defers to a child host only when it has no form of its own. */
export function shouldAdoptRemoteHost(localRecognized: number, remoteRecognized: number): boolean {
  return localRecognized === 0 && remoteRecognized > 0;
}

/**
 * An OverlayCallbacks whose every method marshals to `send(op, args)` and
 * returns the unwrapped value. Void methods (rescan / profile-resolved) fire
 * and forget — the host pushes fields back over the update channel.
 */
export function makeProxyCallbacks(
  send: (op: FormOpName, args: unknown[]) => Promise<FormOpResult>
): OverlayCallbacks {
  const call = (op: FormOpName, args: unknown[]): Promise<unknown> =>
    send(op, args).then((r) => {
      if (!r.ok) throw new Error(r.error ?? `Form op ${op} failed`);
      return r.value;
    });

  const proxy = {} as Record<FormOpName, (...args: unknown[]) => unknown>;
  for (const op of ALL_OPS) {
    proxy[op] = VOID_OPS.has(op)
      ? (...args: unknown[]): void => {
          void call(op, args).catch(() => {});
        }
      : (...args: unknown[]): Promise<unknown> => call(op, args);
  }
  return proxy as unknown as OverlayCallbacks;
}

/** Run one overlay op against the local callbacks, wrapping the outcome. */
export async function dispatchFormOp(
  ops: OverlayCallbacks,
  op: FormOpName,
  args: unknown[]
): Promise<FormOpResult> {
  try {
    const fn = ops[op] as (...a: unknown[]) => unknown;
    const value = await fn(...args);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
