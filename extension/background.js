// Auto Apply Bot — Background Service Worker

// Initialize default state on install/update
chrome.runtime.onInstalled.addListener(() => {
  console.log("Auto Apply Bot — Extension installed");

  chrome.storage.local.set({
    isRunning: false,
    appliedCount: 0,
    skippedCount: 0,
    appliedJobs: [],
    mode: "autofill"
  });
});

// Listen for tab updates to trigger queue processing on LinkedIn job pages
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only act when page is fully loaded
  if (changeInfo.status !== 'complete') return;
  
  // Only act on LinkedIn job pages
  if (!tab.url || !tab.url.includes('linkedin.com/jobs/')) return;
  
  console.log('[AutoApplyBot BG] Tab updated:', tab.url);
  
  // Check if we have a pending queue
  const stored = await chrome.storage.local.get(['pendingJobs', 'currentJobIndex', 'isRunning']);
  
  if (!stored.pendingJobs || stored.pendingJobs.length === 0 || !stored.isRunning) {
    console.log('[AutoApplyBot BG] No active queue');
    return;
  }
  
  const currentIndex = stored.currentJobIndex || 0;
  const currentJob = stored.pendingJobs[currentIndex];
  
  if (!currentJob) {
    console.log('[AutoApplyBot BG] No current job at index', currentIndex);
    return;
  }
  
  // Extract job IDs to verify we're on the right page
  const extractJobId = (url) => {
    if (!url) return null;
    const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    const paramMatch = url.match(/currentJobId=(\d+)/);
    if (paramMatch) return paramMatch[1];
    const pathMatch = url.match(/\/(\d{8,})(?:[/?]|$)/);
    if (pathMatch) return pathMatch[1];
    return null;
  };
  
  const currentUrlJobId = extractJobId(tab.url);
  const expectedJobId = extractJobId(currentJob.url);
  
  console.log('[AutoApplyBot BG] Job ID check - current:', currentUrlJobId, 'expected:', expectedJobId);
  
  if (currentUrlJobId !== expectedJobId) {
    console.log('[AutoApplyBot BG] Job ID mismatch, not triggering');
    return;
  }
  
  console.log('[AutoApplyBot BG] Active queue detected, sending processQueue message...');
  
  // Wait a bit for the page to stabilize
  setTimeout(async () => {
    try {
      // First ensure content script is injected
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      console.log('[AutoApplyBot BG] Content script injected');
    } catch (e) {
      console.log('[AutoApplyBot BG] Content script may already be loaded:', e.message);
    }
    
    // Wait a bit more then send processQueue message
    setTimeout(async () => {
      try {
        const data = await chrome.storage.local.get(['profile', 'settings']);
        const profile = data.profile || {};
        const settings = data.settings || {};
        const prefilledAnswers = settings.prefilledAnswers || {};
        
        console.log('[AutoApplyBot BG] Sending processQueue message to tab', tabId);
        await chrome.tabs.sendMessage(tabId, {
          action: 'processQueue',
          profile,
          settings,
          prefilledAnswers
        });
      } catch (e) {
        console.log('[AutoApplyBot BG] Failed to send processQueue:', e.message);
      }
    }, 2000);
  }, 1500);
});

// Message listener — relay messages from content script and popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "incrementCount") {
    chrome.storage.local.get(["appliedCount"], (result) => {
      const newCount = (result.appliedCount || 0) + 1;
      chrome.storage.local.set({ appliedCount: newCount });
    });
  } else if (message.type === "incrementSkippedCount") {
    chrome.storage.local.get(["skippedCount"], (result) => {
      const newCount = (result.skippedCount || 0) + 1;
      chrome.storage.local.set({ skippedCount: newCount });
    });
  } else if (message.type === "setRunning") {
    chrome.storage.local.set({ isRunning: message.value });
  } else if (message.action === "askAI") {
    // AI relay to backend API — fetch answer from backend
    (async () => {
      try {
        // Read backendUrl from settings in chrome.storage.local
        const storage = await chrome.storage.local.get(["settings"]);
        const backendUrl = (storage.settings && storage.settings.backendUrl) || "http://localhost:8000";

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const resp = await fetch(`${backendUrl}/api/extension/ai/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: message.question || "",
            options: message.options || [],
            resumeText: message.resumeText || "",
            jobDescription: message.jobDescription || "",
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          sendResponse({ answer: null, error: `Backend error: ${resp.status}` });
          return;
        }

        const data = await resp.json();
        sendResponse({ answer: data.answer || null, error: data.error || null });
      } catch (e) {
        if (e.name === "AbortError") {
          sendResponse({ answer: null, error: "Request timed out (10s)" });
        } else {
          sendResponse({ answer: null, error: `AI unavailable: ${e.message}` });
        }
      }
    })();
    return true; // keep message channel open for async response
  }
});
