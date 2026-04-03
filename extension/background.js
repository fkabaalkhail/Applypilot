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
  } else if (message.action === "executeInMainWorld") {
    // Execute code in the page's MAIN world context (bypasses CSP)
    // This is needed for BambooHR dropdowns that only respond to clicks from the page context
    (async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: _sender.tab.id },
          world: 'MAIN',
          func: (label, answer) => {
            try {
              console.log('[AutoApplyBot-MAIN] Looking for toggle:', label, '→', answer);
              const toggles = document.querySelectorAll('.fab-SelectToggle');
              let targetToggle = null;
              
              for (const t of toggles) {
                const ariaLabel = t.getAttribute('aria-label') || '';
                let wrapperLabel = '';
                const wrapper = t.closest('[data-fabric-component*="SelectField"], [data-fabric-component*="InputWrapper"]');
                if (wrapper) {
                  const labelEl = wrapper.querySelector('label');
                  if (labelEl) wrapperLabel = labelEl.textContent.replace(/\s*\*\s*$/, '').trim();
                }
                if (ariaLabel.includes(label) || wrapperLabel === label) {
                  targetToggle = t;
                  break;
                }
              }
              
              if (!targetToggle) {
                console.log('[AutoApplyBot-MAIN] Toggle not found for:', label);
                return { success: false, error: 'toggle_not_found' };
              }
              
              // ─── Helper: get React fiber from DOM element ───
              function getFiber(el) {
                const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                return key ? el[key] : null;
              }
              
              // ─── Strategy: Walk up the React fiber tree to find the Select component's state ───
              // BambooHR's Fabric Select component has internal state controlling open/closed.
              // The menu element (fab-menu22 etc.) is only rendered when state.isOpen = true.
              // We need to find that state hook and flip it, then trigger a re-render.
              
              const fiber = getFiber(targetToggle);
              if (!fiber) {
                console.log('[AutoApplyBot-MAIN] No React fiber found on toggle');
                return { success: false, error: 'no_fiber' };
              }
              
              // Walk up the fiber tree looking for a component with state that controls the menu
              let current = fiber;
              let selectFiber = null;
              let stateNode = null;
              
              for (let i = 0; i < 30 && current; i++) {
                // Look for class component with setState
                if (current.stateNode && typeof current.stateNode.setState === 'function') {
                  const state = current.stateNode.state;
                  if (state && ('isOpen' in state || 'open' in state || 'menuOpen' in state || 'showMenu' in state)) {
                    console.log('[AutoApplyBot-MAIN] Found class component with open state at level', i, 'state:', JSON.stringify(state).substring(0, 200));
                    selectFiber = current;
                    stateNode = current.stateNode;
                    break;
                  }
                }
                
                // Look for function component with hooks (memoizedState chain)
                if (current.memoizedState && current.tag === 0) { // tag 0 = FunctionComponent
                  let hook = current.memoizedState;
                  let hookIndex = 0;
                  while (hook) {
                    const q = hook.queue;
                    const val = hook.memoizedState;
                    // Look for boolean state that could be isOpen
                    if (typeof val === 'boolean') {
                      console.log('[AutoApplyBot-MAIN] Found boolean hook at level', i, 'index', hookIndex, 'value:', val);
                    }
                    // Look for object state with isOpen/open property
                    if (val && typeof val === 'object' && ('isOpen' in val || 'open' in val)) {
                      console.log('[AutoApplyBot-MAIN] Found object hook with open state at level', i, 'index', hookIndex);
                      selectFiber = current;
                      break;
                    }
                    hook = hook.next;
                    hookIndex++;
                  }
                  if (selectFiber) break;
                }
                
                // Also check memoizedProps for component name hints
                const type = current.type;
                const typeName = type && (type.displayName || type.name || '');
                if (typeName && /select|dropdown|menu|popover/i.test(typeName)) {
                  console.log('[AutoApplyBot-MAIN] Found component:', typeName, 'at level', i);
                  if (current.memoizedState) {
                    selectFiber = current;
                    // Don't break — keep looking for more specific component
                  }
                }
                
                current = current.return;
              }
              
              // ─── Try to open via React state manipulation ───
              if (stateNode) {
                // Class component — use setState
                console.log('[AutoApplyBot-MAIN] Trying setState to open menu');
                const currentState = stateNode.state;
                const openKey = 'isOpen' in currentState ? 'isOpen' : 'open' in currentState ? 'open' : 'menuOpen' in currentState ? 'menuOpen' : 'showMenu';
                stateNode.setState({ [openKey]: true });
              } else if (selectFiber && selectFiber.memoizedState) {
                // Function component — try to find and call the setState dispatch
                console.log('[AutoApplyBot-MAIN] Trying hook state dispatch to open menu');
                let hook = selectFiber.memoizedState;
                let hookIndex = 0;
                while (hook) {
                  if (typeof hook.memoizedState === 'boolean' && hook.queue && hook.queue.dispatch) {
                    console.log('[AutoApplyBot-MAIN] Dispatching true to boolean hook at index', hookIndex, '(was:', hook.memoizedState, ')');
                    hook.queue.dispatch(true);
                    break;
                  }
                  if (hook.memoizedState && typeof hook.memoizedState === 'object' && hook.queue && hook.queue.dispatch) {
                    if ('isOpen' in hook.memoizedState || 'open' in hook.memoizedState) {
                      const newState = { ...hook.memoizedState };
                      if ('isOpen' in newState) newState.isOpen = true;
                      if ('open' in newState) newState.open = true;
                      console.log('[AutoApplyBot-MAIN] Dispatching open state:', JSON.stringify(newState).substring(0, 100));
                      hook.queue.dispatch(newState);
                      break;
                    }
                  }
                  hook = hook.next;
                  hookIndex++;
                }
              }
              
              // ─── Also try native click (sometimes works after state prep) ───
              targetToggle.focus();
              targetToggle.click();
              
              // ─── Poll for menu to appear ───
              const dataMenuId = targetToggle.getAttribute('data-menu-id');
              
              return new Promise((resolve) => {
                let attempts = 0;
                const poll = setInterval(() => {
                  attempts++;
                  
                  // Check if menu element now exists in DOM
                  let menu = null;
                  if (dataMenuId) {
                    menu = document.getElementById(dataMenuId);
                  }
                  if (!menu) {
                    // Scan for any visible fab menu
                    const allMenus = document.querySelectorAll('[id^="fab-menu"]');
                    for (const m of allMenus) {
                      if (m.querySelectorAll('.fab-MenuOption, [role="menuitem"]').length > 0) {
                        const style = getComputedStyle(m);
                        if (style.display !== 'none' && style.visibility !== 'hidden') {
                          menu = m;
                          break;
                        }
                      }
                    }
                  }
                  
                  if (menu) {
                    const items = menu.querySelectorAll('.fab-MenuOption, [role="menuitem"], [role="option"]');
                    if (items.length > 0) {
                      clearInterval(poll);
                      const target = answer.toLowerCase().trim();
                      const optionTexts = Array.from(items).map(i => i.textContent.trim());
                      console.log('[AutoApplyBot-MAIN] Menu appeared! Options:', optionTexts.slice(0, 10));
                      
                      // Exact match
                      for (const item of items) {
                        if (item.textContent.trim().toLowerCase() === target) {
                          item.click();
                          console.log('[AutoApplyBot-MAIN] Selected (exact):', item.textContent.trim());
                          resolve({ success: true, selected: item.textContent.trim() });
                          return;
                        }
                      }
                      // Partial match
                      for (const item of items) {
                        const text = item.textContent.trim().toLowerCase();
                        if (text.includes(target) || target.includes(text)) {
                          item.click();
                          console.log('[AutoApplyBot-MAIN] Selected (partial):', item.textContent.trim());
                          resolve({ success: true, selected: item.textContent.trim() });
                          return;
                        }
                      }
                      
                      // No match — close and return options
                      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                      resolve({ success: false, error: 'no_match', options: optionTexts });
                      return;
                    }
                  }
                  
                  // On attempt 5, try clicking again
                  if (attempts === 5) {
                    console.log('[AutoApplyBot-MAIN] Retrying click at attempt 5');
                    targetToggle.click();
                  }
                  
                  // On attempt 10, try dispatching full event sequence
                  if (attempts === 10) {
                    console.log('[AutoApplyBot-MAIN] Trying full event sequence at attempt 10');
                    const rect = targetToggle.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: cx, clientY: cy };
                    targetToggle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', pointerId: 1 }));
                    targetToggle.dispatchEvent(new MouseEvent('mousedown', opts));
                    targetToggle.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', pointerId: 1 }));
                    targetToggle.dispatchEvent(new MouseEvent('mouseup', opts));
                    targetToggle.dispatchEvent(new MouseEvent('click', opts));
                  }
                  
                  if (attempts >= 20) {
                    clearInterval(poll);
                    
                    // Log fiber tree for debugging
                    let debugFiber = getFiber(targetToggle);
                    const fiberInfo = [];
                    for (let i = 0; i < 20 && debugFiber; i++) {
                      const typeName = debugFiber.type && (debugFiber.type.displayName || debugFiber.type.name || '');
                      const hasState = !!debugFiber.memoizedState;
                      const tag = debugFiber.tag;
                      if (typeName || hasState) {
                        fiberInfo.push(`L${i}:${typeName||'anon'}(tag=${tag},state=${hasState})`);
                      }
                      debugFiber = debugFiber.return;
                    }
                    console.log('[AutoApplyBot-MAIN] Fiber tree:', fiberInfo.join(' → '));
                    console.log('[AutoApplyBot-MAIN] Menu never appeared for:', label);
                    
                    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    resolve({ success: false, error: 'menu_not_opened' });
                  }
                }, 200);
              });
            } catch(e) { 
              console.error('[AutoApplyBot-MAIN] Error:', e);
              return { success: false, error: e.message };
            }
          },
          args: [message.label, message.answer]
        });
        
        const result = results?.[0]?.result;
        console.log('[AutoApplyBot BG] MAIN world result:', result);
        sendResponse({ success: result?.success || false, result });
      } catch (e) {
        console.error('executeInMainWorld error:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
});
