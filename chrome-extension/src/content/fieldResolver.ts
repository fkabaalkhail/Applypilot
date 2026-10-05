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
import { placeOf } from "./placeMatch";
import { closestDemographicOption, declineOption, hispanicRaceOption, veteranOption } from "./demographicMatch";
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
// "2SLGBTQI+" (Canada) and "2ELGBTQI+" (French) carry no word boundary before
// "LGBT" (Coveo, live 2026-10-05).
const LGBTQ_Q = /\b(?:2[se])?lgbt\w*|\b(queer|gay|lesbian|bisexual|sexual orientation)\b/i;

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
  if (category === "eeoOther" && /\b(?:2[se])?lgbt/i.test(label)) {
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
  // Only transgender options are qualified ("Female" | "Male" | "Transgender-
  // Female", Braze; question bank 2026-10-05): a cisgender identity is the
  // plain gender.
  if (kind.source.includes("cis") && !qualified.some((o) => kind.test(o))) {
    const plain = options.filter((o) => !qualified.includes(o));
    return gender ? closestDemographicOption(category, gender, plain) : null;
  }
  const sex = /^(female|woman)$/i.test(gender) ? /\b(woman|female)\b/i : /^(male|man)$/i.test(gender) ? /\b(man|male)\b/i : null;
  if (!sex) return undefined;
  const both = qualified.filter((o) => kind.test(o) && sex.test(o));
  return both.length === 1 ? both[0] : undefined;
}

const APPLICANT_ADDRESS: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "location", "addressStreet", "addressCity", "addressState", "postalCode", "country",
]);
/** A field named for an education or employment history row. */
const HISTORY_ROW = /education|school|employ|experience|work ?history|job ?history|workhistory/i;

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

/** A second street line: "Address Line 2", "Address 2", "Apt / Suite". */
function isAddressLine2(label: string, signals: FieldSignals): boolean {
  if (/address-line2/i.test(signals.autocomplete ?? "")) return true;
  const text = `${label} ${signals.nameAttr} ${signals.idAttr}`;
  return /\b(address ?(line ?)?2|line ?2|addr(ess)?_?2|apt|apartment|suite|unit number)\b/i.test(text) || /\baddress2\b/i.test(text);
}

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
  // A fact asked WITH an essay is still an essay: "What is your major? Please
  // describe why you feel it is applicable…" got the major alone
  // (NinjaHoldings on Breezy, live 2026-10-03).
  if (/\b(describe|explain|elaborate|tell us|why (do|did|would|are|is)|in your own words)\b/i.test(label)) return true;
  return !/\b(name of|what is your|what's your|your current|please (enter|provide|list|state) (your|the name))\b/i.test(label);
}

/** Controls whose options are fully known at scan time. */
const CONSTRAINED: ReadonlySet<ControlType> = new Set<ControlType>(["select", "radioGroup", "ariaRadioGroup", "checkboxGroup"]);

const pick = (options: string[], value: string): string | null => matchOption(options, (o) => o, (o) => o, value);

/** An address in the parts a one-line label asks for: "City, ST", "City, ST
 *  ZIP", or the full street address. Null when it asks for no more than one
 *  field gives, or a part is unknown. */
function composedAddress(label: string, profile: UserApplicationProfile): string | null {
  const loc = profileFacts(profile).location;
  const city = isHigh(loc.city) ? loc.city.value : null;
  const region = isHigh(loc.region) ? loc.region.value.code : null;
  const postal = isHigh(loc.postalCode) ? loc.postalCode.value : null;
  const street = isHigh(loc.street) ? loc.street.value : null;
  const zip = /\b(zip|postal|post ?code)\b/i.test(label);
  // One part of a split address ("Home Address Line 1", "Home Address City",
  // SoFi) is that part; only a label asking for the WHOLE address gets it.
  const part = /\b(line ?\d|apt|apartment|unit|suite|city|state|province|zip|postal|cep|country|street (1|2))\b/i.test(label);
  if (!part && (/\b(full|complete) (home |mailing |street |residential )?address\b/i.test(label) || /^\s*what is your (current |home |mailing |permanent |residential )*address\b/i.test(label)) && !/\be-?mail\b/i.test(label)) {
    if (!street || !city) return null;
    return [street, city, [region, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }
  if (/\bcity\b[^?]{0,20}\b(state|province|region)\b/i.test(label)) {
    if (!city || !region || (zip && !postal)) return null;
    return `${city}, ${region}${zip ? ` ${postal}` : ""}`;
  }
  return null;
}

/** Words every school name shares: never what tells two schools apart. */
const SCHOOL_GENERIC = new Set(["university", "universities", "universite", "universitat", "universidad", "universita", "universiteit", "college", "school", "institute", "institution", "academy", "campus", "of", "the", "and", "at", "in", "for", "de", "del", "la", "le", "du", "des", "da", "di"]);

const schoolWords = (s: string): Set<string> =>
  new Set(
    (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !SCHOOL_GENERIC.has(w))
  );

/**
 * A school chosen by its OWN words, the ones left once "School", "University",
 * "of" are set aside: "Turing School of Software & Design" chose "Parsons
 * School of Design" by the words every school shares (Squarespace, question
 * bank 2026-10-05). One name's words must hold all of the other's; among
 * several, the one with exactly the same words ("University of Washington",
 * not "… - Bothell"). None: blank, never a neighbour.
 */
function snapSchool(options: string[], value: string): string | null {
  // The same text twice is one school (Lever's list carries "University of
  // Waterloo" under two values).
  const exact = options.filter((o) => o.trim().toLowerCase() === value.trim().toLowerCase());
  if (exact.length > 0) return exact[0];
  const want = schoolWords(value);
  if (want.size === 0) return null;
  const fits = options.filter((o) => {
    const has = schoolWords(o);
    if (has.size === 0) return false;
    return [...want].every((w) => has.has(w)) || [...has].every((w) => want.has(w));
  });
  if (fits.length === 1) return fits[0];
  const same = fits.filter((o) => {
    const has = schoolWords(o);
    return has.size === want.size && [...want].every((w) => has.has(w));
  });
  return same.length > 0 && same.every((o) => o.trim() === same[0].trim()) ? same[0] : null;
}

/**
 * Snap `value` onto one of `options`, strictly. Country names get their
 * spelling variants first ("Canada" ↔ "CA", "USA" ↔ "United States of America").
 */
export function snapToOption(options: string[], value: string, category: FieldCategory): string | null {
  if (category === "school") return snapSchool(options, value);
  const direct = pick(options, value);
  if (direct) return direct;
  if (category === "country" || category === "phoneCountryCode") {
    const want = countryFromName(value);
    if (want) {
      const hits = options.filter((o) => countryFromName(o.replace(/\s*\(.*\)\s*$/, ""))?.code === want.code);
      if (hits.length === 1) return hits[0];
    }
  }
  // "What is your location?" over a list of countries (Hermeus on Lever, live
  // 2026-10-03): the country the place is in.
  if (category === "location") {
    const code = placeOf(value).country;
    if (code) {
      const hits = options.filter((o) => countryFromName(o.replace(/\s*\(.*\)\s*$/, ""))?.code === code);
      if (hits.length === 1) return hits[0];
    }
  }
  // A major the list does not carry ("Mechatronics Engineering" among Computer
  // Science / Computer Engineering / … / Other, Palantir on Lever): "Other" is
  // true, a sibling discipline is not.
  if (category === "fieldOfStudy") {
    // "Computing" is Computer Science (Imperial's MSc in Computing got "Other"
    // on Palantir's major list, live 2026-10-03).
    if (/^(computing|informatics|informatique)$/i.test(value.trim())) {
      const cs = options.filter((o) => /^computer science$/i.test(o.trim()));
      if (cs.length === 1) return cs[0];
    }
    const other = options.filter((o) => /^other(\s*\(.*\))?\W*$/i.test(o.trim()));
    if (other.length === 1) return other[0];
    // "Other (Technical)" and "Other (Non-Technical)" (SpaceX's Discipline,
    // live 2026-10-03: "Software Engineering" went to the AI): by the major.
    if (other.length > 1) {
      const wanted = TECHNICAL_FIELD.test(value) ? /\(\s*technical\s*\)/i : /\(\s*non[\s-]?technical\s*\)/i;
      const qualified = other.filter((o) => wanted.test(o));
      if (qualified.length === 1) return qualified[0];
    }
  }
  return null;
}

/** A major in engineering, the sciences or computing. */
const TECHNICAL_FIELD =
  /\b(engineering|computer|computing|software|mathematics|math|physics|chemistry|biochemistry|biology|statistics|data|informatics|information (technology|systems)|robotics|mechatronics|electronics|astronomy|geology)\b|\b(applied|natural|physical|computer|data|materials|earth|environmental) sciences?\b/i;

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
  // A URL input rejects a link without a scheme ("linkedin.com/in/…" was
  // written into Superhuman's, live 2026-10-03): the page would not submit.
  if (kind === "url") return valueFitsKind(v, kind) ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : null;
  if (kind === "phone" || kind === "email" || kind === "date") {
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
    // The profile knows the date to the month or year only: the missing day
    // is no more the AI's to invent than ours (Ramp's "Pick date...", live
    // 2026-10-03, was sent to it).
    return { value: null, kind: r.kind, source: "none", deviceAbstained: true, rule: "wrong-kind:partial-date", dateFormat };
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
  // An education or employment row's City / State / Country belongs to the
  // school or the employer, never to the applicant's address (Paylocity's
  // "educationHistory.city.0" got the applicant's city, live 2026-10-03).
  if (source === "category" && APPLICANT_ADDRESS.has(category) && HISTORY_ROW.test(`${signals.nameAttr} ${signals.idAttr}`)) {
    return none(true, "row:not-applicant-address");
  }
  // "Legal Name (if different than above)" (Cloudflare on Greenhouse, live
  // 2026-10-05): the profile has one name, so it is never different.
  if (source === "category" && (category === "fullName" || category === "firstName" || category === "lastName") && /\bif (it is |its )?different\b/i.test(label)) {
    return none(true, "name:if-different");
  }
  // "In what City, State and Zip are you currently residing?" (Box) and
  // "…city and state… (e.g. San Jose, CA)" (Zscaler) got the city alone;
  // "What is your current full address?" (Riot) got no street (question bank
  // 2026-10-05). The parts the label asks for, in one line.
  if (source === "category" && (kind === "text" || kind === "longText") && (category === "addressCity" || category === "location" || category === "addressStreet")) {
    const composed = composedAddress(label, profile);
    if (composed) value = composed;
  }
  // "What are your salary expectations (hourly)?" (StackAdapt, question bank
  // 2026-10-05) got "$185,000": a pay figure only in the unit it was asked in.
  if (source === "category" && category === "salary" && value && (kind === "text" || kind === "number" || kind === "longText")) {
    const unitOf = (t: string): string | null =>
      /\b(hourly|per hour|an hour|hour ?rate)\b|\/ ?(h|hr|hour)\b/i.test(t) ? "hour" : /\b(monthly|per month|a month)\b|\/ ?(mo|month)\b/i.test(t) ? "month" : /\b(annual|annually|yearly|per year|a year|per annum)\b|\/ ?(yr|year)\b/i.test(t) ? "year" : null;
    const asked = unitOf(label);
    const given = unitOf(value) ?? "year";
    if (asked && asked !== given) return none(true, "salary:other-unit");
  }
  // "Secondary Major" (Jane Street, question bank 2026-10-05) got the major:
  // the profile names one field of study.
  if (source === "category" && category === "fieldOfStudy" && (/\b(secondary|second|double|dual|additional) (major|field|concentration)\b/i.test(label) || (/\bminors?\b/i.test(label) && !/\bmajor\b/i.test(label)))) {
    return none(true, "major:no-second");
  }
  // "University Email Address" (Jane Street, question bank 2026-10-05) got
  // the personal one: only an academic address is a university email.
  if (source === "category" && category === "email" && /\b(university|school|student|college|academic|campus|\.edu)\b[^?]{0,20}\be-?mail\b/i.test(label) && !/@[^@\s]+\.(edu|ac\.[a-z]{2,3}|edu\.[a-z]{2})$/i.test((value ?? "").trim())) {
    return none(true, "email:not-academic");
  }
  // "Alternate Email" (Duolingo, live 2026-10-05) got the email again: the
  // profile holds one email and one phone.
  if (source === "category" && (category === "email" || category === "phone") && /\b(alternate|alternative|secondary|additional|backup|second|other)\b/i.test(label)) {
    return none(true, "contact:no-second");
  }
  // Address Line 2 is the unit ("app. 3" of "4520 rue Saint-Denis, app. 3"),
  // never a copy of line 1 (Pinpoint got "1 Washington Sq" twice, live
  // 2026-10-03). No unit: blank, and nothing for the AI to invent.
  if (category === "addressStreet" && value && isAddressLine2(label, signals)) {
    const unit = /,\s*((?:apt|app|appt|apartment|unit|suite|ste|bureau|#)\b.*)$/i.exec(value);
    if (!unit) return none(true, "address-line2:none");
    value = unit[1].trim();
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
  // Race and Hispanic origin asked in one list: a Hispanic applicant's answer.
  if (input.sensitive && category === "eeoRace" && options?.length) {
    const hispanic = hispanicRaceOption(profile.eeo?.hispanicLatino ?? "", options);
    if (hispanic === null) return none(false, "eeo:race-hispanic-unsettled");
    if (hispanic !== undefined) value = hispanic;
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
      // One option, once: "No, I do not have a disability" splits on its own
      // comma, and both halves land on the same box ("No, I do not have a
      // disability and have not had one in the past" twice over).
      const ok = [...new Set(hits.filter((h): h is string => h !== null))];
      if (ok.length === 0) return none(false, "no-confident-option");
      return { value: ok.join(", "), kind, source, rule, deviceAbstained: false };
    }
    // A demographic answer in other words ("Female" among Man / Woman, Ashby):
    // the on-device demographic matcher knows the synonyms.
    const snapped = snapToOption(options, value, category) ?? (input.sensitive ? closestDemographicOption(category, value, options) : null);
    if (!snapped) return none(false, "no-confident-option");
    value = snapped;
  }
  return { value, kind, source, rule, deviceAbstained: false };
}
