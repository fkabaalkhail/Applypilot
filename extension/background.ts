export {}

import { registerMessageHandlers } from "./lib/messaging"

// Background service worker — handles API calls to backend and message routing
registerMessageHandlers()

console.log("[ApplyPilot] Background service worker initialized")
