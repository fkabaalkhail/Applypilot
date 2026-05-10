export {}

// Background service worker — handles API calls to backend
const API_BASE = "http://localhost:8000"

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "FILL_FORM") {
    fetch(`${API_BASE}/api/fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload)
    })
      .then((r) => r.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }))
    return true // keep channel open for async response
  }
})
