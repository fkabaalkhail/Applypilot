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
