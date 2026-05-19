/**
 * Onboarding — handles first-install detection and opens the demo page.
 * Imported and called from background.ts.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const ONBOARDING_URL = "https://www.tailrd.ca/demo-apply"
const COMPLETION_FLAG = "onboarding_complete"

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register the onInstalled listener to detect first-time extension installs.
 * If this is a fresh install and the user hasn't completed onboarding,
 * opens the demo application page in a new tab.
 */
export function registerOnboardingListener(): void {
  chrome.runtime.onInstalled.addListener(
    (details: chrome.runtime.InstalledDetails) => {
      if (details.reason !== "install") {
        return
      }

      chrome.storage.local.get(COMPLETION_FLAG, (result) => {
        if (result[COMPLETION_FLAG]) {
          return
        }

        chrome.tabs.create({ url: ONBOARDING_URL })
      })
    }
  )
}
