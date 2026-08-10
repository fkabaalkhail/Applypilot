/**
 * Safe chrome.runtime messaging for the content script.
 *
 * Once the extension is reloaded / updated / disabled, content scripts already
 * injected into open tabs are ORPHANED: `chrome.runtime.id` becomes undefined
 * and every messaging call throws "Extension context invalidated", and it
 * throws SYNCHRONOUSLY, so a trailing `.catch()` never sees it. That is the
 * error the page's MutationObserver was spamming on every re-render after a
 * reload (its FIELDS_UPDATED send).
 *
 * These helpers check the context first, swallow the synchronous throw, and run
 * a registered teardown handler exactly once so the orphaned script can
 * disconnect its observers and go quiet. A normal "no receiver" rejection (the
 * toolbar popup is simply closed) is NOT an invalidation. It is expected and
 * ignored.
 */

/** The slice of chrome.runtime we touch, kept minimal so tests can stub it and
 *  so we don't depend on @types/chrome's non-nullable ambient `chrome`. */
interface MinimalRuntime {
  id?: string;
  sendMessage: (message: unknown) => Promise<unknown> | undefined;
}

function getRuntime(): MinimalRuntime | undefined {
  try {
    return (globalThis as unknown as { chrome?: { runtime?: MinimalRuntime } }).chrome?.runtime;
  } catch {
    return undefined;
  }
}

let onInvalidatedHandler: (() => void) | null = null;

/** Register the teardown to run when the extension context dies (this content
 *  script orphaned). Fired at most once, then cleared. */
export function onExtensionContextInvalidated(handler: () => void): void {
  onInvalidatedHandler = handler;
}

function fireInvalidated(): void {
  const handler = onInvalidatedHandler;
  onInvalidatedHandler = null;
  if (handler) {
    try {
      handler();
    } catch {
      // teardown must never throw
    }
  }
}

/** True only while this content script still has a live bridge to the extension. */
export function isExtensionContextValid(): boolean {
  return Boolean(getRuntime()?.id);
}

/**
 * Fire-and-forget a runtime message. Never throws. When the context is (or has
 * just become) invalid, runs the registered teardown; a normal no-receiver
 * rejection (closed popup) is ignored.
 */
export function postToRuntime(message: unknown): void {
  const rt = getRuntime();
  if (!rt?.id) {
    fireInvalidated();
    return;
  }
  try {
    const pending = rt.sendMessage(message);
    void (pending as Promise<unknown> | undefined)?.catch(() => {
      // Async rejection: a closed popup (no receiver) is normal and ignored;
      // only a now-dead context counts as an invalidation.
      if (!isExtensionContextValid()) fireInvalidated();
    });
  } catch {
    // A synchronous throw right after a valid id check means the context was
    // invalidated between the check and the send, treat it as such.
    fireInvalidated();
  }
}

/**
 * Request/response send. Resolves `undefined` (never throws or rejects for an
 * invalid context) so awaited callers observe a missing response instead of an
 * uncaught "Extension context invalidated". A live-context rejection (e.g. no
 * receiver) propagates unchanged, preserving existing caller behavior.
 */
export function sendToRuntime<T>(message: unknown): Promise<T | undefined> {
  const rt = getRuntime();
  if (!rt?.id) {
    fireInvalidated();
    return Promise.resolve(undefined);
  }
  try {
    return rt.sendMessage(message) as Promise<T>;
  } catch {
    fireInvalidated();
    return Promise.resolve(undefined);
  }
}

/** Test-only: clear the registered handler between cases. */
export function __resetInvalidationHandlerForTests(): void {
  onInvalidatedHandler = null;
}
