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
import { countryAlias } from "./countryAliases";
import { matchOption } from "./writeEngine";

export interface ComboboxResult {
  filled: boolean;
  reason?: string;
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

const DEFAULTS = { openWaitMs: 1000, commitWaitMs: 1000, pollMs: 50 };

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

  // Wait for the listbox to mount.
  let listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);

  // Filter step. When the wanted option isn't present yet, type into whatever
  // search field this widget exposes so it filters/loads the option:
  //   - react-select & typeahead comboboxes: the trigger IS the <input>.
  //   - Workday and other large lists: a SEPARATE search box mounts inside the
  //     opened popup (usually auto-focused) and the option list is virtualized,
  //     so the target simply isn't in the DOM until you type.
  // Without this, a button-triggered dropdown whose option isn't initially
  // rendered can never be filled — the Workday country/location failure.
  const search = findSearchInput(trigger, listbox);
  if (!listbox || !findOption(listbox, value)) {
    if (search) {
      // Type each candidate query until the wanted option appears. A full
      // location like "Austin, TX, United States" filters a country search to
      // zero matches, so retry with coarser segments (country/region first).
      let filtered: HTMLElement | null = null;
      for (const query of searchQueries(value)) {
        typeInto(search, query);
        filtered = await waitFor(
          () => {
            const lb = getListbox(trigger);
            return lb && findOption(lb, value) ? lb : null;
          },
          sleep,
          openWaitMs,
          pollMs
        );
        if (filtered) break;
      }
      listbox = filtered ?? getListbox(trigger) ?? listbox;
    }
  }
  if (!listbox) {
    close(trigger);
    return { filled: false, reason: `Couldn't open the "${truncate(value)}" dropdown — select it manually` };
  }

  // Primary: click the matching option element.
  const option = findOption(listbox, value);
  if (option) {
    clickOption(option);
    // Confirm: the committed value shows, or the popup closed after clicking a
    // matching option (the standard "selected and dismissed" outcome).
    const committed = await waitFor(
      () => (comboboxShowsValue(trigger, value) || isCollapsed(trigger) ? true : null),
      sleep,
      commitWaitMs,
      pollMs
    );
    if (committed) return { filled: true };
  }

  // Fallback: keyboard navigation. Virtualized listboxes (Ashby rc-virtual-list)
  // may not render the target option in the DOM to click, and some typeaheads
  // commit only on ArrowDown→Enter via aria-activedescendant. Arrow through the
  // options and press Enter on the match.
  const keyboardOk = await selectByKeyboard(
    trigger,
    search ?? trigger,
    listbox,
    value,
    sleep,
    commitWaitMs,
    pollMs
  );
  if (keyboardOk) return { filled: true };

  close(trigger);
  return {
    filled: false,
    reason: option
      ? "Selection didn't stick — select it manually"
      : `No option matches "${truncate(value)}" — select it manually`,
  };
}

/**
 * Keyboard-driven option selection: focus the search/trigger, ArrowDown through
 * the options reading the active one each step, and Enter when it matches. Bounded
 * so it never spins on a widget that ignores keys. Covers virtualized lists (the
 * target isn't clickable in the DOM) and keyboard-commit typeaheads.
 */
async function selectByKeyboard(
  trigger: HTMLElement,
  focusTarget: HTMLElement,
  listbox: HTMLElement | null,
  value: string,
  sleep: (ms: number) => Promise<void>,
  commitWaitMs: number,
  pollMs: number
): Promise<boolean> {
  focusTarget.focus?.({ preventScroll: true });
  const optionCount = listbox ? deepQueryAll(listbox, '[role="option"]').length : 0;
  const maxSteps = Math.min(80, Math.max(30, optionCount + 5));
  let lastActiveKey = "";
  let stalls = 0;
  for (let i = 0; i < maxSteps; i++) {
    pressKey(focusTarget, "ArrowDown", 40);
    await sleep(pollMs);
    const lb = listbox && listbox.isConnected ? listbox : getListbox(trigger);
    const active = activeOption(trigger, focusTarget, lb);
    // Commit only on the BEST/exact match (same precedence as the click path),
    // never the first loosely-overlapping option — else we could pick the wrong
    // country/option when an exact one exists further down.
    const want = lb ? findOption(lb, value) : null;
    const isMatch =
      !!active &&
      ((want !== null && active === want) || normalize(optionText(active)) === normalize(value));
    if (isMatch) {
      pressKey(focusTarget, "Enter", 13);
      const committed = await waitFor(
        () => (comboboxShowsValue(trigger, value) || isCollapsed(trigger) ? true : null),
        sleep,
        commitWaitMs,
        pollMs
      );
      if (committed) return true;
    }
    // Stall detection keyed on option identity (id, else its text), so it also
    // fires for listboxes whose options carry no id, and when none is active.
    const activeKey = active ? active.id || optionText(active) : "__none__";
    if (activeKey === lastActiveKey) {
      if (++stalls >= 2) break; // highlight stopped moving — end of list
    } else {
      stalls = 0;
    }
    lastActiveKey = activeKey;
  }
  return false;
}

/** A keydown+keyup pair carrying the legacy keyCode fields some widgets require. */
function pressKey(el: HTMLElement, key: string, keyCode: number): void {
  const init: KeyboardEventInit & { keyCode: number; which: number } = {
    key,
    code: key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** The currently-highlighted option: aria-activedescendant first, then common
 *  "active/focused/highlighted" markers within the listbox. */
function activeOption(
  trigger: HTMLElement,
  focusTarget: HTMLElement,
  listbox: HTMLElement | null
): HTMLElement | null {
  const activeId =
    focusTarget.getAttribute("aria-activedescendant") ||
    trigger.getAttribute("aria-activedescendant") ||
    "";
  if (activeId) {
    const byId = trigger.ownerDocument.getElementById(activeId);
    if (byId) return byId;
  }
  if (!listbox) return null;
  return listbox.querySelector<HTMLElement>(
    '[role="option"][aria-selected="true"], [role="option"][data-focused="true"], ' +
      '[role="option"].active, [role="option"][class*="focus" i], [role="option"][class*="highlight" i]'
  );
}

// ---------------------------------------------------------------------------
// Interaction primitives
// ---------------------------------------------------------------------------

/** A realistic activation sequence: pointer + mouse + click. Pointer events are
 *  a best-effort nicety (jsdom's PointerEvent is stricter than the DOM spec);
 *  the mouse events are what actually drive jsdom and real widgets. */
function activate(el: HTMLElement): void {
  const base: MouseEventInit = { bubbles: true, cancelable: true };
  firePointer(el, "pointerdown");
  el.dispatchEvent(new MouseEvent("mousedown", base));
  firePointer(el, "pointerup");
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
}

function firePointer(el: HTMLElement, type: string): void {
  const PE = (el.ownerDocument.defaultView as unknown as { PointerEvent?: typeof PointerEvent })?.PointerEvent;
  if (!PE) return;
  try {
    el.dispatchEvent(new PE(type, { bubbles: true, cancelable: true }));
  } catch {
    // jsdom rejects some PointerEvent inits — ignore; mouse events cover it.
  }
}

function open(trigger: HTMLElement): void {
  trigger.focus({ preventScroll: true });
  if (trigger.getAttribute("aria-expanded") === "true") return;
  activate(trigger);
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
  activate(option);
}

function isTypeahead(trigger: HTMLElement): boolean {
  if (!(trigger instanceof HTMLInputElement)) return false;
  const ac = (trigger.getAttribute("aria-autocomplete") || "").toLowerCase();
  return ac === "list" || ac === "both" || ac === "inline" || trigger.type === "text";
}

/**
 * The text field used to filter/search a combobox's options, if any:
 *   1. a typeahead trigger that is itself an <input> (react-select);
 *   2. the widget's own search box, which large dropdowns (Workday country,
 *      skills…) mount inside the opened popup and usually auto-focus — so the
 *      active element right after opening is a strong signal;
 *   3. otherwise the first visible text input inside the opened popup/listbox.
 * Returns null for plain button dropdowns that render every option at once
 * (nothing to type into) so their behaviour is unchanged.
 */
function findSearchInput(trigger: HTMLElement, listbox: HTMLElement | null): HTMLInputElement | null {
  if (trigger instanceof HTMLInputElement && isTypeahead(trigger)) return trigger;

  const NON_TEXT = new Set(["hidden", "checkbox", "radio", "file", "submit", "button", "range", "color"]);
  const isSearchy = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement && el !== trigger && !NON_TEXT.has(el.type) && isVisible(el);

  // The popup commonly moves focus to its search box on open.
  const active = trigger.ownerDocument.activeElement;
  if (isSearchy(active)) return active;

  // Otherwise look for a search input inside the opened popup around the listbox.
  if (listbox) {
    const popup =
      listbox.closest('[role="dialog"], [class*="popup" i], [class*="menu" i], [class*="dropdown" i]') ??
      listbox.parentElement ??
      listbox;
    const input = popup.querySelector(
      'input[type="text"], input[type="search"], input:not([type]), input[aria-autocomplete], input[role="combobox"]'
    );
    if (isSearchy(input)) return input;
  }
  return null;
}

function typeInto(input: HTMLInputElement, value: string): void {
  setNativeValue(input, value);
  dispatchInputEvents(input, value);
}

/**
 * Search queries to try, in order, when filtering a typeahead/searchable list.
 * The full value first; then each comma/slash/pipe segment, coarsest LAST-first
 * (a "City, State, Country" location is searched by "Country" before "City"),
 * since dropdowns that carry this problem — country/region prompts — key on the
 * trailing segment. De-duplicated, so a value with no separators is just itself.
 */
function searchQueries(value: string): string[] {
  const segments = value
    .split(/[,/|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [value];
  const wholeAlias = countryAlias(value);
  if (wholeAlias) out.push(wholeAlias);
  // Coarsest (trailing) segment first — a "City, State, Country" location is
  // searched by country before city. Each segment also contributes its country
  // alias ("USA" → "United States") so the widget's own search renders it.
  for (let i = segments.length - 1; i >= 0; i--) {
    out.push(segments[i]);
    const alias = countryAlias(segments[i]);
    if (alias) out.push(alias);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Listbox + option lookup
// ---------------------------------------------------------------------------

/** Locate the open listbox: prefer the one the combobox points at (it may be
 *  portaled far away in the DOM), else any visible listbox in the document. */
function getListbox(trigger: HTMLElement): HTMLElement | null {
  const doc = trigger.ownerDocument;
  const ids = `${trigger.getAttribute("aria-controls") ?? ""} ${trigger.getAttribute("aria-owns") ?? ""}`.trim();
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const lb = (el.getAttribute("role") === "listbox" ? el : el.querySelector('[role="listbox"]')) as HTMLElement | null;
    if (lb && isVisible(lb) && hasOptions(lb)) return lb;
  }
  // Fallback: a visible listbox with options anywhere (portals, shadow roots).
  for (const lb of deepQueryAll(doc, '[role="listbox"]')) {
    if (isVisible(lb) && hasOptions(lb)) return lb;
  }
  return null;
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

/** Texts of react-select-style single/multi-value display elements near the trigger. */
function valueContainerTexts(trigger: HTMLElement): string[] {
  // NB: do not include [role="combobox"] here — the trigger itself is often the
  // role=combobox element, and closest() would return it (an <input> has no
  // value-display descendant). Climb to the select/combobox wrapper instead;
  // querySelectorAll is recursive, so a value nested under a classless
  // div[role=combobox] is still found via the trigger's parent.
  const container =
    trigger.closest('[class*="select" i], [class*="combobox" i]') ??
    trigger.parentElement ??
    trigger;
  return Array.from(
    container.querySelectorAll(
      '[class*="single-value" i], [class*="singlevalue" i], [class*="multi-value" i], [class*="multivalue" i]'
    )
  ).map((e) => cleanText(e.textContent));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function isCollapsed(trigger: HTMLElement): boolean {
  return trigger.getAttribute("aria-expanded") === "false";
}

/** Whether the combobox's committed/displayed value reflects the target. */
function comboboxShowsValue(trigger: HTMLElement, value: string): boolean {
  const candidates: string[] = [];
  if (trigger instanceof HTMLInputElement && trigger.value) candidates.push(trigger.value);
  if (trigger.tagName === "BUTTON") candidates.push(cleanText(trigger.textContent));
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
  return true;
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
