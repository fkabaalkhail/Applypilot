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
import type { ControlType, DetectedField, FieldCategory, UserApplicationProfile } from "../shared/types";
import {
  bestDisplayLabel,
  cleanText,
  collectSignals,
  deepQueryAll,
  isHiddenButLabeled,
  isUploadAffordance,
  isRequiredField,
  isVisible,
  nearbyText,
  type FieldSignals,
} from "./domUtils";
import { isCaptchaField } from "./captcha";
import { isConsentField } from "./consent";
import { isInPageChrome } from "./pageChrome";
import { filterToScope, resolveFormScope, type ScopeEntry } from "./formScope";
import { isAriaCombobox, readComboboxOptions, readComboboxValue } from "./comboboxEngine";
import { classifyWithAdapter, resolveAnswerWithAdapter } from "./adapters/apply";
import { resolveCheckboxIntent } from "./checkboxIntent";
import { matchOption } from "./writeEngine";
import { getAdapter } from "./adapters/registry";
import { detectGroupIndex } from "./groupIndex";
import type { SiteAdapter } from "./adapters/types";
import { detectFillDriver } from "./driverDetect";
import type { FillDriver } from "./mainWorldBridge";

/** Live handle for a detected field — never leaves the content script. */
export interface RuntimeControl {
  id: string;
  controlType: ControlType;
  /** Single element controls. */
  el?: HTMLElement;
  /** Radio groups: all members, in DOM order. */
  radios?: HTMLInputElement[];
  /** Native checkbox groups ("select all that apply"): all members, in DOM order. */
  checkboxes?: HTMLInputElement[];
  /** For customDropdown/combobox: which MAIN-world driver fills it, if any. */
  driver?: FillDriver;
  /** A multi-select combobox (skills, multiple locations): its value is a list,
   *  added one chip at a time rather than matched as a single option. */
  multi?: boolean;
}

export interface ScanResult {
  fields: DetectedField[];
  registry: Map<string, RuntimeControl>;
  adapter: SiteAdapter | null;
  /** The resolved application-form container, or null when scoping fell back. */
  scopeEl: HTMLElement | null;
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
  // ARIA radio groups (react-aria / Radix custom radios — Jobvite, etc.): a
  // role=radiogroup whose role=radio children are divs, not native inputs.
  '[role="radiogroup"]',
].join(", ");

/** Input types that are never application fields. `password` is intentionally
 *  NOT here — it is surfaced as an `accountPassword` field, filled only by the
 *  account sub-flow (see controlTypeOf + scanPage below), never generically. */
const SKIPPED_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "search",
  "range",
  "color",
]);

/** Controls whose options are fully known at scan time — a deterministic
 *  profile value that matches none of them can only fail to fill, so it is
 *  dropped and the field routes to the option-aware AI pass. Comboboxes /
 *  custom dropdowns are excluded: they harvest their real options lazily. */
const CONSTRAINED_OPTION_TYPES: ReadonlySet<ControlType> = new Set<ControlType>([
  "select",
  "radioGroup",
  "checkboxGroup",
  "ariaRadioGroup",
]);

/** Null out a proposed value that cannot land in a constrained-option control
 *  (e.g. the applicant's home city into a select of company offices). */
function guardConstrainedOption(
  value: string | null,
  controlType: ControlType,
  options: string[] | undefined
): string | null {
  if (value === null || !CONSTRAINED_OPTION_TYPES.has(controlType)) return value;
  if (!options || options.length === 0) return value;
  return matchOption(options, (o) => o, (o) => o, value) ? value : null;
}

let idCounter = 0;

/** Stable per-frame token so field ids are unique across iframes. */
export const FRAME_TOKEN = Math.random().toString(36).slice(2, 8);

/** Ids assigned in the current scanPage() run — lets ensureFieldId fall back to
 *  a counter when a deterministic id would collide with another live field. */
const assignedThisScan = new Set<string>();

/** Identifiers that carry a volatile per-render instance counter / uuid
 *  (react-select "react-select-3-input", SAP juic "36:_input", uuids) — a
 *  "stable" id built from these would NOT survive a re-render, so we skip them. */
const VOLATILE_ID = /react-select-\d|(^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|^\d+:/i;

/** A re-render-stable identity for `el` (Workday keeps element id / name /
 *  automation-id across step re-renders), or null when it only has volatile ones. */
function stableIdentity(el: HTMLElement): string | null {
  const candidates: Array<[string, string]> = [
    ["id", el.id],
    ["name", el.getAttribute("name") ?? ""],
    ["auto", el.getAttribute("data-automation-id") ?? ""],
  ];
  for (const [kind, value] of candidates) {
    if (value && !VOLATILE_ID.test(value)) return `${kind}=${value}`;
  }
  return null;
}

function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * A per-field id that is STABLE across re-renders. Workday swaps the whole field
 * subtree on every step, so a counter id would change and orphan the reconciler's
 * state as "Field no longer found". Deriving the id from a stable identifier
 * (element id / name / automation-id) makes a replaced element resolve to the
 * same field. Falls back to a counter for fields with no stable identifier (and
 * on the rare collision between two live fields sharing an identifier).
 */
function ensureFieldId(el: HTMLElement): string {
  const existing = el.getAttribute(FIELD_ID_ATTR);
  if (existing) {
    assignedThisScan.add(existing);
    return existing;
  }
  const stable = stableIdentity(el);
  let id = stable ? `${FRAME_TOKEN}-s${hashKey(stable)}` : null;
  if (!id || assignedThisScan.has(id)) id = `${FRAME_TOKEN}-${idCounter++}`;
  assignedThisScan.add(id);
  el.setAttribute(FIELD_ID_ATTR, id);
  return id;
}

function controlTypeOf(el: HTMLElement): ControlType | null {
  // ARIA combobox / listbox dropdown — checked first so a react-select
  // <input role="combobox"> is driven by the listbox engine, not typed into,
  // and a Workday <button aria-haspopup="listbox"> is now fillable.
  if (isAriaCombobox(el)) return "combobox";
  // ARIA radio group (role=radio children clicked to select) — checked before the
  // generic element fallbacks so it is driven as a choice control, not skipped.
  if (el.getAttribute("role") === "radiogroup") return "ariaRadioGroup";
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return "password"; // account sub-flow only
    if (SKIPPED_INPUT_TYPES.has(el.type)) return null;
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radioGroup"; // grouped later
    if (el.type === "file") return "file";
    // Workday's multiselect/typeahead trigger (e.g. Country Phone Code) is a bare
    // <input> with NO role=combobox / aria-haspopup — its widget type lives only
    // in data-uxi-widget-type="selectinput". Drive it through the listbox engine
    // instead of typing the value into what is actually a search box.
    if (el.getAttribute("data-uxi-widget-type") === "selectinput") return "combobox";
    return "text"; // text, email, tel, url, number, date…
  }
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (el.tagName === "BUTTON") return "customDropdown";
  if (el.isContentEditable || el.getAttribute("role") === "textbox") return "contenteditable";
  return null;
}

/** Options for a <select>, trimmed for transport. Exported for the Phase-2
 *  re-ask pass, which re-reads options after dependent-dropdown repopulation. */
export function selectOptions(el: HTMLSelectElement): string[] {
  return Array.from(el.options)
    .map((o) => cleanText(o.textContent))
    .filter((t) => t.length > 0)
    .slice(0, 60);
}

/** Option labels of an ARIA radio group (its role=radio children). */
function ariaRadioOptions(group: HTMLElement): string[] {
  return Array.from(group.querySelectorAll('[role="radio"]'))
    .map((r) => cleanText(r.getAttribute("aria-label")) || cleanText(r.textContent))
    .filter((t) => t.length > 0)
    .slice(0, 30);
}

/** The label of one radio button (its own label, value as fallback). */
function radioOptionLabel(radio: HTMLInputElement): string {
  const labels = radio.labels;
  if (labels && labels.length > 0) return cleanText(labels[0].textContent);
  return radio.value || "";
}

/**
 * Signals for a group come from its container (fieldset legend, role=group/
 * radiogroup label, or — for a container with none of those — the heading text
 * immediately before it) rather than the individual buttons.
 */
function groupSignals(members: HTMLInputElement[], container: Element | null): FieldSignals {
  const first = members[0];
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
    // No semantic label: a plain-<div> group's question is usually the heading
    // text right before the option list (the container itself, not the first
    // option, since the first option has no useful "previous sibling" text).
    if (!label) label = nearbyText(container as HTMLElement);
  }
  const base = collectSignals(first);
  return {
    ...base,
    // The group question; individual radio/checkbox labels ("Yes"/"LinkedIn") are options.
    label: label || base.nearby,
    placeholder: "",
    typeHint: "",
  };
}

/** Form-field types other than checkboxes — finding one inside a candidate
 *  checkbox-group container means we've climbed past the group's natural
 *  boundary into an unrelated section. */
const OTHER_FIELD_SELECTOR =
  'input:not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

/** Never accepted as a checkbox-group container even if it would otherwise qualify. */
const CONTAINER_CLIMB_BOUNDARY = new Set(["FORM", "BODY", "HTML"]);

/**
 * The smallest enclosing container for a "select all that apply" checkbox
 * cluster. Prefers an explicit `fieldset`/`[role=group]`; most real ATS render
 * the same pattern with plain `<div>`s instead, so fall back to the closest
 * ancestor (within a few levels, never the form/body/page itself) that encloses
 * ≥2 checkboxes and no unrelated field — the natural list boundary.
 */
function checkboxGroupContainer(el: HTMLInputElement): Element | null {
  const explicit = el.closest('fieldset, [role="group"]');
  if (explicit && explicit.querySelectorAll('input[type="checkbox"]').length >= 2) {
    return explicit;
  }
  let node: Element | null = el.closest("label") ?? el.parentElement;
  for (let depth = 0; depth < 5 && node && !CONTAINER_CLIMB_BOUNDARY.has(node.tagName); depth++) {
    if (
      node.querySelectorAll('input[type="checkbox"]').length >= 2 &&
      node.querySelectorAll(OTHER_FIELD_SELECTOR).length === 0
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

const UPLOAD_VERB_RE = /\b(upload|attach|add|choose|browse|select|drag)\b/i;
const RESUME_NOUN_RE = /\b(resume|r[ée]sum[ée]|cv|curriculum\s*vitae)\b/i;
const COVER_NOUN_RE = /\bcover\s*letter\b/i;

/** Accessible name of a clickable: aria-label, else the joined text of its
 *  aria-labelledby targets, else its own text. Capped for sanity. */
function accessibleNameOf(el: HTMLElement): string {
  const aria = cleanText(el.getAttribute("aria-label"));
  if (aria) return aria;
  const ids = el.getAttribute("aria-labelledby");
  if (ids) {
    const doc = el.ownerDocument;
    const txt = ids
      .split(/\s+/)
      .map((id) => cleanText(doc.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (txt) return txt;
  }
  return cleanText(el.textContent);
}

/**
 * Custom (non-`<input>`) résumé / cover-letter upload widgets. Some ATS — SAP
 * SuccessFactors most notably — render the upload as a `<div role="button">Upload
 * a Resume</div>` that opens a file dialog, with no scannable `<input type=file>`.
 * The generic loop never sees these (a role=button div isn't a form control), so
 * the panel reported "no résumé field" and its Attach button stayed disabled.
 *
 * This detects at most one widget per category, requiring BOTH an upload verb and
 * a résumé/cover noun in the accessible name so ordinary buttons never match, and
 * skips a category a native file input already covers (no duplicates). Emitted as
 * a `file` control the panel's Attach flow already understands. `deepQueryAll`
 * excludes our own panel, so its "Attach"/"Generate Custom Resume" buttons can't
 * be mistaken for a page field.
 */
function scanCustomUploads(fields: DetectedField[], registry: Map<string, RuntimeControl>): void {
  const covered = new Set<FieldCategory>(
    fields.filter((f) => f.controlType === "file").map((f) => f.category)
  );
  const seenWidgets = new Set<Element>();
  for (const el of deepQueryAll(document, '[role="button"], button')) {
    const name = accessibleNameOf(el);
    if (!name || name.length > 120 || !UPLOAD_VERB_RE.test(name)) continue;
    const category: FieldCategory | null = COVER_NOUN_RE.test(name)
      ? "coverLetter"
      : RESUME_NOUN_RE.test(name)
        ? "resumeUpload"
        : null;
    if (!category || covered.has(category)) continue;
    // One field per widget: SF renders several role=button parts (icon + label).
    const widget = el.closest('[class*="attach" i], [class*="upload" i], [class*="dropzone" i]') ?? el;
    if (seenWidgets.has(widget)) continue;
    seenWidgets.add(widget);
    covered.add(category);
    const id = ensureFieldId(el);
    registry.set(id, { id, controlType: "file", el });
    fields.push({
      id,
      category,
      confidence: 0.9,
      label: name.slice(0, 80),
      controlType: "file",
      required: false,
      proposedValue: null,
      fillable: false,
      sensitive: false,
      note: noteFor("file", category),
      currentValue: undefined,
    });
  }
}

const REPEAT_CATEGORIES: ReadonlyArray<ReadonlySet<FieldCategory>> = [
  new Set<FieldCategory>(["currentCompany", "currentTitle"]),
  new Set<FieldCategory>(["school", "degree", "graduationYear"]),
];

/**
 * Remap repeating-section rows to 0-based POSITIONAL indices and re-resolve.
 * Workday numbers work-experience rows with an arbitrary instance id
 * ("workExperience-8--jobTitle"), so a field parsed as groupIndex 8 would read
 * profile.experience[8] (undefined) and never fill. Ranking the distinct raw
 * indices maps 8 → 0 and {8,12} → {0,1}, while a standard experience[0]/[1] form
 * is left unchanged.
 */
function remapRepeatingRows(
  fields: DetectedField[],
  registry: Map<string, RuntimeControl>,
  profile: UserApplicationProfile | null,
  adapter: SiteAdapter | null,
  fillEEO: boolean
): void {
  if (!profile) return;
  for (const cats of REPEAT_CATEGORIES) {
    const rowFields = fields.filter((f) => cats.has(f.category) && f.groupIndex != null);
    if (rowFields.length === 0) continue;
    const distinct = [...new Set(rowFields.map((f) => f.groupIndex as number))].sort((a, b) => a - b);
    if (distinct.length === 1 && distinct[0] === 0) continue; // already positional
    const posOf = new Map(distinct.map((raw, i) => [raw, i] as const));
    for (const f of rowFields) {
      const pos = posOf.get(f.groupIndex as number) ?? 0;
      if (pos === f.groupIndex) continue;
      f.groupIndex = pos;
      const control = registry.get(f.id);
      if (!control?.el) continue;
      f.proposedValue = guardConstrainedOption(
        resolveAnswerWithAdapter(
          adapter,
          f.category,
          profile,
          { controlType: f.controlType, options: f.options, groupIndex: pos },
          fillEEO,
          control.el
        ),
        f.controlType,
        f.options
      );
    }
  }
}

export function scanPage(
  profile: UserApplicationProfile | null,
  fillEEO: boolean,
  adapter: SiteAdapter | null = getAdapter(location.hostname, location.href)
): ScanResult {
  const fields: DetectedField[] = [];
  const registry = new Map<string, RuntimeControl>();
  assignedThisScan.clear();

  const candidates = deepQueryAll(document, CANDIDATE_SELECTOR);
  const radioGroups = new Map<string, HTMLInputElement[]>();
  const checkboxGroups = new Map<Element, HTMLInputElement[]>();

  for (const el of candidates) {
    const controlType = controlTypeOf(el);
    if (controlType === null) continue;
    // Never surface or fill a captcha widget's own controls — fill around it.
    if (isCaptchaField(el)) continue;
    // Skip cookie-consent / privacy-banner controls — they are real form
    // controls but never application fields; counting them leaves the panel
    // stuck on a consent dialog when the real form is lazy-mounted.
    if (isConsentField(el)) continue;
    // Page chrome (header/nav/footer/aside and landmark roles) is never part
    // of the application form — an EN/FR switcher is a real <select> we skip.
    if (isInPageChrome(el)) continue;
    if ((el as HTMLInputElement).disabled) continue;
    if (el instanceof HTMLInputElement && el.readOnly) continue;

    // Visibility: checkbox/radio/file are often visually hidden behind styled
    // replacements but still operable — allow them when labeled. Comboboxes get
    // NO relaxation: an invisible combobox is not user-operable (react-select's
    // real input is small but rendered; what hides fully is other widgets'
    // internals, e.g. intl-tel-input's dial-code search inside a closed dialog).
    const relaxed =
      controlType === "checkbox" ||
      controlType === "radioGroup" ||
      controlType === "file";
    if (!isVisible(el) && !(relaxed && (isHiddenButLabeled(el) || isUploadAffordance(el)))) continue;
    // A control inside aria-hidden markup is by definition not part of the form
    // the user sees (react-select's `<input required>` validation twin, screen-
    // reader-excluded duplicates). Styled-replacement natives (checkbox/radio/
    // file) legitimately carry aria-hidden, so only strict types are skipped.
    if (!relaxed && el.closest('[aria-hidden="true"]')) continue;

    if (el instanceof HTMLInputElement && el.type === "radio") {
      const groupKey = `${el.form?.id ?? "noform"}::${el.name || ensureFieldId(el)}`;
      const group = radioGroups.get(groupKey) ?? [];
      group.push(el);
      radioGroups.set(groupKey, group);
      continue; // grouped below
    }

    // "Select all that apply": checkboxes sharing a natural group container
    // (fieldset/[role=group], or the closest plain-<div> ancestor enclosing
    // ≥2 of them and nothing else) are one multi-select field. A standalone
    // checkbox (no such container, or only one inside it) falls through to
    // the single-control path.
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      const container = checkboxGroupContainer(el);
      if (container) {
        const group = checkboxGroups.get(container) ?? [];
        group.push(el);
        checkboxGroups.set(container, group);
        continue; // emitted as one checkboxGroup below
      }
    }

    const id = ensureFieldId(el);
    const signals = collectSignals(el);

    // Passwords: registry-tracked for the account sub-flow, but never listed
    // as a generic field, never fillable generically, never sent to the AI —
    // and the value is never echoed into the serializable field.
    if (controlType === "password") {
      registry.set(id, { id, controlType, el });
      fields.push({
        id,
        category: "accountPassword",
        confidence: 1,
        label: bestDisplayLabel(signals),
        controlType,
        required: isRequiredField(el, signals),
        proposedValue: null,
        fillable: false,
        sensitive: false,
        note: "Handled by the account sign-up flow.",
        currentValue: (el as HTMLInputElement).value ? "filled" : undefined,
      });
      continue;
    }

    const groupIndex = detectGroupIndex(signals);
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el, signals, controlType });

    const options =
      el instanceof HTMLSelectElement
        ? selectOptions(el)
        : controlType === "combobox"
          ? readComboboxOptions(el)
          : controlType === "ariaRadioGroup"
            ? ariaRadioOptions(el)
            : undefined;

    const driver =
      controlType === "combobox" || controlType === "customDropdown"
        ? detectFillDriver(el) ?? undefined
        : undefined;
    // A skills combobox is multi-value ("Type to Add Skills"): the engine adds
    // one chip per skill rather than matching the joined list as one option.
    const multi =
      controlType === "combobox" &&
      (category === "skills" || el.getAttribute("aria-multiselectable") === "true");
    const control: RuntimeControl = { id, controlType, el, driver, multi };
    registry.set(id, control);

    const label = bestDisplayLabel(signals);
    let proposedValue = guardConstrainedOption(
      resolveAnswerWithAdapter(adapter, category, profile, { controlType, options, groupIndex }, fillEEO, el),
      controlType,
      options
    );
    // A single checkbox is a boolean control: never write a text value into it.
    // Check clear application consent, skip marketing / ambiguous boxes (→ null,
    // so they're simply not selected rather than counted as failures).
    if (controlType === "checkbox") {
      proposedValue = resolveCheckboxIntent(`${label} ${signals.nearby ?? ""}`, proposedValue);
    }

    fields.push({
      id,
      category,
      confidence,
      label,
      controlType,
      required: isRequiredField(el, signals),
      proposedValue,
      fillable:
        driver !== undefined ||
        (controlType !== "file" && controlType !== "customDropdown"),
      sensitive,
      note: noteFor(controlType, category),
      options,
      helpText: signals.nearby,
      inputType: signals.typeHint,
      groupIndex,
      currentValue: currentValueOf(el, controlType),
    });
  }

  // Radio groups become a single logical field each.
  for (const radios of radioGroups.values()) {
    const first = radios[0];
    const id = ensureFieldId(first);
    const signals = groupSignals(radios, first.closest('fieldset, [role="radiogroup"]'));
    const groupIndex = detectGroupIndex(signals);
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el: first, signals, controlType: "radioGroup" });
    const options = radios.map(radioOptionLabel).filter(Boolean).slice(0, 30);

    registry.set(id, { id, controlType: "radioGroup", radios });

    const proposedValue = guardConstrainedOption(
      resolveAnswerWithAdapter(adapter, category, profile, { controlType: "radioGroup", options, groupIndex }, fillEEO, first),
      "radioGroup",
      options
    );

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
      helpText: signals.nearby,
      inputType: signals.typeHint,
      groupIndex,
      currentValue: checked ? radioOptionLabel(checked) : undefined,
    });
  }

  // Native checkbox groups ("select all that apply") — one logical multi-select
  // field each, classified by the group question (not the option text).
  for (const [container, checkboxes] of checkboxGroups.entries()) {
    const first = checkboxes[0];
    const id = ensureFieldId(first);
    const signals = groupSignals(checkboxes, container);
    const groupIndex = detectGroupIndex(signals);
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el: first, signals, controlType: "checkboxGroup" });
    const options = checkboxes.map(radioOptionLabel).filter(Boolean).slice(0, 30);

    registry.set(id, { id, controlType: "checkboxGroup", checkboxes });

    const proposedValue = guardConstrainedOption(
      resolveAnswerWithAdapter(adapter, category, profile, { controlType: "checkboxGroup", options, groupIndex }, fillEEO, first),
      "checkboxGroup",
      options
    );

    const checkedLabels = checkboxes.filter((c) => c.checked).map(radioOptionLabel).filter(Boolean);
    fields.push({
      id,
      category,
      confidence,
      label: bestDisplayLabel(signals),
      controlType: "checkboxGroup",
      required: checkboxes.some((c) => isRequiredField(c, signals)),
      proposedValue,
      fillable: true,
      sensitive,
      note: noteFor("checkboxGroup", category),
      options,
      helpText: signals.nearby,
      inputType: signals.typeHint,
      groupIndex,
      currentValue: checkedLabels.length ? checkedLabels.join(", ") : undefined,
    });
  }

  // Custom (non-<input>) résumé / cover-letter upload widgets (SuccessFactors).
  scanCustomUploads(fields, registry);

  // Repeating-section rows → positional indices (Workday's instance-numbered rows).
  remapRepeatingRows(fields, registry, profile, adapter, fillEEO);

  // Scope to the application-form container; anything outside is noise even
  // when its category is known. No qualifying container → unscoped fallback.
  const entries: ScopeEntry[] = fields.flatMap((f) => {
    const c = registry.get(f.id);
    const el = c?.el ?? c?.radios?.[0] ?? c?.checkboxes?.[0];
    return el ? [{ field: f, el }] : [];
  });
  const scopeEl = resolveFormScope(entries);
  if (!scopeEl) return { fields, registry, adapter, scopeEl: null };
  const keep = new Set(filterToScope(entries, scopeEl).map((e) => e.field.id));
  const scoped = fields.filter((f) => keep.has(f.id));
  for (const f of fields) if (!keep.has(f.id)) registry.delete(f.id);
  return { fields: scoped, registry, adapter, scopeEl };
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
  if (controlType === "ariaRadioGroup") {
    const checked = el.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null;
    if (!checked) return undefined;
    return (cleanText(checked.getAttribute("aria-label")) || cleanText(checked.textContent)) || undefined;
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
