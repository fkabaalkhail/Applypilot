/**
 * One field's deterministic answer, decided in a fixed order:
 *
 *   1. KIND first (answerKind.ts): what this field accepts.
 *   2. QUESTION shapes (questionResolver.ts): screening questions answered
 *      from derived facts. An explicit abstain ENDS resolution: the field stays
 *      blank and is never handed to the backend, whose rule pass would guess
 *      (it answers "authorized to work?" Yes for everyone).
 *   3. CATEGORY value (adapter hook, then the generic profile resolver).
 *   4. GATE: a value of the wrong kind is dropped ("Quebec" never reaches a
 *      Yes/No field); a choice control only ever gets one of its REAL options,
 *      matched strictly, or nothing.
 *
 * Every value this returns is safe to write without review; anything less
 * certain comes back null.
 */
import type { ControlType, FieldCategory, ResolveControl, UserApplicationProfile } from "../shared/types";
import { resolveAnswerWithAdapter } from "./adapters/apply";
import type { SiteAdapter } from "./adapters/types";
import { answerKindOf, optionPolarity, valueFitsKind, type AnswerKind } from "./answerKind";
import { dateFormatFor, fitDate, type DateFormat } from "./dateControl";
import type { FieldSignals } from "./domUtils";
import { profileFacts } from "./profileFacts";
import { resolveQuestion, type QuestionContext, type QuestionInput, type QuestionResult } from "./questionResolver";
import { countryFromName } from "./geo";
import { matchOption } from "./writeEngine";

export interface FieldResolveInput {
  adapter: SiteAdapter | null;
  category: FieldCategory;
  sensitive: boolean;
  profile: UserApplicationProfile | null;
  control: ResolveControl & { multi?: boolean };
  fillEEO: boolean;
  el: HTMLElement;
  /** The question text (bestDisplayLabel). */
  label: string;
  signals: FieldSignals;
}

export interface FieldResolution {
  value: string | null;
  kind: AnswerKind;
  /** "question" (computed from facts) | "category" (profile/adapter) | "none" */
  source: "question" | "category" | "none";
  rule?: string;
  /** The device recognized the question and decided it must stay blank. */
  deviceAbstained: boolean;
  /** The format of a date control (dateControl.ts), when the field is one. */
  dateFormat?: DateFormat;
}

let resolveContext: QuestionContext = { jobCountry: null, company: "" };

/** The page's job context (country, company), set by the content script. */
export function setResolveContext(ctx: Partial<QuestionContext>): void {
  resolveContext = { ...resolveContext, ...ctx };
}

export function getResolveContext(): QuestionContext {
  return resolveContext;
}

/** Categories whose answers are the user's own demographic statements; they
 *  keep their dedicated matcher (demographicMatch) and never take a computed
 *  answer. */
const PASS_THROUGH: ReadonlySet<FieldCategory> = new Set<FieldCategory>(["accountPassword", "resumeUpload"]);

/** Categories that live in repeating employment / education rows. */
const ROW_CATEGORIES: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "currentCompany", "currentTitle", "experienceStartDate", "experienceEndDate", "experienceDescription",
  "experienceCurrent", "school", "degree", "fieldOfStudy", "graduationYear",
]);

/** Categories whose answer is a single short fact. */
const SINGLE_LINE_FACTS: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "firstName", "lastName", "fullName", "email", "phone", "location", "addressStreet", "addressCity",
  "addressState", "postalCode", "country", "linkedin", "github", "portfolio", "currentCompany", "currentTitle",
  "school", "degree", "fieldOfStudy", "graduationYear", "salary", "yearsOfExperience", "startDate", "noticePeriod",
]);

/** A label that is a prompt for prose rather than the name of a fact. */
function isProsePrompt(label: string): boolean {
  const words = (label || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 5) return false;
  return !/\b(name of|what is your|what's your|your current|please (enter|provide|list|state) (your|the name))\b/i.test(label);
}

/** Controls whose options are fully known at scan time. */
const CONSTRAINED: ReadonlySet<ControlType> = new Set<ControlType>(["select", "radioGroup", "ariaRadioGroup", "checkboxGroup"]);

const pick = (options: string[], value: string): string | null => matchOption(options, (o) => o, (o) => o, value);

/**
 * Snap `value` onto one of `options`, strictly. Country names get their
 * spelling variants first ("Canada" ↔ "CA", "USA" ↔ "United States of America").
 */
export function snapToOption(options: string[], value: string, category: FieldCategory): string | null {
  const direct = pick(options, value);
  if (direct) return direct;
  if (category === "country" || category === "phoneCountryCode") {
    const want = countryFromName(value);
    if (want) {
      const hits = options.filter((o) => countryFromName(o.replace(/\s*\(.*\)\s*$/, ""))?.code === want.code);
      if (hits.length === 1) return hits[0];
    }
  }
  return null;
}

function coerceToKind(value: string, kind: AnswerKind): string | null {
  const v = value.trim();
  if (kind === "number") {
    // "$120,000" → "120000"; "120k" → "120000"; "3 years" → "3"; two
    // different numbers (a range) → refuse rather than pick one.
    const flat = v.replace(/,/g, "");
    const nums = flat.match(/\d+(?:\.\d+)?/g) ?? [];
    if (nums.length !== 1) return null;
    const k = /(\d+(?:\.\d+)?)\s*k\b/i.exec(flat);
    return k ? String(Math.round(parseFloat(k[1]) * 1000)) : nums[0];
  }
  if (kind === "phone" || kind === "email" || kind === "url" || kind === "date") {
    return valueFitsKind(v, kind) ? v : null;
  }
  return v;
}

/**
 * A date control (dateControl.ts) takes only a whole date in its own format:
 * the value is re-emitted in that format, or the field stays blank when it
 * lacks a part (a graduation YEAR for a day-precise picker).
 */
export function resolveField(input: FieldResolveInput): FieldResolution {
  const r = resolveFieldValue(input);
  const dateFormat = dateFormatFor(input.el, input.signals.typeHint, input.signals.placeholder);
  if (!dateFormat) return r;
  if (r.value === null) return { ...r, dateFormat };
  const value = fitDate(r.value, dateFormat);
  if (value === null) {
    return { value: null, kind: r.kind, source: "none", deviceAbstained: false, rule: "wrong-kind:partial-date", dateFormat };
  }
  return { ...r, value, dateFormat };
}

function resolveFieldValue(input: FieldResolveInput): FieldResolution {
  const { profile, category, control, signals, label } = input;
  const options = control.options;
  const kind = answerKindOf({
    controlType: control.controlType,
    inputType: signals.typeHint,
    label,
    helpText: signals.nearby,
    placeholder: signals.placeholder,
    options,
    multi: control.multi,
  });
  const none = (deviceAbstained = false, rule?: string): FieldResolution => ({ value: null, kind, source: "none", deviceAbstained, rule });
  if (!profile) return none();
  if (kind === "file" || kind === "password" || PASS_THROUGH.has(category)) {
    const v = resolveAnswerWithAdapter(input.adapter, category, profile, control, input.fillEEO, input.el);
    return { value: v, kind, source: v === null ? "none" : "category", deviceAbstained: false };
  }

  // 2. Question shapes. EEO answers are the user's own words and are matched
  //    by demographicMatch, never computed. A repeating employment/education
  //    row ("experience[1][start]") is transcription of THAT row, never a
  //    screening question.
  let q: QuestionResult = null;
  // groupIndex alone is not proof of a repeating row: it is parsed from ids,
  // and Ashby's radio ids end "-labeled-radio-0". Only the row categories count.
  const inRepeatingRow = control.groupIndex !== null && control.groupIndex !== undefined && ROW_CATEGORIES.has(category);
  if (!input.sensitive && !inRepeatingRow) {
    const question: QuestionInput = {
      label,
      helpText: signals.nearby,
      controlType: control.controlType,
      inputType: signals.typeHint,
      placeholder: signals.placeholder,
      options,
      category,
      kind,
    };
    q = resolveQuestion(question, profileFacts(profile), profile, resolveContext);
    if (q?.status === "abstain") return none(q.blockBackend === true, q.rule);
  }

  let value: string | null;
  let source: FieldResolution["source"];
  let rule: string | undefined;
  if (q?.status === "answer" && q.confidence === "high") {
    value = q.value;
    source = "question";
    rule = q.rule;
  } else {
    value = resolveAnswerWithAdapter(input.adapter, category, profile, control, input.fillEEO, input.el);
    source = "category";
  }
  if (value === null || !value.trim()) return none();

  // A one-line fact (a company, a title, a city) never answers a PROSE prompt
  // in a long-text box: "Let the company know about your interest working
  // there" classified as currentCompany on the word "company", and the
  // employer's name was written into it (SmartRecruiters, live 2026-10-03).
  // A label that actually asks for the name ("What is the name of…") is
  // answered by the question resolver above, before this point.
  if (source === "category" && kind === "longText" && SINGLE_LINE_FACTS.has(category) && isProsePrompt(label)) {
    return none(false, "wrong-kind:prose-prompt");
  }

  // 4. Gate. Single checkboxes keep their own intent logic (checkboxIntent),
  //    which reads the label; everything else must fit its kind.
  if (control.controlType !== "checkbox") {
    if (kind === "boolean" && optionPolarity(value) === null && !(options && options.length)) {
      return none(false, "wrong-kind:not-yes-no");
    }
    if (kind !== "choice" && kind !== "multiChoice" && kind !== "boolean" && kind !== "text" && kind !== "longText") {
      const coerced = coerceToKind(value, kind);
      if (coerced === null) return none(false, `wrong-kind:${kind}`);
      value = coerced;
    }
  }
  if (options && options.length > 0 && (CONSTRAINED.has(control.controlType) || control.controlType === "combobox")) {
    if (control.controlType === "checkboxGroup" || control.multi) {
      const parts = value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
      const hits = parts.map((p) => snapToOption(options, p, category));
      if (hits.some((h) => h === null)) {
        const ok = hits.filter((h): h is string => h !== null);
        if (ok.length === 0) return none(false, "no-confident-option");
        return { value: ok.join(", "), kind, source, rule, deviceAbstained: false };
      }
      return { value: (hits as string[]).join(", "), kind, source, rule, deviceAbstained: false };
    }
    const snapped = snapToOption(options, value, category);
    if (!snapped) return none(false, "no-confident-option");
    value = snapped;
  }
  return { value, kind, source, rule, deviceAbstained: false };
}
