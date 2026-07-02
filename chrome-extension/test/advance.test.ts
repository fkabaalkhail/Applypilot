import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { findAdvanceButton } from "../src/content/advance";
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
