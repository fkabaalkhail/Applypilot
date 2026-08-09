# Hand-off — Workday widgets, gap modal, and the advance gate

Date: 2026-08-09
Commits: `9973700..949fb1e` (21 commits on `main`, unpushed)
Spec: `docs/superpowers/specs/2026-08-08-workday-widgets-and-gate-design.md`
Plan: `docs/superpowers/plans/2026-08-08-workday-widgets-and-gate.md`

Verified at `949fb1e` in a **clean checkout** (not the working tree, which carries
another session's files): **95 test files / 877 tests, 0 failures**;
`npx tsc --noEmit` exit 0; `node build.mjs` exit 0; all four browser probes pass.

---

## The four reported defects

| # | Defect | Verdict |
| --- | --- | --- |
| 1a | Workday date spinbuttons unreadable / unfillable | **Fixed**, see risk 2 below |
| 1b | Field of Study fed the degree value | **Fixed** |
| 2 | Gap modal rendered a `<select>` for everything | **Fixed** |
| 3 | Continue button green, absent on the account page | **Fixed** |
| 4 | Résumé drop zone never auto-attached | **Fixed** |

Defect 3 had **two** independent causes, both fixed: the posting's "Apply" button
was classified as the application's final submit (ending the flow), and a
`validation` pause offered no gate and no press could clear it. A Playwright
probe (`npm run test:workday-gate`) reproduces both at once and was proven red
against a pre-fix build **per cause**.

---

## Do this before shipping

**1. Confirm one attribute on a live Workday tenant.** Open any Workday
application's education or work-experience step and run:

```js
document.querySelector('[data-automation-id="dateSectionYear-input"]').outerHTML
```

Every Workday DOM shape in this plan's fixtures was *inferred* from the
`-input` / `-display` naming in the bug report — none was captured from a real
tenant. The final fix wave made defect 1a's read-fix robust to a missing or
zero `aria-valuemin`, so this check is now confirmation rather than a
dependency, but it is still the cheapest way to retire the largest unknown.

**2. Nothing in this plan has been replayed against a live ATS.** All evidence
is jsdom plus local-fixture browser probes. The one verbatim production capture
in the repo (`test/fixtures/workdayReal.ts`, BMO 2026-07-04) covers three
"My Information" dropdowns that this work did not change.

---

## Residual risks, highest first

**1. `isMultiSelect` mis-commits on real Workday markup — pre-existing, NOT fixed.**
`comboboxEngine.ts` treats any widget inside `multiselectInputContainer` as
multi-select. On the repo's only verbatim production capture — Country Phone
Code, a **single-value** control — filling `"Canada, United States"` commits
**"United States"** and reports `filled: true`. A wrong value banked as success,
which is the exact failure class this plan was built to prevent. It predates
this work at every revision.

This plan closed the one new door it opened onto that bug: `deriveFieldOfStudy`
now truncates at the first comma, so no comma-bearing value reaches the splitter
from the Field-of-Study path. The underlying bug is untouched and is the highest
-value item on this surface.

**2. `npm test` is not in CI.** `.github/workflows/ci.yml` runs only `typecheck`
and `build`, so the 877-test gate is local-only.

**3. `tsconfig.json` has `"include": ["src"]`,** so `npm run typecheck` never
checks `test/`. Widening it surfaces **16 pre-existing errors** (none from this
work — the two this plan introduced were fixed). Worth closing, but it is its
own piece of work.

**4. Two call sites have no regression protection.** Reverting
`overlay.ts`'s gaps-card click wiring, or the settle handler's
`resolveGapPlaceholders` call, each left the full suite green until the final
fix wave added a test for the latter. The card-click wiring is still uncovered.

---

## Deliberate decisions worth knowing

- **Spec §1e was reverted.** It told us to add `data-uxi-multiselect-id` to the
  multi-select probe because `education-11--fieldOfStudy` carries it. Measurement
  showed that control is *single*-value, so the premise was wrong and the change
  caused wrong values to be committed. Both the spec and the plan carry dated
  correction notes; the original text is preserved.
- **`fieldOfStudy` is derived, not stored.** It is parsed from the existing
  degree string (`"BSc in Computer Science"` → `"Computer Science"`), falling
  back to the grounded AI pass. No profile field, no migration.
- **An optional résumé upload attaches but never blocks.** `resumeFieldForAttach`
  (no `required` gate) drives auto-attach; `resumeFieldNeedingFile` (still
  `required`-gated) drives the pause. Merging them would park the flow forever
  behind "attach your résumé to continue" for a user with no résumé on file.
- **"Create Account and Apply" resolves to *advance*, not terminal.** `apply` is
  an entry verb at every ATS in the registry, and at evaluation time the wall has
  established no application data exists. A button reading "Register and Submit"
  is still correctly terminal and is pinned by test.

---

## Smaller deferred items

- `adapters/apply.ts` drops the adapter's `reason`, so
  `"no date part matched the value"` never reaches `autofill_reports` — worth
  fixing before the first live Workday date failure, since telemetry-first
  debugging is this codebase's established workflow.
- `deriveFieldOfStudy("Bachelor of Arts, Honours, Political Science")` returns
  `"Honours"`. Both the old and new values are wrong; the new one is safer.
- `input[data-automation-id*="dateSection" i]` is a substring match, so a
  hypothetical `dateSectionHour-input` reading `"0"` would also read as empty.
  Pinning the selector to month/day/year closes it at no cost.
- A résumé zone and a cover-letter zone sharing one immediate wrapper both
  classify `unknown` and neither attaches — a do-nothing failure, not a wrong one.
- Commit `54c776b` does not compile standalone (a `FieldCategory` widening whose
  type declaration landed in the next commit). The tip is green; this only bites
  a `git bisect` landing exactly there. Left alone rather than rewriting shared
  history.

---

## Note on the working tree

These 21 commits necessarily swept in uncommitted work from a concurrent session
in the same checkout — `git add <path>` takes whole files, and the plan was
written against that state. That includes the `adapters/workday.ts` refactor, the
previously-untracked `adapters/workdaySelectors.ts`, `shared/types.ts`,
`fieldMatcher.ts`, `flowController.ts` and `test/browser/flow-probe.mjs`. Every
task verified the other session's hunks were intact before committing. Fifteen of
their files remain uncommitted, including three untracked test files
(`profileSchema`, `workdayChooserEntry`, `workdayPhoneWidgets`) that cover code
already committed here — they should be landed.
