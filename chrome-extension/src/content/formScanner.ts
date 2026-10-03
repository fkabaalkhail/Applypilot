/**
 * Page scanner: finds candidate form controls, groups radios, classifies
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
  EXTENSION_UI_HOST_IDS,
  isHiddenButLabeled,
  isPlaceholderFiller,
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
import { resolveField, snapToOption, type FieldResolution } from "./fieldResolver";
import { splitGreenhouseDate } from "./adapters/greenhouse";
import { graduationOfRow, profileFacts } from "./profileFacts";
import { isConsentText, resolveCheckboxIntent } from "./checkboxIntent";
import { matchOption } from "./writeEngine";
import { getAdapter } from "./adapters/registry";
import { detectGroupIndex } from "./groupIndex";
import type { SiteAdapter } from "./adapters/types";
import { detectFillDriver } from "./driverDetect";
import { DATE_PART_ID_SELECTOR } from "./adapters/workdaySelectors";
import type { FillDriver } from "./mainWorldBridge";

/** Live handle for a detected field, never leaves the content script. */
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
  // ARIA radio groups (react-aria / Radix custom radios, Jobvite, etc.): a
  // role=radiogroup whose role=radio children are divs, not native inputs.
  '[role="radiogroup"]',
].join(", ");

/** Input types that are never application fields. `password` is intentionally
 *  NOT here: it is surfaced as an `accountPassword` field, filled only by the
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

/** Controls whose options are fully known at scan time, a deterministic
 *  profile value that matches none of them can only fail to fill, so it is
 *  dropped and the field routes to the option-aware AI pass. Comboboxes /
 *  custom dropdowns are excluded: they harvest their real options lazily. */
const CONSTRAINED_OPTION_TYPES: ReadonlySet<ControlType> = new Set<ControlType>([
  "select",
  "radioGroup",
  "checkboxGroup",
  "ariaRadioGroup",
]);

/** The DetectedField flags a resolution sets (absent when false, so field
 *  snapshots in existing tests and telemetry stay unchanged). */
function resolutionFlags(
  r: FieldResolution
): Pick<DetectedField, "deterministic" | "deviceAbstained" | "answerKind" | "dateFormat"> {
  return {
    ...(r.source === "question" && r.value !== null ? { deterministic: true } : {}),
    ...(r.deviceAbstained ? { deviceAbstained: true } : {}),
    answerKind: r.kind,
    ...(r.dateFormat ? { dateFormat: r.dateFormat } : {}),
  };
}

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

/** Ids assigned in the current scanPage() run, lets ensureFieldId fall back to
 *  a counter when a deterministic id would collide with another live field. */
const assignedThisScan = new Set<string>();

/** Identifiers that carry a volatile per-render instance counter / uuid
 *  (react-select "react-select-3-input", SAP juic "36:_input", uuids), a
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
  // ARIA combobox / listbox dropdown, checked first so a react-select
  // <input role="combobox"> is driven by the listbox engine, not typed into,
  // and a Workday <button aria-haspopup="listbox"> is now fillable.
  if (isAriaCombobox(el)) return "combobox";
  // ARIA radio group (role=radio children clicked to select), checked before the
  // generic element fallbacks so it is driven as a choice control, not skipped.
  if (el.getAttribute("role") === "radiogroup") return "ariaRadioGroup";
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return "password"; // account sub-flow only
    if (SKIPPED_INPUT_TYPES.has(el.type)) return null;
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radioGroup"; // grouped later
    if (el.type === "file") return "file";
    // Workday's multiselect/typeahead trigger (e.g. Country Phone Code) is a bare
    // <input> with NO role=combobox / aria-haspopup, its widget type lives only
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
export function selectOptions(el: HTMLSelectElement, limit = 60): string[] {
  return Array.from(el.options)
    .map((o) => cleanText(o.textContent))
    .filter((t) => t.length > 0)
    .slice(0, limit);
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
 * The question of an option group that has no fieldset/radiogroup container:
 * climb from the options' common ancestor and take the first text that sits
 * OUTSIDE the options, the block's question.
 *
 * Lever renders every custom radio question as
 *   <li class="application-question"><div class="application-label">Question?</div>
 *     <div class="application-field"><ul><li><label><input type=radio>Yes</label></li>…
 * where nearbyText from the first radio climbs three levels of empty siblings
 * and gives up, so the group was labelled with its input's NAME
 * ("cards[f6189244-…][field0]") and never recognized: "Are you legally able to
 * work in Canada?" and the years-of-experience buckets went unanswered (live,
 * 2026-10-03).
 */
function questionAboveOptions(members: HTMLInputElement[]): string {
  if (members.length === 0) return "";
  let common: HTMLElement | null = members[0].parentElement;
  while (common && !members.every((m) => common!.contains(m))) common = common.parentElement;
  const optionText = new Set(members.map((m) => cleanText(radioOptionLabel(m))).filter(Boolean));
  for (let node = common, depth = 0; node && depth < 5 && !CONTAINER_CLIMB_BOUNDARY.has(node.tagName); node = node.parentElement, depth++) {
    let text = "";
    for (const child of Array.from(node.children)) {
      if (members.some((m) => child.contains(m))) continue;
      if (child.querySelector(OTHER_FIELD_SELECTOR) || child.matches(OTHER_FIELD_SELECTOR)) continue;
      text += ` ${child.textContent ?? ""}`;
    }
    const t = cleanText(text);
    if (t && t.length <= 300 && !optionText.has(t) && !isPlaceholderFiller(t)) return t;
    // Another control's block: stop before borrowing a neighbour's question.
    if (node.parentElement && Array.from(node.parentElement.querySelectorAll(OTHER_FIELD_SELECTOR)).some((c) => !members.includes(c as HTMLInputElement) && !node!.contains(c))) {
      break;
    }
  }
  return "";
}

/**
 * Signals for a group come from its container (fieldset legend, role=group/
 * radiogroup label, or (for a container with none of those) the heading text
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
    // A <label> inside the group that labels none of its options is the
    // group's question. Ashby renders every radio question this way:
    // <fieldset><label for="<question id>">Question</label> + options, with no
    // <legend>. Without this the label fell through to nearbyText(container),
    // the text BEFORE the fieldset, which is the PREVIOUS question: "Do you
    // think AI will take over the world?" was classified as a work-authorization
    // question and answered "Yes" (live, 2026-10-03).
    if (!label) {
      const optionLabels = new Set<Element>();
      for (const m of members) for (const l of Array.from(m.labels ?? [])) optionLabels.add(l);
      const heading = Array.from(container.querySelectorAll("label")).find(
        (l) => !optionLabels.has(l) && !l.querySelector("input, select, textarea") && cleanText(l.textContent)
      );
      if (heading) label = cleanText(heading.textContent);
    }
    // No semantic label: a plain-<div> group's question is usually the heading
    // text right before the option list (the container itself, not the first
    // option, since the first option has no useful "previous sibling" text).
    if (!label) label = nearbyText(container as HTMLElement);
  } else {
    label = questionAboveOptions(members);
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

/**
 * A native <select> enhanced by select2 / chosen: hidden (and often
 * aria-hidden), mirrored by a styled proxy. Lever's university picker is one
 * (live 2026-10-03): the scanner skipped the hidden select and fought the proxy,
 * so "What Post-Secondary institution do you attend?" stayed blank.
 */
function isEnhancedSelect(el: HTMLElement): boolean {
  if (!(el instanceof HTMLSelectElement)) return false;
  if (el.classList.contains("select2-hidden-accessible")) return true;
  const next = el.nextElementSibling;
  return Boolean(next && /\b(select2-container|chosen-container)\b/.test(next.getAttribute("class") ?? ""));
}

/** The styled proxy of an enhanced select, or its open dropdown/search box. */
function isEnhancedSelectProxy(el: HTMLElement): boolean {
  if (el.closest(".select2-dropdown, .chosen-drop")) return true;
  const container = el.closest(".select2-container, .chosen-container");
  if (!container) return false;
  const prev = container.previousElementSibling;
  return prev instanceof HTMLSelectElement && isEnhancedSelect(prev);
}

/**
 * Keys for radios that carry no `name`: the smallest container holding two or
 * more radios and no other kind of field (a fieldset / radiogroup when there is
 * one). One key per container, so its radios form one question.
 */
function namelessRadioKeys(): { keyFor(el: HTMLInputElement): string | null } {
  const keys = new Map<Element, string>();
  let n = 0;
  const otherField = 'input:not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';
  return {
    keyFor(el: HTMLInputElement): string | null {
      let container: Element | null = el.closest('fieldset, [role="radiogroup"]');
      if (!container || container.querySelectorAll('input[type="radio"]').length < 2) {
        container = null;
        let node: Element | null = el.closest("label") ?? el.parentElement;
        for (let depth = 0; depth < 5 && node && !CONTAINER_CLIMB_BOUNDARY.has(node.tagName); depth++) {
          if (node.querySelectorAll('input[type="radio"]').length >= 2) {
            if (node.querySelectorAll(otherField).length === 0) container = node;
            break;
          }
          node = node.parentElement;
        }
      }
      if (!container) return null;
      let key = keys.get(container);
      if (!key) {
        key = `nameless-${n++}`;
        keys.set(container, key);
      }
      return key;
    },
  };
}

/** Form-field types other than checkboxes, finding one inside a candidate
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
 * ≥2 checkboxes and no unrelated field, the natural list boundary.
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
 * Custom (non-`<input>`) résumé / cover-letter upload widgets. Some ATS, SAP
 * SuccessFactors most notably: render the upload as a `<div role="button">Upload
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
  new Set<FieldCategory>([
    "currentCompany",
    "currentTitle",
    "experienceStartDate",
    "experienceEndDate",
    "experienceDescription",
    "experienceCurrent",
  ]),
  new Set<FieldCategory>(["school", "degree", "fieldOfStudy", "graduationYear"]),
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
      // Every option, not the panel's capped copy (see scanPage).
      const allOptions = control.el instanceof HTMLSelectElement ? selectOptions(control.el, Infinity) : f.options;
      f.proposedValue = guardConstrainedOption(
        resolveAnswerWithAdapter(
          adapter,
          f.category,
          profile,
          { controlType: f.controlType, options: allOptions, groupIndex: pos },
          fillEEO,
          control.el
        ),
        f.controlType,
        allOptions
      );
    }
  }
}

const BARE_ADDRESS = /^[\W\d]*(home |mailing |street |current |residential |permanent )?address( line)?( ?1)?[\W]*$/i;

/**
 * "Address" alone classifies as the generic `location` (a one-line "where do
 * you live"), which is right on a form with no other location fields. On a form
 * that ALSO asks City or Postal code separately it means the street line:
 * BambooHR got "Toronto, ON, Canada" in Address and City both (live,
 * 2026-10-03). Re-resolved as addressStreet, which fills only a real street.
 */
function reclassifyBareAddress(
  fields: DetectedField[],
  registry: Map<string, RuntimeControl>,
  profile: UserApplicationProfile | null,
  adapter: SiteAdapter | null,
  fillEEO: boolean
): void {
  const hasParts = fields.some((f) => f.category === "addressCity" || f.category === "postalCode");
  if (!hasParts) return;
  for (const f of fields) {
    if (f.category !== "location" || !BARE_ADDRESS.test(f.label.trim())) continue;
    const el = registry.get(f.id)?.el;
    if (!el) continue;
    f.category = "addressStreet";
    const resolved = resolveField({
      adapter,
      category: "addressStreet",
      sensitive: false,
      profile,
      control: { controlType: f.controlType, options: f.options, groupIndex: f.groupIndex ?? null },
      fillEEO,
      el,
      label: f.label,
      signals: collectSignals(el),
    });
    f.proposedValue = resolved.value;
  }
}

/** Inside an EDUCATION block (class / id / automation-id), and not first inside
 *  an employment one. A wrapper naming both says nothing: Greenhouse's older
 *  boards put EMPLOYMENT rows in `.education-experience-block` (Lyft). */
function inEducationBlock(el: HTMLElement): boolean {
  for (let a = el.parentElement, i = 0; a && i < 8; a = a.parentElement, i++) {
    const marks = `${a.id} ${typeof a.className === "string" ? a.className : ""} ${a.getAttribute("data-automation-id") ?? ""}`;
    const edu = /education/i.test(marks);
    const work = /employment|experience|work-?history/i.test(marks);
    if (edu !== work) return edu;
  }
  return false;
}

/**
 * A row date inside an EDUCATION block is the school's date, not a job's.
 * Greenhouse's education block has its own "Start date month / year" and "End
 * date month / year" (`.education--date-container`, ids `start-month--0`): they
 * classify as experience dates and were filled with the first JOB's dates
 * (Twitch, Astranis, live 2026-10-03). The end date is the graduation, split
 * into the month and year controls the way Greenhouse renders them (a bare
 * year leaves the month blank; the expected graduation month fills it); the
 * profile has no education start date, so a start date gets nothing. Ashby's
 * month and year selects carry no name of their own: their options tell them
 * apart. "Still Student?" is ticked for a degree still in progress.
 */
function reclassifyEducationRowDates(
  fields: DetectedField[],
  registry: Map<string, RuntimeControl>,
  profile: UserApplicationProfile | null
): void {
  for (const f of fields) {
    const control = registry.get(f.id);
    const el = control?.el ?? control?.checkboxes?.[0] ?? null;
    if (f.controlType === "checkbox" && el && profile && STILL_STUDENT.test(f.label) && inEducationBlock(el)) {
      const entry = profileFacts(profile).education.entries[f.groupIndex ?? 0];
      f.proposedValue = entry?.completed === false ? "yes" : entry?.completed === true ? "no" : null;
      // Computed from the profile, so selected on its own evidence: the label
      // classifies weakly, and the box was never filled (Ramp, live 2026-10-03).
      if (f.proposedValue !== null) f.deterministic = true;
      continue;
    }
    if (f.category !== "experienceStartDate" && f.category !== "experienceEndDate") continue;
    if (!el || !inEducationBlock(el)) continue;
    const isEnd = f.category === "experienceEndDate";
    f.category = isEnd ? "graduationYear" : "unknown";
    f.proposedValue = null;
    if (!isEnd || !profile) continue;
    const grad = splitGreenhouseDate(graduationOfRow(profile, f.groupIndex ?? 0));
    if (!grad) continue;
    const key = `${el.id} ${el.getAttribute("name") ?? ""} ${f.label}`.toLowerCase();
    const part = /month/.test(key) ? "month" : /year/.test(key) ? "year" : datePartOfOptions(f.options);
    const value = part === "month" ? grad.month : part === "year" ? grad.year : "";
    if (!value) continue;
    f.proposedValue = f.options && f.options.length ? snapToOption(f.options, value, "graduationYear") : value;
  }
}

/** "Still Student?", "Currently attending": the education row is in progress. */
const STILL_STUDENT = /\bstill (a )?student\b|\bcurrent(ly)? (a )?student\b|\bcurrently (attending|enrolled|studying)\b|\bin progress\b/i;

const MONTH_OPTION = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
/** A select that names no part: twelve months, or a run of years. */
function datePartOfOptions(options: string[] | undefined): "month" | "year" | "" {
  const opts = (options ?? []).map((o) => o.trim()).filter(Boolean);
  if (opts.filter((o) => MONTH_OPTION.test(o)).length >= 12) return "month";
  if (opts.filter((o) => /^(19|20)\d{2}$/.test(o)).length >= 3) return "year";
  return "";
}

/**
 * A field resolved again now that its widget's REAL options are known. A
 * react-select mounts its list only when opened, so at scan time a question
 * whose answer depends on the options ("Yes, I'd relocate prior to the start"
 * vs "Yes, I'm currently located here"; which channel "How did you hear" offers)
 * can only propose a generic value. With the options it resolves on device, to
 * an exact option, instead of waiting for the AI (Brex, live 2026-10-03).
 */
export function resolveWithOptions(
  field: DetectedField,
  registry: Map<string, RuntimeControl>,
  profile: UserApplicationProfile | null,
  adapter: SiteAdapter | null,
  fillEEO: boolean,
  options: string[]
): string | null {
  const control = registry.get(field.id);
  const el = control?.el ?? control?.radios?.[0] ?? control?.checkboxes?.[0];
  if (!el || !profile || options.length === 0) return null;
  const resolved = resolveField({
    adapter,
    category: field.category,
    sensitive: field.sensitive,
    profile,
    control: { controlType: field.controlType, options, groupIndex: field.groupIndex ?? null, multi: control?.multi },
    fillEEO,
    el,
    label: field.label,
    signals: collectSignals(el),
  });
  return resolved.value;
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
  const nameless = namelessRadioKeys();
  const checkboxGroups = new Map<Element, HTMLInputElement[]>();

  for (const el of candidates) {
    const controlType = controlTypeOf(el);
    if (controlType === null) continue;
    // A role=radiogroup that only WRAPS native radios (Material UI renders two
    // such wrappers per question) is presentation: the native group is the
    // control. Scanned as an ARIA group it had no options and logged a failed
    // fill beside the native group that filled (BambooHR, live 2026-10-03).
    if (controlType === "ariaRadioGroup" && el.querySelector('input[type="radio"]') && !el.querySelector('[role="radio"]')) {
      continue;
    }
    // Never surface or fill a captcha widget's own controls, fill around it.
    if (isCaptchaField(el)) continue;
    // Skip cookie-consent / privacy-banner controls. They are real form
    // controls but never application fields; counting them leaves the panel
    // stuck on a consent dialog when the real form is lazy-mounted.
    if (isConsentField(el)) continue;
    // Page chrome (header/nav/footer/aside and landmark roles) is never part
    // of the application form, an EN/FR switcher is a real <select> we skip.
    if (isInPageChrome(el)) continue;
    if ((el as HTMLInputElement).disabled) continue;
    if (el instanceof HTMLInputElement && el.readOnly) continue;
    // select2 / chosen: the visible widget is a proxy of a hidden native
    // <select> that holds the real options and value. Fill the select (the
    // library follows its change event) and never the proxy or its dropdown.
    if (isEnhancedSelectProxy(el)) continue;
    const enhancedSelect = isEnhancedSelect(el);

    // Visibility: checkbox/radio/file are often visually hidden behind styled
    // replacements but still operable, allow them when labeled. Comboboxes get
    // NO relaxation: an invisible combobox is not user-operable (react-select's
    // real input is small but rendered; what hides fully is other widgets'
    // internals, e.g. intl-tel-input's dial-code search inside a closed dialog).
    const relaxed =
      controlType === "checkbox" ||
      controlType === "radioGroup" ||
      controlType === "file";
    if (!isVisible(el) && !enhancedSelect && !(relaxed && (isHiddenButLabeled(el) || isUploadAffordance(el)))) continue;
    // A control inside aria-hidden markup is by definition not part of the form
    // the user sees (react-select's `<input required>` validation twin, screen-
    // reader-excluded duplicates). Styled-replacement natives (checkbox/radio/
    // file) legitimately carry aria-hidden, so only strict types are skipped.
    if (!relaxed && !enhancedSelect && el.closest('[aria-hidden="true"]')) continue;

    if (el instanceof HTMLInputElement && el.type === "radio") {
      // A name ties a radio group together in the browser; a framework
      // (Vue v-model, hand-rolled React) may tie it together instead and
      // render no name at all. Those group by their question container.
      const groupKey = el.name
        ? `${el.form?.id ?? "noform"}::${el.name}`
        : `container::${nameless.keyFor(el) ?? ensureFieldId(el)}`;
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
    // as a generic field, never fillable generically, never sent to the AI,
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
    // Kind → question shapes → category value → kind/option gate (fieldResolver).
    // Resolution sees EVERY option: `options` is capped at 60 for the panel,
    // and a value past the cap ("United States" in a country list) was dropped
    // as "not offered" when the gate used the capped copy.
    const allOptions = el instanceof HTMLSelectElement ? selectOptions(el, Infinity) : options;
    const resolved = resolveField({
      adapter,
      category,
      sensitive,
      profile,
      control: { controlType, options: allOptions, groupIndex, multi },
      fillEEO,
      el,
      label,
      signals,
    });
    let proposedValue = resolved.value;
    // A single checkbox is a boolean control: never write a text value into it.
    // Check clear application consent, skip marketing / ambiguous boxes (→ null,
    // so they're simply not selected rather than counted as failures).
    let consentTick = false;
    if (controlType === "checkbox" && !resolved.deviceAbstained) {
      const text = `${label} ${signals.nearby ?? ""}`;
      proposedValue = resolveCheckboxIntent(text, proposedValue);
      // A consent tick is selected on its own evidence, whatever the label's
      // category score: whether it got ticked used to depend on how confidently
      // its words happened to classify.
      consentTick = proposedValue === "yes" && isConsentText(text);
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
      ...resolutionFlags(resolved),
      ...(consentTick ? { deterministic: true } : {}),
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

    const label = bestDisplayLabel(signals);
    const resolved = resolveField({
      adapter,
      category,
      sensitive,
      profile,
      control: { controlType: "radioGroup", options, groupIndex },
      fillEEO,
      el: first,
      label,
      signals,
    });

    const checked = radios.find((r) => r.checked);
    fields.push({
      id,
      category,
      confidence,
      label,
      controlType: "radioGroup",
      required: radios.some((r) => isRequiredField(r, signals)),
      proposedValue: resolved.value,
      fillable: true,
      sensitive,
      note: noteFor("radioGroup", category),
      options,
      helpText: signals.nearby,
      inputType: signals.typeHint,
      groupIndex,
      currentValue: checked ? radioOptionLabel(checked) : undefined,
      ...resolutionFlags(resolved),
    });
  }

  // Native checkbox groups ("select all that apply"), one logical multi-select
  // field each, classified by the group question (not the option text).
  for (const [container, checkboxes] of checkboxGroups.entries()) {
    const first = checkboxes[0];
    const id = ensureFieldId(first);
    const signals = groupSignals(checkboxes, container);
    const groupIndex = detectGroupIndex(signals);
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el: first, signals, controlType: "checkboxGroup" });
    const options = checkboxes.map(radioOptionLabel).filter(Boolean).slice(0, 30);

    registry.set(id, { id, controlType: "checkboxGroup", checkboxes });

    const label = bestDisplayLabel(signals);
    const resolved = resolveField({
      adapter,
      category,
      sensitive,
      profile,
      control: { controlType: "checkboxGroup", options, groupIndex },
      fillEEO,
      el: first,
      label,
      signals,
    });

    const checkedLabels = checkboxes.filter((c) => c.checked).map(radioOptionLabel).filter(Boolean);
    fields.push({
      id,
      category,
      confidence,
      label,
      controlType: "checkboxGroup",
      required: checkboxes.some((c) => isRequiredField(c, signals)),
      proposedValue: resolved.value,
      fillable: true,
      sensitive,
      note: noteFor("checkboxGroup", category),
      options,
      helpText: signals.nearby,
      inputType: signals.typeHint,
      groupIndex,
      currentValue: checkedLabels.length ? checkedLabels.join(", ") : undefined,
      ...resolutionFlags(resolved),
    });
  }

  // Custom (non-<input>) résumé / cover-letter upload widgets (SuccessFactors).
  scanCustomUploads(fields, registry);

  // A bare "Address" next to separate City / Postal fields is the street line.
  reclassifyBareAddress(fields, registry, profile, adapter, fillEEO);
  reclassifyEducationRowDates(fields, registry, profile);

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

/**
 * Workday's segmented date widget renders each EMPTY part as a spinbutton
 * reading "0". Read that as empty, or the part looks already-filled and every
 * path that acts on a blank field skips it: aiFillPlanner's `!f.currentValue`,
 * answerGaps' currentValue guard, and shared/selection's default selection.
 *
 * TWO independent signals, because neither covers the other's ground:
 *
 *  - a `dateSection*` automation-id (DATE_PART_ID_SELECTOR). 0 is never a
 *    month, a day or a year, so this is sound BY CONSTRUCTION. It rests on no
 *    attribute a tenant may or may not emit.
 *  - `aria-valuemin` above zero on a role=spinbutton, for a part whose
 *    automation-id a tenant has renamed out from under us.
 *
 * `aria-valuemin` alone was one unverified attribute away from being a no-op:
 * it was inferred from a bug report, never captured from a live tenant, and a
 * part rendered with no `aria-valuemin`: or with `aria-valuemin="0"`: fell
 * straight back through as "already filled" (see workdayDateParts.test.ts).
 *
 * An ordinary <input type="number"> where 0 IS the answer ("years of
 * experience: 0") carries neither signal and is untouched.
 */
function readsEmptyAsZero(el: HTMLElement, raw: string): boolean {
  if (raw.trim() !== "0") return false;
  if (el.matches(DATE_PART_ID_SELECTOR)) return true;
  if (el.getAttribute("role") !== "spinbutton") return false;
  const min = Number(el.getAttribute("aria-valuemin"));
  return Number.isFinite(min) && min > 0;
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
    if (!v) return undefined;
    return readsEmptyAsZero(el, v) ? undefined : v;
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
      ? "Browser security requires choosing the file manually. Click the field and pick your resume."
      : "File uploads must be selected manually.";
  }
  if (controlType === "customDropdown") {
    return "Custom dropdown. Please select manually.";
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
 * document, so the scanner already classifies them, but a top-documentElement
 * MutationObserver never sees mutations inside them. Same-origin iframes are NOT
 * included: their fields are a different realm the top frame can't classify (they
 * run their own content-script instance), so observing them would only cause
 * pointless rescans.
 */
export function openShadowRoots(root: Document | ShadowRoot): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const visit = (node: Document | ShadowRoot): void => {
    node.querySelectorAll("*").forEach((el) => {
      // Our own panel is not part of the page: observing it turned every
      // panel repaint into a "page change" and a rescan (see observePage).
      if (EXTENSION_UI_HOST_IDS.has((el as HTMLElement).id)) return;
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

/** A mutation that happened inside (or to) the extension's own UI host. */
function isOwnUiMutation(m: MutationRecord): boolean {
  const target = m.target as Node;
  const root = target.getRootNode?.();
  const host = root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
  if (host && EXTENSION_UI_HOST_IDS.has(host.id)) return true;
  const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
  return nodes.length > 0 && nodes.every((n) => n instanceof HTMLElement && EXTENSION_UI_HOST_IDS.has(n.id));
}

/**
 * Watch for DOM changes (SPA navigation, multi-step Workday forms, UI5 shadow-DOM
 * steps) and call back, debounced. Observes the top document AND every open shadow
 * root, re-attaching to roots that appear later. Attribute changes are ignored, we
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
    // Only the PAGE changing is a reason to rescan. The panel repainting itself
    // (job-card logo swap, button label) used to count, and the rescan it
    // caused repainted the panel again: a rescan every 500 ms, forever.
    const relevant = mutations.some(
      (m) => (m.addedNodes.length > 0 || m.removedNodes.length > 0) && !isOwnUiMutation(m)
    );
    if (!relevant) return;
    attach(); // pick up newly-added shadow roots
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 500);
  });
  attach();
  return observer;
}
