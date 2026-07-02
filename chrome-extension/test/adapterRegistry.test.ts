import { describe, it, expect } from "vitest";
import { resolveAdapter } from "../src/content/adapters/registry";
import type { SiteAdapter } from "../src/content/adapters/types";

const stub = (id: string, match: SiteAdapter["match"]): SiteAdapter => ({ id, match });

describe("resolveAdapter", () => {
  it("returns the first adapter whose match() is true (order = precedence)", () => {
    const a = stub("a", (h) => h.endsWith("a.com"));
    const b = stub("b", (h) => h.endsWith("b.com"));
    expect(resolveAdapter([a, b], "x.b.com", "https://x.b.com/")?.id).toBe("b");
  });

  it("returns null when nothing matches", () => {
    const a = stub("a", (h) => h === "a.com");
    expect(resolveAdapter([a], "other.com", "https://other.com/")).toBeNull();
  });

  it("skips an adapter whose match() throws (one bad adapter can't break resolution)", () => {
    const bad = stub("bad", () => { throw new Error("boom"); });
    const good = stub("good", (h) => h === "ok.com");
    expect(resolveAdapter([bad, good], "ok.com", "https://ok.com/")?.id).toBe("good");
  });
});
