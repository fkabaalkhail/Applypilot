/**
 * LIVE-page forensic harness — injected into a real ATS page (MAIN world) by
 * live-probe.mjs. Runs the exact shipping engine (scanPage → driver/combobox/
 * reconciler routing, mirroring contentScript.fillItems) against the real form
 * and reports, per field: what the scanner saw, what it proposed, how the fill
 * routed, and what actually committed. Pure diagnostics — no overlay/network.
 */
import { scanPage } from "../../src/content/formScanner";
import type { RuntimeControl } from "../../src/content/formScanner";
import { AutofillReconciler } from "../../src/content/reconciler";
import { fillAriaCombobox, readComboboxValue } from "../../src/content/comboboxEngine";
import { cleanText, collectSignals } from "../../src/content/domUtils";
import { __test as mwTest } from "../../src/content/mainWorldDriver";
import { MOCK_PROFILE } from "../../src/api/mockProfile";
import type { DetectedField, UserApplicationProfile } from "../../src/shared/types";

const COMBO = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  openWaitMs: 1200,
  commitWaitMs: 1200,
  pollMs: 40,
};

/** Compact DOM outline: the control + a few ancestors, attrs that matter. */
function outline(el: HTMLElement | undefined, depth = 4): string[] {
  if (!el) return ["<no element>"];
  const lines: string[] = [];
  let node: HTMLElement | null = el;
  for (let i = 0; i < depth && node; i++) {
    const attrs: string[] = [];
    for (const a of ["id", "role", "aria-haspopup", "aria-expanded", "aria-controls", "aria-labelledby", "aria-label", "name", "data-automation-id", "placeholder", "type", "for"]) {
      const v = node.getAttribute(a);
      if (v) attrs.push(`${a}="${v.slice(0, 60)}"`);
    }
    const cls = (node.getAttribute("class") || "").slice(0, 90);
    lines.push(
      `${"  ".repeat(i)}<${node.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ""}${attrs.length ? " " + attrs.join(" ") : ""}> text="${cleanText(node.textContent).slice(0, 70)}"`
    );
    node = node.parentElement;
  }
  return lines;
}

/** Siblings/children snapshot of the control's field container (2 levels up). */
function containerHtml(el: HTMLElement | undefined): string {
  if (!el) return "";
  let host: HTMLElement = el;
  for (let i = 0; i < 3 && host.parentElement; i++) host = host.parentElement;
  return host.outerHTML.slice(0, 3200);
}

function readActual(control: RuntimeControl | undefined): string {
  if (!control) return "";
  const el = control.el;
  switch (control.controlType) {
    case "select":
      return (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "";
    case "text":
    case "textarea":
      return (el as HTMLInputElement | HTMLTextAreaElement).value;
    case "contenteditable":
      return cleanText(el?.textContent ?? "");
    case "checkbox":
      return (el as HTMLInputElement).checked ? "true" : "";
    case "radioGroup":
      return control.radios?.find((r) => r.checked)?.value ?? "";
    case "checkboxGroup":
      return (control.checkboxes ?? []).filter((c) => c.checked).map((c) => c.value).join(", ");
    case "ariaRadioGroup": {
      const checked = el?.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null;
      return cleanText(checked?.textContent ?? "");
    }
    case "combobox":
    case "customDropdown": {
      const v = el ? readComboboxValue(el) : undefined;
      if (v) return v;
      if (el instanceof HTMLInputElement) return el.value;
      return cleanText(el?.textContent ?? "");
    }
    default:
      return "";
  }
}

export interface LiveFieldDump {
  id: string;
  label: string;
  category: string;
  confidence: number;
  controlType: string;
  required: boolean;
  sensitive: boolean;
  fillable: boolean;
  driver: string | null;
  proposed: string | null;
  options?: string[];
  signals?: Record<string, string>;
  dom?: string[];
}

export interface LiveFillOutcome {
  id: string;
  label: string;
  route: "driver" | "driver-fallback" | "combobox" | "reconciler" | "skipped";
  ok: boolean;
  reason?: string;
  actualAfter: string;
}

async function scan(profile: UserApplicationProfile, fillEEO: boolean): Promise<LiveFieldDump[]> {
  const { fields, registry } = scanPage(profile, fillEEO);
  (window as unknown as Record<string, unknown>).__liveState = { fields, registry, profile };
  return fields.map((f: DetectedField) => {
    const c = registry.get(f.id);
    const el = c?.el ?? c?.radios?.[0] ?? c?.checkboxes?.[0];
    const sig = el ? collectSignals(el) : undefined;
    return {
      id: f.id,
      label: f.label,
      category: f.category,
      confidence: f.confidence,
      controlType: f.controlType,
      required: f.required,
      sensitive: f.sensitive,
      fillable: f.fillable,
      driver: c?.driver ?? null,
      proposed: f.proposedValue,
      options: f.options,
      signals: sig
        ? Object.fromEntries(Object.entries(sig).filter(([, v]) => v).map(([k, v]) => [k, String(v).slice(0, 90)]))
        : undefined,
      dom: el ? outline(el) : undefined,
    };
  });
}

/** Mirror contentScript.fillItems routing for the scanned fields. */
async function fill(): Promise<LiveFillOutcome[]> {
  const state = (window as unknown as Record<string, unknown>).__liveState as
    | { fields: DetectedField[]; registry: Map<string, RuntimeControl> }
    | undefined;
  if (!state) return [];
  const { fields, registry } = state;
  const out: LiveFillOutcome[] = [];
  const targets = fields.filter((f) => f.fillable && f.proposedValue !== null);

  const driverT = targets.filter((f) => registry.get(f.id)?.driver);
  const comboT = targets.filter((f) => !registry.get(f.id)?.driver && registry.get(f.id)?.controlType === "combobox");
  const reconT = targets.filter((f) => !registry.get(f.id)?.driver && registry.get(f.id)?.controlType !== "combobox");

  const engine = new AutofillReconciler({ observe: false });
  const reports = await engine.run(
    reconT.map((f) => ({ fieldId: f.id, value: f.proposedValue as string })),
    registry
  );
  engine.dispose();
  for (const r of reports) {
    const f = reconT.find((x) => x.id === r.fieldId);
    out.push({
      id: r.fieldId,
      label: f?.label ?? "",
      route: "reconciler",
      ok: r.ok,
      reason: r.reason,
      actualAfter: readActual(registry.get(r.fieldId)),
    });
  }

  let seq = 1;
  for (const f of driverT) {
    const c = registry.get(f.id);
    const res = await mwTest.fillField(document, {
      id: seq++,
      fieldId: f.id,
      value: f.proposedValue as string,
      kind: c?.driver as "react-select" | "workday",
    });
    if (res.ok) {
      out.push({ id: f.id, label: f.label, route: "driver", ok: true, actualAfter: readActual(c) });
      continue;
    }
    const fb = c?.el ? await fillAriaCombobox(c.el, f.proposedValue as string, COMBO) : { filled: false, reason: "no element" };
    out.push({
      id: f.id,
      label: f.label,
      route: "driver-fallback",
      ok: fb.filled,
      reason: `driver:${res.reason ?? "?"} → aria:${fb.reason ?? "ok"}`,
      actualAfter: readActual(c),
    });
  }

  for (const f of comboT) {
    const c = registry.get(f.id);
    const res = c?.el
      ? await fillAriaCombobox(c.el, f.proposedValue as string, COMBO)
      : { filled: false, reason: "no element" };
    out.push({
      id: f.id,
      label: f.label,
      route: "combobox",
      ok: res.filled,
      reason: res.reason,
      actualAfter: readActual(c),
    });
  }

  return out;
}

/** Dump the raw container HTML for fields whose label matches `re` (diagnosis). */
function domFor(pattern: string): Array<{ label: string; html: string }> {
  const state = (window as unknown as Record<string, unknown>).__liveState as
    | { fields: DetectedField[]; registry: Map<string, RuntimeControl> }
    | undefined;
  if (!state) return [];
  const re = new RegExp(pattern, "i");
  return state.fields
    .filter((f) => re.test(f.label) || re.test(f.category))
    .map((f) => {
      const c = state.registry.get(f.id);
      const el = c?.el ?? c?.radios?.[0] ?? c?.checkboxes?.[0];
      return { label: `${f.label} [${f.category}/${f.controlType}]`, html: containerHtml(el) };
    });
}

declare global {
  interface Window {
    __LIVE: {
      scan: typeof scan;
      fill: typeof fill;
      domFor: typeof domFor;
      profile: UserApplicationProfile;
    };
  }
}

window.__LIVE = {
  scan,
  fill,
  domFor,
  profile: {
    ...MOCK_PROFILE,
    addressCity: "Ottawa",
    eeo: {
      gender: "Male",
      race: "White",
      hispanicLatino: "No",
      veteranStatus: "I am not a protected veteran",
      disabilityStatus: "No, I do not have a disability",
    },
  } as UserApplicationProfile,
};
