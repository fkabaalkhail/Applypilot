/**
 * ARIA combobox / listbox filler.
 *
 * Custom dropdowns (react-select, Headless UI, Radix, Workday button-listboxes…)
 * cannot be driven by setting `.value`: the chosen value lives in the widget's
 * own state and only commits when the user opens the popup and clicks an option.
 * This module mimics that interaction — open → find the listbox → click the
 * matching option → confirm — following the WAI-ARIA combobox/listbox pattern.
 *
 * It is async and ONE-SHOT on purpose: re-driving a dropdown on every page
 * mutation is exactly the focus-stealing churn the reconciler avoids, so these
 * controls are filled once during the autofill pass and never drift-tracked.
 */
import { cleanText, deepQueryAll, dispatchInputEvents, setNativeValue } from "./domUtils";
import { normalize } from "./fieldMatcher";
import { matchOption } from "./writeEngine";

export interface ComboboxResult {
  filled: boolean;
  reason?: string;
  /** On a no-match failure: the open listbox's REAL option labels, harvested
   *  for the one-shot AI re-ask pass (contentScript). */
  options?: string[];
}

export interface FillComboboxOptions {
  /** Injectable for tests — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the menu to mount after opening. */
  openWaitMs?: number;
  /** How long to wait for the selection to commit after clicking. */
  commitWaitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
}

const DEFAULTS = { openWaitMs: 1500, commitWaitMs: 2500, pollMs: 50 };

/**
 * True when an element is an ARIA combobox/listbox we can drive by clicking an
 * option — as opposed to a free-text field. We require an explicit listbox
 * affordance so plain inputs are never mistaken for dropdowns.
 */
export function isAriaCombobox(el: HTMLElement): boolean {
  const role = (el.getAttribute("role") || "").toLowerCase();
  const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
  if (haspopup === "listbox") return true;
  if (role === "combobox") {
    // A combobox that actually toggles a listbox declares its state/target.
    return (
      el.hasAttribute("aria-expanded") ||
      el.hasAttribute("aria-controls") ||
      el.hasAttribute("aria-owns")
    );
  }
  return false;
}

export async function fillAriaCombobox(
  trigger: HTMLElement,
  value: string,
  opts: FillComboboxOptions = {}
): Promise<ComboboxResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const openWaitMs = opts.openWaitMs ?? DEFAULTS.openWaitMs;
  const commitWaitMs = opts.commitWaitMs ?? DEFAULTS.commitWaitMs;
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;

  if (!trigger.isConnected) {
    return { filled: false, reason: "Field was removed — rescan the page" };
  }
  // Already showing the desired value — idempotent no-op, never opens the menu.
  if (comboboxShowsValue(trigger, value)) return { filled: true };

  open(trigger);

  // Wait for the listbox to mount. Typeahead inputs may need the value typed in
  // to surface (and filter, or async-load) the options.
  let listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
  // SF's paginated picklists occasionally swallow the first activation (the
  // listbox never mounts). Re-open once — open() re-activates only while the
  // widget is still collapsed, so this is a no-op when it did open.
  if (!listbox) {
    open(trigger);
    listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
  }
  let option = listbox ? findOption(listbox, value) : null;
  if (isTypeahead(trigger) && !option) {
    typeInto(trigger as HTMLInputElement, value);
    listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
    option = listbox ? findOption(listbox, value) : null;
    // A long answer can over-filter a substring-matching widget down to zero
    // options ("I am not a protected veteran" never substring-matches "No, I am
    // not a veteran"). Clear the filter text and re-match against the full list.
    if (!option) {
      typeInto(trigger as HTMLInputElement, "");
      listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
      option = listbox ? findOption(listbox, value) : null;
    }
  }
  if (!listbox) {
    close(trigger);
    return { filled: false, reason: `Couldn't open the "${truncate(value)}" dropdown — select it manually` };
  }

  if (!option) {
    const options = optionLabels(listbox);
    close(trigger);
    // Record what the listbox actually offered — distinguishes an async/empty
    // read from a contaminated (wrong-field) menu from a genuine match miss.
    const seen =
      options && options.length ? ` (saw: ${options.slice(0, 6).join(" | ")})` : " (listbox had no options)";
    return {
      filled: false,
      reason: `No option matches "${truncate(value)}"${seen}`,
      options,
    };
  }

  const chosenText = optionText(option);
  clickOption(option);

  // Confirm: the committed value must actually SHOW on the widget. A merely
  // collapsed popup is not proof — a click that lands nowhere also leaves the
  // trigger collapsed, and reporting that as filled hides a real failure from
  // the user (the empty-required-dropdown bug). The widget displays the OPTION's
  // text, which for a fuzzy match ("I am not a protected veteran" → "No, I am
  // not a veteran") differs from the target — accept either.
  const committed = await waitFor(
    () =>
      comboboxShowsValue(trigger, value) || (chosenText && comboboxShowsValue(trigger, chosenText))
        ? true
        : null,
    sleep,
    commitWaitMs,
    pollMs
  );
  if (!committed) {
    return { filled: false, reason: "Selection didn't stick — select it manually" };
  }
  return { filled: true };
}

// ---------------------------------------------------------------------------
// Interaction primitives
// ---------------------------------------------------------------------------

/** A realistic activation sequence: pointer + mouse + click. Exported for the
 *  flow controller's advance-button click (advance.ts). */
export function activateElement(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // composed: true is essential — many ATS (Workday included) render the app in
  // an open shadow root, and frameworks delegate their click handling at the
  // document. A non-composed event bubbles only within the shadow tree, so the
  // button's real handler never runs and the page never advances. Real user
  // events are composed; coordinates + button/buttons make the sequence faithful
  // for handlers that inspect them. (No `view`: jsdom rejects it and browsers
  // don't need it here.)
  const mouse = (type: string, buttons: number): MouseEvent =>
    new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      button: 0, buttons, clientX: cx, clientY: cy,
    });
  try {
    el.focus({ preventScroll: true }); // some handlers gate on focus first
  } catch {
    // not focusable — the pointer/mouse sequence below still activates it
  }
  firePointer(el, "pointerdown", cx, cy);
  el.dispatchEvent(mouse("mousedown", 1));
  firePointer(el, "pointerup", cx, cy);
  el.dispatchEvent(mouse("mouseup", 0));
  el.dispatchEvent(mouse("click", 0));
}

function firePointer(el: HTMLElement, type: string, cx = 0, cy = 0): void {
  const PE = (el.ownerDocument.defaultView as unknown as { PointerEvent?: typeof PointerEvent })?.PointerEvent;
  if (!PE) return;
  try {
    el.dispatchEvent(
      new PE(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: cx, clientY: cy, isPrimary: true, pointerType: "mouse",
      })
    );
  } catch {
    // jsdom rejects some PointerEvent inits — ignore; mouse events cover it.
  }
}

function open(trigger: HTMLElement): void {
  trigger.focus({ preventScroll: true });
  if (trigger.getAttribute("aria-expanded") === "true") return;
  activateElement(trigger);
}

function close(trigger: HTMLElement): void {
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true })
  );
  // Many widgets dismiss the popup on a pointer-down outside it rather than on
  // Escape — fire one on <body> too. (Never re-activate the trigger: that would
  // re-open a widget that opens, rather than toggles, on click.)
  const body = trigger.ownerDocument.body;
  if (body && trigger.getAttribute("aria-expanded") === "true") {
    body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  }
}

function clickOption(option: HTMLElement): void {
  option.scrollIntoView?.({ block: "nearest" });
  activateElement(option);
}

function isTypeahead(trigger: HTMLElement): boolean {
  if (!(trigger instanceof HTMLInputElement)) return false;
  const ac = (trigger.getAttribute("aria-autocomplete") || "").toLowerCase();
  return ac === "list" || ac === "both" || ac === "inline" || trigger.type === "text";
}

function typeInto(input: HTMLInputElement, value: string): void {
  setNativeValue(input, value);
  dispatchInputEvents(input, value);
}

// ---------------------------------------------------------------------------
// Listbox + option lookup
// ---------------------------------------------------------------------------

/** Locate the open listbox: prefer the one the combobox points at (it may be
 *  portaled far away in the DOM), else a visible listbox that isn't part of a
 *  DIFFERENT widget. */
function getListbox(trigger: HTMLElement): HTMLElement | null {
  const doc = trigger.ownerDocument;
  const declared = `${trigger.getAttribute("aria-controls") ?? ""} ${trigger.getAttribute("aria-owns") ?? ""}`
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const id of declared) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const lb = (el.getAttribute("role") === "listbox" ? el : el.querySelector('[role="listbox"]')) as HTMLElement | null;
    if (lb && isVisible(lb) && hasOptions(lb)) return lb;
  }
  // A trigger that NAMES its listbox (aria-owns / aria-controls) must only ever
  // use THAT listbox — never a neighbour's. SAP SuccessFactors renders each
  // picklist's options into its own aria-owns'd <ul> a beat after opening;
  // falling back to "a visible listbox" here grabbed the previously-opened
  // field's still-open menu (race read gender's options, gender read the city
  // field's). Return null so waitFor keeps polling for the declared one.
  if (declared.length > 0) return null;
  // Fallback for widgets that declare no association. Prefer the menu inside the
  // trigger's OWN widget container (its own popup). Only then trust a document-
  // wide portaled menu — and ONLY when it is UNAMBIGUOUS (exactly one open):
  // grabbing "the first visible listbox" lets a stale or neighbouring dropdown's
  // menu contaminate this field's options (the mixed-up-options bug). A wrong
  // option list is worse than none, so when it's ambiguous we return null.
  const container = trigger.closest('[class*="select" i], [class*="combobox" i]');
  if (container) {
    const own = deepQueryAll(container, '[role="listbox"]').find((lb) => isVisible(lb) && hasOptions(lb));
    if (own) return own;
  }
  const visible = deepQueryAll(doc, '[role="listbox"]').filter(
    (lb) => isVisible(lb) && hasOptions(lb) && !belongsToOtherWidget(lb, trigger)
  );
  return visible.length === 1 ? visible[0] : null;
}

/** True when `lb` sits inside a widget wrapper that hosts a combobox trigger
 *  other than `trigger` — i.e. it's some other control's menu. */
function belongsToOtherWidget(lb: HTMLElement, trigger: HTMLElement): boolean {
  let node: HTMLElement | null = lb.parentElement;
  for (let hops = 0; node && node !== node.ownerDocument.body && hops < 8; hops++, node = node.parentElement) {
    if (node.contains(trigger)) return false; // shared container — it's ours
    const owner = node.querySelector('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="dialog"]');
    if (owner && owner !== trigger) return true;
  }
  return false;
}

function hasOptions(listbox: HTMLElement): boolean {
  return deepQueryAll(listbox, '[role="option"]').length > 0;
}

function findOption(listbox: HTMLElement, value: string): HTMLElement | null {
  const options = deepQueryAll(listbox, '[role="option"]').filter(
    (o) => o.getAttribute("aria-disabled") !== "true"
  );
  return matchOption(
    options,
    (o) => optionText(o),
    (o) => o.getAttribute("data-value") ?? o.getAttribute("value") ?? "",
    value
  );
}

/** Visible label of an option, ignoring nested check/icon glyph text. */
function optionText(option: HTMLElement): string {
  const labelled = option.getAttribute("aria-label");
  return cleanText(labelled) || cleanText(option.textContent);
}

/**
 * Read a combobox's option labels WITHOUT opening it — only when the listbox is
 * already mounted in the DOM. Many widgets keep a hidden listbox; react-select
 * mounts it lazily on open, so this returns undefined there (the AI then answers
 * from the label alone). Visibility is ignored on purpose: a mounted-but-hidden
 * listbox is a valid source.
 */
export function readComboboxOptions(trigger: HTMLElement): string[] | undefined {
  const listbox = findMountedListbox(trigger);
  if (!listbox) return undefined;
  return optionLabels(listbox);
}

/**
 * Actively harvest a lazy combobox's options by briefly opening its menu and
 * closing it again — for widgets (react-select…) that mount the listbox only
 * while open, where readComboboxOptions has nothing to read. Used to give the
 * missing-info modal the REAL choices for a dropdown nothing could answer.
 * Best-effort: returns undefined when no listbox appears; always closes what
 * it opened, and never types or selects anything.
 */
export async function harvestComboboxOptions(
  trigger: HTMLElement,
  opts: FillComboboxOptions = {}
): Promise<string[] | undefined> {
  const mounted = readComboboxOptions(trigger);
  if (mounted && mounted.length > 0) return mounted;
  if (!trigger.isConnected) return undefined;

  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const openWaitMs = opts.openWaitMs ?? DEFAULTS.openWaitMs;
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;

  open(trigger);
  const listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
  const labels = listbox ? optionLabels(listbox) : undefined;
  close(trigger);
  return labels;
}

/** Non-disabled option labels of a listbox, trimmed for transport (cap 60). */
function optionLabels(listbox: HTMLElement): string[] | undefined {
  const labels = deepQueryAll(listbox, '[role="option"]')
    .filter((o) => o.getAttribute("aria-disabled") !== "true")
    .map((o) => optionText(o))
    .filter((t) => t.length > 0)
    .slice(0, 60);
  return labels.length > 0 ? labels : undefined;
}

/** The combobox's listbox if it is already in the DOM (no opening, any visibility). */
function findMountedListbox(trigger: HTMLElement): HTMLElement | null {
  const doc = trigger.ownerDocument;
  const ids = `${trigger.getAttribute("aria-controls") ?? ""} ${trigger.getAttribute("aria-owns") ?? ""}`.trim();
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const lb = (el.getAttribute("role") === "listbox" ? el : el.querySelector('[role="listbox"]')) as HTMLElement | null;
    if (lb && hasOptions(lb)) return lb;
  }
  // Same-container fallback: a listbox rendered next to the trigger (not a
  // document-wide search, which could grab an unrelated open menu at scan time).
  // [role="combobox"] is intentionally excluded — the trigger is often that
  // element itself, and closest() would then return it (no listbox descendant).
  const container =
    trigger.closest('[class*="select" i], [class*="combobox" i]') ?? trigger.parentElement;
  const lb = container?.querySelector('[role="listbox"]') as HTMLElement | null;
  return lb && hasOptions(lb) ? lb : null;
}

/**
 * The combobox's currently-displayed value, if one is committed — best-effort,
 * for scan-time "already answered?" detection. Deliberately ignores raw <button>
 * text (often a "Select…" placeholder) and reads only strong selection signals.
 */
export function readComboboxValue(trigger: HTMLElement): string | undefined {
  const candidates = [
    trigger instanceof HTMLInputElement ? trigger.value : "",
    activeDescendantText(trigger),
    ...valueContainerTexts(trigger),
  ];
  for (const c of candidates) {
    const v = cleanText(c);
    if (v) return v;
  }
  return undefined;
}

/** Text of the option referenced by aria-activedescendant, if any. */
function activeDescendantText(trigger: HTMLElement): string {
  const active = trigger.getAttribute("aria-activedescendant");
  if (!active) return "";
  const opt = trigger.ownerDocument.getElementById(active);
  return opt ? optionText(opt) : "";
}

const VALUE_DISPLAY_SELECTOR =
  '[class*="single-value" i], [class*="singlevalue" i], [class*="multi-value" i], [class*="multivalue" i]';

/** Texts of react-select-style single/multi-value display elements near the trigger.
 *  The committed-value div is a COUSIN of the input (react-select: value-container
 *  > single-value + input-container > input), so `closest('[class*=select]')` —
 *  which stops at the innermost `select__input-container` — can never see it.
 *  Climb a few ancestors and query at each level until something shows. */
function valueContainerTexts(trigger: HTMLElement): string[] {
  let node: HTMLElement | null = trigger.parentElement;
  for (let hops = 0; node && node !== node.ownerDocument.body && hops < 6; hops++, node = node.parentElement) {
    // Climbed past our widget into a container holding other dropdowns — any
    // value found from here would be a NEIGHBOR field's selection, not ours.
    if (node.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]').length > 1) break;
    const texts = Array.from(node.querySelectorAll(VALUE_DISPLAY_SELECTOR))
      .map((e) => cleanText(e.textContent))
      .filter(Boolean);
    if (texts.length > 0) return texts;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Whether the combobox's committed/displayed value reflects the target. */
function comboboxShowsValue(trigger: HTMLElement, value: string): boolean {
  const candidates: string[] = [];
  if (trigger instanceof HTMLInputElement && trigger.value) candidates.push(trigger.value);
  if (trigger.tagName === "BUTTON") candidates.push(cleanText(trigger.textContent));
  // SAP SuccessFactors' rcmpaginatedselect commits the choice into the input's
  // `title` while leaving `value` empty and the placeholder ("No Selection")
  // in place — so a successful selection read as "didn't stick" without this.
  const title = cleanText(trigger.getAttribute("title"));
  if (title && !/^no selection$/i.test(title)) candidates.push(title);
  const active = activeDescendantText(trigger);
  if (active) candidates.push(active);
  candidates.push(...valueContainerTexts(trigger));
  return candidates.some((c) => textMatches(c, value));
}

function textMatches(displayed: string, target: string): boolean {
  const a = normalize(displayed);
  const b = normalize(target);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  // Computed style is per-element and does NOT reflect a display:none ANCESTOR —
  // intl-tel-input keeps its 244-option dial-code listbox mounted inside a hidden
  // dialog, and grabbing it cross-contaminates every dropdown on the page. A
  // rendered listbox always has client rects; a hidden-subtree one has none.
  return el.getClientRects().length > 0;
}

async function waitFor<T>(
  probe: () => T | null,
  sleep: (ms: number) => Promise<void>,
  budgetMs: number,
  pollMs: number
): Promise<T | null> {
  let elapsed = 0;
  for (;;) {
    const hit = probe();
    if (hit) return hit;
    if (elapsed >= budgetMs) return null;
    await sleep(pollMs);
    elapsed += pollMs;
  }
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
