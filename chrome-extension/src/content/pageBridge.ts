/**
 * MAIN-world page bridge.
 *
 * Content scripts run in an ISOLATED world: they share the DOM but not the page's
 * JS realm, so they cannot see the instance-level `value` setter React installs on
 * an <input>, nor its `_valueTracker`. A controlled React input can therefore
 * silently REVERT a value written purely from the isolated world (React's
 * dirty-check sees no change and restores the old value).
 *
 * This tiny script is injected into the page's own realm (see pageBridgeClient).
 * It listens for a postMessage from the content script and re-applies the value
 * the React-correct way: call the NATIVE prototype setter, then rewind
 * `_valueTracker` to the OLD value so the subsequent `input` event is seen as a
 * real change. It is a REINFORCEMENT — the isolated-world write already happened;
 * this makes it stick on frameworks that would otherwise revert it.
 *
 * Best-effort by design: if the page CSP blocks the injected script it simply
 * never runs and the isolated-world write stands. It never reads or exfiltrates
 * anything; it only writes a value we already wrote.
 */
type BridgeMessage = {
  __apPageBridge: true;
  action: "setValue";
  fieldId: string;
  value: string;
};

(function initPageBridge(): void {
  const FIELD_ID_ATTR = "data-ap-field";

  /** Find the target across the document and any OPEN shadow roots. */
  function findByFieldId(id: string): HTMLElement | null {
    // Field ids are frame-token + counter (alphanumeric/hyphen); a minimal escape
    // of quotes/backslashes keeps the attribute selector valid regardless.
    const sel = `[${FIELD_ID_ATTR}="${id.replace(/["\\]/g, "\\$&")}"]`;
    const direct = document.querySelector<HTMLElement>(sel);
    if (direct) return direct;
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      const hit = root.querySelector<HTMLElement>(sel);
      if (hit) return hit;
      root.querySelectorAll("*").forEach((el) => {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) stack.push(sr);
      });
    }
    return null;
  }

  /** Write `value` the way React/Vue/Angular will register: native prototype
   *  setter + `_valueTracker` rewind + the full input/change lifecycle. */
  function applyValue(el: HTMLElement, value: string): void {
    const isText = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (!isText) return;
    const node = el as HTMLInputElement | HTMLTextAreaElement;
    const proto =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const previous = node.value;
    const protoSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try {
      if (protoSetter) protoSetter.call(node, value);
      else node.value = value;
    } catch {
      node.value = value;
    }
    // Rewind React's tracked value to the OLD value so its onChange dirty-check
    // (which compares tracker vs current on the `input` event) sees a real diff.
    const tracker = (node as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
    if (tracker && previous !== value) {
      try {
        tracker.setValue(previous);
      } catch {
        /* not a tracked input — ignore */
      }
    }
    node.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
    node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data as Partial<BridgeMessage> | null;
    if (!data || data.__apPageBridge !== true || data.action !== "setValue") return;
    if (typeof data.fieldId !== "string" || typeof data.value !== "string") return;
    // Field ids are frame-token + counter (alphanumeric/hyphen/underscore). Reject
    // anything else so a crafted message can't inject a selector or throw.
    if (!/^[A-Za-z0-9_-]+$/.test(data.fieldId)) return;
    let el: HTMLElement | null = null;
    try {
      el = findByFieldId(data.fieldId);
    } catch {
      return;
    }
    if (el) applyValue(el, data.value);
  });
})();
