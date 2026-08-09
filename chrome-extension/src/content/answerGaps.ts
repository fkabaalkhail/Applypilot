/**
 * Which unanswered fields are worth asking the user about?
 *
 * Autofill leaves a field blank whenever the profile has no value and the AI
 * returns __NO_ANSWER__ (the grounding contract — it must not invent facts).
 * Many of those blanks are recurring screening questions ("Are you willing to
 * relocate?", "Years of experience with Python") whose answer transfers to
 * every future application. Asking once and remembering the answer is the whole
 * point; asking about a question that CANNOT transfer is pure noise.
 *
 * So this predicate is deliberately conservative. Pure — no chrome.*, no DOM —
 * so it unit-tests cleanly (jobFormEvidence.ts style).
 */
import type {
  ControlType,
  DetectedField,
  FieldCategory,
  UserApplicationProfile,
} from "../shared/types";
import { buildProfilePatch, isProfileCategory } from "../shared/profileCategories";
import { isNamedQuestion } from "../shared/questionText";
import { normalize } from "./fieldMatcher";

/** Never ask about more than this in one sitting — the modal is a follow-up,
 *  not a second application form. */
export const MAX_GAPS = 8;

/** One unanswered question to put to the user. */
export interface AnswerGap {
  fieldId: string;
  /** The field's label — also the key the answer is remembered under. */
  question: string;
  controlType: ControlType;
  category: FieldCategory;
  /** The page's own option strings, for constrained controls. */
  options: string[];
  required: boolean;
  /** EEO / demographic — the answer stays device-local and is never transmitted. */
  sensitive: boolean;
  helpText?: string;
  /** Native input type hint ("date", "number") — picks the modal's input type. */
  inputType?: string;
  /** Names this employer or role, so the answer cannot transfer to another
   *  application: still asked, never banked. */
  oneOff?: boolean;
}

export interface GapJobContext {
  company?: string | null;
  jobTitle?: string | null;
}

/** Controls that offer a fixed set of choices. A constrained field is a
 *  screening question almost by definition, and its answer is one of a handful
 *  of values that recur verbatim across ATS vendors — always worth asking. */
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

/** Essay-shaped prompts. The answer is about THIS company or a personal story,
 *  so replaying it on the next application would be wrong, not helpful. */
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

/** Is this field's answer plausibly reusable on a future application? */
function isReusable(f: DetectedField): boolean {
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
    if (!isReusable(f)) continue;
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
      // Asked, because the form needs it filled now; not remembered, because the
      // answer is about THIS employer. Dropping it from the modal instead left a
      // required question with no way to answer it.
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
 * The answers still worth remembering after the page write.
 *
 * Persistence must not outlive a failed write — but only where the failure
 * proves the ANSWER is unusable, not merely that this moment was bad.
 * selectAnswerGaps skips any field that already has a proposedValue, so an
 * answer we remember permanently retires its question: store a value the widget
 * rejects and the user is never asked again, never sees why, and the extension
 * replays the rejected value on every future application.
 *
 * So exactly one case is dropped: a blind constrained gap (above) whose write
 * failed — text typed into a box that stood in for a dropdown nobody could read.
 *
 * Everything else is kept, deliberately. A genuinely free-text question that
 * failed to write for an unrelated reason — a disabled input, a re-render
 * mid-fill, a field that scrolled out of the DOM — is still a correct answer,
 * and discarding it would silently throw away the user's work.
 */
export function answersWorthRemembering(
  answers: readonly AnsweredGap[],
  filledFieldIds: ReadonlySet<string>
): AnsweredGap[] {
  return answers.filter(
    ({ gap }) => filledFieldIds.has(gap.fieldId) || !isBlindConstrainedGap(gap)
  );
}

/** Where a batch of answers should be written. Each answer lands in exactly one
 *  bucket — the caller executes all three. */
export interface AnswerSavePlan {
  /** Merged patch for PUT /api/user/application-profile (may be empty). */
  profilePatch: Partial<UserApplicationProfile>;
  /** Device-local sensitive answers — never transmitted anywhere. */
  local: { question: string; answer: string }[];
  /** Question Memory (POST /api/answers) — recalled semantically by /api/fill. */
  bank: { question: string; answer: string; fieldType: string }[];
}

/**
 * Decide where each answer is remembered.
 *
 * Order matters. A profile slot wins first, so the five standard EEO questions
 * — which the profile genuinely stores — persist there and sync, exactly as
 * localAnswers.ts documents. Only THEN does `sensitive` divert to the device:
 * that catches gender identity, orientation and pronouns, which have no profile
 * slot and must never leave the machine. Everything left is an ordinary
 * screening question and goes to the answer bank.
 *
 * The consequence worth stating: a sensitive answer can never reach the bank,
 * because the sensitive check is above it.
 */
export function planAnswerSaves(answers: readonly AnsweredGap[]): AnswerSavePlan {
  const profileEntries: { category: FieldCategory; value: string }[] = [];
  const local: AnswerSavePlan["local"] = [];
  const bank: AnswerSavePlan["bank"] = [];

  for (const { gap, value } of answers) {
    const answer = value.trim();
    if (!answer) continue;
    // An answer is remembered UNDER ITS QUESTION, and recalled by matching that
    // text against a future form's question. A key that names no question —
    // "Unlabeled field", or a raw widget id — can never match the question it
    // came from, and can match unrelated ones. Filling the page already happened;
    // this only declines to remember it. A profile slot is exempt: its key is the
    // category, not the label, so it stays correct however the field was named.
    if (!isProfileCategory(gap.category) && (gap.oneOff || !isNamedQuestion(gap.question))) continue;
    if (isProfileCategory(gap.category)) {
      profileEntries.push({ category: gap.category, value: answer });
    } else if (gap.sensitive) {
      local.push({ question: gap.question, answer });
    } else {
      bank.push({ question: gap.question, answer, fieldType: gap.controlType });
    }
  }

  return { profilePatch: buildProfilePatch(profileEntries), local, bank };
}
