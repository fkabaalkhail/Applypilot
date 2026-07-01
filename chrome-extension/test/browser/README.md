# Real-Chromium autofill harness

These tests drive the **actual shipping autofill engine** (`scanPage` +
`AutofillReconciler` + `fillAriaCombobox`) inside a genuine Chromium via
Playwright — covering what the jsdom suite (`npm test`) cannot: real shadow DOM,
real custom-dropdown open→click interaction, a real same-origin iframe realm, and
real `DataTransfer` file injection.

## Run

```bash
npm run test:browser     # all 15 ATS + shadow/iframe/EEO/upload scenarios
npm run test:extension   # load the packaged dist/ extension, prove it boots & detects a form
```

`test:browser` is self-contained (generates the sample résumé, bundles the
harness, runs the suite). It exits non-zero if any field fails to fill.

## What it checks

`run.mjs` mounts each fixture, runs the two-phase autofill the content script
performs, then reads **every** control back from the live DOM and asserts the
value committed:

- 15 ATS fixtures (Easy/Medium/Hard) in the top frame
- `workday-shadow` — a Workday combobox + inputs inside an **open shadow root**,
  with the listbox portaled into that shadow root (exercises `deepQueryAll`
  piercing + the combobox engine's shadow-aware listbox lookup)
- `icims-in-iframe` — the iCIMS form mounted inside a real **same-origin iframe**;
  the harness runs in that child frame's realm (mirrors `all_frames` injection)
- `workday` EEO-on — proves EEO selects fill only when the toggle + answers are present
- résumé upload — injects a real generated PDF via `injectResumeFile`'s
  `DataTransfer` path and confirms the `FileList` + `change` event

`load-extension.mjs` loads the built `dist/` as an unpacked extension in full
Chromium (new headless), navigates to a served job form, and confirms the MV3
service worker registers, the content script injects, and the overlay
auto-mounts (its host element + shadow-root UI appear in the page DOM).

## Files

| File | Role |
|------|------|
| `entry.ts` | Browser bundle entry — exposes `window.__T` (`fillAndVerify`, `fillAndVerifyEeo`, `testFileUpload`) |
| `build.mjs` | esbuild bundles `entry.ts` → `dist/harness.js` (injected via `addScriptTag`) |
| `run.mjs` | Playwright runner + per-field assertions + report |
| `load-extension.mjs` | Packaged-extension boot/detect smoke |
| `gen-resume.mjs` | Generates a valid sample résumé PDF + txt |
| `fixtures/workdayShadow.ts` | Browser-only shadow-DOM Workday fixture |

The ATS fixtures themselves live in `../fixtures/` and are shared with the jsdom
suite — same builders, exercised here in a real browser.
