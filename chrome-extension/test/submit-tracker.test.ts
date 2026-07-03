import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindSubmitTracking } from "../src/content/submitTracker";

/**
 * Submit tracking fires exactly once, only when the user's real submit click
 * appears to have gone through (no blocking validation), and never after
 * dispose. This is what keeps the Applications page free of phantom entries.
 */
describe("bindSubmitTracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mountButton(disabled = false): HTMLButtonElement {
    const form = document.createElement("form");
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.textContent = "Submit application";
    btn.disabled = disabled;
    form.appendChild(btn);
    document.body.appendChild(form);
    return btn;
  }

  it("records once, after the delay, when the click goes through", () => {
    const btn = mountButton();
    const onSubmitted = vi.fn();
    bindSubmitTracking(btn, onSubmitted, { delayMs: 1000 });

    btn.click();
    expect(onSubmitted).not.toHaveBeenCalled(); // deferred
    vi.advanceTimersByTime(1000);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("does NOT record when blocking validation is showing", () => {
    const btn = mountButton();
    const onSubmitted = vi.fn();
    bindSubmitTracking(btn, onSubmitted, {
      delayMs: 1000,
      hasBlockingValidation: () => true,
    });

    btn.click();
    vi.advanceTimersByTime(2000);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("records at most once across repeated clicks", () => {
    const btn = mountButton();
    const onSubmitted = vi.fn();
    bindSubmitTracking(btn, onSubmitted, { delayMs: 500 });

    btn.click();
    btn.click();
    vi.advanceTimersByTime(500);
    btn.click();
    vi.advanceTimersByTime(500);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("does not record after dispose()", () => {
    const btn = mountButton();
    const onSubmitted = vi.fn();
    const handle = bindSubmitTracking(btn, onSubmitted, { delayMs: 500 });

    btn.click();
    handle.dispose();
    vi.advanceTimersByTime(500);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("ignores clicks on a disabled submit button", () => {
    const btn = mountButton(true);
    const onSubmitted = vi.fn();
    bindSubmitTracking(btn, onSubmitted, { delayMs: 500 });

    btn.click();
    vi.advanceTimersByTime(500);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("records via a form submit event too", () => {
    const btn = mountButton();
    const onSubmitted = vi.fn();
    bindSubmitTracking(btn, onSubmitted, { delayMs: 300 });

    btn.form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });
});
