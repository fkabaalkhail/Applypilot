import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  detectWall,
  findSignupToggle,
  LOGIN_ADVANCE_RE,
  runAccountWall,
  SIGNUP_ADVANCE_RE,
} from "../src/content/accountFlow";
import { getCredential, saveCredential, saveDefaultCredential } from "../src/content/credentialStore";
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
    expect(out.extraAdvance).toBe(SIGNUP_ADVANCE_RE);
    expect(out.pause).toBeUndefined();
    const saved = await getCredential("https://acme.jobs");
    expect(saved?.email).toBe("me@x.com");
    expect(saved?.password).toBe(p1);
  });

  it("signup: detects and ticks Workday's createAccountCheckbox (hidden, unlabelled, not required)", async () => {
    // Workday's consent is a native checkbox with only a data-automation-id —
    // no `required`, no agreement-worded label, often visually hidden. The old
    // filter missed it entirely ("0 agreement boxes"), leaving Create Account
    // inert. It must now be found by its automation-id and ticked.
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" id="em" />
        <input type="password" data-automation-id="password" id="p1" />
        <input type="password" data-automation-id="verifyPassword" id="p2" />
        <div data-automation-id="createAccountCheckbox">
          <input type="checkbox" id="agree" data-automation-id="createAccountCheckbox" />
        </div>
      </div>`;
    const wall = detectWall(scope())!;
    expect(wall.kind).toBe("signup");
    expect(wall.agreeEls).toHaveLength(1);
    await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    expect((document.getElementById("agree") as HTMLInputElement).checked).toBe(true);
  });

  it("signup: recognized from a Workday verify-password marker even with one visible password", async () => {
    // A slow-loading verify-password field can leave one password box visible;
    // the automation-id marker still identifies this as create-account, so we
    // never misread it as a sign-in (which would just pause).
    document.body.innerHTML = `
      <div id="s"><h2>Account</h2>
        <input type="email" name="email" />
        <input type="password" data-automation-id="password" id="p1" />
        <div data-automation-id="verifyPassword"></div>
      </div>`;
    expect(detectWall(scope())?.kind).toBe("signup");
  });

  it("signup: ticks a required consent checkbox but leaves marketing opt-ins alone", async () => {
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" id="em" />
        <input type="password" id="p1" /><input type="password" id="p2" />
        <label><input type="checkbox" id="agree" required /> I agree to the Privacy Statement</label>
        <label><input type="checkbox" id="marketing" /> Send me job tips</label>
      </div>`;
    const wall = detectWall(scope())!;
    expect(wall.agreeEls).toHaveLength(1);
    await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    expect((document.getElementById("agree") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("marketing") as HTMLInputElement).checked).toBe(false);
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
    expect(withCreds.extraAdvance).toBe(LOGIN_ADVANCE_RE);
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Stored#Pass9x");
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("me@x.com");
  });

  it("signup: the user's account-creation credentials beat generation", async () => {
    await saveDefaultCredential({ email: "reg@x.com", password: "Chosen#Pass1" });
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" id="em" />
        <input type="password" id="p1" /><input type="password" id="p2" />
      </div>`;
    await runAccountWall(detectWall(scope())!, "https://acme.jobs", "profile@x.com", write);
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("reg@x.com");
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Chosen#Pass1");
    expect((document.getElementById("p2") as HTMLInputElement).value).toBe("Chosen#Pass1");
    // The pair actually used is saved per-origin (Saved sign-ins).
    const saved = await getCredential("https://acme.jobs");
    expect(saved).toMatchObject({ email: "reg@x.com", password: "Chosen#Pass1" });
  });

  it("signup: the user's explicit default password beats a stale per-origin pair", async () => {
    // The user set an account-creation password in the modal; it must be honored
    // even when an older per-origin credential exists (e.g. a generated one saved
    // during an earlier attempt). An explicit choice always wins for signup.
    await saveDefaultCredential({ email: "reg@x.com", password: "Chosen#Pass1" });
    await saveCredential("https://acme.jobs", "orig@x.com", "Original#Pass9");
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" /><input type="password" id="p1" />
      </div>`;
    await runAccountWall(detectWall(scope())!, "https://acme.jobs", "profile@x.com", write);
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Chosen#Pass1");
  });

  it("login without a per-origin pair falls back to the defaults and saves the pair", async () => {
    await saveDefaultCredential({ email: "reg@x.com", password: "Chosen#Pass1" });
    document.body.innerHTML = `
      <div id="s"><h2>Sign In</h2><input type="email" id="em" /><input type="password" id="p1" /></div>`;
    const out = await runAccountWall(detectWall(scope())!, "https://acme.jobs", "me@x.com", write);
    expect(out.pause).toBeUndefined();
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("reg@x.com");
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Chosen#Pass1");
    expect(await getCredential("https://acme.jobs")).toMatchObject({
      email: "reg@x.com",
      password: "Chosen#Pass1",
    });
  });

  it("login with only a default email (no password) still pauses", async () => {
    await saveDefaultCredential({ email: "reg@x.com", password: "" });
    document.body.innerHTML = `
      <div id="s"><h2>Sign In</h2><input type="email" /><input type="password" /></div>`;
    const out = await runAccountWall(detectWall(scope())!, "https://acme.jobs", "me@x.com", write);
    expect(out.pause).toBe("account");
  });
});

describe("findSignupToggle", () => {
  it("finds Workday's createAccountLink by automation-id", () => {
    document.body.innerHTML = `
      <div id="s">
        <button data-automation-id="createAccountLink">Don't have an account yet?</button>
      </div>`;
    expect(findSignupToggle(scope())?.getAttribute("data-automation-id")).toBe("createAccountLink");
  });

  it("finds a create-account link by anchored text, ignoring body copy", () => {
    document.body.innerHTML = `
      <div id="s">
        <p>You must create an account to continue reading our terms.</p>
        <a href="#" id="toggle">Create Account</a>
      </div>`;
    expect(findSignupToggle(scope())?.id).toBe("toggle");
  });

  it("returns null when the page offers no registration path", () => {
    document.body.innerHTML = `
      <div id="s"><a href="#">Forgot password?</a><button>Sign In</button></div>`;
    expect(findSignupToggle(scope())).toBeNull();
  });
});
