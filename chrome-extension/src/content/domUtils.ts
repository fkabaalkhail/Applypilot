/**
 * DOM helpers used by the scanner, matcher and autofill engine.
 * No Chrome APIs in here — pure DOM, easy to unit test later.
 */

/** Collapse whitespace and trim. */
export function cleanText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Keep a node attached: if the page (a SPA re-render or client-side navigation)
 * tore `node` out of the document, re-append it to `parent`. Returns true if it
 * had to re-attach. This is what stops the in-page overlay from silently dying
 * on React/Angular sites that rebuild the DOM out from under it.
 */
export function reattachIfDetached(node: HTMLElement, parent: ParentNode): boolean {
  if (node.isConnected) return false;
  parent.appendChild(node);
  return true;
}

/**
 * querySelectorAll that also descends into open shadow roots AND same-origin
 * iframes. Several ATS embed their form in an iframe (Greenhouse/Lever boards)
 * or render widgets inside shadow DOM. Cross-origin iframes throw on access and
 * are skipped silently — those frames run their own copy of the content script.
 */
export function deepQueryAll(root: ParentNode, selector: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<Document | ShadowRoot>();
  const visit = (node: ParentNode): void => {
    node.querySelectorAll(selector).forEach((el) => out.push(el as HTMLElement));
    node.querySelectorAll("*").forEach((el) => {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) visit(shadow);
      if (el instanceof HTMLIFrameElement) {
        const doc = sameOriginDocument(el);
        if (doc && !seen.has(doc)) {
          seen.add(doc);
          visit(doc);
        }
      }
    });
  };
  visit(root);
  return out;
}

/** A same-origin iframe's document, or null if cross-origin / not ready. */
function sameOriginDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null; // cross-origin — accessing contentDocument throws
  }
}

/** Visible enough to be a real, user-facing field. */
export function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  // Zero-area boxes are invisible companions, not fields: react-select renders a
  // hidden `<input required>` twin (height:0, opacity:0) purely so native form
  // validation fires — typing into it churns the widget and double-counts the
  // question. A genuine field always has a rendered box.
  return Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
}

/**
 * Many ATS visually hide the native input behind a styled replacement
 * (custom checkboxes, drag-and-drop resume zones). Those are still real,
 * fillable controls as long as something labels them.
 */
export function isHiddenButLabeled(el: HTMLElement): boolean {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) return true;
  return Boolean(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"));
}

/** Resolve aria-labelledby into text. Nodes INSIDE the control itself are
 *  skipped: widgets (react-aria, Radix) point aria-labelledby at their own
 *  value/placeholder span, whose text is "Select…" — the current selection,
 *  never the question. */
function ariaLabelledByText(el: HTMLElement): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  const doc = el.ownerDocument;
  return cleanText(
    ids
      .split(/\s+/)
      .map((id) => {
        const ref = doc.getElementById(id);
        if (!ref || el.contains(ref)) return "";
        return ref.textContent ?? "";
      })
      .join(" ")
  );
}

/** Text of associated <label> elements (covers both for= and wrapping). */
export function associatedLabelText(el: HTMLElement): string {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    return cleanText(Array.from(labels).map((l) => l.textContent ?? "").join(" "));
  }
  const wrapping = el.closest("label");
  if (wrapping) return cleanText(wrapping.textContent);
  return "";
}

/**
 * Placeholder / "no selection yet" filler that a dropdown shows before the user
 * picks — e.g. react-select's `<div class="select__placeholder">Select…</div>`.
 * This is NEVER the field's question, but it commonly sits as a sibling of the
 * inner combobox input, so nearbyText would otherwise grab it as the label (and
 * the classifier would then see "select" instead of "Country"/"Gender"). We
 * match the WHOLE trimmed string so a real label like "Select your country"
 * still counts as a label.
 */
const PLACEHOLDER_FILLER =
  /^[-\s]*(please\s+)?(select|choose|pick)( (an?|one|your) )?( ?(option|value|answer|choice|one|country|item))?\s*(\.{3}|…)?[-\s]*$/i;

export function isPlaceholderFiller(text: string): boolean {
  return PLACEHOLDER_FILLER.test(text.trim());
}

/**
 * Fallback when there is no <label>: walk previous siblings (including bare
 * text nodes), then climb a few ancestors and repeat. This catches the very
 * common ATS markup `<div><span>Label</span><input/></div>`. Dropdown
 * placeholder filler ("Select…") is skipped so it never masquerades as a label.
 */
export function nearbyText(el: HTMLElement): string {
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "INPUT", "SELECT", "TEXTAREA", "BUTTON", "OPTION"]);
  let node: HTMLElement | null = el;
  for (let depth = 0; depth < 3 && node; depth++) {
    let sib: ChildNode | null = node.previousSibling;
    let hops = 0;
    while (sib && hops < 6) {
      let text = "";
      if (sib.nodeType === Node.TEXT_NODE) {
        text = cleanText(sib.textContent);
      } else if (sib.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has((sib as Element).tagName)) {
        text = cleanText(sib.textContent);
      }
      // Long blobs are paragraphs/descriptions, not labels; placeholder filler
      // ("Select…") is not a label either — skip both and keep scanning.
      if (text && text.length <= 160 && !isPlaceholderFiller(text)) return text;
      sib = sib.previousSibling;
      hops++;
    }
    node = node.parentElement;
  }
  return "";
}

/**
 * Custom dropdowns (react-select, Headless UI, Workday button-listboxes…) nest
 * the operable control — a tiny `role="combobox"` input or an
 * `aria-haspopup="listbox"` button — several layers inside a widget wrapper, and
 * the field's real `<label>` sits as a sibling of that WRAPPER, not the inner
 * control. Label discovery run from the inner control never climbs far enough
 * (and trips over the "Select…" placeholder on the way). So for combobox-like
 * controls we resolve labels from the outermost widget wrapper instead.
 */
function dropdownWidgetHost(el: HTMLElement): HTMLElement {
  const role = (el.getAttribute("role") || "").toLowerCase();
  const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
  if (role !== "combobox" && haspopup !== "listbox") return el;

  const WIDGET_CLASS = /select|combobox|dropdown|autocomplete/i;
  let host = el;
  let node = el.parentElement;
  for (let hops = 0; node && hops < 6; hops++) {
    const cls = node.getAttribute("class") || "";
    const nodeRole = (node.getAttribute("role") || "").toLowerCase();
    const isWidget =
      WIDGET_CLASS.test(cls) ||
      nodeRole === "combobox" ||
      nodeRole === "listbox" ||
      (node.getAttribute("aria-haspopup") || "").toLowerCase() === "listbox";
    if (!isWidget) break; // reached the field container — its sibling is the label
    host = node;
    node = node.parentElement;
  }
  return host;
}

/** All the text signals the field matcher scores against. */
export interface FieldSignals {
  label: string;
  ariaLabel: string;
  placeholder: string;
  nearby: string;
  nameAttr: string;
  idAttr: string;
  autocomplete: string;
  /** Native input type ("email", "tel", "url"…) — a strong category hint. */
  typeHint: string;
  /** Developer-assigned test ids (Workday's data-automation-id, data-testid…) —
   *  stable semantic anchors when labels are generic or missing. */
  testId: string;
}

/**
 * First present developer-assigned test id. Workday's `data-automation-id` is the
 * most valuable; the `data-testid` / `data-test` / `data-qa` family covers most
 * React/Vue/Angular apps. These are author-declared semantics, so they make a
 * strong matching signal where visible labels are generic or missing.
 */
function testIdOf(el: HTMLElement): string {
  for (const attr of ["data-automation-id", "data-testid", "data-test", "data-qa"]) {
    const v = el.getAttribute(attr);
    if (v) return v;
  }
  return "";
}

/**
 * A drag-and-drop / "Select file" upload widget hides its real <input type=file>
 * behind a styled zone, and the input itself is usually unlabeled — the
 * describing text ("Upload your resume", "Drop file here") lives on the
 * surrounding zone. True when `el` is the hidden file input of such a widget,
 * so the scanner can still surface it (Workday, Greenhouse, Ashby dropzones).
 */
const UPLOAD_HINT = /file.?upload|fileupload|attach|resume|\bcv\b|drop.?zone|upload/i;

export function isUploadAffordance(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== "file" || el.disabled) return false;
  const testId = el.getAttribute("data-automation-id") || el.getAttribute("data-testid") || "";
  const cls = el.className || "";
  if (UPLOAD_HINT.test(testId) || UPLOAD_HINT.test(cls)) return true;
  // Climb a few wrappers looking for an upload zone marker (testId/class).
  let node: HTMLElement | null = el.parentElement;
  for (let i = 0; i < 4 && node; i++) {
    const id = node.getAttribute("data-automation-id") || node.getAttribute("data-testid") || "";
    if (UPLOAD_HINT.test(id) || UPLOAD_HINT.test(node.className || "")) return true;
    node = node.parentElement;
  }
  return /upload|drop file|select file|attach|resume|\bcv\b|drag/i.test(nearbyText(el));
}

/**
 * Describing text of the upload widget wrapping a hidden file input — e.g.
 * Workday's "Upload your resume…" heading, which sits a wrapper or two ABOVE the
 * drop zone, not on the input. Climbs ancestors and returns the first container
 * that names a document (resume/CV/cover letter); else the nearest small wrapper.
 */
export function uploadZoneText(el: HTMLElement): string {
  if (!(el instanceof HTMLInputElement) || el.type !== "file") return "";
  const DOC = /resume|résumé|curriculum vitae|\bcv\b|cover letter/i;
  let node: HTMLElement | null = el.parentElement;
  let widest = "";
  for (let i = 0; i < 5 && node; i++) {
    const t = cleanText(node.textContent).slice(0, 300);
    if (t && DOC.test(t)) return t; // explicit document text → best signal
    if (t && t.length <= 300) widest = t;
    node = node.parentElement;
  }
  return widest;
}

export function collectSignals(el: HTMLElement): FieldSignals {
  const labelledBy = ariaLabelledByText(el);
  const isFile = el instanceof HTMLInputElement && el.type === "file";
  // Custom dropdowns bury the operable control deep inside a widget wrapper; the
  // real label lives beside that wrapper, so resolve labels/nearby from it.
  const host = dropdownWidgetHost(el);
  const isDropdown = host !== el;
  const hostLabel = isDropdown ? associatedLabelText(host) : "";
  const hostLabelledBy = isDropdown ? ariaLabelledByText(host) : "";
  // A hidden upload input's identity lives on its zone, so fold the zone's
  // describing text into `nearby` for classification (e.g. "…your resume…").
  const nearby = isFile
    ? [nearbyText(el), uploadZoneText(el)].filter(Boolean).join(" ").slice(0, 220)
    : nearbyText(host);
  const assocLabel = associatedLabelText(el);
  const ariaLabel = cleanText(el.getAttribute("aria-label"));
  // For a custom dropdown that carries NO programmatic label of any kind, the
  // text sitting right before the widget IS its question (that's how the form
  // reads visually) — promote it to the reliable `label` signal. Without this it
  // would only land in weak `nearby` (0.6) and fall below the autofill bar (0.7),
  // so the field is classified yet never filled (country/gender/disability on
  // Greenhouse). Gated on the absence of every real label signal so a widget that
  // *does* declare an aria-label / association is never overridden by a stray
  // neighbouring label.
  const hasRealLabel = Boolean(assocLabel || hostLabel || labelledBy || hostLabelledBy || ariaLabel);
  const promotedLabel = isDropdown && !hasRealLabel ? nearby : "";
  return {
    label: assocLabel || hostLabel || labelledBy || hostLabelledBy || promotedLabel,
    ariaLabel: ariaLabel || labelledBy || hostLabelledBy,
    placeholder: cleanText(el.getAttribute("placeholder")),
    nearby,
    nameAttr: el.getAttribute("name") ?? "",
    idAttr: el.id ?? "",
    autocomplete: (el.getAttribute("autocomplete") ?? "").trim().toLowerCase(),
    typeHint: el instanceof HTMLInputElement ? el.type : "",
    testId: testIdOf(el),
  };
}

/** Pick the most human-readable label for display in the popup. Placeholder
 *  filler ("Select…", "Choose an option") is never a usable question text — a
 *  dropdown whose only signal is its own placeholder must fall through to the
 *  name/id attributes rather than present "Select" as the question. */
export function bestDisplayLabel(signals: FieldSignals): string {
  const candidates = [
    signals.label,
    signals.ariaLabel,
    signals.placeholder,
    signals.nearby,
    signals.nameAttr,
    signals.idAttr,
  ];
  for (const c of candidates) {
    if (c && !isPlaceholderFiller(c)) return c;
  }
  return "Unlabeled field";
}

export function isRequiredField(el: HTMLElement, signals: FieldSignals): boolean {
  if ((el as HTMLInputElement).required) return true;
  if (el.getAttribute("aria-required") === "true") return true;
  return /[*✱]\s*$/.test(signals.label) || /[*✱]\s*$/.test(signals.nearby);
}

// ---------------------------------------------------------------------------
// Value writing — must look like real user input to React/Vue/Angular
// ---------------------------------------------------------------------------

type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Set .value through the native prototype setter. React overrides the value
 * property on instances to track programmatic writes; going through the
 * prototype setter makes the framework see the change as user input.
 */
export function setNativeValue(el: ValueElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * Fire the events frameworks listen for. React uses "input"; Angular and
 * many validation libraries also want "change" and "blur".
 */
export function dispatchInputEvents(el: HTMLElement, value?: string): void {
  el.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value ?? null, inputType: "insertText" })
  );
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Briefly outline a filled control so the user can review what changed. */
export function flashHighlight(el: HTMLElement): void {
  const doc = el.ownerDocument;
  if (!doc.getElementById("ap-autofill-style")) {
    const style = doc.createElement("style");
    style.id = "ap-autofill-style";
    style.textContent = `
      [data-ap-flash] {
        outline: 2px solid #533afd !important;
        outline-offset: 1px;
        transition: outline-color 0.4s ease;
      }`;
    doc.documentElement.appendChild(style);
  }
  el.setAttribute("data-ap-flash", "");
  setTimeout(() => el.removeAttribute("data-ap-flash"), 2500);
}
