import { describe, it, expect, beforeEach } from "vitest";
import { detectCaptcha, isCaptchaField } from "../src/content/captcha";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isCaptchaField", () => {
  it("flags the reCAPTCHA response textarea", () => {
    document.body.innerHTML = `<textarea name="g-recaptcha-response"></textarea>`;
    expect(isCaptchaField(document.body.firstElementChild as HTMLElement)).toBe(true);
  });

  it("flags the Cloudflare Turnstile response input", () => {
    document.body.innerHTML = `<input name="cf-turnstile-response" />`;
    expect(isCaptchaField(document.body.firstElementChild as HTMLElement)).toBe(true);
  });

  it("flags the hCaptcha response field", () => {
    document.body.innerHTML = `<textarea name="h-captcha-response"></textarea>`;
    expect(isCaptchaField(document.body.firstElementChild as HTMLElement)).toBe(true);
  });

  it("flags a control nested inside a captcha widget container", () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="x"><input id="inner" /></div>`;
    expect(isCaptchaField(document.getElementById("inner")!)).toBe(true);
  });

  it("does not flag an ordinary application field", () => {
    document.body.innerHTML = `<input name="first_name" id="first_name" />`;
    expect(isCaptchaField(document.body.firstElementChild as HTMLElement)).toBe(false);
  });
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
