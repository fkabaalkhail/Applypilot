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
 * The questions this page left unanswered that are worth remembering. Ordered
 * as scanned (so the modal reads top-to-bottom like the form), deduped by
 * normalized label, capped at MAX_GAPS.
 */
export function selectAnswerGaps(
  fields: readonly DetectedField[],
  job: GapJobContext
): AnswerGap[] {
  const gaps: AnswerGap[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (gaps.length >= MAX_GAPS) break;
    if (!f.fillable || f.proposedValue !== null) continue;
    if ((f.currentValue ?? "").trim()) continue;
    const question = f.label.trim();
    if (!question) continue;
    if (!isReusable(f)) continue;
    if (isOneOff(`${question} ${f.helpText ?? ""}`, job)) continue;
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
