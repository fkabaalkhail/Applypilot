/**
 * Browser harness entry — bundled by build.mjs into dist/harness.js and injected
 * into a real Chromium page (or iframe realm) by the Playwright spec.
 *
 * It runs the EXACT shipping engine the content script uses — scanPage +
 * AutofillReconciler + fillAriaCombobox — against the same fixtures the jsdom
 * suite uses, then reads every control back from the live DOM so the spec can
 * assert the autofill actually committed. No overlay / background / network.
 */
import { scanPage } from "../../src/content/formScanner";
import type { RuntimeControl } from "../../src/content/formScanner";
import { AutofillReconciler } from "../../src/content/reconciler";
import { fillAriaCombobox, readComboboxValue } from "../../src/content/comboboxEngine";
import { cleanText } from "../../src/content/domUtils";
import { base64ToFile, injectResumeFile } from "../../src/content/fileUpload";
import { MOCK_PROFILE } from "../../src/api/mockProfile";
import type { DetectedField, UserApplicationProfile } from "../../src/shared/types";

// Fixtures — identical builders the jsdom suite mounts.
import { mountGreenhouseForm, mountLeverForm, mountBambooHrForm, mountBreezyForm } from "../fixtures/easy";
import {
  mountAshbyForm,
  mountWorkableForm,
  mountSmartRecruitersForm,
  mountJobviteForm,
  mountRipplingForm,
  mountBullhornForm,
} from "../fixtures/medium";
import { mountWorkdayMyInfo } from "../fixtures/workday";
import { mountIcimsForm } from "../fixtures/icims";
import { mountTaleoForm } from "../fixtures/taleo";
import { mountAdpForm } from "../fixtures/adp";
import { mountSuccessFactorsForm } from "../fixtures/successfactors";
// Browser-only.
import { mountWorkdayShadow } from "./fixtures/workdayShadow";

type MountFn = (doc: Document) => unknown;

const FIXTURES: Record<string, MountFn> = {
  // Easy
  greenhouse: mountGreenhouseForm,
  lever: mountLeverForm,
  bamboohr: mountBambooHrForm,
  breezy: mountBreezyForm,
  // Medium
  ashby: mountAshbyForm,
  workable: mountWorkableForm,
  smartrecruiters: mountSmartRecruitersForm,
  jobvite: mountJobviteForm,
  rippling: mountRipplingForm,
  bullhorn: mountBullhornForm,
  // Hard
  workday: mountWorkdayMyInfo,
  icims: mountIcimsForm,
  taleo: mountTaleoForm,
  adp: mountAdpForm,
  successfactors: mountSuccessFactorsForm,
  // Browser-only (shadow DOM)
  "workday-shadow": mountWorkdayShadow,
};

// Real (non-stubbed) sleeps so the combobox open→commit timing is exercised, but
// fast — the fixtures mount their listbox synchronously on click.
const COMBO = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  openWaitMs: 800,
  commitWaitMs: 800,
  pollMs: 20,
};

/** The two-phase fill the content script runs in onAutofill. */
async function runAutofill(profile: UserApplicationProfile, fillEEO: boolean) {
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
    const el = registry.get(f.id)?.el;
    if (el) await fillAriaCombobox(el, f.proposedValue as string, COMBO);
  }
  return { fields, registry };
}

/** Read the live, committed value of any control type straight from the DOM. */
function readActual(control: RuntimeControl | undefined): string {
  if (!control) return "";
  const el = control.el;
  switch (control.controlType) {
    case "select":
      return (el as HTMLSelectElement).value;
    case "text":
    case "textarea":
      return (el as HTMLInputElement | HTMLTextAreaElement).value;
    case "contenteditable":
      return cleanText(el?.textContent ?? "");
    case "file":
      return (el as HTMLInputElement).value;
    case "checkbox":
      return (el as HTMLInputElement).checked ? "true" : "";
    case "radioGroup":
      return control.radios?.find((r) => r.checked)?.value ?? "";
    case "checkboxGroup":
      return (control.checkboxes ?? [])
        .filter((c) => c.checked)
        .map((c) => c.value)
        .join(", ");
    case "ariaRadioGroup": {
      const checked = el?.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null;
      return checked?.getAttribute("data-value") ?? cleanText(checked?.textContent ?? "");
    }
    case "combobox":
    case "customDropdown": {
      const v = el ? readComboboxValue(el) : undefined;
      if (v) return v;
      if (el instanceof HTMLInputElement) return el.value;
      return cleanText(el?.textContent ?? "");
    }
    default:
      return "";
  }
}

export interface FieldResult {
  id: string;
  label: string;
  category: string;
  controlType: string;
  fillable: boolean;
  sensitive: boolean;
  expected: string | null;
  actual: string;
}

/** Mount → autofill → read back every detected field. Pure data out, asserted in Node. */
async function fillAndVerify(name: string, fillEEO: boolean): Promise<FieldResult[]> {
  const mount = FIXTURES[name];
  if (!mount) throw new Error(`unknown fixture: ${name}`);
  mount(document);
  const { fields, registry } = await runAutofill(MOCK_PROFILE, fillEEO);
  return fields.map((f: DetectedField) => ({
    id: f.id,
    label: f.label,
    category: f.category,
    controlType: f.controlType,
    fillable: f.fillable,
    sensitive: Boolean((f as { sensitive?: boolean }).sensitive),
    expected: f.proposedValue,
    actual: readActual(registry.get(f.id)),
  }));
}

/** Same, but with an EEO-bearing profile so the EEO-enabled path can be checked. */
async function fillAndVerifyEeo(name: string): Promise<FieldResult[]> {
  const mount = FIXTURES[name];
  if (!mount) throw new Error(`unknown fixture: ${name}`);
  mount(document);
  const profile: UserApplicationProfile = {
    ...MOCK_PROFILE,
    eeo: {
      gender: "Female",
      race: "Asian",
      hispanicLatino: "No",
      veteranStatus: "I am not a veteran",
      disabilityStatus: "No",
    },
  } as UserApplicationProfile;
  const { fields, registry } = await (async () => {
    const { fields, registry } = scanPage(profile, true);
    const targets = fields.filter((f) => f.fillable && f.proposedValue !== null);
    const engine = new AutofillReconciler({ sleep: async () => {}, observe: false });
    await engine.run(
      targets.filter((f) => f.controlType !== "combobox").map((f) => ({ fieldId: f.id, value: f.proposedValue as string })),
      registry
    );
    engine.dispose();
    for (const f of targets.filter((f) => f.controlType === "combobox")) {
      const el = registry.get(f.id)?.el;
      if (el) await fillAriaCombobox(el, f.proposedValue as string, COMBO);
    }
    return { fields, registry };
  })();
  return fields.map((f: DetectedField) => ({
    id: f.id,
    label: f.label,
    category: f.category,
    controlType: f.controlType,
    fillable: f.fillable,
    sensitive: Boolean((f as { sensitive?: boolean }).sensitive),
    expected: f.proposedValue,
    actual: readActual(registry.get(f.id)),
  }));
}

export interface UploadTestResult {
  ok: boolean;
  reason?: string;
  fileName: string;
  fileCount: number;
  changeFired: boolean;
}

/**
 * Mount a fixture with a résumé file input, then run the real injectResumeFile
 * (DataTransfer-based) the overlay's "attach résumé" action uses. Reads back the
 * input's FileList — the real-browser capability jsdom cannot reproduce.
 */
function testFileUpload(
  name: string,
  b64: string,
  fileName: string,
  type: string
): UploadTestResult {
  const mount = FIXTURES[name];
  if (!mount) throw new Error(`unknown fixture: ${name}`);
  mount(document);
  const { fields, registry } = scanPage(MOCK_PROFILE, false);
  const field = fields.find((f) => f.category === "resumeUpload" && f.controlType === "file");
  const el = field ? registry.get(field.id)?.el : undefined;
  if (!el) {
    return { ok: false, reason: "no resume upload field detected", fileName: "", fileCount: 0, changeFired: false };
  }
  let changeFired = false;
  el.addEventListener("change", () => (changeFired = true));
  const file = base64ToFile(b64, fileName, type);
  const res = injectResumeFile(el, file);
  const input = el as HTMLInputElement;
  return {
    ok: res.ok,
    reason: res.reason,
    fileName: input.files?.[0]?.name ?? "",
    fileCount: input.files?.length ?? 0,
    changeFired,
  };
}

/**
 * Probe: does the country dropdown fill for an arbitrary applicant location?
 * Verifies the audit claim that country matching only works when the location
 * string literally contains the country option's name.
 */
async function probeCountry(name: string, location: string) {
  const mount = FIXTURES[name];
  if (!mount) throw new Error(`unknown fixture: ${name}`);
  mount(document);
  const profile = { ...MOCK_PROFILE, location };
  const { fields, registry } = await runAutofill(profile, false);
  const country = fields.find(
    (f) => (f.controlType === "combobox" || f.controlType === "select") && /country/i.test(f.label)
  );
  const city = fields.find((f) => f.category === "location" && f.controlType === "text");
  return {
    location,
    countryLabel: country?.label ?? null,
    countryProposed: country?.proposedValue ?? null,
    countryActual: country ? readActual(registry.get(country.id)) : null,
    cityActual: city ? readActual(registry.get(city.id)) : null,
  };
}

declare global {
  interface Window {
    __T: {
      fillAndVerify: typeof fillAndVerify;
      fillAndVerifyEeo: typeof fillAndVerifyEeo;
      testFileUpload: typeof testFileUpload;
      probeCountry: typeof probeCountry;
      fixtures: string[];
      profile: UserApplicationProfile;
    };
  }
}

window.__T = {
  fillAndVerify,
  fillAndVerifyEeo,
  testFileUpload,
  probeCountry,
  fixtures: Object.keys(FIXTURES),
  profile: MOCK_PROFILE,
};
