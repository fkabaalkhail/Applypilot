import { describe, it, expect, beforeEach } from "vitest";
import {
  deleteCredential,
  getCredential,
  getDefaultCredential,
  listCredentials,
  saveCredential,
  saveDefaultCredential,
} from "../src/content/credentialStore";

function mockLocalStorage(): void {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: mem[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(mem, obj);
        },
      },
    },
  };
}

describe("credentialStore", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  it("saves and retrieves per-origin credentials", async () => {
    await saveCredential("https://acme.wd3.myworkdayjobs.com", "me@x.com", "S3cret!");
    const c = await getCredential("https://acme.wd3.myworkdayjobs.com");
    expect(c?.email).toBe("me@x.com");
    expect(c?.password).toBe("S3cret!");
    expect(c?.createdAt).toBeGreaterThan(0);
    expect(await getCredential("https://other.example.com")).toBeNull();
  });

  it("overwrites on re-save (last write wins) and lists newest first", async () => {
    await saveCredential("https://a.com", "a@x.com", "one");
    await saveCredential("https://b.com", "b@x.com", "two");
    await saveCredential("https://a.com", "a@x.com", "three");
    expect((await getCredential("https://a.com"))?.password).toBe("three");
    const all = await listCredentials();
    expect(all.map((c) => c.origin)).toHaveLength(2);
  });

  it("deletes a single origin", async () => {
    await saveCredential("https://a.com", "a@x.com", "one");
    await deleteCredential("https://a.com");
    expect(await getCredential("https://a.com")).toBeNull();
  });

  it("defaults are empty until saved, then round-trip", async () => {
    expect(await getDefaultCredential()).toEqual({ email: "", password: "" });
    await saveDefaultCredential({ email: "reg@x.com", password: "MyChosen#Pass1" });
    expect(await getDefaultCredential()).toEqual({ email: "reg@x.com", password: "MyChosen#Pass1" });
    // Defaults live beside per-origin pairs without clobbering them.
    await saveCredential("https://a.com", "a@x.com", "one");
    expect(await getDefaultCredential()).toEqual({ email: "reg@x.com", password: "MyChosen#Pass1" });
    expect((await getCredential("https://a.com"))?.password).toBe("one");
  });
});
