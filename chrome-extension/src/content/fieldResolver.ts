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
import { isHigh, profileFacts } from "./profileFacts";
import { resolveQuestion, type QuestionContext, type QuestionInput, type QuestionResult } from "./questionResolver";
import { countryFromName } from "./geo";
import { closestDemographicOption, declineOption, veteranOption } from "./demographicMatch";
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

/** Demographic questions answered "decline" when the profile holds no answer:
 *  it discloses nothing, and a required one no longer blocks the submit. */
const EEO_DECLINABLE: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "eeoGender", "eeoRace", "eeoHispanic", "eeoVeteran", "eeoDisability",
  "eeoGenderIdentity", "eeoSexualOrientation", "eeoPronouns", "eeoOther",
]);
const CHOICE_CONTROLS: ReadonlySet<ControlType> = new Set<ControlType>([
  "select", "radioGroup", "ariaRadioGroup", "combobox", "customDropdown", "checkboxGroup",
]);
/** What a decline reads as before a lazy dropdown's options are known; the
 *  on-device demographic matcher maps it to the form's own wording. */
export const EEO_DECLINE = "Decline to self-identify";

/** "Do you identify as transgender?": its own question, never an LGBTQ+ one. */
const TRANS_Q = /\b(identify as|are you|consider yourself( to be)?)( a)? trans(gender)?\b|\btrans(gender)? (identity|status|experience)\b/i;
const LGBTQ_Q = /\b(lgbt\w*|queer|gay|lesbian|bisexual|sexual orientation)\b/i;

/**
 * Gender identity asked three ways (live 2026-10-03). "Do you identify as
 * transgender?" (Ashby) is answered from a cisgender / transgender identity.
 * Plain gender options ("Female", "Male", "Gender non-binary" on
 * PointClickCare; "Man", "Woman" on Ashby) take the GENDER answer, which an
 * identity like "Cisgender" is not one of. Qualified options ("Cisgender
 * woman") need both, so a cisgender woman never lands on "Cisgender man".
 * undefined = no refinement.
 */
function refineGenderIdentity(
  category: FieldCategory,
  label: string,
  options: string[] | undefined,
  profile: UserApplicationProfile
): string | null | undefined {
  const identity = (profile.eeo?.genderIdentity ?? "").trim();
  const gender = (profile.eeo?.gender ?? "").trim();
  // "Do you identify as LGBTQ+?": Yes for a stated orientation or identity
  // that is one; No only when BOTH are stated and neither is. A cisgender
  // identity says nothing about orientation, so it never answers alone.
  if (category === "eeoOther" && /\blgbt/i.test(label)) {
    const orientation = (profile.eeo?.sexualOrientation ?? "").trim();
    if (/\b(gay|lesbian|bisexual|queer|pansexual)\b/i.test(orientation) || /\btrans(gender)?\b/i.test(identity)) return "Yes";
    if (/^(heterosexual|straight)$/i.test(orientation) && /\bcis(gender)?\b/i.test(identity)) return "No";
    return undefined;
  }
  if ((category === "eeoOther" || category === "eeoGenderIdentity") && TRANS_Q.test(label) && !LGBTQ_Q.test(label)) {
    if (/\bcis(gender)?\b/i.test(identity)) return "No";
    if (/\btrans(gender)?\b/i.test(identity)) return "Yes";
    return undefined;
  }
  if (category !== "eeoGenderIdentity" || !options?.length) return undefined;
  const qualified = options.filter((o) => /\b(cis|trans)(gender)?\b/i.test(o));
  if (qualified.length === 0) return /\b(male|female|man|woman)\b/i.test(options.join(" ")) && gender ? gender : undefined;
  const kind = /\bcis(gender)?\b/i.test(identity) ? /\bcis(gender)?\b/i : /\btrans(gender)?\b/i.test(identity) ? /\btrans(gender)?\b/i : null;
  // Options split by cis/trans and the profile states neither: "Cisgender
  // man" from "Male" claims an identity the user never gave (a real profile
  // on Robinhood, 2026-10-03). Only an unqualified option ("Man",
  // "Non-binary") may answer; else decline, as for any unanswered EEO question.
  if (!kind) {
    const plain = options.filter((o) => !qualified.includes(o));
    return gender ? closestDemographicOption(category, gender, plain) : null;
  }
  const sex = /^(female|woman)$/i.test(gender) ? /\b(woman|female)\b/i : /^(male|man)$/i.test(gender) ? /\b(man|male)\b/i : null;
  if (!sex) return undefined;
  const both = qualified.filter((o) => kind.test(o) && sex.test(o));
  return both.length === 1 ? both[0] : undefined;
}

const CURRENT_JOB_LABEL = /\b(current|currently|present|presently)\b/i;
const RECENT_JOB_LABEL = /\b(most recent|recent|previous|last|latest|former)\b/i;

/**
 * The company / title for a field outside a repeating row, read against the
 * DATED experience rows. The backend sends the resume's first job as the
 * current company whatever its end date: a real profile's internship that
 * ended in May 2026 was typed into "Current company" in October (Lever,
 * Commvault). So a label that says current gets a job still running or
 * nothing (null), and a bare "Company" / "Title" (Workable's experience
 * entry) gets the most recent job, its title from the same row as the
 * company. undefined = keep the value as resolved.
 */
function employmentForLabel(
  category: FieldCategory,
  label: string,
  profile: UserApplicationProfile,
  value: string | null
): string | null | undefined {
  const emp = profileFacts(profile).employment;
  const rows = (profile.experience ?? []).filter((r) => r && (r.company?.trim() || r.title?.trim()));
  const same = (a: string | undefined, b: string): boolean => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  if (CURRENT_JOB_LABEL.test(label) && !RECENT_JOB_LABEL.test(label)) {
    const ended = emp.currentlyEmployed?.value === false;
    const fromRow = value !== null && rows.some((r) => same(category === "currentCompany" ? r.company : r.title, value));
    return ended && fromRow ? null : undefined;
  }
  if (category === "currentTitle" && !value) {
    const company = isHigh(emp.currentCompany) ? emp.currentCompany.value : emp.mostRecentCompany?.value ?? "";
    const row = company ? rows.find((r) => same(r.company, company)) : undefined;
    return row?.title?.trim() || undefined;
  }
  return undefined;
}

function eeoDecline(category: FieldCategory, controlType: ControlType, options: string[] | undefined): string | null {
  if (!EEO_DECLINABLE.has(category) || !CHOICE_CONTROLS.has(controlType)) return null;
  const real = (options ?? []).filter((o) => o.trim());
  if (real.length > 0) return declineOption(real);
  return controlType === "combobox" || controlType === "customDropdown" ? EEO_DECLINE : null;
}

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
  // A major the list does not carry ("Mechatronics Engineering" among Computer
  // Science / Computer Engineering / … / Other, Palantir on Lever): "Other" is
  // true, a sibling discipline is not.
  if (category === "fieldOfStudy") {
    const other = options.filter((o) => /^other(\s*\(.*\))?\W*$/i.test(o.trim()));
    if (other.length === 1) return other[0];
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
  // A radio group is never a row's date or school control: Superhuman's "When
  // is your expected graduation date?" radios (ids "…-labeled-radio-0") were
  // treated as a row's graduation year and never reached the question resolver.
  const isRadios = control.controlType === "radioGroup" || control.controlType === "ariaRadioGroup";
  const inRepeatingRow = control.groupIndex !== null && control.groupIndex !== undefined && ROW_CATEGORIES.has(category) && !isRadios;
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
  if (
    (category === "currentCompany" || category === "currentTitle") &&
    source === "category" &&
    control.controlType !== "checkbox" &&
    (control.groupIndex ?? null) === null
  ) {
    const adjusted = employmentForLabel(category, label, profile, value);
    if (adjusted === null) return none(true, "employment:not-current");
    if (adjusted !== undefined) value = adjusted;
  }
  if (input.sensitive) {
    const refined = refineGenderIdentity(category, label, options, profile);
    if (refined !== undefined) value = refined;
  }
  // Veteran status: an answer settles only the options it actually claims
  // ("not a protected veteran" is not "never served"); else left for the user.
  if (input.sensitive && category === "eeoVeteran" && value?.trim() && options?.length) {
    const veteran = veteranOption(value, label, options);
    if (veteran === null) return none(false, "eeo:veteran-not-settled");
    if (veteran !== undefined) value = veteran;
  }
  // A demographic question the profile holds no answer for: decline (default).
  if ((value === null || !value.trim()) && input.sensitive) {
    const decline = eeoDecline(category, control.controlType, options);
    if (decline) return { value: decline, kind, source: "question", rule: "default:eeo-decline", deviceAbstained: false };
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
      const hits = parts.map((p) => snapToOption(options, p, category) ?? (input.sensitive ? closestDemographicOption(category, p, options) : null));
      if (hits.some((h) => h === null)) {
        const ok = hits.filter((h): h is string => h !== null);
        if (ok.length === 0) return none(false, "no-confident-option");
        return { value: ok.join(", "), kind, source, rule, deviceAbstained: false };
      }
      return { value: (hits as string[]).join(", "), kind, source, rule, deviceAbstained: false };
    }
    // A demographic answer in other words ("Female" among Man / Woman, Ashby):
    // the on-device demographic matcher knows the synonyms.
    const snapped = snapToOption(options, value, category) ?? (input.sensitive ? closestDemographicOption(category, value, options) : null);
    if (!snapped) return none(false, "no-confident-option");
    value = snapped;
  }
  return { value, kind, source, rule, deviceAbstained: false };
}
