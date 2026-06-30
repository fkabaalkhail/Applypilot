# SuccessFactors Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the rescan-observer gap for open shadow DOM (so UI5/SuccessFactors multi-step forms re-detect), prove it with a UI5-style fixture, and complete the Hard tier (5/15).

**Architecture:** The substantive cycle. `scanPage` already classifies + fills fields inside open shadow roots (same realm — probe-confirmed), but `observePage` watches only the top documentElement and never sees shadow-internal mutations (probe: 0 callbacks). Extend `observePage` to also observe every open shadow root (re-attaching as new ones appear), via a new pure `openShadowRoots` helper. Same-origin iframes are intentionally excluded (cross-realm — handled per-frame). TDD on the engine change.

**Tech Stack:** TypeScript (strict), vitest + jsdom. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `feat/successfactors-autofill-hardening` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only** — no per-ATS modules / hostname branching.
- Preserve hard guarantees: never fill EEO unless toggle on + profile has the answer; never script file inputs; never submit.
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Extend the rescan observer to open shadow roots

**Files:**
- Modify: `chrome-extension/src/content/formScanner.ts` (add `openShadowRoots`; rewrite `observePage` internals)
- Test: `chrome-extension/test/observePage.test.ts` (new)

**Interfaces:**
- Produces: `openShadowRoots(root: Document | ShadowRoot): ShadowRoot[]` — every open shadow root reachable from `root` (nested included). `observePage(onChange)` unchanged signature, now also observes those roots.

- [ ] **Step 1: Write the failing tests**

Create `chrome-extension/test/observePage.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { observePage, openShadowRoots } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("openShadowRoots", () => {
  it("collects open shadow roots, including nested ones", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const innerHost = document.createElement("div");
    sr.appendChild(innerHost);
    const nested = innerHost.attachShadow({ mode: "open" });

    const roots = openShadowRoots(document);
    expect(roots).toContain(sr);
    expect(roots).toContain(nested);
  });

  it("returns nothing for a tree with no shadow roots", () => {
    document.body.innerHTML = `<div><input /></div>`;
    expect(openShadowRoots(document)).toEqual([]);
  });
});

describe("observePage — shadow reach", () => {
  it("fires a rescan when a field is added inside an open shadow root", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    sr.appendChild(document.createElement("span")); // shadow root exists at observe time

    let calls = 0;
    const observer = observePage(() => {
      calls++;
    });
    sr.appendChild(document.createElement("input")); // mutate INSIDE the shadow root
    await new Promise((r) => setTimeout(r, 650)); // MutationObserver + 500ms debounce
    observer.disconnect();
    expect(calls).toBeGreaterThan(0);
  });

  it("still fires for top-document mutations", async () => {
    let calls = 0;
    const observer = observePage(() => {
      calls++;
    });
    document.body.appendChild(document.createElement("div"));
    await new Promise((r) => setTimeout(r, 650));
    observer.disconnect();
    expect(calls).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/observePage.test.ts`
Expected: FAIL — `openShadowRoots` is not exported (import error), and the shadow-reach test would see 0 callbacks.

- [ ] **Step 3: Implement the change**

In `chrome-extension/src/content/formScanner.ts`, replace the existing `observePage` function (the `// Dynamic page support` section) with:
```ts
const OBSERVE_OPTS: MutationObserverInit = { childList: true, subtree: true };

/**
 * Every open shadow root reachable from `root` (nested included). SuccessFactors-
 * style UI5 fields live in open shadow roots, which are the SAME JS realm as the top
 * document — so the scanner already classifies them, but a top-documentElement
 * MutationObserver never sees mutations inside them. Same-origin iframes are NOT
 * included: their fields are a different realm the top frame can't classify (they
 * run their own content-script instance), so observing them would only cause
 * pointless rescans.
 */
export function openShadowRoots(root: Document | ShadowRoot): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const visit = (node: Document | ShadowRoot): void => {
    node.querySelectorAll("*").forEach((el) => {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) {
        out.push(sr);
        visit(sr);
      }
    });
  };
  visit(root);
  return out;
}

/**
 * Watch for DOM changes (SPA navigation, multi-step Workday forms, UI5 shadow-DOM
 * steps) and call back, debounced. Observes the top document AND every open shadow
 * root, re-attaching to roots that appear later. Attribute changes are ignored — we
 * cause those ourselves when assigning field ids and flashing highlights.
 */
export function observePage(onChange: () => void): MutationObserver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observed = new Set<Node>();
  const attach = (): void => {
    if (!observed.has(document.documentElement)) {
      observed.add(document.documentElement);
      observer.observe(document.documentElement, OBSERVE_OPTS);
    }
    for (const root of openShadowRoots(document)) {
      if (observed.has(root)) continue;
      observed.add(root);
      observer.observe(root, OBSERVE_OPTS);
    }
  };
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => m.addedNodes.length > 0 || m.removedNodes.length > 0);
    if (!relevant) return;
    attach(); // pick up newly-added shadow roots
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 500);
  });
  attach();
  return observer;
}
```

(Replaces the previous `observePage` that observed only `document.documentElement`. The `// Dynamic page support` banner comment above it can stay.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/observePage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/formScanner.ts chrome-extension/test/observePage.test.ts
git commit -m "feat(extension): extend rescan observer to open shadow roots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: SuccessFactors UI5 shadow-DOM fixture + tests

**Files:**
- Create: `chrome-extension/test/fixtures/successfactors.ts`
- Create: `chrome-extension/test/successfactors.test.ts`

**Interfaces:**
- Consumes: `stubLayout`, `runAutofill`, `scanPage`, `MOCK_PROFILE`.
- Produces: `mountSuccessFactorsForm(doc: Document): void` — mounts a light-DOM form of custom-element hosts, each with an OPEN shadow root wrapping an aria-labelled control; hosts carry known ids.

- [ ] **Step 1: Write the fixture builder**

Create `chrome-extension/test/fixtures/successfactors.ts`:
```ts
/**
 * Reproduces SAP SuccessFactors / UI5 field markup: each field is a custom-element
 * host with an OPEN shadow root wrapping the real control, whose accessible name is
 * an aria-label (UI5's pattern). Open shadow roots are the same JS realm as the top
 * document, so the scanner reaches and classifies them. Reconstructed from known
 * UI5 patterns as of 2026-06-30, not copied markup.
 */

function host(doc: Document, tag: string, id: string, control: HTMLElement): HTMLElement {
  const h = doc.createElement(tag);
  h.id = id;
  const sr = h.attachShadow({ mode: "open" });
  sr.appendChild(control);
  return h;
}

function textControl(doc: Document, ariaLabel: string, type = "text"): HTMLInputElement {
  const i = doc.createElement("input");
  i.type = type;
  i.setAttribute("aria-label", ariaLabel);
  return i;
}

function selectControl(doc: Document, ariaLabel: string, options: string[]): HTMLSelectElement {
  const s = doc.createElement("select");
  s.setAttribute("aria-label", ariaLabel);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  s.append(placeholder);
  for (const o of options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    s.append(opt);
  }
  return s;
}

export function mountSuccessFactorsForm(doc: Document): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.id = "sf-apply";

  form.append(host(doc, "ui5-input", "sf-firstname-host", textControl(doc, "First Name")));
  form.append(host(doc, "ui5-input", "sf-lastname-host", textControl(doc, "Last Name")));
  form.append(host(doc, "ui5-input", "sf-email-host", textControl(doc, "Email", "email")));
  form.append(host(doc, "ui5-input", "sf-phone-host", textControl(doc, "Phone", "tel")));
  form.append(host(doc, "ui5-input", "sf-city-host", textControl(doc, "City")));
  form.append(host(doc, "ui5-select", "sf-country-host", selectControl(doc, "Country", ["United States", "Canada", "Mexico"])));
  form.append(host(doc, "ui5-fileuploader", "sf-resume-host", textControl(doc, "Resume/CV", "file")));
  form.append(host(doc, "ui5-select", "sf-gender-host", selectControl(doc, "Gender", ["Male", "Female", "Decline to self-identify"])));
  form.append(host(doc, "ui5-select", "sf-ethnicity-host", selectControl(doc, "Race/Ethnicity", ["Asian", "White", "Decline to self-identify"])));
  form.append(host(doc, "ui5-select", "sf-veteran-host", selectControl(doc, "Veteran Status", ["I am not a veteran", "I am a veteran"])));

  doc.body.appendChild(form);
}
```

- [ ] **Step 2: Write the failing detection + fill + rescan test**

Create `chrome-extension/test/successfactors.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountSuccessFactorsForm } from "./fixtures/successfactors";
import { stubLayout } from "./helpers/layout";
import { runAutofill } from "./helpers/autofill";
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

/** The real control inside a UI5 host's open shadow root. */
function inner(hostId: string): HTMLInputElement | HTMLSelectElement {
  return document
    .getElementById(hostId)!
    .shadowRoot!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
}

describe("SuccessFactors UI5 shadow DOM — detection", () => {
  it("classifies fields living inside open shadow roots", () => {
    mountSuccessFactorsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountSuccessFactorsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("SuccessFactors UI5 shadow DOM — autofill", () => {
  it("fills the inner shadow controls; skips resume + EEO", async () => {
    mountSuccessFactorsForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(inner("sf-firstname-host").value).toBe("John");
    expect(inner("sf-lastname-host").value).toBe("Doe");
    expect(inner("sf-email-host").value).toBe("john@example.com");
    expect(inner("sf-phone-host").value).toBe("+1 555 555 5555");
    expect(inner("sf-city-host").value).toBe("Ottawa, ON, Canada");
    expect(inner("sf-country-host").value).toBe("Canada");
    expect(inner("sf-resume-host").value).toBe("");
    expect(inner("sf-gender-host").value).toBe("");
  });
});

describe("SuccessFactors UI5 shadow DOM — rescan after a step change", () => {
  it("re-detects a field added inside an existing shadow root", () => {
    mountSuccessFactorsForm(document);
    const first = scanPage(MOCK_PROFILE, false);
    const before = first.fields.length;

    // UI5 multi-step: a new field appears inside a host's open shadow root.
    const sr = document.getElementById("sf-firstname-host")!.shadowRoot!;
    const extra = document.createElement("input");
    extra.setAttribute("aria-label", "LinkedIn Profile");
    sr.appendChild(extra);

    const second = scanPage(MOCK_PROFILE, false);
    expect(second.fields.length).toBe(before + 1);
    expect(second.fields.some((f) => f.category === "linkedin")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the SuccessFactors test**

Run: `npx vitest run test/successfactors.test.ts`
Expected: PASS. `deepQueryAll` reaches the open shadow roots; aria-labels drive classification; `runAutofill` writes the inner controls; the country select resolves "Ottawa, ON, Canada" → "Canada"; resume + EEO untouched; the scanner re-detects the field added inside the shadow root. A missing/failed assertion is a real gap — fix generically.

- [ ] **Step 4: Full suite + typecheck + commit**

Run: `npx vitest run` (expected all green), `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/fixtures/successfactors.ts chrome-extension/test/successfactors.test.ts
git commit -m "test(extension): SuccessFactors UI5 shadow-DOM fixture + detection/fill/rescan coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Confirm regression + check SuccessFactors off (Hard tier complete)

**Files:**
- Modify: `docs/ats-coverage.md` (SuccessFactors `[ ]` → `[x]`, progress `4 / 15` → `5 / 15`)
- Add: the spec + this plan.

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `observePage.test.ts` and `successfactors.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check SuccessFactors off in the tracker**

In `docs/ats-coverage.md`:
- Change `- [ ] **SAP SuccessFactors** *(SAP SE)*` to `- [x] **SAP SuccessFactors** *(SAP SE)*`.
- Change `**Progress:** 4 / 15 covered` to `**Progress:** 5 / 15 covered`.

- [ ] **Step 5: Commit docs + spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-successfactors-autofill-hardening-design.md docs/superpowers/plans/2026-06-30-successfactors-autofill-hardening.md
git commit -m "docs: add SuccessFactors autofill hardening spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git add docs/ats-coverage.md
git commit -m "docs: mark SuccessFactors covered in ATS tracker (5/15, Hard tier complete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 DoD → Tasks 1–3; §3 engine change (`observePage` + `openShadowRoots`, shadow-only) → Task 1; §4 fixture → Task 2; §5 testing (detection, fill, observer-reach behavioral + `openShadowRoots` unit + scanner-level rescan) → Tasks 1–2; §7 deliverables → Tasks 1–3. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; explicit expected results. ✓

**Type/name consistency:** `openShadowRoots(root)` defined + exported in Task 1, imported in `observePage.test.ts`; `observePage` signature unchanged; `mountSuccessFactorsForm(doc)` defined Task 2, used in its tests; host ids (`sf-firstname-host`…`sf-veteran-host`) consistent between fixture and the `inner()` helper; `runAutofill`/`stubLayout`/`scanPage`/`MOCK_PROFILE` match existing modules. ✓

**Empirical basis:** shadow discovery/fill is probe-confirmed; the observer gap is probe-confirmed (0 callbacks today → red), making Task 1 a genuine red→green; the iframe exclusion is justified by the iCIMS cross-realm finding.
