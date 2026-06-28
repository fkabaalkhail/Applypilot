# AGENT TASK: Build Autofill Core Engine (Jobright-Level)

You are implementing a production-grade browser-extension autofill engine.
Treat this as a **state reconciliation system**, not a simple DOM filler.
Follow the spec below exactly. Do not simplify steps to save time — partial
implementations cause silent failures on real ATS platforms.

**Last updated:** 2026-06-27
**Scope:** Chrome Extension Autofill Engine (Workday, Greenhouse, Lever, custom ATS, React/Angular/Vue forms)

---

## 1. Architecture (build in this order)

1. **Field Discovery Layer** — turns a page into a structured field model
2. **Write Correctness Layer** — ensures values actually persist in controlled inputs
3. **Stability & Reconciliation Layer** — survives re-renders and DOM drift

Do not skip layer ordering. Layer B depends on Layer A's output schema; Layer C depends on B's write confirmation events.

---

## 2. Field Discovery Layer

- Recursively traverse: main document, same-origin iframes, open shadow DOM
- Extract: `input`, `textarea`, `select`
- Map each field to canonical schema (`first_name`, `last_name`, `email`, `phone`, `address`, `education.*`, `experience.*`)
- Score field-to-schema confidence using: label text (highest weight) > aria-label > placeholder > name/id > section headers
- Only act on fields with confidence ≥ 0.70

## 3. Write Correctness Layer

- **Never** use `el.value = "x"` directly on React/Angular/Vue-controlled inputs.
- **Always** use the native setter:

```ts
const setValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
};
```

- After setting value, fire events in this exact order: `focus` → `input` → `change` → `blur`
- Immediately verify the DOM value. Immediate match alone is not sufficient. matches what was written. On mismatch, retry once (max 2 attempts per field).
- Verification is only considered valid if the value remains stable after the next render/mutation window (300–800ms).

## 4. Stability & Reconciliation Layer

- Introduce a per-field state machine to track lifecycle. States: discovered, mapped, filled, verified, stable, drifted, blocked_captcha
- Run a `MutationObserver` watching for value changes, DOM replacement, iframe reloads, and shadow DOM updates.
- Mutation events take priority over all ongoing reconciliation cycles and must immediately trigger a restart of the affected field’s reconciliation process (estart = revert to mapped state, NOT rediscovery).
- After initial fill: wait 300–800ms, re-scan filled fields, detect drift, reapply corrections. Repeat up to 3 cycles, stop when stable.
- If a single field drifts post-fill, reapply and revalidate just that field (don't rerun the whole pipeline).

## 5. CAPTCHA Policy (hard constraint)

- Never attempt to bypass or interact with CAPTCHA/verification systems.
- Detect via: recaptcha/hcaptcha iframes, verification overlays, submit buttons disabled pending human verification.
- On detection: CAPTCHA enters a global suspend mode for the form group, not just a field, resume after the DOM stabilizes.

## 6. Execution Pipeline

```
Discover fields (A)
  → build semantic field graph
  → normalize to schema
  → filter by confidence ≥ 0.70
Fill via native setter + event sequence (B)
  → verify write
Observe mutations (C)
  → reconcile drift, max 3 cycles
  → final stability check
```

## 7. Non-Functional Requirements

- Must work on Workday, Greenhouse, Lever, and generic React-controlled forms
- Must survive DOM re-renders and framework value overwrites
- Must traverse iframes + open shadow DOM
- Must be idempotent — re-running the pipeline on an already-filled form should not corrupt values
- No brittle fixed-timing hacks as the _only_ correctness mechanism — timing is a backstop to the observer/reconciliation logic, not a substitute for it
- Only mark field as complete after stability confirmation post-mutation window.

## 8. Infrastructure / MCP Access

You have these integrations available:

- **GitHub MCP** — repo read/write, branch management, PR updates
- **Neon MCP** — DB schema updates, user profile sync, session persistence
- **Vercel MCP** — env vars, deployments, preview management

**Deployment rule:** always land changes on the development branch first. Only promote to production after autofill regression tests pass and session/handshake sync is confirmed working.

## 9. End-of-Session Reporting (mandatory)

At the end of every work session, output a status block with exactly these fields:

```
WHAT CHANGED:
WHAT IS BROKEN / INCOMPLETE:
NEXT FILE + FUNCTION TO MODIFY:
CURRENT STATE OF AUTOFILL ENGINE:
```

This is required so the next session can resume without re-analyzing the codebase from scratch.

## 10. Definition of Done

- Works on Workday + Greenhouse + Lever
- Survives React controlled-input overrides
- Maintains values across DOM re-render
- Passes 3-cycle reconciliation with zero drift
- Correctly handles iframe + shadow DOM traversal

## 11. Core Principle

The DOM is unstable by default. Your job is continuous reconciliation until live DOM state matches the canonical user data model — not a one-shot fill.
