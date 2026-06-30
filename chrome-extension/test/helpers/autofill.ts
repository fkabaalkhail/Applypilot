import { scanPage } from "../../src/content/formScanner";
import { AutofillReconciler } from "../../src/content/reconciler";
import { fillAriaCombobox } from "../../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../../src/shared/types";

const fastCombo = { sleep: async () => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

/**
 * Run the real two-phase fill the content script performs in onAutofill: the
 * reconciler drives text/select/radio; the combobox engine drives ARIA dropdowns
 * one-shot. Scans the global document, so it works for any fixture mounted there.
 */
export async function runAutofill(profile: UserApplicationProfile, fillEEO: boolean): Promise<void> {
  const { fields, registry } = scanPage(profile, fillEEO);
  const targets = fields.filter((f) => f.fillable && f.proposedValue !== null);

  const engine = new AutofillReconciler({ sleep: async () => {}, observe: false });
  await engine.run(
    targets
      .filter((f) => f.controlType !== "combobox")
      .map((f) => ({ fieldId: f.id, value: f.proposedValue as string })),
    registry
  );
  engine.dispose();

  for (const f of targets.filter((f) => f.controlType === "combobox")) {
    await fillAriaCombobox(registry.get(f.id)!.el!, f.proposedValue as string, fastCombo);
  }
}
