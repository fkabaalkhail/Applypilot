import type { RuntimeControl } from "./formScanner";

/** The control's element is still in the page. */
export function isLiveControl(control: RuntimeControl | undefined): boolean {
  const el = control?.el ?? control?.radios?.[0] ?? control?.checkboxes?.[0];
  return Boolean(el?.isConnected);
}

/**
 * The live control for a fill target. One the last scan lost, or whose element
 * the page replaced, is looked up again once, after the page settles and is
 * rescanned: a scan taken while an open menu hid the rest of the form (Ashby's
 * school typeahead, Superhuman's second school, 2026-10-05) must not fail a
 * field that is still there. Undefined when the rescan cannot find it either.
 */
export async function liveControlFor(
  fieldId: string,
  lookup: (id: string) => RuntimeControl | undefined,
  rescan: () => Promise<void>
): Promise<RuntimeControl | undefined> {
  const control = lookup(fieldId);
  if (isLiveControl(control)) return control;
  await rescan();
  const again = lookup(fieldId);
  return isLiveControl(again) ? again : undefined;
}
