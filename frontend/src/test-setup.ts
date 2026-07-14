import "@testing-library/jest-dom";

// jsdom does not implement scrollIntoView; the onboarding overlay calls it
// when scrolling a step's target element into view.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom does not implement ResizeObserver; FittedResume (the live résumé
// preview) observes its container to scale the page to fit.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom's window.crypto shadows Node's webcrypto and omits randomUUID, which
// SettingsModal uses to key toasts.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
  });
}
