import "@testing-library/jest-dom";

// jsdom does not implement scrollIntoView; the onboarding overlay calls it
// when scrolling a step's target element into view.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}
