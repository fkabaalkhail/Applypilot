export {}

import { registerMessageHandlers } from "./lib/messaging"
import { registerOnboardingListener } from "./onboarding"

// Background service worker — handles API calls to backend and message routing
registerMessageHandlers()
registerOnboardingListener()

console.log("[Tailrd] Background service worker initialized")
