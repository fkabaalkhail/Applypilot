# Jobright Autofill — Reverse‑Engineering Analysis & Reimplementation Blueprint

> Reference analyzed: `1.15.0_0/` (also present as `jobright-extension-ref/`) — **Jobright Autofill v1.15.0**, a Manifest V3 Chrome extension built with the **Plasmo** framework (Parcel bundler). All bundles are minified; findings below are derived from static extraction of surviving string literals, Parcel export/require metadata, and control‑flow fragments. Nothing here was copied — this document describes **behavior** for a clean‑room rebuild.

---

## 1. Identity & scope

| Field | Value |
|---|---|
| Name | "Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume" |
| Author | Jobright.ai |
| Version | 1.15.0 |
| Framework | Plasmo (Parcel), React + Ant Design + `@ant-design/cssinjs`, lottie (bodymovin) |
| Backend | `https://api.jobright.ai` (host site `https://jobright.ai`, cookie domain `.jobright.ai`) |
| Internal modules | ~383 (via `~`-aliased Parcel requires) |
| Supported ATS/company sites | ~60 (131 site‑adapter modules) |

**Value proposition:** one‑click autofill of job applications across ~60 ATS platforms, AI‑generated answers for custom questions, AI resume tailoring + cover‑letter generation, all backed by the user's Jobright account/profile.

---

## 2. Manifest & permissions (MV3)

- **`manifest_version: 3`**, background = **service worker** (`static/background/index.js`). No deprecated background page. ✅ MV3‑correct.
- **Permissions:** `storage`, `declarativeNetRequest`, `tabs`, `cookies`, `activeTab`, `scripting`.
- **Host permissions:** `http://*/*`, `https://*/*`, `<all_urls>` (needs to run on any employer/ATS domain).
- **`web_accessible_resources`** (`<all_urls>`): the Inter font, SVG/PNG UI assets, and **injectable MAIN‑world scripts** `answer.d77729c7.js`, `dom.ed166d80.js`, `click-jr-injector.*.js`, `constants.*.js`, `filler.*.js`.
- **`key`** pinned (stable extension ID) and `update_url` → Chrome Web Store.

### Content scripts (all ISOLATED world unless injected otherwise)
| File | Matches | Role |
|---|---|---|
| `click-jr-injector.*.js` | `<all_urls>` | Apply‑button detection, site registry, job‑id extraction, iframe‑autofill orchestration |
| `constants.*.js` | `<all_urls>` | Shared constants (Greenhouse react‑select class names, Jobright route names) |
| `filler.*.js` | `<all_urls>` | Fill orchestration: `TaskQueue`, `ProgressTracker`, `FillError`/`ValueError` (+ bundled lodash) |
| `scroll-to-anchor.*.js` | `jobright.ai/jobs/info/*` only | Scroll‑to‑field helper on the Jobright site itself |
| `contents.*.js` (+ CSS) | `<all_urls>`, `all_frames:true` | **Main bundle:** crawler, methods, 60 site adapters, stores, hooks, and the Shadow‑DOM UI overlay |

`exclude_matches` on the main content script skips Cloudflare/recaptcha/analytics frames (`*.cloudflare.com`, `google.com/recaptcha/enterprise`, `googletagmanager`, doubleclick, LinkedIn tracking pixels) to avoid interfering with challenge/analytics iframes.

---

## 3. Execution & injection model

Three execution contexts cooperate:

1. **Isolated‑world content scripts** (`contents.js`, `click-jr-injector.js`, `filler.js`, `constants.js`) — detection, UI, orchestration, and `chrome.runtime` messaging. Only `contents.js` touches `chrome.*` (`chrome.runtime`, `chrome.storage.local`).
2. **MAIN‑world injected scripts** (`dom.js`, `answer.js`, plus per‑ATS shims) — injected on demand by the background via `chrome.scripting.executeScript({world:'MAIN'})`. These run in **page context** so they can reach the page's React internals (Fiber), native DOM prototypes, and dispatch native events. They report results back through **`CustomEvent`** (e.g. `__jr_react_select_response`, `__jr_workable_checkbox_response`). Idempotency guards: `window.__jr_react_select_injected`, `window.__jr_workable_checkbox_injected`, `window.__jr_workday_fiber_injected`.
3. **Background service worker** — the privileged hub (see §5).

**Why MAIN world matters:** modern ATS use React‑controlled inputs. Setting `.value` directly does nothing because React tracks its own state. The reference reaches into React's Fiber tree (Workday, react‑select) from page context to drive components the way a user would. Where Fiber isn't needed, it uses the **native value setter** technique (§7).

### Cross‑context messaging channels
- **Content ↔ Background:** Plasmo messaging — **68 message handlers** under `~background/messages/*` (each handler is one message name; see §9).
- **Isolated ↔ MAIN (page):** `window.postMessage` + `CustomEvent`. Custom events seen: `CancelAutoFill`, `SkipAutoFill`, `sdfFilter` (select‑dropdown filter), `CheckAgentCoverLetter`, `FromExtension`, `__jr_react_select_response`, `__jr_react_select_click_response`, `__jr_workable_checkbox_response`.
- **Cross‑frame (top ↔ iframe):** `postMessage` with an `IFRAME_EVENTS` protocol; `window.uberScrollToField`, `window.iframeLoaded` globals; `TRIGGER_BANNER_CLICK_FROM_IFRAME`.

---

## 4. Module architecture (grouped)

Derived from `~`-aliased require graph. Counts in parentheses.

- **`~background/messages` (68)** — the content↔background RPC surface (§9).
- **`~background/*`** — `cache`, `headerStripRules`, `inventoryMatchResolver`, `loginGuard`, `loginState`.
- **`~api/*` (12)** — `autoFill`, `autofill-cover-letter`, `autofill-signup-information`, `env-resolver`, `externalJob`, `feedback`, `inventoryMatch`, `job`, `profile`, `resume`, `resume-helpers`, `suggestion`.
- **`~contents/crawler` (6)** — `factory` + `utils/{checkbox,executor,input,select}` — field detection & DOM writing primitives.
- **`~contents/methods` (10)** — `answer`, `cancellation`, `checkbox-label`, `cover-letter`, `dom`, `observer`, `rules`, `runtime-error`, `submit-success-observer`, `track`.
- **`~contents/pre-autofill-flow` (5)** — `account-flow`, `core`, `dom`, `registry`, `tracking` — handles login/account‑creation walls before a form (e.g., Workday requires signup).
- **`~contents/sites` (131)** — per‑ATS adapters (§8).
- **`~core/*`** — `dom`, `xpath`, `enums`, `iframeEventHandle`, `jobPageScraper`, `markdownConverter`, `pagenation`, `cloudflare-challenge`, `utils`.
- **`~store/*` (16)** — reactive state atoms: `autofillInfo`, `autofillResult`, `autofill-diff`, `autofill-storage`, `profile`, `resume`, `cover-letter-state`, `externalJob`, `feedback`, `hide`, `inventory-match-job`, `setting`, `url`, `workday-signup-info`, `container`.
- **`~components/*`, `~hooks/*`, `~ui/*`, `~theme`** — the React overlay UI (§11).
- **`~utils/*` (30+)** — `atsDetection`, `fieldLabel`, `phone`, `date`, `gpa`, `skill-list`, `job-id`, `trace`, `indexedDB`, `blobToBase64`, `download-file`, `ab-test`, `starRating`, `workday-signup-password`, etc.

---

## 5. Background service worker (the hub)

Exports (real, non‑lodash): `API_DOMAIN`, `HOST_DOMAIN`, `COOKIE_DOMAIN`, `agentDomains`, cover‑letter helpers, `STORE_NAMES`/`indexedDBUtil`, and the API layer. Responsibilities:

1. **API gateway to `api.jobright.ai`** (all network calls proxied here so content scripts avoid CORS and keep the token out of the page):
   - `fetchAutoFillAnswer` — **core**: send the form's fields/questions, receive answers/values.
   - `fetchRuleByElements` — send serialized DOM elements, receive fill **rules**.
   - `fetchRuleByAgentQL` — server‑side **AgentQL** semantic DOM query → rules for unknown forms.
   - `fetchAnswerRegeneration` — regenerate a single answer.
   - `fetchSiteToken` — per‑site auth token.
   - `fetchAutofillBalance`, `getCreditSwitchStatus`, `getPaymentSubscription`, `getPaymentPriceV2` — credits/paywall.
   - `getAutofillConfig` (remote feature config), `getAbUser` (A/B bucket), `trackEvent` (analytics).
   - `fetchAutofillCoverLetter` / `generateAutofillCoverLetterMessage` — cover‑letter generation.
   - HTTP helpers: `HTTP_STATUS_CODES`, `CUSTOM_ERROR_CODES`, `isAutofillTerminalHttpStatus`, `TIMEOUT_DURATION_MS`, `RETRYABLE_FAILURE`.
2. **Auth via cookies** — reads the `jr_id` cookie on `.jobright.ai` (`chrome.cookies.get/getAll` + `onChanged` to react to login/logout). Exchanges for a site token (`fetchSiteToken`).
3. **Header stripping via `declarativeNetRequest.updateSessionRules`** (`~background/headerStripRules`): removes response headers **`x-frame-options`**, **`content-security-policy`**, **`content-disposition`** for `main_frame`+`sub_frame` on target domains. Rule shape:
   ```
   { id, priority:1,
     action:{ type:"modifyHeaders", responseHeaders:[{header, operation:"remove"}] },
     condition:{ regexFilter:"^https?://<domain>(?:[/:?#]|$)", resourceTypes:["main_frame","sub_frame"] } }
   ```
   Purpose: **embed the ATS application page in an iframe inside Jobright's "agent apply" flow** (strip XFO/CSP) and fetch/convert resume & cover‑letter PDFs inline (strip content‑disposition).
4. **MAIN‑world script injection** via `chrome.scripting.executeScript` — handlers `injectReactSelectFiber`, `injectWorkdayFiber`, `injectWorkableCheckbox`, `installMainWorldAlertSuppressor` (suppress page `window.alert`/`beforeunload`), `interceptFileInputClick` (hijack file picker to inject the resume blob).
5. **IndexedDB cache** (`indexedDBUtil`, `STORE_NAMES`) — caches resume/cover‑letter blobs, autofill answers, rules.
6. **Tab management** — `tabs.create/update/remove/query`, `onUpdated`/`onRemoved`; opens the Jobright tailor/apply tab, tracks the active application tab.
7. **External messaging** — `runtime.onMessageExternal` lets the **jobright.ai website** talk to the extension (e.g., "start agent apply for job X"). `onConnect` long‑lived ports for streaming progress.
8. **Lifecycle** — `onInstalled` (seed config), `setUninstallURL` → `jobright.ai/autofill/uninstall` (offboarding survey), `action.onClicked` (toolbar → open Jobright).

---

## 6. Field detection — the crawler (`~contents/crawler/factory`)

The crawler scans a form and produces a normalized field model. Field **types** emitted: `text`, `select`, `checkbox`, `radio`, `file`, `location`, `complex` (composite/repeating groups such as education/employment history).

Signals used to classify a field (via `~utils/fieldLabel`, `~core/xpath`, `~core/dom`):
- Associated `<label>` text, `aria-label`/`aria-labelledby`, placeholder, `name`/`id`, nearby text, and role.
- XPath addressing for stable re‑location (`~core/xpath`).
- Custom‑widget detection: native `<select>` vs. react‑select/typeahead/combobox vs. Lever "Lyte" dropdown (`LYTE-DROPDOWN`) vs. Workday widgets.
- Repeating‑group detection (`collectFormDataWithRepeatingGroups` in the injector) for education/work sections.
- `~utils/skill-list`, `~utils/gpa`, `~utils/date`, `~utils/phone`, `~constants/country`, `~constants/phone-country-code` provide domain vocabularies for value normalization.

Answer resolution is a **hybrid**: local structural detection + **server‑side AI answers** (`fetchAutoFillAnswer`) + per‑site rule modules (`~contents/sites/<ats>/rules`). Fuzzy string matching (`isMatched`, `findClosestStringId`, `levenshteinDistance`) picks the closest option in dropdowns/radios.

---

## 7. Fill engine & DOM techniques (`dom.ed166d80.js`, `~contents/crawler/utils/*`)

MAIN‑world primitives (`dom.js` exports): `fillInputTextField`, `fillCheckBoxesField`, `fillSelectField` (custom widgets), `fillOriginSelectField` (native `<select>`), `uploadFiles`, `triggerEvents`, `postCoverLetterStatus`. These delegate into `~contents/crawler/utils/{input,checkbox,select}`.

**Key techniques observed:**
- **React‑compatible value set:** `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el, value)` — bypasses React's value tracker so the framework "sees" the change. (Found in the crawler input util and in injected background scripts.)
- **Event sequence:** dispatch `focus` (`FocusEvent`), `beforeinput`, `input` (`InputEvent`), `change` (`Event`), `blur`, plus `keyup`/`keydown` where widgets need keystrokes; `mousedown`+`mouseup`+`click` for option selection. All `{bubbles:true, cancelable:true}`.
- **Native `<select>`:** iterate `options`, fuzzy‑match `option.text` (`isMatched`), set + `click()` + dispatch `mousedown`/`mouseup`/`change`.
- **Custom dropdowns (react‑select, etc.):** open the menu, emit a filter (`sdfFilter`), wait for options, click the match; Fiber injection for stubborn components.
- **Checkboxes/consent (`~contents/methods/checkbox-label`):** label‑aware logic for agreement/consent ("have read", "I agree"), "currently employed/current", and negative defaults ("no" for sponsorship/relocation unless profile says otherwise).
- **File upload (`uploadFiles`):** build a `DataTransfer`, set `input.files`, dispatch `change`; for drag‑drop zones, synthesize `dragenter`/`drop`. The resume blob is fetched by the background (`getResumeBlob`/`getBaseResumeBlob`) and passed in; `interceptFileInputClick` catches native pickers.
- **Orchestration (`filler.js`):** `TaskQueue` runs fill tasks sequentially with a `ProgressTracker`; `FillError`/`ValueError` classify failures; retries on `RETRYABLE_FAILURE`.
- **Observers (`~contents/methods/observer`, `submit-success-observer`):** MutationObservers watch for async‑rendered fields, multi‑step page transitions, and submission success to advance/track.

---

## 8. ATS site‑adapter pattern (`~contents/sites/*`)

Each major ATS gets a sub‑package, typically `{rules, answer, operations}` plus specialized modules:
- **Greenhouse** — `rules`, `answer`, `education-operation`, `location-operation`, `snapshot-alignment`, `validation-tracking`, `resolve-tracking` (+ Greenhouse v2 react‑select class constants).
- **Workday (myworkday)** — `rules`, `answer`, `operations`, `education-operation`, `snapshot-alignment`, `account-preflow` (signup wall), Fiber injection.
- **Oracle Cloud** — `rules`, `answer`, `operations`, `address-operation`, `url`.
- **Ashby** — `rules`, `answer`, `operations`, `native-select`, `canonical-search`.
- **Workable / Jobvite / Breezy / Paylocity / Polymer / Recruiterflow / Zoho (v1+v2)** — `rules`/`answer`/`operations` each.
- **Company‑specific:** amazon, apple (`typeahead`), google, tesla, uber, walmart, cisco, adobe, intuit, bytedance, tiktok, metacareers, ycombinator, gusto, hubspot, okta.
- **Generic fallback:** `base-filler`, `careers-page`.

Detection (`~utils/atsDetection`): a **site registry** mapping each platform to `{ patterns:["*://*.oraclecloud.com/*", …], domains:["icims.com"], iframeDomains:["icims.com"] }`, plus job‑id query‑param maps (`gh_jid`/`gh_src` for Greenhouse, `ashby_jid`, etc.) and `MatchPattern` URL matching. `PAGE_SOURCE_ATS_LIST` also sniffs page HTML for ATS signatures.

**Supported platforms (counts = code volume, i.e. handling depth):** workday(278) · icims(249) · greenhouse(127) · myworkday(113) · dayforce(94) · ashby(93) · avature(84) · oraclecloud(82) · phenom(73) · taleo(74) · sap/successfactors · smartrecruiters · jobvite · paylocity · bamboohr · brassring · rippling · gohire · eightfold · jobscore · teamtailor · breezy · recruitee · personio · hrmdirect · clearcompany · paycom · ukg · jazzhr · dover · applytojob · adp (myjobs/recruiting/workforcenow) · plus company portals.

---

## 9. Messaging protocol — the 68 background handlers (`~background/messages/*`)

Grouped by concern (each is a Plasmo message name = a content→background RPC):

- **Autofill core:** `getAutofillConfig`, `getAutofillInfo`, `saveAutofillInfo`, `getCurrentFillAnswer`, `resolveAutofillOperation`, `updateAutofillSection`, `getRulesBase`, `getRulesByUrl`, `getAgentQLRule`, `regenerateAnswer`, `saveSubmitStatus`.
- **Answers / suggestions:** `getGptResults`, `getDegreeSuggestions`, `getMajorSuggestions`, `getCompanyNameList`, `getAddressComponents`, `getOpenCitiesByRegion`, `getOpenRegions`.
- **Resume:** `getResumeInfo`, `getResumeCollection`, `updateResumeCollection`, `getResumeBlob`, `getBaseResumeBlob`, `previewBaseResumeBlob`, `getTailorResume`, `getTailorResumeBlob`, `previewTailorResumeBlob`, `getAgentTailorResume`, `getResumeDiagnose`, `convertResumePdfToWord`.
- **Cover letter:** `generateAutofillCoverLetter`, `getAgentCoverLetter`, `getCurrentCoverLetter`, `getCoverLetterBlob`.
- **Job data:** `getJobDetail`, `getJobBannerDetail`, `getSimilarJobs`, `saveJobDetail`, `postApplyJob`, `resolveJobIdByUrl`, `getExternalJobId`, `saveExternalJobId`, `getExternalJobStatus`, `countExternalJobIds`, `postExternalJobImport`, `getPageLinkedinJobInfo`.
- **Profile / auth / credits:** `getUserProfile`, `getSiteToken`, `getAbUser`, `getCreditsLeft`, `getCreditFeed`, `getCreditSwitchStatus`, `getPaymentPrice`.
- **MAIN‑world injection:** `injectReactSelectFiber`, `injectWorkdayFiber`, `injectWorkableCheckbox`, `installMainWorldAlertSuppressor`, `interceptFileInputClick`, `uploadBrassringProfileBuilderFile`.
- **Tab / page:** `getCurrentTabId`, `getCurrentTabUrl`, `getTabContext`, `openAgentApplyTab`, `parsePageMarkdown`.
- **Feedback / tracking:** `postAutofillFeedback`, `postPluginFeedback`, `postEventSubmit`, `postSimilarJobPopupExposure`.

---

## 10. State & storage

- **`chrome.storage.local`** — config, auth/session mirror, per‑user namespaced flags, autofill diff/result cache.
- **IndexedDB** (`indexedDBUtil`, `STORE_NAMES`) — large blobs (resume/cover‑letter PDFs), rules, answers.
- **In‑memory reactive stores** (`~store/*`, 16 atoms) — drive the React UI: current autofill info/result/diff, profile, resume, cover‑letter state, external‑job import, feedback, hide/visibility, A/B, current URL/job id, Workday signup info.
- **Cookies** — `jr_id` (session identity) on `.jobright.ai`; `resume_id` tracked as a key.

---

## 11. UI (Plasmo CSUI, Shadow DOM)

- Rendered via Plasmo Content‑Script UI: `createShadowContainer`/`createRender`/`OverlayCSUIContainer`/`InlineCSUIContainer` mount a **Shadow DOM** host (`HOST_ID`) to isolate styles; Ant Design components styled with `@ant-design/cssinjs`; Inter font shipped as a web‑accessible resource.
- Surfaces: floating draggable autofill button/banner (`LinkedinBannerProvider`, `DraggableIcon`), fill‑progress panel (`FillProgress`), autofill‑info modal, cover‑letter review drawer, resume switcher/review, external‑job import wizard (`ExternalJob/*`), payment/out‑of‑credit modals, star‑rating & review prompts (`StarRatingModal`, `GoodReviewsModel`/`CriticizeReviewsModal`), setting panel, onboarding.
- Lottie animations (bodymovin) for the "AI star" loading states.
- Lifecycle hooks (`~hooks/*`): `useStartAutofill`, `useSubmitApplication`, `useShowContinue/Submitted`, `useSkipTimer`, `useRegisterAgentCancel/Skip`, `usePreAutofillFlowRunner`, `useTrackAutofillStuck`, `useSubscribeTabUrl`, `usePaginationObserver`.

---

## 12. End‑to‑end runtime flows

**A. Activation / detection.** On every page, `click-jr-injector` + `contents.js` run. `atsDetection` matches the URL/host against the site registry (and sniffs page HTML). Apply buttons are detected via `matchesApplyHeuristic`/`matchesSiteSpecificPattern`; clicking is intercepted (`handleClickForJrInjection`) to keep the Jobright job id in the URL and open the tailored flow.

**B. Auth.** Background reads `jr_id` cookie → `fetchSiteToken` → token attached to API calls. `loginGuard`/`loginState` gate features when logged out; not‑available state shown otherwise.

**C. Autofill (one‑click).** UI `useStartAutofill` → crawler scans form → fields serialized → background `fetchAutoFillAnswer` / `fetchRuleByElements` / `getRulesByUrl` (+ `fetchRuleByAgentQL` fallback for unknown forms) → returns answers/rules → per‑site `operations` translate rules into fill tasks → `filler` `TaskQueue` executes via `dom.js` primitives (native setter + event sequence) → `ProgressTracker` streams progress to UI → `submit-success-observer` confirms → `saveSubmitStatus`/`postApplyJob`/`trackEvent`.

**D. Agent apply (iframe).** From jobright.ai (external message) → background strips XFO/CSP headers → ATS form embedded in an iframe inside Jobright → `startIframeAutoFill` drives the fill via the `IFRAME_EVENTS` postMessage protocol; user can `CancelAutoFill`/`SkipAutoFill`.

**E. Repeating sections.** Education/employment handled by `getEducationOperations`/`getEmploymentOperations` (`answer.js`) + per‑site `education-operation`/`operations`; `parseDateParts` normalizes dates; `buildAutocompleteAnswerCandidates` feeds typeaheads (school/company/major).

**F. Cover letter & resume tailoring.** `generateAutofillCoverLetter`/`fetchAutofillCoverLetter` → PDF/Word blob (`convertPdfBlobToWordFile`) → uploaded to the file field; resume tailoring via `getTailorResume`/`getAgentTailorResume`.

**G. Credits/paywall.** `fetchAutofillBalance`/`getCreditsLeft` gate autofill; `OutofCreditModal`/`PaymentEntry` when exhausted.

---

## 13. Our extension vs. Jobright — gap analysis

Our extension (`chrome-extension/src`, ~8.8k LOC, 31 files) already mirrors the conceptual architecture. Mapping + gaps:

| Capability | Jobright module(s) | Our module | Status / gap |
|---|---|---|---|
| Field detection | `crawler/factory`, `fieldLabel`, `xpath` | `formScanner.ts`, `domUtils.ts` | ✅ present; add XPath re‑location, repeating‑group detection, richer widget typing |
| Field classification | AI answers + per‑site `rules` | `fieldMatcher.ts` (local heuristics) | ⚠️ local‑only; add server‑answer path + per‑site rule hooks |
| AI answering | `fetchAutoFillAnswer`, `fetchRuleByElements`, AgentQL | `aiFillPlanner.ts` + `api/aiFill.ts` (longform only) | ⚠️ AI is secondary; promote to primary answer source with rule caching |
| DOM write | `dom.js` + `crawler/utils/input` (native setter) | `writeEngine.ts` | ✅ present; verify native‑setter + full event sequence parity |
| Custom dropdowns | react‑select/Workday **Fiber injection**, Lyte | `comboboxEngine.ts` (aria combobox) | ❌ no MAIN‑world Fiber injection; biggest robustness gap |
| Checkboxes/consent | `checkbox-label` | `consent.ts` | ✅ present; extend consent/negative‑default logic |
| File upload | `uploadFiles`, `interceptFileInputClick` | `fileUpload.ts` | ✅ present; add file‑picker interception + drag‑drop zones |
| Cross‑frame | `iframeEventHandle`, `IFRAME_EVENTS` | `crossFrame.ts` | ⚠️ same‑origin only; no header‑strip iframe agent‑apply |
| Captcha | fills around, never suspends | `captcha.ts` | ✅ matches our documented decision |
| Job scraping | `jobPageScraper` | `jobContext.ts` | ✅ present |
| Per‑site adapters | `sites/*` (60) | constants‑level ATS awareness only | ❌ no per‑site adapters — the largest breadth gap |
| Header stripping | `declarativeNetRequest` XFO/CSP/CD removal | — | ❌ absent (only needed for iframe agent‑apply) |
| MAIN‑world injection | `chrome.scripting {world:MAIN}` shims | — | ❌ absent |
| State stores | `~store/*` (16) | `shared/storage.ts` + module state | ⚠️ simpler; fine for our scope |
| UI overlay | Plasmo CSUI + Ant Design | `overlay.ts` (2k LOC, vanilla) | ✅ present (different stack) |
| Backend | `api.jobright.ai` | Tailrd API (`api/client.ts`, `sync.ts`) | ✅ our own backend |

**Robustness priorities (highest leverage first):**
1. **MAIN‑world Fiber/native‑setter injection** for react‑select & Workday — the single biggest source of "fill didn't stick" failures.
2. **Per‑site adapter framework** (`rules`/`answer`/`operations`) with a site registry + generic fallback, starting with the highest‑volume ATS (Workday, Greenhouse, iCIMS, Ashby, Lever, Workable, Dayforce, Oracle Cloud, SmartRecruiters, SuccessFactors).
3. **Server‑answer as primary** with local heuristics as fallback + rule caching in IndexedDB.
4. **Repeating‑group operations** (education/employment) with date parsing + typeahead candidates.
5. **Resilient re‑location** via XPath + MutationObserver for async/multi‑step forms.

---

## 14. Compliance, clean‑room & risk notes

- **MV3:** our target stays MV3 with a service worker; `declarativeNetRequest` (if we add iframe apply) uses **session rules**, not blocking webRequest. ✅
- **Permissions/CSP:** MAIN‑world injection must go through `chrome.scripting.executeScript({world:'MAIN'})` with scripts declared in `web_accessible_resources`; no remote code eval. Keep host permissions as broad as ATS coverage requires, justified in the store listing.
- **Clean‑room:** reimplement **behavior only**. Do not copy Jobright bundles, class names, event names (`__jr_*`), or the site registry verbatim. Re‑derive selectors/heuristics from the live ATS DOM, not from their code. **Do not commit `1.15.0_0/` or `jobright-extension-ref/`** to our repo (third‑party copyrighted code) — add to `.gitignore`.
- **Privacy:** answers/resume flow through **our** backend; keep the token in the service worker (never expose in page/MAIN world).

---

## 15. Proposed phased rebuild (maps to §13 priorities)

1. **Phase 1 — Write‑reliability core:** native‑setter parity in `writeEngine`, MAIN‑world injection harness (`chrome.scripting` + web‑accessible shim + `CustomEvent` bridge), react‑select + Workday Fiber drivers.

   > **Phase 1 status (2026-07-01):** Implemented on branch `feature/autofill-rebuild` — targeted MAIN-world drivers for react-select (real-Chromium verified via Fiber `selectOption`) and Workday (Fiber `onChange` + prompt-DOM fallback, unit-tested), injected per-frame by the service worker over a `CustomEvent` bridge. See the spec and plan dated 2026-07-01.

2. **Phase 2 — Site‑adapter framework:** registry + `rules/answer/operations` interface + generic fallback; implement top‑10 ATS.

   > **Phase 2 status (2026-07-01):** Implemented on branch `feature/autofill-site-adapters` — per-site adapter framework (registry + `SiteAdapter` classify/resolveAnswer/fillOperation override hooks + generic fallback) in `chrome-extension/src/content/adapters/`, with Greenhouse and Workday reference adapters. See the spec and plan dated 2026-07-01.

3. **Phase 3 — AI‑primary answering:** promote `aiFillPlanner`/`api/aiFill` to the primary resolver with local fallback + IndexedDB rule/answer cache.

   > **Phase 3 status (2026-07-02):** Implemented on branch `feature/autofill-ai-answering` — hybrid AI-primary answering: `planFillRoute` routes deterministic profile fields to the instant local fast-path and judgment fields to the backend `/api/fill` (primary), deduped by an in-memory session `answerCache` (normalized-question key). `onAutofill` is Phase A (instant local) + Phase B (async backend), with the local `proposedValue` as fallback. Client-only. See the spec and plan dated 2026-07-02.

4. **Phase 4 — Repeating groups & typeaheads:** education/employment operations, date parsing, autocomplete candidates.

   > **Phase 4 status (2026-07-02):** Implemented on branch `feature/autofill-repeating-groups` — index-aware resolution for repeating education/employment sections: `detectGroupIndex` parses a field's row index (`education[1][school]` → 1) and `resolveProfileValue` resolves it against `profile.education[N]` / `profile.experience[N]`, threaded through the scanner→adapter→resolver path. Fills all *present* rows; auto-adding rows (DOM mutation) deferred with rationale. See the spec and plan dated 2026-07-02.
5. **Phase 5 — (optional) iframe agent‑apply:** header‑strip session rules + embedded‑iframe fill protocol.
6. **Phase 6 — Hardening:** observers for async/multi‑step forms, submit‑success detection, telemetry, credit/paywall parity.

Each phase is independently shippable and testable against the existing ATS fixtures (`chrome-extension/test`).
