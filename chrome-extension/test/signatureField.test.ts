import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const catOf = (label: string) => {
  document.body.innerHTML = `<div><label for="s">${label}</label><input id="s" type="text"></div>`;
  return scanPage(MOCK_PROFILE, false).fields[0]?.category;
};

describe("text signature fields resolve to the full name", () => {
  it("classifies e-signature / 'type your name to sign' as fullName", () => {
    expect(catOf("Type your full name to sign")).toBe("fullName");
    expect(catOf("E-Signature")).toBe("fullName");
    expect(catOf("Signature (sign below)")).toBe("fullName");
  });
  it("does not treat sign in / sign up as a signature", () => {
    expect(catOf("Sign in")).not.toBe("fullName");
    expect(catOf("Sign up")).not.toBe("fullName");
  });
});
