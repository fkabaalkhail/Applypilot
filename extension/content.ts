import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://www.linkedin.com/*", "https://jobs.lever.co/*", "https://boards.greenhouse.io/*"]
}

// Content script — Wassim will implement form detection + fill logic here
console.log("[ApplyPilot] Content script loaded")
