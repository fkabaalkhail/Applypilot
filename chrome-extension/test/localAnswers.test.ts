import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveLocalAnswer, getLocalAnswer, getLocalAnswers } from "../src/content/localAnswers";
import { normalize } from "../src/content/fieldMatcher";

// Minimal chrome.storage.local stub backed by a plain object.
function makeStorageArea() {
  const data: Record<string, unknown> = {};
  return {
    _data: data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(data, obj); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
}

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: makeStorageArea() },
  };
});

describe("localAnswers — device-local sensitive answer memory", () => {
  it("round-trips an answer keyed by the normalized question", async () => {
    await saveLocalAnswer("I identify as transgender (please select one):*", "No");
    // Same question, different decoration (case/punctuation/whitespace) → same key.
    expect(await getLocalAnswer("I identify as transgender (please select one):")).toBe("No");
    expect(await getLocalAnswer("i identify as TRANSGENDER (please select one)")).toBe("No");
  });

  it("returns null for a question never answered", async () => {
    expect(await getLocalAnswer("I identify my sexual orientation as:")).toBeNull();
  });

  it("never reuses an answer across DIFFERENT questions", async () => {
    await saveLocalAnswer("I identify as transgender (please select one):*", "No");
    expect(await getLocalAnswer("I identify my sexual orientation as (please select one):*")).toBeNull();
  });

  it("ignores blank questions and blank answers", async () => {
    await saveLocalAnswer("   ", "No");
    await saveLocalAnswer("A real question?", "   ");
    expect((await getLocalAnswers()).size).toBe(0);
  });

  it("getLocalAnswers exposes the normalized-question → answer map", async () => {
    await saveLocalAnswer("Do you identify as LGBTQ+?", "Prefer not to say");
    const map = await getLocalAnswers();
    expect(map.get(normalize("Do you identify as LGBTQ+?"))).toBe("Prefer not to say");
  });

  it("overwrites a previous answer to the same question", async () => {
    await saveLocalAnswer("I identify as transgender:*", "I don't wish to answer");
    await saveLocalAnswer("I identify as transgender:*", "No");
    expect(await getLocalAnswer("I identify as transgender:*")).toBe("No");
  });
});

describe("localAnswers — concurrent saves", () => {
  it("keeps every entry when saves race (the modal fires one per answer)", async () => {
    await Promise.all([
      saveLocalAnswer("I identify as transgender:*", "No"),
      saveLocalAnswer("I identify my sexual orientation as:*", "Heterosexual"),
      saveLocalAnswer("Do you identify as LGBTQ+?", "Prefer not to say"),
    ]);
    const map = await getLocalAnswers();
    expect(map.size).toBe(3);
    expect(await getLocalAnswer("I identify as transgender:*")).toBe("No");
    expect(await getLocalAnswer("I identify my sexual orientation as:*")).toBe("Heterosexual");
  });
});
