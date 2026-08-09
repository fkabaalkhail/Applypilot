# Workday widgets, faithful gap modal, and the advance gate

Date: 2026-08-08
Scope: `chrome-extension/` only. No backend changes, no migration, no frontend
changes — every value this needs is already on the profile or reachable through
the existing grounded `/api/fill` path.

Four independent defects reported from a live Workday application. They are
grouped into one spec because three of the four are Workday DOM-shape bugs that
share the same selector module, and all four ship as one extension build.

---

## 1. Workday date spinbuttons and Field of Study

### 1a. The date parts read as already-filled

Workday renders a date as two or three sibling spinbuttons:

```html
<input role="spinbutton" aria-label="Year" aria-valuemax="9999" aria-valuemin="1"
       aria-valuetext="0" id="workExperience-10--startDate-dateSectionYear-input"
       data-automation-id="dateSectionYear-input" value="0" aria-invalid="true"
       aria-valuenow="0">
```

An **empty** Workday date part carries `value="0"`, not `""`. Two call sites
treat any non-empty `currentValue` as "the user already filled this":

| Site | Effect |
| --- | --- |
| `aiFillPlanner.ts:51` — `isAiCandidate(f) && f.proposedValue === null && !f.currentValue` | the part is never sent to `/api/fill` |
| `answerGaps.ts:117` — `if ((f.currentValue ?? "").trim()) continue;` | the part never appears in the gaps modal |

So the field is invisible to *both* fill paths. Nothing writes it, and nothing
asks the user about it. `aria-invalid="true"` in the reported DOM is Workday
saying the value is out of range (`aria-valuemin="1"`) — the page agrees `0`
means empty.

**Fix.** A spinbutton whose value is `0` (or whose `aria-valuetext` is `0`) and
whose `aria-valuemin` is `≥ 1` reports `currentValue: undefined`. This is a
placeholder-normalisation rule in `formScanner.currentValueOf`, keyed on
`role="spinbutton"` so it cannot affect an ordinary numeric input where `0` is a
legitimate answer.

### 1b. The split-date fill path never fires

`adapters/workday.ts:86`:

```ts
const container = ctx.el.closest("[data-automation-id]");
if (!container || !DATE_CONTAINER_RE.test(container.getAttribute("data-automation-id") || "")) return undefined;
```

`Element.closest()` matches the element itself. The year input's own
automation-id is `dateSectionYear-input`, which `DATE_CONTAINER_RE` (`/date/i`)
matches — so `container` **is the input**, and the three
`container.querySelector('input[data-automation-id*="month|day|year"]')` lookups
search the input's own (empty) subtree and return `null`. The guard
`if (!parts || (!month && !day && !year)) return undefined` then bails every
time. The whole split-date operation is dead code for the per-part inputs the
scanner actually detects.

**Fix.** Resolve the container by climbing from `ctx.el.parentElement`, so the
element itself can never be its own container, and require the container to
actually hold at least one date-part input. New helper in
`adapters/workdaySelectors.ts`:

```ts
/** The date WIDGET wrapping a part input — never the part itself. */
export function dateContainerOf(el: HTMLElement): HTMLElement | null;
```

### 1c. The parts carry no category

`FIELD_RULES` has no date entries, so a part input falls through to the generic
matcher on its `aria-label` ("Year" / "Month"), which resolves to `unknown` or
mis-resolves. Workday namespaces the section in the element **id**:
`workExperience-10--startDate-…`, `education-11--…`.

**Fix.** New `SECTION_DATE_RULES` in `workdaySelectors.ts`, matched against the
element id (not the automation-id, which is section-agnostic):

| id fragment | category |
| --- | --- |
| `workexperience-…-startdate` | `experienceStartDate` |
| `workexperience-…-enddate` | `experienceEndDate` |
| `education-…-(graduation|enddate|completiondate)` | `graduationYear` |

Applied in `workdayAdapter.classify` **before** `FIELD_RULES`, since the id is
the more specific signal.

All three parts of one widget resolve to the **same** category, so each is
independently proposed the same full date value and each triggers
`fillOperation`, which writes all three parts. That is redundant but idempotent —
the second and third passes write the values already there. It is preferred over
electing a single "owner" part, because Workday renders month/day/year
inconsistently across tenants (some omit the day) and an owner that is absent
would leave the widget unfilled.

Filling only the year would leave Workday's own validation unsatisfied — a
month is required whenever a date widget is present — which is why all parts are
in scope.

### 1d. Field of Study is fed the degree

```html
<input data-uxi-widget-type="selectinput" data-automation-id="searchBox"
       id="education-11--fieldOfStudy" placeholder="Search"
       data-uxi-multiselect-id="4bb0bcf4-…" …>
```

`fieldMatcher.ts:304` folds `field of study|major|discipline` into the **degree**
rule at weight 0.85. Workday shows *Degree* and *Field of Study* as two separate
dropdowns, so both receive "Bachelor of Science" — which matches no option in
the Field of Study list, and the fill fails.

**Fix.**

- New `FieldCategory` member `fieldOfStudy`, split out of the `degree` rule.
  `degree` keeps `\bdegree\b` and the qualification words; `fieldOfStudy` takes
  `\bfield of study\b|\bmajor\b|\bdiscipline\b|\bconcentration\b`.
- `resolveValue` derives it from the existing `EducationEntry.degree` string:
  strip a leading qualification (`Bachelor|Master|B\.?S\.?|M\.?S\.?|PhD|…`) and
  a joining `in|of`, and take the remainder — `"BSc in Computer Science"` →
  `"Computer Science"`. Returns `null` when the degree carries no such
  remainder, which routes the field to the grounded AI pass with the résumé as
  context. **No new profile field, no migration** — deliberately, so this ships
  with the rest of the extension fix.
- The derived value is not written blind. `guardConstrainedOption` deliberately
  excludes comboboxes (they harvest options lazily), so the protection here is
  the combobox engine's own commit guard: it types the value, matches against
  the listbox the widget returns, and reports `written: false` when nothing
  matches — which routes the question to the gaps modal (§2) rather than leaving
  a bogus value in the field.

### 1e. The searchBox widget

> **Correction — 2026-08-09 (added after implementation).** The **multiselect half of this section was implemented and then deliberately reverted** in commit `3fbc19a` (*revert(extension): data-uxi-multiselect-id is not a multi-select signal*). Its premise — that `data-uxi-multiselect-id` on the input marks a multi-select — is refuted by the DOM that motivated it: `education-11--fieldOfStudy` carries the marker but is a **single-value** control, and so does Country Phone Code in the repo's only captured production Workday DOM (`chrome-extension/test/fixtures/workdayReal.ts:19-23`). With the branch in place, `"Toronto, Ontario"` committed `"Ontario"` and still reported `filled: true` — a wrong value banked as a success, which is worse than not filling. It bought nothing in exchange: genuine Workday multiselects nest inside `multiselectInputContainer` / `multiSelectContainer`, already matched by the pre-existing ancestor probe. `MULTISELECT_ID_ATTR` was deleted and is not in the shipped code. **The typeahead half below did ship** — `SEARCH_BOX_FRAGMENT` exists in `workdaySelectors.ts` and `isTypeahead` recognises `searchBox`. Evidence: `.superpowers/sdd/2026-08-08-workday-widgets-and-gate/task-3-report.md` § *"Fix round 2 — the marker branch reverted"*, and the `Task 3: ADJUDICATION` entry in that directory's `progress.md`. The original wording is kept below unchanged, so the record shows what was specified as well as what measurement did to it.
>
> Known, unfixed, and *pre-existing* (not introduced here): the ancestor probe is itself unsound on real Workday. On `workdayReal.ts` the single-value Country Phone Code control matches `multiselectInputContainer`, so `"Canada, United States"` commits `"United States"` with `filled: true`. Reverting the marker branch did not create this and does not cure it.

`formScanner.ts:189` already routes `data-uxi-widget-type="selectinput"` to
`"combobox"`, so the control type is right. What is missing is the widget's
identity in the combobox engine:

- `comboboxEngine.isMultiSelect` looks for an ancestor
  `[data-automation-id*="multiselect"]`. The reported input carries
  `data-uxi-multiselect-id` **on itself** — add that attribute to the probe so
  chips commit through the multiselect path.
- The widget is a **typeahead** (`placeholder="Search"`,
  `data-automation-id="searchBox"`): its listbox is empty until text is typed.
  Add `searchBox` to `isTypeahead`'s signals so the engine types first and then
  matches, instead of opening and finding an empty list.

New constants in `workdaySelectors.ts`: `SEARCH_BOX_FRAGMENT`,
`MULTISELECT_ID_ATTR`.

---

## 2. The gap modal must mirror the page's real control

### Current behaviour

`overlay.gapInputHTML` renders exactly three shapes: a `<select>` when
`gap.options` is non-empty, a Yes/No `<select>` for a bare checkbox, and a text
input otherwise. A radio group on the page becomes a dropdown in the modal; a
combobox whose options have not been harvested becomes a **free-text box**, and
the string the user types is then handed to a widget that only accepts one of
its own options — so "Save & fill" silently fails to fill.

### Target

The modal renders the same control the page renders:

| `gap.controlType` | Modal control |
| --- | --- |
| `radioGroup`, `ariaRadioGroup` | real `<input type=radio>` list, one per option |
| `checkboxGroup` | `<input type=checkbox>` list; answer is the ticked labels joined with `, ` |
| `select`, `combobox`, `customDropdown` | `<select>` of the page's real options |
| `checkbox` | Yes / No radio pair |
| `text` with `inputType` `date` / `number` | typed `<input>` |
| everything else | text `<input>` |

`saveGaps` reads the answer per shape — `:checked` for radios, the joined ticked
set for checkbox groups, `.value` otherwise — instead of reading `.value` from
every `.ap-gap-input`.

### Option harvesting

A combobox's options are not in the DOM until it is opened. When the modal opens,
every gap with a constrained control type and `options.length === 0` has its real
options harvested through the existing
`comboboxEngine.harvestComboboxOptions(trigger)`, which opens the widget, reads
the listbox and closes it again.

- Runs once per modal open, sequentially, with a per-widget budget of 600 ms and
  a total budget of 4 s. The modal renders immediately with a "Loading choices…"
  placeholder on those rows and swaps in the real control as each resolves.
- A widget that yields nothing keeps the text input — the current behaviour, and
  an honest one.
- Harvested options are written back onto `overlayState.gaps[i].options` so
  `saveGaps` sends a value the widget can actually accept.

This is a visible side effect on the page (each dropdown flickers open and shut);
it is the price of the modal offering the page's real choices, and it was chosen
explicitly over a silent text box.

### Filling

Unchanged. `contentScript.onAnswerGaps` already routes through
`fillItems → writeControl`, which drives every control type including radio
groups and comboboxes. The reported "doesn't autofill no matter the input field"
is a consequence of the modal's shape, not of the write path.

---

## 3. The advance gate

### 3a. Colour

`.ap-flow-next` is `#10cf7f` (green) with `#0bb96f` / `#0aa563` states — a colour
that appears nowhere else in the panel. It adopts the app primary, matching
`.ap-btn-update`:

```css
background: linear-gradient(135deg, var(--stripe-primary) 0%, var(--stripe-primary-deep) 100%);
box-shadow: 0 4px 12px rgba(var(--stripe-primary-rgb), 0.25);
```

It keeps its full-width, square-cornered bar shape — only the colour changes.

### 3b. Missing on the account-creation page

Two candidate causes, both real code paths. **The first implementation step is a
Playwright probe** (`test/browser/workday-account-gate-probe.mjs`) that renders a
Workday-shaped create-account gate — visible `role="alert"` validation text, a
create-account submit button, and the posting's "Apply" button still in the
document — and records the `FlowProgress` beats the panel receives. The fix
applied is the one the probe implicates; both are specified so neither needs a
second design round.

**Candidate (a) — a `validation` pause hides the gate.**
`contentScript.pauseReason` returns `"validation"` whenever
`validationMessages(scope)` is non-empty (`flowChecks.ts:37` — visible
`role="alert"` / `aria-live="assertive"`). Workday's create-account form renders
live password-rule alerts. `flowController.waitWhileBlocked` is reached *before*
the gate code, and `overlay.showsAdvanceGate` returns `true` only for `ready`,
`unfilled-required` and `account` — so the flow parks with the strip reading
"Paused — fix the highlighted errors" and **no button**.

Fix:
- `showsAdvanceGate` also returns `true` for `pauseReason === "validation"`.
- `waitWhileBlocked` honours `advanceRequested` as a **manual override** — the
  user saying "I have dealt with this, continue" — for `validation`,
  `unfilled-required` and `account` only. It is never honoured for `captcha`,
  `verification` or `resume-upload`: those are blocks the click genuinely cannot
  clear, and offering a button that does nothing is worse than offering none.
- The override consumes the flag exactly like `waitForAdvanceRequest`, so a
  press that lands during the synchronous `emit` is not dropped.

**Candidate (b) — the posting's Apply button is read as terminal.**
When the account gate shares a scope with the job posting,
`advance.findAdvanceButton` iterates the scope's buttons and returns
`{ kind: "terminal" }` on the first `TERMINAL_RE` hit — and `/\bapply\b/` matches
the posting's own "Apply". `flowController` then calls `onTerminal` and finishes
`"done"`, which hides the gate and ends the flow on the account page.

Fix: `findAdvanceButton` takes the existing `opts.extraAdvance` as a signal that a
wall is present, and while it is set, a button matching `extraAdvance` wins over
a terminal match. A create-account wall's own submit is never the application's
final submit, so this cannot cause an unintended application submission — the
controller's "never click a terminal button" invariant is untouched for ordinary
form pages, where `extraAdvance` is `undefined`.

---

## 4. Workday résumé drop zone auto-attach

```html
<div data-automation-id="file-upload-drop-zone" class="css-1ikudie">
  …<div class="css-1ge88gr">Drop files here</div>
  <button data-automation-id="select-files" id="resumeAttachments--attachments">Select files</button>
</div>
<input data-automation-id="file-upload-input-ref" type="file" multiple class="css-1hyfx7x">
```

### Root cause

The hidden input **is** scanned — `domUtils.isUploadAffordance` matches
`file-upload-input-ref` against `UPLOAD_HINT` (`/file.?upload/`), which is what
lets `formScanner.ts:460` admit an invisible control. It is the **classification**
that fails.

`fieldMatcher`'s `resumeUpload` rule requires the literal token `resume` /
`resum` / `cv` / `curriculum vitae` in the field's signals. For this widget:

- `automationIdChain` reads `data-automation-id` attributes → `file-upload-input-ref`,
  and the wrappers (`css-wtpnzt`, `css-1ikudie`) carry none. So the Workday
  adapter's `RESUME_SECTION_RE` never matches.
- `uploadZoneText` reads the zone's **text** → "Drop files here or Select files".
  No document word.
- The one "resume" token on the widget is `id="resumeAttachments--attachments"`,
  an **element id on the button** — read by neither.

So the field classifies as `unknown`, `resumeFieldNeedingFile` never returns it,
the `resume-upload` pause never fires, and `flowController`'s bounded
`attachResume` retry loop never targets it. The résumé is never attached.

### Fix

New constants in `workdaySelectors.ts`:

```ts
export const FILE_DROP_ZONE_SELECTOR = '[data-automation-id="file-upload-drop-zone"]';
export const FILE_INPUT_SELECTOR     = '[data-automation-id="file-upload-input-ref"]';
export const SELECT_FILES_SELECTOR   = '[data-automation-id="select-files"]';
/** Element *ids* Workday puts on the upload widget's button — the only place
 *  the document's name appears on a class-hashed drop zone. */
export const UPLOAD_WIDGET_ID_RE = /resumeattachments|resume|curriculum.?vitae/i;
export const COVER_WIDGET_ID_RE  = /coverletter/i;
```

- `workdayAdapter.classify` gains an upload branch: when the element is a file
  input or sits inside a `FILE_DROP_ZONE_SELECTOR`, look for a document name in
  (i) the automation-id chain, (ii) the `id` attributes of the widget's own
  elements — matching `UPLOAD_WIDGET_ID_RE` on `#resumeAttachments--attachments`
  — and (iii) the zone text. Resolves to `resumeUpload` / `coverLetter` at 0.9.
  A Workday drop zone with no document signal at all still classifies as
  `resumeUpload`: on a Workday application the résumé is the only upload that
  appears before the cover-letter section, and leaving it `unknown` is exactly
  today's failure.
- `fileUpload.findFileInput` and `injectResumeFile` add the automation-id
  selectors alongside their class probes. Today they key on
  `[class*='dropzone'|'upload'|'attach'|'field']`; Workday's classes are hashed
  (`css-1ikudie`), so none can ever match and the code relies on the
  `el.parentElement` fallback happening to be right.
- No change to the attach *trigger*: `flowController.waitWhileBlocked` already
  auto-attaches on the `resume-upload` pause with `RESUME_ATTACH_TRIES = 6`
  retries for lazy-rendered zones. Once the zone classifies, that existing path
  attaches it with no user click.

---

## Testing

Every fix gets a vitest fixture built from the DOM reported above.

| Test | Asserts |
| --- | --- |
| `test/workdayDateParts.test.ts` (new) | a `value="0"` spinbutton has `currentValue === undefined`; a date widget's three parts all classify to `experienceStartDate`; `fillOperation` writes month, day and year |
| `test/workdayFieldOfStudy.test.ts` (new) | `education-N--fieldOfStudy` classifies as `fieldOfStudy`, not `degree`; `"BSc in Computer Science"` resolves to `"Computer Science"`; a bare `"Bachelor's"` resolves to `null` |
| `test/workdayResume.test.ts` (extend) | the reported drop zone classifies as `resumeUpload`; `findFileInput` returns `file-upload-input-ref` |
| `test/answerGapsModal.test.ts` (new) | a `radioGroup` gap renders radios and `saveGaps` reads the checked one; a `checkboxGroup` gap joins ticked labels; a zero-option combobox renders its harvested options |
| `test/overlayFlow.test.ts` (extend) | `showsAdvanceGate` is true for a `validation` pause; the gate's computed background is the primary token, not green |
| `test/flowController.test.ts` (extend) | a user press releases a `validation` pause but **not** a `captcha` pause |
| `test/browser/workday-account-gate-probe.mjs` (new) | on a Workday-shaped create-account gate the panel receives a beat for which `showsAdvanceGate` is true, and the button is visible |

Run: `npx vitest run` (see the npm-stdio quirk — `npm test` exits 1 with no
output in this shell) and `npm run test:flow` for the browser probes.

## Out of scope

- Any backend or `frontend/` change. `fieldOfStudy` is derived, not stored.
- Workday tenants that render a date as a single `<input type=date>` — already
  handled by the generic writer.
- The apply-method chooser and account-wall behaviour beyond the gate's
  visibility.
