/**
 * Bundle entry for the headless smoke test (see scan-smoke.mjs).
 * Re-exports the pure-DOM engine pieces so they can run under jsdom.
 */
export { scanPage } from "../src/content/formScanner";
export { AutofillReconciler } from "../src/content/reconciler";
export { MOCK_PROFILE } from "../src/api/mockProfile";
export { AUTOFILL_CONFIDENCE_THRESHOLD } from "../src/shared/constants";
