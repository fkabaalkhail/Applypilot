import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { findAdvanceButton } from "../src/content/advance";
import { LOGIN_ADVANCE_RE, SIGNUP_ADVANCE_RE } from "../src/content/accountFlow";
import type { SiteAdapter } from "../src/content/adapters/types";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

function scopeWith(html: string): HTMLElement {
  document.body.innerHTML = `<div id="scope">${html}</div>`;
  return document.getElementById("scope")!;
}

describe("findAdvanceButton", () => {
  it("finds EN advance buttons (Next / Save & Continue)", () => {
    for (const label of ["Next", "Save & Continue", "Save and Continue", "Continue", "Next Step", "Review"]) {
      const scope = scopeWith(`<button>${label}</button>`);
      const hit = findAdvanceButton(scope, null);
      expect(hit?.kind, label).toBe("advance");
    }
  });

  it("finds FR advance buttons (Suivant / Continuer)", () => {
    for (const label of ["Suivant", "Continuer", "Poursuivre"]) {
      const scope = scopeWith(`<button>${label}</button>`);
      expect(findAdvanceButton(scope, null)?.kind, label).toBe("advance");
    }
  });

  it("classifies submit-like buttons as terminal (EN + FR) and never as advance", () => {
    for (const label of ["Submit", "Submit application", "Send application", "Apply now", "Soumettre", "Envoyer", "Postuler", "Terminer"]) {
      const scope = scopeWith(`<button>${label}</button>`);
      expect(findAdvanceButton(scope, null)?.kind, label).toBe("terminal");
    }
  });

  it("terminal wins when both a Next and a Submit are present", () => {
    const scope = scopeWith(`<button>Next</button><button>Submit</button>`);
    expect(findAdvanceButton(scope, null)?.kind).toBe("terminal");
  });

  it("matches wall verbs only via extraAdvance", () => {
    const scope = scopeWith(`<button>Create Account</button>`);
    expect(findAdvanceButton(scope, null)).toBeNull();
    const hit = findAdvanceButton(scope, null, {
      extraAdvance: /\bcreate( an| my)? account\b/i,
    });
    expect(hit?.kind).toBe("advance");
  });

  it("ignores disabled and aria-disabled buttons", () => {
    const scope = scopeWith(`<button disabled>Next</button><button aria-disabled="true">Continue</button>`);
    expect(findAdvanceButton(scope, null)).toBeNull();
  });

  it("reads input[type=submit] values and [role=button] text", () => {
    const a = scopeWith(`<input type="submit" value="Continue" />`);
    expect(findAdvanceButton(a, null)?.kind).toBe("advance");
    const b = scopeWith(`<div role="button">Next</div>`);
    expect(findAdvanceButton(b, null)?.kind).toBe("advance");
  });

  it("adapter override wins, but its button is still terminal-checked", () => {
    const scope = scopeWith(`<button id="wd">Submit</button><button>Next</button>`);
    const adapter = {
      id: "t", match: () => true,
      advanceButton: (s: HTMLElement) => s.querySelector<HTMLElement>("#wd"),
    } as SiteAdapter;
    const hit = findAdvanceButton(scope, adapter);
    expect(hit?.el.id).toBe("wd");
    expect(hit?.kind).toBe("terminal");
  });
});

/**
 * REGRESSION: on Workday the create-account gate shares a scope with the job
 * posting, whose "Apply" button matches TERMINAL_RE. The flow read that as the
 * final submit, finished "done", and the user was left on the account page with
 * no Continue button.
 */
describe("account wall advance", () => {
  function mountWall(): HTMLElement {
    document.body.innerHTML = `
      <div id="scope">
        <button data-automation-id="adventureButton">Apply</button>
        <input type="password" />
        <button data-automation-id="createAccountSubmitButton">Create Account</button>
      </div>`;
    return document.getElementById("scope")!;
  }

  it("prefers the wall's own button over the posting's Apply", () => {
    const found = findAdvanceButton(mountWall(), null, { extraAdvance: SIGNUP_ADVANCE_RE });
    expect(found).not.toBeNull();
    expect(found!.kind).toBe("advance");
    expect(found!.el.textContent).toBe("Create Account");
  });

  it("still reports a terminal submit on an ordinary form page", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button>Back</button>
        <button>Submit Application</button>
      </div>`;
    const found = findAdvanceButton(document.getElementById("scope")!, null, {});
    expect(found!.kind).toBe("terminal");
  });

  it("does not let a wall regex smuggle past a real submit when no wall is present", () => {
    document.body.innerHTML = `<div id="scope"><button>Submit</button></div>`;
    const found = findAdvanceButton(document.getElementById("scope")!, null, {});
    expect(found!.kind).toBe("terminal");
  });

  it("a real submit still wins when a wall regex is live but no wall button matches", () => {
    document.body.innerHTML = `<div id="scope"><input type="password" /><button>Submit</button></div>`;
    const found = findAdvanceButton(document.getElementById("scope")!, null, { extraAdvance: SIGNUP_ADVANCE_RE });
    expect(found!.kind).toBe("terminal");
  });

  /**
   * SAFETY: on a wall page the controller clicks an "advance" WITHOUT parking
   * for the user (flowController: `if (account.wall)` skips the advance gate).
   * Both regexes are \b-anchored alternations, so one button can carry a wall
   * verb AND a submit verb, classifying that as "advance" would submit the
   * application unreviewed, breaking the never-click-a-terminal invariant.
   */
  it("never returns advance for a button that also reads as a final submit", () => {
    const composites: Array<[string, RegExp]> = [
      ["Register and Submit", SIGNUP_ADVANCE_RE],
      ["Sign up & Submit", SIGNUP_ADVANCE_RE],
      ["Create account and finish", SIGNUP_ADVANCE_RE],
      ["Sign in and submit application", LOGIN_ADVANCE_RE],
      ["S'inscrire et soumettre", SIGNUP_ADVANCE_RE],
    ];
    for (const [label, extraAdvance] of composites) {
      document.body.innerHTML = `<div id="scope"><input type="password" /><button>${label}</button></div>`;
      const found = findAdvanceButton(document.getElementById("scope")!, null, { extraAdvance });
      expect(found!.kind, label).toBe("terminal");
    }
  });

  it("keeps a wall's 'Sign in to apply' an advance, apply is an entry verb, not a final submit", () => {
    document.body.innerHTML = `<div id="scope"><input type="password" /><button>Sign in to apply</button></div>`;
    const found = findAdvanceButton(document.getElementById("scope")!, null, { extraAdvance: LOGIN_ADVANCE_RE });
    expect(found!.kind).toBe("advance");
  });
});
