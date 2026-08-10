/**
 * One-time migration: erase what the removed "Remembered Answers" feature left
 * on disk.
 *
 * Question Memory used to keep a device-local store of sensitive answers under
 * `ap_local_answers` in chrome.storage.local, keyed by normalized question text.
 * The feature is gone, so nothing reads that key any more — but an existing
 * install still HOLDS it, and it holds exactly the answers we promised would
 * never leave the machine (gender identity, orientation, pronouns). Removing the
 * code without removing the data would leave that sitting there forever.
 *
 * Idempotent by construction: a marker key records that the pass ran, so the
 * second call and every call after it does nothing. That matters because this
 * runs on BOTH onInstalled and onStartup — an existing user who never reinstalls
 * only ever reaches the startup path, and a user who does reinstall must not get
 * the pass twice.
 *
 * Never throws: the service-worker top level cannot absorb a rejection, and a
 * storage hiccup here must not take the worker's other startup work with it. A
 * failed pass simply leaves the marker unset, so the next startup retries.
 */

/** Storage keys written by the removed Remembered Answers feature. */
export const LEGACY_ANSWER_KEYS = ["ap_local_answers"] as const;

/** Set once the removal pass has run. Versioned so a future migration can add
 *  its own marker without colliding with this one. */
export const CLEANUP_MARKER_KEY = "ap_cleanup_v1";

/**
 * Remove the legacy remembered-answer keys, exactly once per install.
 *
 * Resolves either way — callers are `void`-ing this from event listeners.
 */
export async function cleanupLegacyStorage(): Promise<void> {
  try {
    const marked = await chrome.storage.local.get(CLEANUP_MARKER_KEY);
    if (marked[CLEANUP_MARKER_KEY]) return; // already done
    await chrome.storage.local.remove([...LEGACY_ANSWER_KEYS]);
    // Marker last: if the remove throws, the next startup tries again rather
    // than recording a pass that never happened.
    await chrome.storage.local.set({ [CLEANUP_MARKER_KEY]: true });
  } catch {
    // Storage unavailable — retry on the next startup.
  }
}
