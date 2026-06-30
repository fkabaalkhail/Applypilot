/**
 * Page scanner — finds candidate form controls, groups radios, classifies
 * everything via the field matcher and maintains a registry that maps the
 * serializable field ids (sent to the popup) back to live DOM nodes.
 *
 * Dynamic ATS pages (Workday, Ashby…) re-render constantly, so a debounced
 * MutationObserver triggers rescans. Ids stay stable across rescans because
 * they are stored on the elements themselves (FIELD_ID_ATTR).
 */
import { FIELD_ID_ATTR } from "../shared/constants";
import type { ControlType, DetectedField, UserApplicationProfile } from "../shared/types";
import {
  bestDisplayLabel,
  cleanText,
  collectSignals,
  deepQueryAll,
  isHiddenButLabeled,
  isRequiredField,
  isVisible,
  type FieldSignals,
} from "./domUtils";
import { isCaptchaField } from "./captcha";
import { isConsentField } from "./consent";
import { isAriaCombobox, readComboboxOptions, readComboboxValue } from "./comboboxEngine";
import { classifyField, resolveProfileValue } from "./fieldMatcher";

/** Live handle for a detected field — never leaves the content script. */
export interface RuntimeControl {
  id: string;
  controlType: ControlType;
  /** Single element controls. */
  el?: HTMLElement;
  /** Radio groups: all members, in DOM order. */
  radios?: HTMLInputElement[];
}

export interface ScanResult {
  fields: DetectedField[];
  registry: Map<string, RuntimeControl>;
}

const CANDIDATE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[role="textbox"]',
  // ARIA comboboxes / custom dropdowns (react-select, Headless UI, Workday…).
  // Driven by opening the listbox and clicking an option (see comboboxEngine).
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
].join(", ");

/** Input types that are never application fields. */
const SKIPPED_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "password", // never touch passwords
  "search",
  "range",
  "color",
]);

let idCounter = 0;

/** Stable per-frame token so field ids are unique across iframes. */
export const FRAME_TOKEN = Math.random().toString(36).slice(2, 8);

function ensureFieldId(el: HTMLElement): string {
  let id = el.getAttribute(FIELD_ID_ATTR);
  if (!id) {
    id = `${FRAME_TOKEN}-${idCounter++}`;
    el.setAttribute(FIELD_ID_ATTR, id);
  }
  return id;
}

function controlTypeOf(el: HTMLElement): ControlType | null {
  // ARIA combobox / listbox dropdown — checked first so a react-select
  // <input role="combobox"> is driven by the listbox engine, not typed into,
  // and a Workday <button aria-haspopup="listbox"> is now fillable.
  if (isAriaCombobox(el)) return "combobox";
  if (el instanceof HTMLInputElement) {
    if (SKIPPED_INPUT_TYPES.has(el.type)) return null;
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radioGroup"; // grouped later
    if (el.type === "file") return "file";
    return "text"; // text, email, tel, url, number, date…
  }
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (el.tagName === "BUTTON") return "customDropdown";
  if (el.isContentEditable || el.getAttribute("role") === "textbox") return "contenteditable";
  return null;
}

/** Options for a <select>, trimmed for transport. */
function selectOptions(el: HTMLSelectElement): string[] {
  return Array.from(el.options)
    .map((o) => cleanText(o.textContent))
    .filter((t) => t.length > 0)
    .slice(0, 60);
}

/** The label of one radio button (its own label, value as fallback). */
function radioOptionLabel(radio: HTMLInputElement): string {
  const labels = radio.labels;
  if (labels && labels.length > 0) return cleanText(labels[0].textContent);
  return radio.value || "";
}

/**
 * Signals for a radio group come from its container (fieldset legend,
 * role=radiogroup label) rather than the individual buttons.
 */
function radioGroupSignals(radios: HTMLInputElement[]): FieldSignals {
  const first = radios[0];
  const container = first.closest('fieldset, [role="radiogroup"]');
  let label = "";
  if (container) {
    const legend = container.querySelector("legend");
    label = cleanText(legend?.textContent) || cleanText(container.getAttribute("aria-label"));
    if (!label) {
      const ids = container.getAttribute("aria-labelledby");
      if (ids) {
        label = cleanText(
          ids
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        );
      }
    }
  }
  const base = collectSignals(first);
  return {
    ...base,
    // The group question; individual radio labels ("Yes"/"No") are options.
    label: label || base.nearby,
    placeholder: "",
    typeHint: "",
  };
}

export function scanPage(
  profile: UserApplicationProfile | null,
  fillEEO: boolean
): ScanResult {
  const fields: DetectedField[] = [];
  const registry = new Map<string, RuntimeControl>();

  const candidates = deepQueryAll(document, CANDIDATE_SELECTOR);
  const radioGroups = new Map<string, HTMLInputElement[]>();

  for (const el of candidates) {
    const controlType = controlTypeOf(el);
    if (controlType === null) continue;
    // Never surface or fill a captcha widget's own controls — fill around it.
    if (isCaptchaField(el)) continue;
    // Skip cookie-consent / privacy-banner controls — they are real form
    // controls but never application fields; counting them leaves the panel
    // stuck on a consent dialog when the real form is lazy-mounted.
    if (isConsentField(el)) continue;
    if ((el as HTMLInputElement).disabled) continue;
    if (el instanceof HTMLInputElement && el.readOnly) continue;

    // Visibility: checkbox/radio/file/combobox are often visually hidden behind
    // styled replacements (e.g. react-select's tiny input) but still operable —
    // allow them when labeled.
    const relaxed =
      controlType === "checkbox" ||
      controlType === "radioGroup" ||
      controlType === "file" ||
      controlType === "combobox";
    if (!isVisible(el) && !(relaxed && isHiddenButLabeled(el))) continue;

    if (el instanceof HTMLInputElement && el.type === "radio") {
      const groupKey = `${el.form?.id ?? "noform"}::${el.name || ensureFieldId(el)}`;
      const group = radioGroups.get(groupKey) ?? [];
      group.push(el);
      radioGroups.set(groupKey, group);
      continue; // grouped below
    }

    const id = ensureFieldId(el);
    const signals = collectSignals(el);
    const { category, confidence, sensitive } = classifyField(signals);

    const options =
      el instanceof HTMLSelectElement
        ? selectOptions(el)
        : controlType === "combobox"
          ? readComboboxOptions(el)
          : undefined;

    const control: RuntimeControl = { id, controlType, el };
    registry.set(id, control);

    const proposedValue = profile
      ? resolveProfileValue(category, profile, { controlType, options }, fillEEO)
      : null;

    fields.push({
      id,
      category,
      confidence,
      label: bestDisplayLabel(signals),
      controlType,
      required: isRequiredField(el, signals),
      proposedValue,
      fillable: controlType !== "file" && controlType !== "customDropdown",
      sensitive,
      note: noteFor(controlType, category),
      options,
      currentValue: currentValueOf(el, controlType),
    });
  }

  // Radio groups become a single logical field each.
  for (const radios of radioGroups.values()) {
    const first = radios[0];
    const id = ensureFieldId(first);
    const signals = radioGroupSignals(radios);
    const { category, confidence, sensitive } = classifyField(signals);
    const options = radios.map(radioOptionLabel).filter(Boolean).slice(0, 30);

    registry.set(id, { id, controlType: "radioGroup", radios });

    const proposedValue = profile
      ? resolveProfileValue(category, profile, { controlType: "radioGroup", options }, fillEEO)
      : null;

    const checked = radios.find((r) => r.checked);
    fields.push({
      id,
      category,
      confidence,
      label: bestDisplayLabel(signals),
      controlType: "radioGroup",
      required: radios.some((r) => isRequiredField(r, signals)),
      proposedValue,
      fillable: true,
      sensitive,
      note: noteFor("radioGroup", category),
      options,
      currentValue: checked ? radioOptionLabel(checked) : undefined,
    });
  }

  return { fields, registry };
}

function currentValueOf(el: HTMLElement, controlType: ControlType): string | undefined {
  if (controlType === "select") {
    const sel = el as HTMLSelectElement;
    const opt = sel.selectedOptions[0];
    // Treat a selected placeholder ("Select…", empty value) as empty.
    if (!opt || !opt.value) return undefined;
    return cleanText(opt.textContent) || undefined;
  }
  if (controlType === "checkbox") {
    return (el as HTMLInputElement).checked ? "checked" : undefined;
  }
  if (controlType === "text" || controlType === "textarea") {
    const v = (el as HTMLInputElement | HTMLTextAreaElement).value;
    return v ? v : undefined;
  }
  if (controlType === "contenteditable") {
    const v = cleanText(el.textContent);
    return v ? v : undefined;
  }
  if (controlType === "combobox") {
    return readComboboxValue(el);
  }
  return undefined;
}

function noteFor(controlType: ControlType, category: string): string | undefined {
  if (controlType === "file") {
    return category === "resumeUpload"
      ? "Browser security requires choosing the file manually — click the field and pick your resume."
      : "File uploads must be selected manually.";
  }
  if (controlType === "customDropdown") {
    return "Custom dropdown — please select manually.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dynamic page support
// ---------------------------------------------------------------------------

/**
 * Watch for DOM changes (SPA navigation, multi-step Workday forms) and call
 * back, debounced. Attribute changes are ignored — we cause those ourselves
 * when assigning field ids and flashing highlights.
 */
export function observePage(onChange: () => void): MutationObserver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => m.addedNodes.length > 0 || m.removedNodes.length > 0);
    if (!relevant) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return observer;
}
