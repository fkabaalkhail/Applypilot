/**
 * Which unanswered fields are worth asking the user about?
 *
 * Autofill leaves a field blank whenever the profile has no value and the AI
 * returns __NO_ANSWER__ (the grounding contract — it must not invent facts).
 * A required question nothing can ground has no other way to get answered, so
 * the modal asks the user directly and the answer is written into THIS page.
 * The asking is still deliberately conservative: a prompt shaped like an essay,
 * or a field with no typed answer at all, is noise in a follow-up dialog.
 *
 * Pure — no chrome.*, no DOM — so it unit-tests cleanly (jobFormEvidence.ts
 * style).
 */
import type {
  ControlType,
  DetectedField,
  FieldCategory,
  UserApplicationProfile,
} from "../shared/types";
import { buildProfilePatch, isProfileCategory } from "../shared/profileCategories";
import { normalize } from "./fieldMatcher";

/** Never ask about more than this in one sitting — the modal is a follow-up,
 *  not a second application form. */
export const MAX_GAPS = 8;

/** One unanswered question to put to the user. */
export interface AnswerGap {
  fieldId: string;
  /** The field's label — the question as put to the user. */
  question: string;
  controlType: ControlType;
  category: FieldCategory;
  /** The page's own option strings, for constrained controls. */
  options: string[];
  required: boolean;
  /** EEO / demographic — never transmitted to the AI fill pipeline. */
  sensitive: boolean;
  helpText?: string;
  /** Native input type hint ("date", "number") — picks the modal's input type. */
  inputType?: string;
  /** Names this employer or role, so the answer is about THIS application only.
   *  Informational: every answer is scoped to this page now. */
  oneOff?: boolean;
}

export interface GapJobContext {
  company?: string | null;
  jobTitle?: string | null;
}

/** Controls that offer a fixed set of choices. A constrained field is a
 *  screening question almost by definition, and answering it is one click on a
 *  value the page itself named — always worth asking. */
const CONSTRAINED: ReadonlySet<ControlType> = new Set<ControlType>([
  "select",
  "radioGroup",
  "checkboxGroup",
  "combobox",
  "ariaRadioGroup",
  "customDropdown",
  "checkbox",
]);

/** Free-text controls we may ask about — but only for a short, generic prompt. */
const FREE_TEXT: ReadonlySet<ControlType> = new Set<ControlType>(["text", "contenteditable"]);

/** Controls we never ask about: a file upload has no typed answer, a signup
 *  password is owned by the account sub-flow, and a textarea is an essay the
 *  compose path already handles. */
const NEVER: ReadonlySet<ControlType> = new Set<ControlType>(["file", "password", "textarea"]);

/** Essay-shaped prompts. A prose answer does not belong in a one-line box in a
 *  follow-up dialog — the compose path owns those. */
const ESSAY_RE = /\bwhy\b|\bdescribe\b|\btell us\b|\bexplain\b|in your own words/i;

/** Above this a "short text question" is really a prose prompt in disguise. */
const MAX_QUESTION_LEN = 80;

/**
 * A company name or job title short enough that it appears inside unrelated
 * words ("Hi" in "This") would drop every question. Only match on names long
 * enough to be meaningful.
 */
const MIN_ONE_OFF_TERM = 3;

/** Does this question name the company or role, making the answer one-off? */
function isOneOff(gapText: string, job: GapJobContext): boolean {
  const haystack = normalize(gapText);
  if (!haystack) return false;
  for (const term of [job.company, job.jobTitle]) {
    const needle = normalize(term ?? "");
    if (needle.length >= MIN_ONE_OFF_TERM && haystack.includes(needle)) return true;
  }
  return false;
}

/** Can this field be put to the user as a short question in the modal? */
function isAskable(f: DetectedField): boolean {
  if (NEVER.has(f.controlType)) return false;
  if (CONSTRAINED.has(f.controlType)) return true;
  if (!FREE_TEXT.has(f.controlType)) return false;
  return f.label.length <= MAX_QUESTION_LEN && !ESSAY_RE.test(f.label);
}

/**
 * The questions this page still has blank. Ordered as scanned (so the modal
 * reads top-to-bottom like the form), deduped by normalized label, capped at
 * MAX_GAPS.
 *
 * The test is what the PAGE holds, not what the planner produced. Gating on
 * "we had no answer for it" instead meant a field we DID answer was never
 * offered again — even when the write missed and the control was left empty,
 * which is precisely when the user needs to be asked. On the BMO questionnaire
 * that hid "What is your gender identity?" (we proposed "Male") and "Have you
 * ever had any Canadian military service?" (we proposed "I am not a protected
 * veteran", a value its Yes/No widget cannot take): both stayed on "Select One"
 * with no way to answer them.
 *
 * This is only ever called after a fill has run (PanelState.fillRan) and over a
 * re-scan of the page, so `currentValue` is the post-fill truth. It follows that
 * a control whose committed value we cannot read is asked about again — the
 * honest failure direction, and why `readComboboxValue` must see a button-style
 * trigger's own text.
 *
 * `reverted` closes the remaining hole. "Has a value" is not "has the right
 * value": a framework that resets a control to its own default after the write
 * verified leaves a non-empty field holding something nobody chose, and the
 * emptiness test alone would skip it forever. Those ids come from the terminal
 * re-scan diff (telemetry.revertedFields), so the modal asks about what the
 * page actually holds rather than about what the planner meant to do.
 */
export function selectAnswerGaps(
  fields: readonly DetectedField[],
  job: GapJobContext,
  reverted: ReadonlySet<string> = new Set()
): AnswerGap[] {
  const gaps: AnswerGap[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (gaps.length >= MAX_GAPS) break;
    if (!f.fillable) continue;
    if ((f.currentValue ?? "").trim() && !reverted.has(f.id)) continue;
    const question = f.label.trim();
    if (!question) continue;
    if (!isAskable(f)) continue;
    const key = normalize(question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      fieldId: f.id,
      question,
      controlType: f.controlType,
      category: f.category,
      options: f.options ?? [],
      required: f.required,
      sensitive: f.sensitive,
      helpText: f.helpText,
      inputType: f.inputType,
      // Asked, because the form needs it filled now. Dropping a question that
      // names the employer from the modal instead left a required field with no
      // way to answer it at all.
      oneOff: isOneOff(`${question} ${f.helpText ?? ""}`, job),
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Persistence routing
// ---------------------------------------------------------------------------

/** One answer as given in the modal. */
export interface AnsweredGap {
  gap: AnswerGap;
  value: string;
}

/**
 * A constrained control the modal could only offer as a bare text box.
 *
 * A combobox mounts its listbox lazily, so a scan often sees no options at all.
 * The modal harvests them (overlay.harvestGapOptions) and, when that yields
 * nothing, honestly falls back to a text input — the user then TYPES an answer
 * for a widget whose vocabulary nobody knows.
 *
 * A bare `checkbox` is excluded on purpose: with no options it still renders a
 * real Yes/No pair, so its answer is one the widget understands.
 *
 * gapInputHTML is the renderer of record; answerGapsModal.test.ts pins this
 * predicate to what it actually paints so the two cannot drift.
 */
export function isBlindConstrainedGap(gap: AnswerGap): boolean {
  if (!CONSTRAINED.has(gap.controlType)) return false; // genuinely free text
  if (gap.controlType === "checkbox") return false; // renders Yes/No, not a text box
  return (gap.options?.length ?? 0) === 0;
}

/**
 * The answers still worth keeping after the page write.
 *
 * Persistence must not outlive a failed write — but only where the failure
 * proves the ANSWER is unusable, not merely that this moment was bad. A value
 * saved into a profile slot is replayed on every future form, so storing one
 * the widget rejects means the user is never asked again and never sees why.
 *
 * So exactly one case is dropped: a blind constrained gap (above) whose write
 * failed — text typed into a box that stood in for a dropdown nobody could read.
 *
 * Everything else is kept, deliberately. A genuinely free-text question that
 * failed to write for an unrelated reason — a disabled input, a re-render
 * mid-fill, a field that scrolled out of the DOM — is still a correct answer,
 * and discarding it would silently throw away the user's work.
 *
 * The count of what was dropped is also what the panel's banner reports, so it
 * matters even for an answer that has no profile slot to be saved into.
 */
export function answersWorthRemembering(
  answers: readonly AnsweredGap[],
  filledFieldIds: ReadonlySet<string>
): AnsweredGap[] {
  return answers.filter(
    ({ gap }) => filledFieldIds.has(gap.fieldId) || !isBlindConstrainedGap(gap)
  );
}

/** Where a batch of answers should be written. One sink: the user's profile. */
export interface AnswerSavePlan {
  /** Merged patch for PUT /api/user/application-profile (may be empty). */
  profilePatch: Partial<UserApplicationProfile>;
}

/**
 * Decide which answers persist.
 *
 * Only one sink is left, and it is the honest one: a question whose category
 * maps to a real profile slot (phone, LinkedIn, the five standard EEO answers)
 * is stored in the user's Tailrd profile, where they can see and edit it.
 * Everything else — an employer's own screening question, a prompt with no
 * profile slot — is filled on THIS page and persisted nowhere. There is no
 * cross-application answer memory any more.
 *
 * Keying is by category, never by label. A profile slot stays correct however
 * badly the form named the field, which is why the old "is this label a real
 * question?" guard is gone with the label-keyed store it protected.
 */
export function planAnswerSaves(answers: readonly AnsweredGap[]): AnswerSavePlan {
  const profileEntries: { category: FieldCategory; value: string }[] = [];

  for (const { gap, value } of answers) {
    const answer = value.trim();
    if (!answer) continue;
    if (!isProfileCategory(gap.category)) continue;
    profileEntries.push({ category: gap.category, value: answer });
  }

  return { profilePatch: buildProfilePatch(profileEntries) };
}
