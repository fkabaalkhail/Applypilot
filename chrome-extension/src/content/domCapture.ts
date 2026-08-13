/**
 * Sanitised DOM snapshots of form fields, for diagnostic capture.
 *
 * The point of this module is one workflow: an agent reads a failed field out
 * of the database, pastes its snapshot into `test/fixtures/`, and writes a
 * regression test WITHOUT visiting the live site. That matters because the
 * forms that fail most are the ones behind a login (Workday's post-account
 * pages, multi-step flows), which nobody can re-fetch later.
 *
 * What is kept is chosen by what the fill engine actually reads: tag, role,
 * aria-*, type, id, name, class (react-select is detected by class), the
 * developer test-ids, and the option/label elements around the control. What is
 * dropped is everything that only makes the snapshot bigger: scripts, styles,
 * SVG paths, images, inline style attributes, data: URIs.
 *
 * On values: `outerHTML` does NOT serialise a control's live `.value` property,
 * so a snapshot of a filled input carries no typed text unless the page itself
 * wrote a `value` attribute. Where it does, `scrubValues` blanks it. The
 * captured VALUE is recorded as a separate, redactable field by the telemetry
 * layer, so this module never has to be the thing that leaks one.
 */

/**
 * Secrets that are never stored, whatever the capture mode says.
 *
 * Diagnostic mode is an opt-in to storing the answers you type into job
 * applications. It is not an opt-in to storing a password or a national ID
 * number, and no debugging workflow needs those: knowing a government-ID field
 * received 9 digits is the whole diagnostic signal, the digits are not.
 *
 * Matched on the VALUE, not the field's category, because the label is exactly
 * what is unreliable here (see the field-label bugs this codebase keeps hitting).
 */
const SECRET_VALUE = [
  /^\d{3}[- ]?\d{2}[- ]?\d{4}$/,           // US SSN
  /^\d{3}[- ]?\d{3}[- ]?\d{3}$/,           // Canadian SIN
  /^(?:\d[ -]?){13,19}$/,                  // payment card
];

/**
 * A value as it should be stored: itself, or a type marker when it is a secret.
 *
 * Returns `[value, redacted]` so the record can say that redaction HAPPENED,
 * rather than silently looking like an empty answer, which would send a future
 * investigation after a fill bug that does not exist.
 */
export function redactCaptureValue(category: string, value: string): [string, boolean] {
  const v = (value ?? "").trim();
  if (!v) return ["", false];
  if (category === "accountPassword") return ["<password>", true];
  for (const re of SECRET_VALUE) {
    if (re.test(v)) return ["<redacted-id>", true];
  }
  return [v, false];
}

/** A stable-ish selector for the control, so a snapshot can be located again. */
export function fieldSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const name = el.getAttribute("name");
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
  const auto = el.getAttribute("data-automation-id") ?? el.getAttribute("data-testid");
  if (auto) return `[data-automation-id="${auto}"]`;
  return el.tagName.toLowerCase();
}

/** Attributes worth keeping: everything the scanner/fill engine reads. */
const KEEP_ATTR =
  /^(id|name|type|role|class|for|href|placeholder|title|value|checked|selected|disabled|required|multiple|maxlength|inputmode|autocomplete|tabindex|hidden|contenteditable|list|min|max|step|pattern)$/i;

/** Prefixes worth keeping wholesale. */
const KEEP_PREFIX = /^(aria-|data-)/i;

/** Data attributes that are pure noise: framework bookkeeping and hydration ids. */
const DROP_DATA =
  /^data-(reactid|react-|v-|ng-|svelte|emotion|styled|testid-generated|framer)/i;

/** Elements that carry no signal for field detection. */
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS", "IFRAME"]);

/**
 * How far up to walk for the field's container.
 *
 * Deliberately bounded: the useful markup is the control plus its label,
 * wrapper and (for a custom dropdown) its listbox. Capturing the whole <form>
 * would balloon every snapshot and drag in the OTHER fields' values, which is
 * both a size and a privacy problem.
 */
const MAX_ASCEND = 5;

/** True once an element looks like a self-contained form-field block. */
function isFieldContainer(el: Element): boolean {
  if (el.querySelector("label")) return true;
  const cls = typeof el.className === "string" ? el.className : "";
  return /(^|\s|-)(form-?field|field|input-?wrapper|question|form-?group|select-?wrapper)(\s|-|$)/i.test(cls);
}

/** The smallest ancestor that reads as this field's own block. */
export function fieldContainer(el: HTMLElement): HTMLElement {
  let node: HTMLElement = el;
  for (let i = 0; i < MAX_ASCEND; i++) {
    const parent = node.parentElement;
    if (!parent || parent.tagName === "FORM" || parent.tagName === "BODY") break;
    node = parent;
    if (isFieldContainer(node)) break;
  }
  return node;
}

function scrubElement(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const keep = (KEEP_ATTR.test(name) || KEEP_PREFIX.test(name)) && !DROP_DATA.test(name);
    if (!keep) {
      el.removeAttribute(attr.name);
      continue;
    }
    // Long opaque values (data: URIs, emotion hashes, base64) say nothing about
    // the field and can be enormous.
    if (attr.value.length > 200) el.setAttribute(attr.name, `${attr.value.slice(0, 200)}…`);
  }
}

/** Blank any value the page serialised into the markup. */
function scrubValues(root: Element): void {
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.hasAttribute?.("value") && (el.getAttribute("value") ?? "").length > 0) {
      el.setAttribute("value", "");
    }
  }
}

/**
 * A sanitised snapshot of the markup around one control.
 *
 * `keepValues: true` retains `value=` attributes (diagnostic mode on an account
 * that opted in); the default blanks them.
 */
export function captureFieldDom(
  el: HTMLElement,
  opts: { maxChars?: number; keepValues?: boolean } = {}
): string {
  const maxChars = opts.maxChars ?? 4000;
  let clone: HTMLElement;
  try {
    clone = fieldContainer(el).cloneNode(true) as HTMLElement;
  } catch {
    return "";
  }

  for (const node of [...clone.querySelectorAll("*")]) {
    if (DROP_TAGS.has(node.tagName.toUpperCase())) {
      // Keep a marker so "there was an icon here" is still visible.
      node.replaceWith(clone.ownerDocument.createComment(node.tagName.toLowerCase()));
    }
  }
  scrubElement(clone);
  for (const node of clone.querySelectorAll("*")) scrubElement(node);
  if (!opts.keepValues) scrubValues(clone);

  const html = clone.outerHTML.replace(/\s+/g, " ").replace(/> </g, "><").trim();
  return html.length > maxChars ? `${html.slice(0, maxChars)}<!--truncated-->` : html;
}

/**
 * The options a choice control is currently offering, read straight from the
 * DOM at capture time.
 *
 * `DetectedField.options` is populated at SCAN time, which for a react-select
 * or a Workday prompt is before the list exists, so it is routinely empty on
 * exactly the widgets that fail. Reading again here catches the ones a harvest
 * or a fill attempt has since mounted.
 */
export function captureOptions(el: HTMLElement, limit = 120): string[] {
  const root = fieldContainer(el);
  const own = el.tagName === "SELECT" ? [...(el as HTMLSelectElement).options].map((o) => o.text) : [];
  if (own.length > 0) return own.slice(0, limit);
  const listboxId = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`.trim();
  const scopes: Element[] = [];
  for (const id of listboxId.split(/\s+/).filter(Boolean)) {
    const lb = el.ownerDocument.getElementById(id);
    if (lb) scopes.push(lb);
  }
  scopes.push(root);
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const o of scope.querySelectorAll('[role="option"], option')) {
      const t = (o.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) seen.add(t);
    }
    if (seen.size > 0) break;
  }
  return [...seen].slice(0, limit);
}
