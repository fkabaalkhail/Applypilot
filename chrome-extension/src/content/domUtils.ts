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
  return el.getClientRects().length > 0;
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

/** Resolve aria-labelledby into text. */
function ariaLabelledByText(el: HTMLElement): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  const doc = el.ownerDocument;
  return cleanText(
    ids
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
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
 * Fallback when there is no <label>: walk previous siblings (including bare
 * text nodes), then climb a few ancestors and repeat. This catches the very
 * common ATS markup `<div><span>Label</span><input/></div>`.
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
      // Long blobs are paragraphs/descriptions, not labels.
      if (text && text.length <= 160) return text;
      sib = sib.previousSibling;
      hops++;
    }
    node = node.parentElement;
  }
  return "";
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
}

export function collectSignals(el: HTMLElement): FieldSignals {
  const labelledBy = ariaLabelledByText(el);
  return {
    label: associatedLabelText(el) || labelledBy,
    ariaLabel: cleanText(el.getAttribute("aria-label")) || labelledBy,
    placeholder: cleanText(el.getAttribute("placeholder")),
    nearby: nearbyText(el),
    nameAttr: el.getAttribute("name") ?? "",
    idAttr: el.id ?? "",
    autocomplete: (el.getAttribute("autocomplete") ?? "").trim().toLowerCase(),
    typeHint: el instanceof HTMLInputElement ? el.type : "",
  };
}

/** Pick the most human-readable label for display in the popup. */
export function bestDisplayLabel(signals: FieldSignals): string {
  return (
    signals.label ||
    signals.ariaLabel ||
    signals.placeholder ||
    signals.nearby ||
    signals.nameAttr ||
    signals.idAttr ||
    "Unlabeled field"
  );
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
