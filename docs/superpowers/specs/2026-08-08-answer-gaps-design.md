# Ask-and-remember: unanswered application questions

Date: 2026-08-08
Scope: `chrome-extension/` (selection, panel UI, persistence routing) +
`frontend/src/pages/Profile.tsx` (Remembered Answers section). No backend
changes — every endpoint this needs already exists.

## Problem

Autofill leaves a field blank whenever the profile has no value and the AI
returns `__NO_ANSWER__` (the grounding contract — it must not invent facts).
Many of those blanks are *recurring screening questions*: "Are you willing to
relocate?", "Do you have a driver's license?", "Years of experience with
Python". The user types the answer by hand on every application, and Tailrd
never learns it.

## What already exists (this feature is mostly re-wiring)

The interactive missing-info modal was deleted on 2026-07-04 because it
interrupted autofill, but its whole support system survived with no caller:

| Piece | State |
| --- | --- |
| `shared/profileCategories.ts` — `profileFieldForCategory`, `isProfileCategory`, `buildProfilePatch` | live, unreferenced; its docstring describes exactly this feature |
| `SAVE_ANSWER` / `LIST_ANSWERS` / `UPDATE_ANSWER` / `DELETE_ANSWER` service-worker handlers | live, no content-side caller |
| `UPDATE_PROFILE` → `PUT /api/user/application-profile` | live, used by the info modal |
| `localAnswers.ts` — device-local sensitive answers + silent refill | live, still used by `refillLocalAnswers` |
| Backend `/api/answers` (canonicalize + embed + dedupe) | live, exercised by tests |
| `/api/fill` semantic recall from the answer bank (`source="memory"`) | live |

So saving to the answer bank is enough for the answer to autofill on a future
application, on any device — the recall path is already wired.

## 1. Selection — `chrome-extension/src/content/answerGaps.ts` (new, pure)

```ts
export interface AnswerGap {
  fieldId: string;
  question: string;        // the field's label
  controlType: ControlType;
  category: FieldCategory;
  options: string[];       // page's own options, for constrained controls
  required: boolean;
  sensitive: boolean;
  helpText?: string;
  inputType?: string;
}

export function selectAnswerGaps(
  fields: readonly DetectedField[],
  jobContext: { company?: string | null; jobTitle?: string | null },
): AnswerGap[]
```

A field is a candidate when it is `fillable`, `proposedValue === null`, has no
non-blank `currentValue`, and its `controlType` is neither `file` nor
`password`.

Then, by control:

| Control | Rule |
| --- | --- |
| `select`, `radioGroup`, `checkboxGroup`, `combobox`, `ariaRadioGroup`, `customDropdown`, `checkbox` | always ask — these are screening questions |
| `text`, `contenteditable` | ask only when the label is ≤ 80 chars and does not match `/\bwhy\b|\bdescribe\b|\btell us\b|\bexplain\b|in your own words/i` |
| `textarea` | never — the essay compose path owns those |

Then drop one-offs: if the label or help text contains this page's company name
or job title (normalized, ≥ 3 chars), the answer cannot transfer to another
application. Dedupe by normalized label, keep the first. Cap at
`MAX_GAPS = 8` so the modal is never a wall of questions.

Pure — no `chrome.*`, no DOM — so it unit-tests like `jobFormEvidence.ts`.

## 2. Panel surface

A card under the Autofill button, between the field count and the banner:

```
⚠  3 questions need your answer            ›
```

Shown only when `overlayState.gapsChecked` is true — i.e. after a fill has
actually run on this page. Without that gate the panel would advertise gaps
before autofill had ever tried, which reads as a failure rather than a
follow-up. Hidden when there are no gaps.

Clicking opens `#ap-gaps-modal`, reusing the `.ap-modal-narrow` shell. One card
per question:

- the question label, and the help text beneath it in muted type when present;
- a control matched to the page's:
  - constrained with options → `<select>` of the page's own option strings,
    prefixed with a blank "Select an answer…";
  - bare `checkbox` → a Yes / No `<select>`;
  - text → `<input>`, `type` taken from `inputType` (date / number / text).
- a "required" marker when the page marks the field required.

Footer: **Save & fill** (primary) and **Skip for now**. Save writes every
answered value into the page, persists each answer (§3), closes the modal, and
re-renders the panel so the card reflects what is left. Unanswered cards are
simply left alone — skipping is never destructive.

Autofill itself never opens this modal. The flow stays silent and
user-gated, which is the property that made the 2026-07-04 removal necessary.

## 3. Persistence routing

Each answer goes to exactly one sink, chosen by the field:

1. `sensitive` (EEO, gender identity, orientation, pronouns) →
   `saveLocalAnswer(question, answer)`. Device-local, never transmitted; the
   existing `refillLocalAnswers` pass replays it by exact-normalized label on
   future applications. This preserves the fill pipeline's privacy rule.
2. `isProfileCategory(category)` → `buildProfilePatch` → `UPDATE_PROFILE` →
   `PUT /api/user/application-profile`. Lands in the extension's Autofill
   Information *and* the web app's Profile page, and refills by category
   (stronger than label matching) next time.
3. otherwise → `SAVE_ANSWER` → `POST /api/answers`. The backend canonicalizes,
   categorizes, embeds and dedupes; `/api/fill` recalls it semantically on
   future applications, across devices.

Routing lives in one exported function so it is testable without a DOM.

## 4. Remembered Answers — both surfaces

The same answer bank, rendered in two places that should look like each other.

**Extension** — a new `Remembered answers` item in the Autofill Information
modal sidebar, after "Account creation". Lists `LIST_ANSWERS`: question (bold),
answer in an editable input, reuse count, delete. Edits commit on blur via
`UPDATE_ANSWER`; delete calls `DELETE_ANSWER` and re-renders. Empty state
explains that answers appear here after they are given on an application.

**Web app** — a new `Remembered Answers` section on `/app/profile`, placed
after "Application Answers" and added to the `SECTIONS` nav. Same data
(`GET /api/answers` via the existing axios client), same three affordances
(edit in place, delete, reuse count), rendered with the page's existing
`profile-card` / `Section` chrome so it matches the rest of the page.

Both read and write the same rows, so an edit in either surface shows in the
other on next load.

## Non-goals

- No UI for device-local sensitive answers. They are deliberately never
  transmitted and have no list today; giving them one means putting EEO
  answers on screen. Called out, not built.
- No change to autofill's silent behavior, the multi-page flow, or the
  grounding contract.

## Verification

- Extension vitest: selection rules (constrained included; essay textarea
  excluded; company/title-named label excluded; already-filled excluded;
  dedupe; cap), routing (sensitive → local, profile category → patch,
  otherwise → answer bank), markup guards for the card + modal.
- `tsc --noEmit` clean in `chrome-extension/` and `frontend/`.
- Frontend vitest for the Remembered Answers section.
- Manual: answer a screening question on a real form, confirm it appears in
  both Autofill Information and `/app/profile`, and refills on a second form.
