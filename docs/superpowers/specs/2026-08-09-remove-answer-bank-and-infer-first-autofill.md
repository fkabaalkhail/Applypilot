# Remove Remembered Answers · Infer-first autofill · Profile parity

Date: 2026-08-09 · Status: approved (user pre-approved; user away)

## 1. Remove "Remembered Answers" entirely

"Remembered Answers" is the user-facing name for the **answer bank / Question Memory**:
the `saved_answers` table, the `/api/answers` CRUD router, the semantic-recall pass in
`/api/fill`, the extension's *Autofill Information → Remembered answers* tab, the web
*Profile → Remembered Answers* tab, and the device-local sensitive-answer store
`chrome.storage.local["ap_local_answers"]`.

### What goes

| Layer | Delete | Surgical edit |
|---|---|---|
| Backend | `routers/answers.py`, `services/answer_memory.py`, `services/embeddings.py`, `migrations/add_answer_match_stats.py`, `scripts/audit_saved_answers.py`, tests `test_answer_memory.py` `test_answers_api.py` `test_answers_eviction.py` `test_answer_bank_audit.py` `test_fill_memory.py` `test_embeddings_service.py` | `routers/fill.py` (drop pass 2 — **`ai_fields` must still be populated or the AI silently stops running**), `db/models.py` (drop `SavedAnswer`), `main.py` (router + migration registration), `tests/test_fill_derived_and_gate.py` |
| Backend data | new migration `drop_saved_answers.py` — **DROP TABLE saved_answers** | `main.py` registers it |
| Extension | `src/api/answers.ts`, `src/content/localAnswers.ts`, `test/localAnswers.test.ts` | `background/serviceWorker.ts` (4 handlers), `shared/types.ts` (`SavedAnswerItem`, `AnswersResponse`, 4 message types, `canonicalQuestion`), `content/overlay.ts` (CSS, sidebar tab, footer case, switch case, `SUSPECT_TEXT`, `renderRememberedAnswers`, modal copy), `content/answerGaps.ts` (`bank` + `local` sinks), `content/contentScript.ts` (`SAVE_ANSWER` loop, `refillLocalAnswers`) |
| Extension storage | one-time cleanup removing `ap_local_answers` on startup/install | `background/serviceWorker.ts` |
| Web | `frontend/src/__tests__/remembered-answers.test.tsx` | `pages/Profile.tsx` (nav entry, `RememberedAnswer`, `RememberedAnswers`), `index.css` |

### What deliberately stays

- `content/answerCache.ts` — a per-session dedupe cache for `/api/fill` HTTP calls. Nothing to do with the bank.
- `services/answer_gate.py` — source-blind validation of *every* answer. It becomes **more** important once the AI infers more.
- `services/derived_facts.py` — deterministic pass-1 resolvers (age, total experience, graduation year, highest degree, current employer). Independent of the bank.
- The **unanswered-questions modal**, minus all memory semantics. It still (a) fills the current page and (b) writes profile-slot answers to the profile. Removing it outright would leave required, ungroundable questions with no way to answer them. All copy promising "filled in automatically on future applications" is rewritten.
- `chrome.storage.local["ap_autofill_extras"]` — the user's own custom autofill fields. A different feature.

## 2. Infer-first answering

`prompts/answer_question.txt` is replaced with the user-supplied contract: derive rather
than skip; never fabricate; leave blank only when no reasoning over the profile could
produce the value. `answer_gate.py` still enforces option vocabulary and refutes answers
that contradict computed facts — the prompt loosens what the model *attempts*, the gate
keeps it honest.

## 3. Profile parity (web ⇄ extension) and fewer blanks

Defects fixed so the two surfaces show the same thing:

1. `dateOfBirth` was extension-only → added to the web profile.
2. `currentTitle` was web-only → added to the extension.
3. `github` had no write path in `ApplicationProfileIn` → added; extension stops shadowing it device-locally.
4. Extension rendered LinkedIn/GitHub/Portfolio only when already non-empty → always rendered.
5. `location` and `addressCity` both mapped to `user_settings.city`, so a PUT carrying both silently dropped one → fixed.
6. EEO option lists were two hand-copied constants → pinned equal by test.
7. Labels harmonised (Email Address, Portfolio, First/Last Name, section names).

New profile answers (stored in the existing `user_settings.prefilled_answers` JSON — no
schema migration) so the AI reasons less and the gate has more ground truth:
`willingToRelocate`, `workPreference`, `noticePeriod`, `earliestStartDate`,
`securityClearance`, `driversLicense`, `languages`, `genderIdentity`, `pronouns`,
`sexualOrientation`, `yearsOfExperience` (override). Each is surfaced on **both** the web
profile and the extension panel, threaded into `_profile_context()` so the prompt sees it,
and mapped in `profileCategories.ts` / `fieldMatcher.ts` so a matching form field is filled
without an LLM call at all.
