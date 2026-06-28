import { describe, it, expect, beforeEach } from "vitest";
import { detectCaptcha } from "../src/content/captcha";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("detectCaptcha", () => {
  it("returns false for an ordinary form with no verification widget", () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="first" />
        <button type="submit">Apply</button>
      </form>`;
    expect(detectCaptcha(document)).toBe(false);
  });

  it("detects a reCAPTCHA iframe", () => {
    document.body.innerHTML = `
      <iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe>`;
    expect(detectCaptcha(document)).toBe(true);
  });

  it("detects an hCaptcha iframe", () => {
    document.body.innerHTML = `
      <iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"></iframe>`;
    expect(detectCaptcha(document)).toBe(true);
  });

  it("detects a Cloudflare Turnstile iframe", () => {
    document.body.innerHTML = `
      <iframe src="https://challenges.cloudflare.com/turnstile/v0/abc"></iframe>`;
    expect(detectCaptcha(document)).toBe(true);
  });

  it("detects a reCAPTCHA container even before the iframe mounts", () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="xyz"></div>`;
    expect(detectCaptcha(document)).toBe(true);
  });

  it("detects an hCaptcha container by class", () => {
    document.body.innerHTML = `<div class="h-captcha" data-sitekey="xyz"></div>`;
    expect(detectCaptcha(document)).toBe(true);
  });

  it("detects a verification widget by iframe title", () => {
    document.body.innerHTML = `<iframe title="reCAPTCHA challenge expires in two minutes"></iframe>`;
    expect(detectCaptcha(document)).toBe(true);
  });
});
