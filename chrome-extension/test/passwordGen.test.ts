import { describe, it, expect } from "vitest";
import { generatePassword } from "../src/content/passwordGen";

describe("generatePassword", () => {
  it("is 20 chars by default and honors a custom length", () => {
    expect(generatePassword()).toHaveLength(20);
    expect(generatePassword(24)).toHaveLength(24);
  });

  it("always contains all four character classes", () => {
    for (let i = 0; i < 25; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*\-_=+?]/);
    }
  });

  it("never uses ambiguous glyphs (0/O, 1/l/I)", () => {
    for (let i = 0; i < 25; i++) {
      expect(generatePassword()).not.toMatch(/[01OlI]/);
    }
  });

  it("produces different values per call", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
