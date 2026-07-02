import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { detectWall, runAccountWall, WALL_ADVANCE_RE } from "../src/content/accountFlow";
import { getCredential, saveCredential } from "../src/content/credentialStore";
import type { WriteResult } from "../src/content/writeEngine";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

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

beforeEach(() => {
  document.body.innerHTML = "";
  mockLocalStorage();
});

const write = (el: HTMLInputElement, value: string): WriteResult => {
  el.value = value;
  return { written: true };
};

function scope(): HTMLElement {
  return document.getElementById("s")!;
}

describe("detectWall", () => {
  it("detects a signup wall (two password fields)", () => {
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" />
        <input type="password" name="password" />
        <input type="password" name="verifyPassword" />
      </div>`;
    const wall = detectWall(scope());
    expect(wall?.kind).toBe("signup");
    expect(wall?.passwordEls).toHaveLength(2);
    expect(wall?.emailEl?.name).toBe("email");
  });

  it("detects a login wall (one password + sign-in copy, EN and FR)", () => {
    document.body.innerHTML = `
      <div id="s"><h2>Sign In</h2><input type="email" /><input type="password" /></div>`;
    expect(detectWall(scope())?.kind).toBe("login");
    document.body.innerHTML = `
      <div id="s"><h2>Se connecter</h2><input type="email" /><input type="password" /></div>`;
    expect(detectWall(scope())?.kind).toBe("login");
  });

  it("returns null with no password fields", () => {
    document.body.innerHTML = `<div id="s"><input type="email" /></div>`;
    expect(detectWall(scope())).toBeNull();
  });

  it("skips a hidden honeypot email field and picks the visible one", () => {
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email_confirm_hp" style="display:none" />
        <input type="email" name="email" id="real-email" />
        <input type="password" /><input type="password" />
      </div>`;
    expect(detectWall(scope())?.emailEl?.id).toBe("real-email");
  });
});

describe("runAccountWall", () => {
  it("signup: generates, fills both password fields, saves the credential", async () => {
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" id="em" />
        <input type="password" id="p1" /><input type="password" id="p2" />
      </div>`;
    const wall = detectWall(scope())!;
    const out = await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    const p1 = (document.getElementById("p1") as HTMLInputElement).value;
    const p2 = (document.getElementById("p2") as HTMLInputElement).value;
    expect(p1).toHaveLength(20);
    expect(p1).toBe(p2);
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("me@x.com");
    expect(out.extraAdvance).toBe(WALL_ADVANCE_RE);
    expect(out.pause).toBeUndefined();
    const saved = await getCredential("https://acme.jobs");
    expect(saved?.email).toBe("me@x.com");
    expect(saved?.password).toBe(p1);
  });

  it("signup revisit: reuses the already-saved password (idempotent)", async () => {
    await saveCredential("https://acme.jobs", "me@x.com", "Existing#Pass9x");
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" /><input type="password" id="p1" />
      </div>`;
    await runAccountWall(detectWall(scope())!, "https://acme.jobs", "me@x.com", write);
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Existing#Pass9x");
  });

  it("login with stored creds fills them; without creds pauses", async () => {
    document.body.innerHTML = `
      <div id="s"><h2>Sign In</h2><input type="email" id="em" /><input type="password" id="p1" /></div>`;
    const wall = detectWall(scope())!;
    const noCreds = await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    expect(noCreds.pause).toBe("account");

    await saveCredential("https://acme.jobs", "me@x.com", "Stored#Pass9x");
    const withCreds = await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    expect(withCreds.pause).toBeUndefined();
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Stored#Pass9x");
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("me@x.com");
  });
});
