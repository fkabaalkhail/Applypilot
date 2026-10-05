/**
 * Deterministic question answering: recognizes the SHAPE of a screening
 * question and answers it from derived profile facts (profileFacts.ts),
 * rendered into what the field accepts (one of its real options, or Yes/No,
 * or a number, or a date).
 *
 * Three outcomes, and the difference between the last two is load-bearing:
 *   answer   the shape is recognized and the facts settle it (high confidence)
 *   abstain  the shape is recognized and the facts do NOT settle it. The field
 *            must stay blank: no category fallback, no backend guess. "Are you
 *            authorized to work in the United States?" for a Canadian citizen
 *            is unknown, and the old category path answered it "Yes".
 *   null     not a shape this module knows; the category resolver decides.
 *
 * Pure: no DOM. `today`, the job's country and company are injected.
 */
import type { ControlType, FieldCategory, UserApplicationProfile } from "../shared/types";
import { isBooleanOptionSet, optionPolarity, type AnswerKind } from "./answerKind";
import {
  CA_PROVINCES as CA_PROVINCES_LIST,
  COUNTRIES,
  KNOWN_CITIES,
  US_STATES as US_STATES_LIST,
  countryByCode,
  countryFromName,
  countryHintForCity,
  geoNorm,
  regionFromText,
  type Country,
} from "./geo";
import {
  authorizedIn,
  degreeRank,
  isHigh,
  needsSponsorshipIn,
  polarityOf,
  type Confidence,
  type ProfileFacts,
} from "./profileFacts";
import { matchOption } from "./writeEngine";
import { resolveDefault } from "./defaultAnswers";

export interface QuestionInput {
  label: string;
  helpText?: string;
  controlType: ControlType;
  inputType?: string;
  placeholder?: string;
  options?: string[];
  category: FieldCategory;
  kind: AnswerKind;
}

export interface QuestionContext {
  /** ISO code of the country the JOB is in, when the page says. */
  jobCountry: string | null;
  /** The hiring company's name, when known. */
  company: string;
  /** The job's city, when the page says ("San Francisco"). */
  jobCity?: string | null;
  /** Every place the posting lists, when it lists several ("San Francisco, CA"). */
  jobPlaces?: string[] | null;
}

export type QuestionResult =
  | { status: "answer"; value: string; confidence: Confidence; rule: string }
  | { status: "abstain"; rule: string; blockBackend?: boolean }
  | null;

const answer = (value: string, rule: string, confidence: Confidence = "high"): QuestionResult => ({
  status: "answer",
  value,
  confidence,
  rule,
});
/**
 * Abstentions on LEGAL-STATUS facts (work authorization, sponsorship,
 * citizenship, age) also keep the field from the backend: its rule pass
 * answers those unconditionally ("authorized to work?" Yes, "sponsorship?"
 * No, "18 or older?" Yes), so sending them is asking for a guess. Every
 * other abstention leaves the field to the backend's AI (essays, opinions,
 * a skill's years), which is the right tool once it has credits again.
 */
const BLOCK_BACKEND_RULES = /^(work-auth|sponsorship|citizenship|age-gate|conditional:does-not-apply|clearance:other-country|graduation:not-enrolled|pursuing:not-enrolled|clearance:level-unknown|high-school:not-in-profile|school-schedule:unknown|conditional-follow-up|phone-extension:not-in-profile)/;
const abstain = (rule: string): QuestionResult => ({ status: "abstain", rule, blockBackend: BLOCK_BACKEND_RULES.test(rule) });

/** Lowercase, accents stripped, apostrophes dropped, punctuation → space. */
export function qnorm(text: string): string {
  return (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Rendering a computed answer into what the field accepts
// ---------------------------------------------------------------------------

const pickOption = (options: string[], value: string): string | null => matchOption(options, (o) => o, (o) => o, value);

/** Render a computed yes/no. With options: the ONE option of that polarity. */
export function renderBoolean(value: boolean, q: QuestionInput): string | null {
  const opts = (q.options ?? []).filter((o) => o.trim());
  if (opts.length > 0) {
    const same = opts.filter((o) => optionPolarity(o) === value);
    if (same.length === 1) return same[0];
    const bare = same.filter((o) => /^(yes|no)$/i.test(o.trim()));
    return bare.length === 1 ? bare[0] : null;
  }
  if (q.controlType === "checkbox") return value ? "yes" : "no";
  return value ? "Yes" : "No";
}

function booleanResult(value: boolean, q: QuestionInput, rule: string): QuestionResult {
  const v = renderBoolean(value, q);
  return v ? answer(v, rule) : abstain(`${rule}:no-matching-option`);
}

/** A dropdown with no options yet, asked as a yes/no ("Are you…?", "Do you…?"). */
function isYesNoDropdown(q: QuestionInput, n: string): boolean {
  if (q.options && q.options.length) return false;
  if (q.controlType !== "combobox" && q.controlType !== "customDropdown") return false;
  return /^(are|do|will|would|can|could|have|has|is|did) you\b/.test(n);
}

/** The question asks for the boolean, its options (when known) allow it. */
function isBooleanQuestion(q: QuestionInput): boolean {
  if (q.kind === "boolean") return true;
  return isBooleanOptionSet(q.options);
}

// ---------------------------------------------------------------------------
// Country / place named by a question
// ---------------------------------------------------------------------------

const THIS_COUNTRY = /\b(this country|the country (in which|where) (this|the) (job|position|role)|country of employment|the country where you are applying|where this (job|role|position) is located)\b/i;

/**
 * The country a question asks about, from its own words. "U.S."/"US" only
 * count in capitals: lowercase "us" is the pronoun ("work for us").
 * `"this-country"` = the question points at the job's country.
 */
export function countryNamedIn(raw: string): { code: string } | "this-country" | null {
  const text = raw || "";
  if (/\bU\.?\s?S\.?A?\b(?!\w)/.test(text) || /\bunited states\b/i.test(text) || /(?<!(north|south|latin|central)\s)\bamerica\b/i.test(text)) {
    return { code: "US" };
  }
  if (/\bcanad(a|ian)\b/i.test(text)) return { code: "CA" };
  if (/\b(united kingdom|great britain|britain)\b/i.test(text) || /\bUK\b/.test(text)) return { code: "GB" };
  const n = ` ${qnorm(text)} `;
  for (const c of COUNTRIES) {
    if (c.code === "US" || c.code === "CA" || c.code === "GB") continue;
    if (n.includes(` ${qnorm(c.name)} `)) return { code: c.code };
  }
  if (THIS_COUNTRY.test(text)) return "this-country";
  return null;
}

/** "…in the country that you are located?" (Netlify): the applicant's own country. */
const RESIDENCE_COUNTRY =
  /\b(the )?country (that |where |in which )?you (are |currently )*(located|living|reside|live|based)\b|\byour (current )?country of residence\b|\b(remain|stay) in your current (location|country)\b|\bwhere you (currently )?(live|reside)\b/;

function targetCountry(q: QuestionInput, ctx: QuestionContext, facts?: ProfileFacts): string | null {
  const named = countryNamedIn(q.label);
  if (named === "this-country") return ctx.jobCountry;
  if (named) return named.code;
  if (facts && RESIDENCE_COUNTRY.test(qnorm(q.label))) return residenceOf(facts);
  return ctx.jobCountry;
}

/**
 * The job's country as the FORM implies it, for a page that states none: when
 * every work-authorization / sponsorship question that names a country names
 * the same one ("Are you authorized to work in the US?" beside an unscoped
 * "Will you require sponsorship?", RAVE on Workable, live 2026-10-03), the
 * employer is asking about the country the job is in.
 */
export function formCountryHint(labels: string[]): string | null {
  const found = new Set<string>();
  for (const label of labels) {
    const n = qnorm(label);
    if (!WORK_RIGHT.test(n) && !SPONSOR.test(n)) continue;
    const c = countryNamedIn(label);
    if (c && c !== "this-country") found.add(c.code);
  }
  return found.size === 1 ? [...found][0] : null;
}

const residenceOf = (facts: ProfileFacts): string | null =>
  isHigh(facts.location.country) ? facts.location.country.value.code : null;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const WORK_RIGHT =
  /\b(authori[sz]ed|eligible|entitled|permitted|allowed|legally able|legal right|right|permission) to (legally |lawfully )?work\b|\bwork authori[sz]ation\b|\bwork permit\b|\b(legally|lawfully) (work|be employed|employed)\b|\bauthori[sz]ation to work\b|\bwork (legally|lawfully)\b|\b(eligible|authori[sz]ed|permitted|allowed) to (legally |lawfully )?(begin|start|commence|accept|take up) (employment|work)\b|\beligible for employment\b/;

/** A sponsorship need ruled out: "do not require…", "without the need for
 *  sponsorship", "no sponsorship". "No, I need sponsorship now" is no such
 *  thing: its "No" answers the work right. */
const NEGATED_NEED =
  /\b(do not|does not|dont|doesnt|will not|wont|not|never|without)( any| the need for| need for| needing| requiring)? (visa |immigration |employer |employment |company )?(require|requires|need|needs|sponsor\w*)\b|\bno (visa |immigration |employer |employment )?sponsor\w*/;

/** "By selecting 'Yes,' you confirm that you do not require Visa Sponsorship"
 *  (Peloton, question bank 2026-10-05): the label says what Yes means. */
const YES_MEANS =
  /\bby (selecting|choosing|clicking|checking|answering|marking|ticking) yes\b (you|i) (confirm|certify|acknowledge|attest|agree|declare|state|represent|affirm)s? (that )?(.+)$/;

/** "Are you able to work…" is a work RIGHT question only when it names a
 *  country and no arrangement: "able to work from our Kepler office" (Lever,
 *  live 2026-10-03) is about the office, and was answered as authorization. */
function isAbleToWorkInCountry(n: string, raw: string): boolean {
  if (!/\bable to work\b/.test(n)) return false;
  if (/\b(office|onsite|on site|in person|remote|remotely|hybrid|weekends?|nights?|shifts?|overtime|hours|travel|commute|schedule|full time|part time|days a week)\b/.test(n)) return false;
  const c = countryNamedIn(raw);
  return c !== null;
}
/** "What Duolingo sponsored conferences have you attended?" (question bank
 *  2026-10-05) is about conferences, not a visa. */
const SPONSOR = /\bsponsor(ship|ing)?\b|\bsponsored\b(?! (conferences?|events?|programs?|programmes?|hackathons?|organi[sz]ations?|communit(y|ies)|groups?|clubs?|scholarships?|teams?|content|posts?)\b)|\b(visa|immigration) (status|support|assistance|transfer)\b|\bh ?1 ?b\b/;
/** Asks whether sponsorship is NEEDED ("will you require / do you need … sponsorship"). */
const REQUIRES_SPONSOR = /\b(require|requires|requiring|need|needs|needing)\b[^?]{0,60}\bsponsor/;
/** Asks for the work RIGHT itself ("are you legally authorized…", "do you have the right to work…"). */
const ASKS_RIGHT =
  /\b(are|is) (you|the applicant)\b[^?]{0,25}\b(authori[sz]ed|eligible|entitled|permitted|allowed|legally able)\b|\bdo you (have|hold|possess)\b[^?]{0,25}\b(right|authori[sz]ation|permit)\b/;
/** Asks whether the work right is NEEDED ("do you require work authorization?",
 *  "will you need a work permit…"): the inverse of having it. */
const NEEDS_RIGHT =
  /\b(do|does|will|would|shall) you\b.{0,20}\b(require|need)\b.{0,30}\b(work authori[sz]ation|authori[sz]ation to work|work permit|work visa|employment authori[sz]ation)\b/;
/** Asks WHICH sponsorship or visa, not whether: no profile answer states it. */
const SPONSOR_TYPE = /\b(what|which) (type of |kind of |form of )?(visa )?(sponsorship|visa|work permit)\b|\b(type|kind|form) of (visa |work )?(sponsorship|visa|permit)\b/;
const WITHOUT_SPONSOR = /\bwithout (the )?(need (for|of) |needing |requiring |requirement (for|of) )?(any )?(current or future )?(visa |employer |employment |immigration |company )?sponsor/;

/**
 * "Have you held H-1B status, or had an H-1B petition approved on your behalf
 * in the past 6 years?" (Twitch, live 2026-10-03) asks about the PAST, and was
 * answered as "will you need sponsorship?" (Yes, for a Canadian not authorized
 * in the US). The profile's own statement says H-1B → Yes; a statement naming
 * no US visa at all → No (the unencumbered default); any other US visa
 * (F-1, OPT, TN, L-1…) → the applicant's to answer.
 */
function resolveH1bHistory(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (!/\bh ?1 ?b\b/.test(n) || !/\b(have|had|did|were) you\b[^?]*\b(held|had|been|filed|approved|registered|selected|petition)\w*/.test(n)) return null;
  if (!isBooleanQuestion(q)) return abstain("h1b-history:not-yes-no");
  const stated = (profile.workAuthorization || "").toLowerCase();
  if (/\bh-?1 ?b\b/.test(stated)) return booleanResult(true, q, "h1b-history:stated");
  if (/\b(f-?1|j-?1|m-?1|opt|cpt|stem opt|tn|l-?1|o-?1|e-?3|h-?4|ead|green card|visa)\b/.test(stated)) return abstain("h1b-history:other-us-visa");
  return booleanResult(false, q, "default:no-h1b-history");
}

/**
 * "After the OPT, are you eligible for a 24-month OPT extension or are
 * currently in a 24-month OPT extension based upon a degree … in Science,
 * Technology, Engineering, or Mathematics?" (Duolingo, live 2026-10-05: a US
 * citizen got Yes, read as "are you in the US?"). A stated STEM OPT: Yes. A
 * statement naming no U.S. student status (a citizen, an H-1B): No. Plain
 * OPT, or F-1: the applicant's to answer.
 */
function resolveOptExtension(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (!/\b(stem )?opt extension\b|\b24 month opt\b|\bstem opt\b/.test(n)) return null;
  // "Will you require sponsorship (e.g., H-1B, E-3, TN, O-1, STEM OPT…)?"
  // (DoorDash, live 2026-10-05): STEM OPT is an example there, and the
  // question is the sponsorship one.
  if (REQUIRES_SPONSOR.test(n)) return null;
  if (!isBooleanQuestion(q)) return abstain("opt-extension:not-yes-no");
  const stated = (profile.workAuthorization || "").toLowerCase();
  if (/\bstem opt\b/.test(stated)) return booleanResult(true, q, "opt-extension:stated");
  if (/\b(f-?1|opt|cpt|student visa|j-?1)\b/.test(stated)) return abstain("opt-extension:unknown");
  if (!stated.trim()) return abstain("opt-extension:unknown");
  return booleanResult(false, q, "opt-extension:no-student-status");
}

/**
 * Whether a sponsorship the applicant needs is needed NOW. Authorized today
 * through a temporary EAD (OPT, a work permit), the need is later; an H-1B,
 * TN or L-1 moves to a new employer only with a new petition, and someone not
 * authorized at all needs it from the start. A label that counts the
 * applicant's own status as sponsorship ("(e.g., H-1B, E-3, TN, O-1, STEM
 * OPT…)", DoorDash, live 2026-10-05) makes it now: a STEM OPT holder needs the
 * new employer's paperwork from day one.
 */
function sponsorshipNeededNow(n: string, facts: ProfileFacts, profile: UserApplicationProfile, country: string | null, residence: string | null): boolean {
  const a = authorizedIn(facts.workAuth, country, residence);
  const stated = (profile.workAuthorization || "").toLowerCase();
  const own = /\bstem opt\b/.test(stated) ? /\bopt\b/ : /\bopt\b/.test(stated) ? /(?<!\bstem )\bopt\b/ : /\bcpt\b/.test(stated) ? /\bcpt\b/ : /\bead\b/.test(stated) ? /\bead\b/ : null;
  const temporary = isHigh(a) && a.value === true && /\b(opt|ead|cpt|work permit|pgwp|open work permit)\b/.test(stated) && !/\b(h-?1 ?b|tn|l-?1|e-?3|o-?1)\b/.test(stated);
  return !temporary || Boolean(own?.test(n));
}

/** Visa names: as the applicant states them, and as an option names them. */
const VISA_NAMES: [RegExp, RegExp][] = [
  [/\bh-?1 ?b\b/, /\bh-?1 ?b\b/],
  [/\btn\b/, /\b(tn|usmca|nafta)\b/],
  [/\b(stem )?opt\b|\bf-?1\b/, /\bopt\b|\bf-?1\b/],
  [/\bcpt\b/, /\bcpt\b/],
  [/\bl-?1\b/, /\bl-?1\b/],
  [/\be-?3\b/, /\be-?3\b/],
  [/\bo-?1\b/, /\bo-?1\b/],
  [/\bj-?1\b/, /\bj-?1\b/],
  [/\bblue card\b/, /\bblue card\b/],
];

/**
 * "Yes, <visa>" options under a sponsorship question ("No | Yes, EU Blue Card
 * | Yes, USMCA Professional (TN) Visa (USA) | Yes, F-1 Visa OPT (USA) | Yes,
 * but not one of the visas listed here", GitLab, live 2026-10-05): the one
 * side the need picks, then the Yes naming the applicant's own visa, then the
 * Yes saying it is not listed. A need with no visa stated picks none.
 */
function chooseSponsorshipOption(options: string[], need: boolean, stated: string, now: boolean | null): string | null {
  const side = options.filter((o) => o.trim() && optionPolarity(o) === need);
  if (side.length === 1) return side[0];
  if (!need || side.length === 0) return null;
  // "Yes, … now" beside "Yes, … in the future" (Airbnb, question bank
  // 2026-10-05): when the need starts.
  const nowOpt = side.filter((o) => /\b(now|currently|immediately)\b/.test(qnorm(o)) && !/\b(future|later)\b/.test(qnorm(o)));
  const laterOpt = side.filter((o) => /\b(future|later)\b/.test(qnorm(o)) && !/\b(now|currently|immediately)\b/.test(qnorm(o)));
  if (nowOpt.length === 1 && laterOpt.length === 1) return now === null ? null : now ? nowOpt[0] : laterOpt[0];
  const mine = VISA_NAMES.filter(([own]) => own.test(stated.toLowerCase()));
  if (mine.length === 0) return null;
  const named = side.filter((o) => mine.some(([, named]) => named.test(o.toLowerCase())));
  if (named.length > 0) return named.length === 1 ? named[0] : null;
  const unlisted = side.filter((o) => /\bnot (one of|listed|among)\b|\b(an|any )?other\b|\bnone of\b/.test(o.toLowerCase()));
  return unlisted.length === 1 ? unlisted[0] : null;
}

function resolveWorkAuthorization(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile, ctx: QuestionContext): QuestionResult {
  const h1b = resolveH1bHistory(q, n, profile);
  if (h1b) return h1b;
  const opt = resolveOptExtension(q, n, profile);
  if (opt) return opt;
  // A notice to acknowledge, its only option "Yes" or "I acknowledge" ("…By
  // submitting an application, I acknowledge that I have read and understand
  // the E-verify notice", Riot Games; question bank 2026-10-05): no work
  // right is asked. The acknowledgement defaults take it.
  // A "Select..." placeholder is no option (Riot's notice under it was read
  // as a work-right question, question bank 2026-10-05).
  const only = (q.options ?? []).filter((o) => o.trim() && !/^(select|choose|please select|select an option|select one|--)/i.test(o.trim()));
  if (only.length === 1 && /\b(i acknowledge|i have read|i understand|acknowledge that)\b/.test(n)) return null;
  // The label says what Yes means: "By selecting 'Yes,' you confirm that you
  // do not require Visa Sponsorship" (Peloton, question bank 2026-10-05: every
  // applicant got the inverse). That statement is what gets answered.
  const means = YES_MEANS.exec(n);
  if (means && (SPONSOR.test(means[5]) || WORK_RIGHT.test(means[5])) && (isBooleanQuestion(q) || isYesNoDropdown(q, n))) {
    const said = means[5];
    const where = targetCountry(q, ctx, facts);
    const home = residenceOf(facts);
    const a = authorizedIn(facts.workAuth, where, home);
    const s = needsSponsorshipIn(facts.workAuth, where, home);
    if (SPONSOR.test(said)) {
      if (!isHigh(s)) return abstain("work-auth:yes-means-unknown");
      const ruledOut = NEGATED_NEED.test(said);
      // "…authorized to work … without sponsorship": the right as well.
      if (ruledOut && WORK_RIGHT.test(said) && isHigh(a) && a.value === false) return booleanResult(false, q, "work-auth:yes-means");
      return booleanResult(ruledOut ? !s.value : s.value, q, "work-auth:yes-means");
    }
    if (!isHigh(a)) return abstain("work-auth:yes-means-unknown");
    return booleanResult(a.value, q, "work-auth:yes-means");
  }
  const hasSponsor = SPONSOR.test(n);
  // "Will you require sponsorship … to legally work in the U.S.?" (ZipRecruiter,
  // live 2026-10-03) asks about SPONSORSHIP; its work-right words are only the
  // purpose. A work-right phrase counts when it is asked ("are you authorized…").
  const sponsorAsked = hasSponsor && REQUIRES_SPONSOR.test(n) && !ASKS_RIGHT.test(n);
  const hasRight = !sponsorAsked && (WORK_RIGHT.test(n) || isAbleToWorkInCountry(n, q.label));
  if (!hasRight && !hasSponsor) return null;
  // "Will you require relocation assistance or visa sponsorship?" asks two
  // things; the sponsorship half alone cannot answer it.
  if (hasSponsor && /\brelocat/.test(n)) return abstain("sponsorship:compound-question");
  // "If you're not authorized to work at the stated location, what sponsorship
  // would you require for the role?" (Brex, live 2026-10-03) wants the TYPE,
  // and got the work-authorization statement ("Canadian citizen").
  if (hasSponsor && SPONSOR_TYPE.test(n) && !isBooleanQuestion(q)) return abstain("sponsorship:type-unknown");
  const country = targetCountry(q, ctx, facts);
  const residence = residenceOf(facts);

  // "Are you eligible to work in Canada without sponsorship?" = authorized AND no sponsorship.
  if (hasRight && WITHOUT_SPONSOR.test(n)) {
    if (!isBooleanQuestion(q)) return abstain("work-auth-without-sponsorship:not-boolean");
    const a = authorizedIn(facts.workAuth, country, residence);
    const s = needsSponsorshipIn(facts.workAuth, country, residence);
    if (isHigh(a) && a.value === false) return booleanResult(false, q, "work-auth-without-sponsorship:not-authorized");
    if (isHigh(s) && s.value === true) return booleanResult(false, q, "work-auth-without-sponsorship:needs-sponsorship");
    if (isHigh(a) && a.value === true && isHigh(s) && s.value === false) {
      return booleanResult(true, q, "work-auth-without-sponsorship");
    }
    return abstain("work-auth-without-sponsorship:unknown");
  }

  if (hasSponsor && !hasRight) {
    // "Will you now or in the future require sponsorship…"
    const s = needsSponsorshipIn(facts.workAuth, country, residence);
    const now = isHigh(s) && s.value === true ? sponsorshipNeededNow(n, facts, profile, country, residence) : null;
    if (!isBooleanQuestion(q)) {
      // "…please list the type of support you may require" (Pinterest,
      // question bank 2026-10-05) asks for a description: never a yes or no.
      if (/\b(list|describe|specify|explain|provide|detail|elaborate)\b|\b(type|kind|form) of (support|assistance|sponsorship|visa|status)\b/.test(n)) {
        return abstain("sponsorship:type-unknown");
      }
      if (q.options?.some((o) => o.trim())) {
        const pick = isHigh(s) ? chooseSponsorshipOption(q.options, s.value, profile.workAuthorization || "", now) : null;
        return pick ? answer(pick, "sponsorship:option") : abstain("sponsorship:option-unknown");
      }
      // Free text: the applicant's own stated answer, verbatim, when it covers this country.
      if (isHigh(s) && profile.requiresSponsorship?.trim() && q.kind !== "number" && q.kind !== "date") {
        return answer(s.value ? "Yes" : "No", "sponsorship:text");
      }
      return abstain("sponsorship:unknown");
    }
    // "Will you NOW require sponsorship…?" beside "…in the FUTURE…?" (DoorDash,
    // live 2026-10-05: both Yes for an OPT holder). "Do you now, or will you
    // ever, require…" (Toast, question bank 2026-10-05) asks about later too.
    const nowOnly = /\b(now|currently|at this time|presently)\b/.test(n) && !/\b(future|later|eventually|ever|at any (point|time)|going forward)\b/.test(n);
    if (nowOnly && now === false) return booleanResult(false, q, "sponsorship:not-now");
    // A question phrased as the inverse ("Can you work WITHOUT sponsorship?")
    // without a work-right phrase ("…work for us without sponsorship").
    const inverted = /\bwithout\b/.test(n) && !/\b(require|need)\b/.test(n);
    if (isHigh(s)) return booleanResult(inverted ? !s.value : s.value, q, "sponsorship");
    return abstain("sponsorship:unknown");
  }

  // "Do you require work authorization?" (Waymo on Greenhouse, live
  // 2026-10-05) asks whether the right is NEEDED, the inverse of having it:
  // read as "are you authorized?", a Canadian on a US job answered No (and a
  // US citizen would have answered Yes).
  if (!hasSponsor && NEEDS_RIGHT.test(n) && !ASKS_RIGHT.test(n)) {
    const a = authorizedIn(facts.workAuth, country, residence);
    if (!isHigh(a)) return abstain("work-auth-needed:unknown");
    if (isBooleanQuestion(q) || isYesNoDropdown(q, n)) return booleanResult(!a.value, q, "work-auth-needed");
    if ((q.kind === "text" || q.kind === "longText") && !q.options?.length) return answer(a.value ? "No" : "Yes", "work-auth-needed:text");
    return abstain("work-auth-needed:not-yes-no");
  }

  // Work authorization proper. A dropdown whose options load only when opened
  // ("Are you legally authorized to work in the country that you are located?",
  // a Netlify react-select) is a yes/no by its words.
  if (isBooleanQuestion(q) || isYesNoDropdown(q, n)) {
    const a = authorizedIn(facts.workAuth, country, residence);
    if (isHigh(a)) return booleanResult(a.value, q, "work-auth");
    return abstain("work-auth:unknown");
  }
  // A status choice ("What is your work authorization status?"), or free text.
  if (q.options && q.options.length > 0) {
    return resolveStatusChoice(q, facts, country) ?? resolveAuthorizationStatement(q, facts, country, residence) ?? abstain("work-auth-status:unknown");
  }
  if (q.kind === "text" || q.kind === "longText") {
    const stated = profile.workAuthorization?.trim();
    // Only when the statement covers the country asked about (or none is named).
    if (stated && (!country || facts.workAuth.byCountry.has(country) || facts.workAuth.byCountry.size === 0)) {
      return answer(stated, "work-auth:statement");
    }
  }
  return abstain("work-auth:unknown");
}

/**
 * Options that are STATEMENTS about the right to work: "I am authorized to work
 * in the United States for any employer", "…for my present employer only", "I
 * require sponsorship…", "I am not authorized…" (SpaceX on Greenhouse, live
 * 2026-10-03: two options read as a yes, so a green-card holder went to the
 * AI). The one the profile's authorization and sponsorship make true.
 */
function resolveAuthorizationStatement(q: QuestionInput, facts: ProfileFacts, country: string | null, residence: string | null): QuestionResult {
  const opts = (q.options ?? []).map((o) => ({ raw: o, n: qnorm(o), pol: optionPolarity(o) }));
  type Opt = (typeof opts)[number];
  const one = (keep: (o: Opt) => boolean): string | null => {
    const hits = opts.filter(keep);
    return hits.length === 1 ? hits[0].raw : null;
  };
  // "I require sponsorship…", "Yes, but I will need sponsorship in the future",
  // "No, I need sponsorship now"; never "I do not require sponsorship".
  const requires = (o: Opt) => /\b(require|requires|need|needs)\b/.test(o.n) && /\bsponsor/.test(o.n) && !NEGATED_NEED.test(o.n);
  const notAuthorized = (o: Opt) => /\b(am|is|are) not (legally |currently )?(authorized|eligible|permitted)\b/.test(o.n);
  const a = authorizedIn(facts.workAuth, country, residence);
  const s = needsSponsorshipIn(facts.workAuth, country, residence);
  // An option's own Yes or No answers the work right: "Yes, but I will need
  // sponsorship in the future" claims it (Datadog, question bank 2026-10-05:
  // written for an applicant with no US work right at all). Only a leading
  // Yes or No: "I require … sponsorship" reads affirmative, and says the
  // opposite of authorized (Lyft).
  const yn = (o: Opt): boolean | null => (/^(yes|no)\b/.test(o.n) ? o.pol : null);
  const fitsRight = (o: Opt) => !isHigh(a) || yn(o) === null || yn(o) === a.value;
  // A need the applicant STATED decides, whatever the work right (a student
  // visa's is unclear); one only inferred from "not authorized" does not, and
  // the literal answer is then "not authorized".
  if (facts.workAuth.statedSponsorship === true && isHigh(s) && s.value === true) {
    const pick = one((o) => requires(o) && fitsRight(o));
    if (pick) return answer(pick, "work-auth-statement:needs-sponsorship");
    if (!isHigh(a) || a.value !== false) return null;
  }
  if (!isHigh(a)) return null;
  if (a.value === false) {
    const pick =
      one(notAuthorized) ??
      one((o) => yn(o) !== true && requires(o)) ??
      // A bare "No" beside statements of the right ("Yes, I am a Canadian
      // citizen…", "Yes, I have a valid permit", Coveo).
      one((o) => o.pol === false && !requires(o));
    return pick ? answer(pick, "work-auth-statement:not-authorized") : null;
  }
  if (!isHigh(s)) return null;
  if (s.value === true) {
    const pick = one((o) => yn(o) !== false && requires(o));
    return pick ? answer(pick, "work-auth-statement:needs-sponsorship") : null;
  }
  const pick =
    one((o) => /\b(authorized|eligible|permitted)\b/.test(o.n) && /\bany employer\b/.test(o.n) && !/\bnot\b/.test(o.n)) ??
    // "Yes, no restriction." beside "Yes, but I will need sponsorship…" (Datadog).
    one((o) => o.pol === true && !/\bsponsor/.test(o.n) && !/\b(present|current) employer only\b/.test(o.n));
  return pick ? answer(pick, "work-auth-statement:any-employer") : null;
}

/** A citizenship / status option for a status choice question. */
function resolveStatusChoice(q: QuestionInput, facts: ProfileFacts, country: string | null): QuestionResult {
  const opts = q.options ?? [];
  const entries = [...facts.workAuth.byCountry.entries()].filter(([code]) => !country || code === country);
  if (entries.length !== 1) return null;
  const [code, auth] = entries[0];
  const countryName = countryByCode(code)?.name ?? "";
  const want =
    auth.basis === "citizen"
      ? /\bcitizen/
      : auth.basis === "permanent_resident"
        ? /\b(permanent resident|green card|lawful permanent)\b/
        : null;
  if (!want) return null;
  const hits = opts.filter((o) => want.test(qnorm(o)));
  // Prefer the one naming the right country when several mention citizenship.
  const named = hits.filter((o) => countryNamedIn(o) && (countryNamedIn(o) as { code: string }).code === code);
  const pick = named.length === 1 ? named[0] : hits.length === 1 && !countryNamedIn(hits[0]) ? hits[0] : null;
  return pick ? answer(pick, `work-auth-status:${auth.basis}:${countryName}`) : null;
}

const CITIZEN_Q = /\b(are you|is the applicant) (a |an )?((u ?s|us|united states|canadian|american|british|uk) )?citizen\b|\bcitizen of\b|\bcitizenship\b/;

/**
 * "Since obtaining your most recent citizenship, did you afterwards become a
 * permanent resident in any other country/region?" (Amazon's export questions,
 * on Twitch's Greenhouse form, live 2026-10-03: answered "United States").
 * A stated permanent residency is one taken in a country not theirs: Yes. A
 * citizen living in a country of their citizenship, with no residency stated
 * anywhere: No. Temporary statuses do not count, by the question's own terms.
 */
function resolveLaterResidency(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\b(since|after) (obtaining|acquiring|receiving|gaining|becoming)\b.*\bcitizen(ship)?\b.*\bpermanent resident\b/.test(n)) return null;
  if (!isBooleanQuestion(q) && q.options?.length) return null;
  const known = [...facts.workAuth.byCountry.entries()];
  if (known.some(([, a]) => a.basis === "permanent_resident")) return booleanResult(true, q, "later-residency:pr");
  const citizenOf = new Set(known.filter(([, a]) => a.basis === "citizen").map(([cc]) => cc));
  const home = isHigh(facts.location.country) ? facts.location.country.value.code : null;
  if (home && citizenOf.has(home)) return booleanResult(false, q, "later-residency:none");
  return abstain("later-residency:unknown");
}

function resolveCitizenship(q: QuestionInput, n: string, facts: ProfileFacts, ctx: QuestionContext): QuestionResult {
  if (!CITIZEN_Q.test(n)) return null;
  const country = countryNamedIn(q.label);
  const code = country === "this-country" ? ctx.jobCountry : country?.code ?? null;
  const known = facts.workAuth.byCountry;
  // A yes/no in words ("…requires US citizenship…, do you meet that
  // requirement?", Striveworks on Greenhouse, live 2026-10-03) is a yes/no
  // even before its options load: it was answered "Canada".
  const yesNoWords = /\b(do|are|can|will|would) you\b[^?]*\??\s*$|\bdo you meet\b/.test(n) && !/\b(which|what) (country|countries)\b/.test(n);
  if (isBooleanQuestion(q) || (yesNoWords && !(q.options && q.options.length))) {
    // Not allowed to work there: certainly not a citizen there.
    if (code && known.get(code)?.authorized === false) return booleanResult(false, q, "citizenship:not-authorized");
    if (!code) return abstain("citizenship:no-country");
    const c = known.get(code);
    if (!c) return abstain("citizenship:unknown");
    const orPr = /\bpermanent resident|green card\b/.test(n);
    if (c.basis === "citizen") return booleanResult(true, q, "citizenship");
    if (c.basis === "permanent_resident") return booleanResult(orPr, q, "citizenship:pr");
    if (c.basis === "work_permit" || c.basis === "student") return booleanResult(false, q, "citizenship:visa");
    return abstain("citizenship:unknown");
  }
  // "Citizenship Status" asks a STATUS ("(b) U.S. lawful permanent resident"),
  // not a country: answered from its options once they load, never settled
  // before. Read as a country, a green-card holder's was blocked for good
  // (SpaceX on Greenhouse, live 2026-10-03).
  if (/\bcitizenship status\b|\bstatus of (your )?citizenship\b/.test(n)) {
    if (!q.options?.length) return null;
    return resolveStatusChoice(q, facts, code) ?? abstain("citizenship:status-unknown");
  }
  // "Country of citizenship" choice/text.
  const citizenOf = [...known.entries()].filter(([, a]) => a.basis === "citizen").map(([cc]) => countryByCode(cc)!);
  if (citizenOf.length !== 1) return abstain("citizenship:unknown");
  return renderCountry(citizenOf[0], q, "citizenship:country");
}

// ----- Residence ------------------------------------------------------------

// "…or are currently in a 24-month OPT extension based upon a degree from a
// qualifying U.S. institution" is no residence (Duolingo, live 2026-10-05:
// answered Yes as "are you in the US?"): never "in a/an" something.
const RESIDE = /\b(live|living|reside|residing|resident|located|based|currently in(?! an? )|located within|within commuting distance)\b/;

const METRO_ALIASES: Record<string, string> = { nyc: "new york", gta: "toronto", "bay area": "san francisco", sf: "san francisco" };

/**
 * The place a residence question names, found by SCANNING the label for a
 * place we know (country, state/province full name, major city or metro),
 * rather than by parsing its grammar: real labels interleave the place with
 * clauses ("based in or planning to relocate to the NYC area and able to…").
 */
function placeIn(label: string): { kind: "country"; code: string } | { kind: "region"; code: string; country: string } | { kind: "city"; name: string } | null {
  const country = countryNamedIn(label);
  if (country && country !== "this-country") return { kind: "country", code: country.code };
  const n = ` ${geoNorm(label)} `;
  // Region FULL names only: two-letter codes collide with words ("in", "or", "me").
  for (const r of [...US_STATES_LIST, ...CA_PROVINCES_LIST]) {
    for (const name of [r.name, ...(r.aliases ?? [])]) {
      const key = geoNorm(name);
      // "New York" is a state AND a city; "New York City"/"NYC" is the city.
      if (key === "new york" && /\bnew york city\b|\bnyc\b/.test(n)) continue;
      if (key === "washington" && /\bwashington d ?c\b/.test(n)) continue;
      if (n.includes(` ${key} `)) return { kind: "region", code: r.code, country: r.country };
    }
  }
  for (const [alias, city] of Object.entries(METRO_ALIASES)) {
    if (n.includes(` ${alias} `)) return { kind: "city", name: city };
  }
  for (const city of KNOWN_CITIES) {
    if (n.includes(` ${city} `)) return { kind: "city", name: city };
  }
  return null;
}

/** The APPLICANT is the one who lives/is located somewhere. "This position
 *  requires you to work from the Toronto office located at …" is about the
 *  office; reading it as residence answered a commute question (Lever, live
 *  2026-10-03), and so did "Are you able to commute … the New York HQ office
 *  (located at …)" (Peloton, question bank 2026-10-05). */
const APPLICANT_RESIDES =
  /\b(do|are|have|did) you\b(?:(?!\b(?:office|offices|headquarters|hq|campus|building|facility)\b)[^?]){0,60}?\b(live|living|reside|residing|located|based|resident|currently in(?! an? ))\b|\bare you (a |an )?(current )?resident\b|\byour (current )?(location|residence|city of residence|place of residence)\b|\bwhere (do|are) you\b/;

function resolveResidence(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile): QuestionResult {
  // "By selecting 'Yes,' you confirm that you currently reside in the New
  // York, NY area or are prepared to commute or relocate at your own expense"
  // (Peloton, question bank 2026-10-05): the statement is the question.
  const means = YES_MEANS.exec(n);
  if (means && RESIDE.test(means[5]) && isBooleanQuestion(q)) {
    const said = /\b(?:confirm|certify|acknowledge|attest|agree|declare|state|represent|affirm)s?\s+(?:that\s+)?(?:you|I)\s+(.+)$/i.exec(q.label);
    if (said) {
      const label = `Do you ${said[1].trim()}`;
      return resolveResidence({ ...q, label }, qnorm(label), facts, profile);
    }
  }
  if (!RESIDE.test(n) || !APPLICANT_RESIDES.test(n) || !isBooleanQuestion(q)) return null;
  if (/\b(willing|open|able|plan|planning) to (relocate|move)\b/.test(n) && !/\b(live|reside|located|based)\b/.test(n)) return null;
  const place = placeIn(q.label);
  if (!place) return null;
  const loc = facts.location;
  const residenceCountry = isHigh(loc.country) ? loc.country.value : null;
  // "…or willing to relocate?", and the other way round: "Are you open to
  // relocating if you're not currently based there?" (Gemini, live 2026-10-05).
  const relocateClause = /\b(or|if not)\b[^?]*\b(relocat|move)/.test(n) || /\b(relocat\w*|move)\b[^?]*\bif (you re |you are |youre )?not\b/.test(n);
  const relocate = polarityOf(profile.willingToRelocate || "");

  const yesOrRelocate = (lives: boolean | null, rule: string): QuestionResult => {
    if (lives === null) return abstain(`${rule}:unknown`);
    if (lives) return booleanResult(true, q, rule);
    if (relocateClause) {
      if (relocate === null) return abstain(`${rule}:relocation-unknown`);
      return booleanResult(relocate, q, `${rule}+relocation`);
    }
    return booleanResult(false, q, rule);
  };

  if (place.kind === "country") {
    if (!residenceCountry) return abstain("residence-country:unknown");
    return yesOrRelocate(residenceCountry.code === place.code, "residence-country");
  }
  if (place.kind === "region") {
    if (isHigh(loc.region)) {
      return yesOrRelocate(loc.region.value.code === place.code && loc.region.value.country === place.country, "residence-region");
    }
    if (residenceCountry && residenceCountry.code !== place.country) return yesOrRelocate(false, "residence-region:other-country");
    return abstain("residence-region:unknown");
  }
  // City / metro ("near Seattle", "the NYC area"): the same city is a Yes; a
  // city in ANOTHER country is a No; another city in the same country is "near"
  // or not by a judgment we do not make.
  if (isHigh(loc.city) && geoNorm(loc.city.value) === geoNorm(place.name)) return yesOrRelocate(true, "residence-city");
  const hinted = countryHintForCity(place.name);
  if (hinted && residenceCountry && hinted !== residenceCountry.code) return yesOrRelocate(false, "residence-city:other-country");
  // "…based near our New York City, NY office. Are you open to relocating if
  // you're not currently based there?" (Gemini, live 2026-10-05): someone who
  // will move says Yes either way, and the label's own state settles "near"
  // for anyone in another one.
  if (relocateClause && relocate === true) return booleanResult(true, q, "residence-city+relocation");
  const labelled = /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}),\s*([A-Z]{2})\b/.exec(q.label);
  const region = labelled ? regionFromText(labelled[2]) : null;
  if (region && isHigh(loc.region) && (loc.region.value.code !== region.code || loc.region.value.country !== region.country)) {
    return yesOrRelocate(false, "residence-city:other-region");
  }
  return abstain("residence-city:unknown");
}

// ----- Places as choices ------------------------------------------------------

function renderCountry(country: Country, q: QuestionInput, rule: string): QuestionResult {
  const opts = q.options ?? [];
  if (opts.length === 0) return answer(country.name, rule);
  const hits = opts.filter((o) => {
    const c = countryFromName(o.replace(/\s*\(.*\)\s*$/, "")) ?? countryFromName(o);
    return c?.code === country.code;
  });
  if (hits.length === 1) return answer(hits[0], rule);
  const direct = pickOption(opts, country.name);
  return direct ? answer(direct, rule) : abstain(`${rule}:no-matching-option`);
}

const OUTSIDE_OPTION = /\b(not applicable|n a|none|other|outside|international|non us|not in the|i do not (live|reside)|not a us|foreign|not listed)\b|^na$/;

/** Places under US embargo or sanctions, as export-control questions list them. */
const SANCTIONED = /\b(cuba|iran|north korea|syria|crimea|donetsk|luhansk|zaporizhzhia|kherson|russia|belarus|venezuela|sudan)\b/;

/**
 * Export-control lists of embargoed places ("Citizen or permanent resident of
 * Cuba, Iran, North Korea, or Syria" | … | "None of the above", Databricks;
 * "Do you reside in … any of the following countries: Cuba, Iran…?", Planet
 * Labs; question bank 2026-10-05): the applicant's own countries (citizenship,
 * residence, permanent residence) against every place listed. None named:
 * "None of the above" / No. One named, or the citizenship unknown: blank.
 */
function resolveSanctionedList(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const opts = (q.options ?? []).filter((o) => o.trim() && !/^(select|choose|please select)/i.test(o.trim()));
  const listed = opts.filter((o) => SANCTIONED.test(qnorm(o)));
  const none = opts.filter((o) => /^none( of the above| of these| apply| applies)?\W*$/i.test(o.trim()));
  const checklist = listed.length > 0 && none.length === 1 && opts.every((o) => o === none[0] || SANCTIONED.test(qnorm(o)));
  const yesNo = !checklist && SANCTIONED.test(n) && isBooleanQuestion(q) && /\b(any of the following|the following (countries|territories|regions))\b/.test(n);
  if (!checklist && !yesNo) return null;
  const residence = isHigh(facts.location.country) ? facts.location.country.value : null;
  const held = [...facts.workAuth.byCountry.entries()];
  const citizenOf = held.filter(([, a]) => a.basis === "citizen").map(([cc]) => countryByCode(cc));
  const prOf = held.filter(([, a]) => a.basis === "permanent_resident").map(([cc]) => countryByCode(cc));
  // Only the facts the question asks about: "Do you reside in…" needs no
  // citizenship (Planet Labs).
  const asked = checklist ? opts.join(" ") : q.label;
  const asksCitizenship = /\b(citizens?|citizenship|nationals?|nationality|passport)\b/i.test(asked);
  const asksResidence = /\b(reside|resides|resident|residence|live|living|located|ordinarily)\b/i.test(asked) || !asksCitizenship;
  if ((asksResidence && !residence) || (asksCitizenship && citizenOf.length === 0)) return abstain("sanctions:unknown");
  const mine = [...(asksResidence ? [residence, ...prOf] : []), ...(asksCitizenship ? citizenOf : [])].filter((c): c is Country => Boolean(c));
  const names = (c: Country): string[] => [c.name, ...c.aliases].map(qnorm).filter((w) => w.length > 2);
  const named = (text: string): boolean => {
    const t = ` ${qnorm(text)} `;
    return mine.some((c) => names(c).some((w) => t.includes(` ${w} `)));
  };
  if (checklist) return listed.some(named) ? abstain("sanctions:named") : answer(none[0], "sanctions:none");
  return named(q.label) ? abstain("sanctions:named") : booleanResult(false, q, "sanctions:none");
}

/**
 * "Do you plan to move out of the state/country in which you currently reside
 * within the next 6-12 months?" over "I have no plans to move at this time"
 * and a list of states (Squarespace, question bank 2026-10-05): a plan, and it
 * was answered with the state the applicant lives in. Someone who will not
 * relocate has none; anyone else's plans are their own to state.
 */
function resolveMovePlan(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (!/\b(plan|plans|planning|intend|intending|expect|expecting)( on)? (to )?(move|moving|relocate|relocating)\b/.test(n)) return null;
  // A move in general, not one for this job (the relocation questions).
  if (!/\b(out of|away from|leave|leaving)\b|\b(with)?in the next\b/.test(n) || /\bfor (this|the) (role|position|job|opportunity)\b/.test(n)) return null;
  if (polarityOf(profile.willingToRelocate || "") !== false) return abstain("move-plan:unknown");
  if (isBooleanQuestion(q)) return booleanResult(false, q, "move-plan:none");
  const none = (q.options ?? []).filter((o) => /\bno plans?\b|\bnot (planning|intending)\b|^no\b/.test(qnorm(o)));
  return none.length === 1 ? answer(none[0], "move-plan:none") : abstain("move-plan:unknown");
}

/** The Middle East, in EMEA though its countries are listed under Asia. */
const MIDDLE_EAST = new Set(["TR", "IL", "AE", "SA", "QA", "KW", "BH", "OM", "JO", "LB", "EG"]);

/** An option naming a business region the country is in: "EMEA", "APAC",
 *  "LATAM", "Americas", "Europe", "Asia Pacific", "North America". */
function inWorldRegion(c: Country, option: string): boolean {
  const me = MIDDLE_EAST.has(c.code);
  if (/^(emea|europe middle east (and|&)? ?africa)$/.test(option)) return c.continent === "Europe" || c.continent === "Africa" || me;
  if (/^(apac|asia pacific|asia and pacific|asia)$/.test(option)) return (c.continent === "Asia" && !me) || c.continent === "Oceania";
  if (/^(latam|latin america|south america|central (and|&) south america)$/.test(option)) return c.continent === "South America" || c.code === "MX";
  if (/^(amer|americas|the americas|north america|na)$/.test(option)) return c.continent === "North America" || (option.includes("americas") && c.continent === "South America");
  if (/^europe$/.test(option)) return c.continent === "Europe";
  if (/^(africa)$/.test(option)) return c.continent === "Africa";
  if (/^middle east$/.test(option)) return me;
  return false;
}

/** "Which state do you reside in?" / a State or Province select. */
function resolveRegionChoice(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const asksRegion = q.category === "addressState" || /\b(which|what) (state|province)\b|\bstate (or province )?(of|you) (residence|reside|live)\b|\bprovince of residence\b|\bstate region (in which|where) you (currently )?(reside|live)\b/.test(n);
  if (!asksRegion || !q.options || q.options.length < 3) return null;
  const loc = facts.location;
  if (isHigh(loc.region)) {
    const r = loc.region.value;
    const hit = q.options.filter((o) => {
      const reg = regionFromText(o.replace(/\s*\(.*\)\s*$/, ""));
      return reg?.code === r.code && reg.country === r.country;
    });
    if (hit.length === 1) return answer(hit[0], "region-choice");
  }
  // Buckets beside the states ("New York | Illinois | Another State in the
  // US | APAC | EMEA | Other", Waymo, question bank 2026-10-05): a US
  // applicant's unlisted state, or the applicant's part of the world.
  if (isHigh(loc.country)) {
    const c = loc.country.value;
    if (c.code === "US" && isHigh(loc.region)) {
      const another = q.options.filter((o) => /\b(another|other|different)( us| u s)? states?\b/.test(qnorm(o)) && !/\b(outside|non|not in|international)\b/.test(qnorm(o)));
      if (another.length === 1) return answer(another[0], "region-choice:another-state");
    }
    const bucket = q.options.filter((o) => inWorldRegion(c, qnorm(o)));
    if (bucket.length === 1) return answer(bucket[0], "region-choice:world-region");
  }
  // The options are another country's regions: pick the explicit "not
  // applicable / outside" option, never a real state.
  const optionCountries = new Set(q.options.map((o) => regionFromText(o)?.country).filter(Boolean));
  if (isHigh(loc.country) && optionCountries.size === 1 && !optionCountries.has(loc.country.value.code as "US" | "CA")) {
    const outside = q.options.filter((o) => OUTSIDE_OPTION.test(qnorm(o)) && !regionFromText(o));
    if (outside.length === 1) return answer(outside[0], "region-choice:outside");
    return abstain("region-choice:outside-not-offered");
  }
  return isHigh(loc.region) ? abstain("region-choice:no-matching-option") : abstain("region-choice:unknown");
}

/** "Where are you located?" with region/continent options ("North America"). */
function resolveLocatedChoice(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\bwhere (are you|do you) (currently )?(located|based|live|reside)\b|\b(current|your) location\b|\bregion of residence\b|\bare you (currently )?(living|located|based|residing) in\b/.test(n)) return null;
  // A preference ("preferred work location", "which office") is not a residence.
  if (/\b(prefer|preferred|desired|willing|office|work location|would you like)\b/.test(n)) return null;
  if (!q.options || q.options.length < 2 || isBooleanOptionSet(q.options)) return null;
  // The options must be places at the scale we can judge: countries or continents.
  const placeLike = q.options.filter((o) => countryNamedIn(o) || /\b(north|south|latin|central) america|europe|asia|africa|oceania|emea|apac|latam\b/i.test(o));
  if (placeLike.length === 0) return null;
  const loc = facts.location;
  if (!isHigh(loc.country)) return abstain("located-choice:unknown");
  const country = loc.country.value;
  const city = isHigh(loc.city) ? geoNorm(loc.city.value) : null;
  // Most specific first: the city, then the country, then the continent.
  if (city) {
    const byCity = q.options.filter((o) => ` ${geoNorm(o)} `.includes(` ${city} `));
    if (byCity.length === 1) return answer(byCity[0], "located-choice:city");
  }
  const byCountry = q.options.filter((o) => {
    const c = countryNamedIn(o);
    return c && c !== "this-country" && c.code === country.code;
  });
  if (byCountry.length === 1) return answer(byCountry[0], "located-choice:country");
  // "United States" beside "United States Minor Outlying Islands" and "Virgin
  // Islands, U.S." (Hermeus on Lever, live 2026-10-03): the option that IS the
  // country, not one that names it.
  const itself = byCountry.filter((o) => countryFromName(o.trim())?.code === country.code);
  if (itself.length === 1) return answer(itself[0], "located-choice:country");
  const continent = geoNorm(country.continent);
  const byContinent = q.options.filter((o) => geoNorm(o) === continent || geoNorm(o).includes(continent));
  if (byContinent.length === 1) return answer(byContinent[0], "located-choice:continent");
  return abstain("located-choice:no-matching-option");
}

// ----- Age -----------------------------------------------------------------

const AGE_MIN = /\b(?:at least|minimum(?: age)?(?: of)?|older than|over(?: the age of)?|above)\s+(\d{1,2})\b|\b(\d{1,2})\s*(?:\+|years? of age|years? old|or older|or above|or over|and older|and over)/;
const AGE_UNDER = /\b(?:under|younger than|below|less than)\s+(?:the age of\s+)?(\d{1,2})\b/;

function resolveAge(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const ageWord = /\bage\b|\bold\b|\bolder\b|\byears of age\b/.test(n);
  const under = AGE_UNDER.exec(n);
  const min = under ? null : AGE_MIN.exec(n);
  if ((under || min) && ageWord) {
    const threshold = Number((under ?? min)![1] ?? (under ?? min)![2]);
    if (threshold < 13 || threshold > 80) return null;
    if (!isBooleanQuestion(q)) return null;
    if (!facts.age) return abstain("age-gate:no-dob");
    const [youngest, oldest] = facts.age;
    let meets: boolean | null = null;
    if (youngest >= threshold) meets = true;
    else if (oldest < threshold) meets = false;
    if (meets === null) return abstain("age-gate:straddles");
    return booleanResult(under ? !meets : meets, q, "age-gate");
  }
  if (/\b(what is your age|your age|age range|how old are you|age group)\b/.test(n)) {
    if (!facts.age || facts.age[0] !== facts.age[1]) return abstain("age:no-exact-dob");
    const age = String(facts.age[0]);
    if (q.options && q.options.length) {
      const hit = pickOption(q.options, age);
      return hit ? answer(hit, "age:bucket") : abstain("age:no-matching-option");
    }
    return answer(age, "age:value");
  }
  return null;
}

// ----- Experience ------------------------------------------------------------

const GENERIC_QUALIFIERS = new Set([
  "relevant", "professional", "work", "working", "total", "overall", "paid", "full", "time", "fulltime",
  "industry", "related", "post", "graduate", "postgraduate", "of", "the", "your", "prior", "previous", "practical", "hands", "on",
]);

/** Words naming a field of work, and the title words that count as that field. */
const DOMAINS: Array<{ q: RegExp; title: RegExp }> = [
  { q: /\b(software|programming|coding|development|developer|engineering|engineer|technical|technology|it)\b/, title: /\b(software|developer|engineer|engineering|programmer|swe|sde|full ?stack|front ?end|back ?end|devops|data|machine learning|ml|web|mobile|platform|systems)\b/ },
  { q: /\b(data|analytics|analysis|analyst)\b/, title: /\b(data|analyst|analytics|scientist|bi)\b/ },
];

function resolveYearsOfExperience(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const m = /\b(?:years?|yrs)\s+(?:of\s+)?([a-z\s-]{0,60}?)\s*experience\b|\bhow (?:much|many years of)\s+([a-z\s-]{0,60}?)\s*experience\b|\bexperience \(years\)|\bexperience in years\b/.exec(n);
  if (!m) return null;
  const qualifiers = (m[1] ?? m[2] ?? "").split(/[\s-]+/).filter(Boolean);
  const domainWords = qualifiers.filter((w) => !GENERIC_QUALIFIERS.has(w));
  // "Years of experience WITH React", "…experience do you have IN marketing",
  // "…AS a nurse": what follows narrows the question. A generic object ("in
  // the industry", "in a professional setting") keeps it the career total; a
  // field of work joins the domain check below; anything else (a skill, a
  // tool, a product) is a question the profile cannot answer.
  // An activity may come between ("…experience do you have developing
  // applications using C# and ASP.NET Core?", Vagaro on Breezy, live
  // 2026-10-03: answered "3+ years" from six years of teaching).
  const narrowed =
    /\bexperience\b(?:\s+(?:do|did|have|has|you|of|that|which|would|say|in total)){0,5}(?:\s+[a-z]+ing(?:\s+[a-z]+){0,3}?)?\s+(?:with|in|using|on|as|doing|working with|working in|leading|managing)\s+(?:a |an |the )?([a-z0-9 +#.-]{2,40})/.exec(n);
  if (narrowed) {
    const obj = narrowed[1].trim();
    if (!/^(total|industry|the industry|professional (setting|capacity|environment)s?|similar roles?|this field|the field|related fields?|the workforce|a professional|full time|paid)\b/.test(obj)) {
      domainWords.push(...obj.split(/\s+/).slice(0, 3));
      const dom = DOMAINS.find((d) => d.q.test(obj));
      if (!dom) return abstain("years-experience:narrowed");
    }
  }
  // A stack in parentheses after the experience narrows it too: "…fullstack
  // software engineering experience do you have (Python/React or Vuejs)?"
  // (AlayaCare, question bank 2026-10-05) got the career total.
  const paren = /\bexperience\b[^?(]*\(([^)]{2,80})\)/i.exec(q.label);
  if (paren && !/^\s*(in )?(years?|total|approx\w*|overall)\b/i.test(paren[1])) return abstain("years-experience:narrowed");
  const total = facts.employment.totalYears;
  if (!isHigh(total)) return abstain("years-experience:unknown");
  if (domainWords.length > 0) {
    const phrase = domainWords.join(" ");
    const dom = DOMAINS.find((d) => d.q.test(phrase));
    const titles = facts.employment.titles;
    if (!dom || titles.length === 0 || !titles.every((t) => dom.title.test(t.toLowerCase()))) {
      return abstain("years-experience:domain-unproven");
    }
    // A specialty inside the field ("fullstack", "front end", "mobile") is
    // proven only by titles that name it.
    const specialty = /\b(full ?stack|front ?end|back ?end|mobile|ios|android|embedded|devops|machine learning|security|cloud|qa)\b/.exec(phrase);
    if (specialty && !titles.every((t) => new RegExp(`\\b${specialty[1].replace(/ /g, " ?")}\\b`, "i").test(t.toLowerCase().replace(/-/g, " ")))) {
      return abstain("years-experience:specialty-unproven");
    }
  }
  const years = total.value;
  if (isBooleanQuestion(q)) {
    // "Do you have at least 3 years of experience?" / "3+ years" / "more than 5 years"
    // "1-2 years of experience" (FSSI on Workable, live 2026-10-03, answered
    // NO for 1.4 years): a range is met from its lower bound.
    // (Normalized, "1–2 years" reads "1 2 years".)
    const range = /\b(\d+(?:\.\d+)?)\s*(?:-|to|\s)\s*(\d+(?:\.\d+)?)\s*\+?\s*(years?|yrs)\b/.exec(n);
    if (range) return booleanResult(years >= Number(range[1]), q, "years-experience:range");
    // "under 2 years" is the inverse of "at least 2" (Veeva on Lever: its N/A
    // option "I have more than 2 years" was picked for 1.4 years).
    const under = /\b(under|less than|fewer than|below)\s+(\d+(?:\.\d+)?)\s*(years?|yrs)\b/.exec(n);
    if (under) return booleanResult(years < Number(under[2]), q, "years-experience:under");
    const need = /\b(at least|minimum( of)?|more than|over|greater than)?\s*(\d+(?:\.\d+)?)\s*\+?\s*(or more\s+)?(years?|yrs)\b/.exec(n);
    if (!need) return abstain("years-experience:boolean-no-threshold");
    const threshold = Number(need[3]);
    const strict = /more than|over|greater than/.test(need[1] ?? "");
    return booleanResult(strict ? years > threshold : years >= threshold, q, "years-experience:threshold");
  }
  if (q.options && q.options.length) {
    const hit = pickOption(q.options, String(years));
    return hit ? answer(hit, "years-experience:bucket") : abstain("years-experience:no-matching-option");
  }
  return answer(String(Math.floor(years)), "years-experience:value");
}

// ----- Education ---------------------------------------------------------------

const LEVEL_Q = /\bhighest (completed )?(level of )?(education|degree|qualification|educational|schooling)\b|\b(level|type) of (education|degree)\b|\beducation(al)? level\b|\bdegree level\b|\bhighest education\b/;

/** Rank an OPTION (labels like "Bachelors", "Associates", "GED", "PhD"). */
function optionRank(o: string): number | null {
  const t = qnorm(o);
  if (/\bged\b|\bhigh school\b|\bsecondary\b/.test(t)) return 1;
  if (/\bassociates?\b/.test(t)) return 3;
  if (/\bbachelors?\b|\bundergrad/.test(t)) return 4;
  if (/\bmasters?\b|\bmba\b/.test(t)) return 5;
  if (/\bphd\b|\bdoctor(ate|al)?\b/.test(t)) return 6;
  return degreeRank(o);
}

function resolveEducationLevel(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const ed = facts.education;
  // "Do you have / have you completed a bachelor's degree?"
  const asked = /\b(do you have|have you (completed|obtained|earned|received|attained)|do you hold|did you (complete|earn|obtain))\b/.test(n) ? degreeRank(n) ?? optionRank(n) : null;
  if (asked && isBooleanQuestion(q)) {
    if (/\b(in|related|relevant) (to )?(a |the )?(computer|engineering|stem|related field|technical|science|business)\b|\bfield\b|\bmajor\b/.test(n)) {
      return abstain("degree-held:field-qualified");
    }
    const pursuing = /\b(or (are )?(you )?(currently )?(pursuing|enrolled|working towards|working toward|completing)|in progress|expected)\b/.test(n);
    const rank = pursuing ? ed.highestRank : ed.highestCompletedRank;
    if (isHigh(rank)) return booleanResult(rank.value >= asked, q, "degree-held");
    if (!pursuing && isHigh(ed.highestRank) && ed.highestRank.value < asked) return booleanResult(false, q, "degree-held:below");
    return abstain("degree-held:unknown");
  }
  if (!LEVEL_Q.test(n)) return null;
  const completedAsked = /\b(completed|attained|obtained|achieved|earned)\b/.test(n);
  const rank = ed.highestCompletedRank;
  // A degree in progress with none completed past high school: "Some College"
  // is the level held under either reading of "highest" (a bachelor's
  // student on ActioNet's Jobvite form, a real profile, 2026-10-03). Only
  // when the list offers it.
  const studying = ed.entries.some((x) => x.completed === false && x.rank !== null && x.rank >= 3);
  if (studying && (!isHigh(rank) || rank.value <= 1) && q.options?.length) {
    const some = q.options.filter((o) => /\bsome (college|university|post ?secondary)\b/.test(qnorm(o)));
    if (some.length === 1) return answer(some[0], "education-level:some-college");
  }
  // Highest level with something still in progress above it: "completed"
  // questions take the completed level; ambiguous wording abstains.
  if (!isHigh(rank)) return abstain("education-level:unknown");
  if (!completedAsked && isHigh(ed.highestRank) && ed.highestRank.value > rank.value) return abstain("education-level:in-progress-above");
  if (!q.options || q.options.length === 0) {
    const label = [, "High School", "Diploma", "Associate Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"][rank.value];
    return label ? answer(label, "education-level:value") : abstain("education-level:unknown");
  }
  const hits = q.options.filter((o) => optionRank(o) === rank.value);
  if (hits.length === 1) return answer(hits[0], "education-level");
  // "High School" vs "GED", "Master's" vs "MBA": prefer the generic one.
  const generic = hits.filter((o) => !/\b(ged|mba|m b a|md|jd)\b/.test(qnorm(o)));
  if (generic.length === 1) return answer(generic[0], "education-level");
  return abstain("education-level:no-unique-option");
}

function resolveEnrollment(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\b(currently|presently) (a |an )?(full time |part time )?(student|enrolled|attending|pursuing)\b|\bare you (a |an )?(current )?(full time |part time )?student\b|\benrolled (in|at)\b/.test(n)) return null;
  if (!isBooleanQuestion(q)) return null;
  // "...enrolled at a Canadian institution" / "...at the University of X":
  // more than enrollment, leave it.
  if (/\b(institution|university|college|school) (in|of|located)\b|\bpost secondary institution\b|\bduring\b|\bafter\b|\bthrough\b|\buntil\b/.test(n)) return abstain("enrollment:qualified");
  const e = facts.education.currentlyEnrolled;
  // "…enrolled in an accredited 4-year Bachelor's degree program or have
  // graduated within the past 2 years?" (Samsara, question bank 2026-10-05:
  // a June 2026 graduate said No): enrolled at that level, or finished it
  // that recently.
  const within = /\bor (have |has )?(graduated|completed)( \w+){0,3} (with)?in the (past|last) (\d+|one|two|three|four|five) (years?|months?)\b/.exec(n);
  if (within) {
    const count = /^\d+$/.test(within[6]) ? Number(within[6]) : ["one", "two", "three", "four", "five"].indexOf(within[6]) + 1;
    const since = new Date(facts.today.getTime());
    since.setUTCMonth(since.getUTCMonth() - (/month/.test(within[7]) ? count : count * 12));
    const asked = degreeLevelAsked(n);
    const fits = (x: { rank: number | null }) => asked === null || x.rank === asked;
    const entries = facts.education.entries;
    if (entries.some((x) => x.completed === false && fits(x))) return booleanResult(true, q, "enrollment:or-graduated-within");
    if (entries.some((x) => x.completed === true && fits(x) && x.graduation && x.graduation.latest >= since)) return booleanResult(true, q, "enrollment:or-graduated-within");
    // Every degree finished before the window, or at another level we can name.
    if (entries.length > 0 && entries.every((x) => x.completed === true && x.graduation && (x.graduation.latest < since || (x.rank !== null && !fits(x))))) {
      return booleanResult(false, q, "enrollment:or-graduated-within");
    }
    return abstain("enrollment:unknown");
  }
  // "…enrolled in a PhD program…?" asks about THAT level (Neighbor on Lever,
  // live 2026-10-03: "Yes" for a bachelor's student).
  const level = degreeLevelAsked(n);
  if (level !== null) return programAtLevel(q, level, facts, "enrollment:level");
  // "…currently enrolled in OR have graduated from a university?": either one.
  if (/\bor (have |has )?(graduated|completed)\b|\bor (a )?(recent )?graduate\b/.test(n)) {
    if (isHigh(e) && e.value) return booleanResult(true, q, "enrollment:or-graduated");
    if (facts.education.entries.some((x) => x.completed === true)) return booleanResult(true, q, "enrollment:or-graduated");
    return abstain("enrollment:unknown");
  }
  if (isHigh(e)) return booleanResult(e.value, q, "enrollment");
  return abstain("enrollment:unknown");
}

/**
 * "Have you completed at least one previous internship? Please provide
 * details." (Hermeus on Lever, live 2026-10-03): the history's finished
 * internships and co-ops, named, or No.
 */
function resolvePreviousInternship(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (!/\b(have|did) you\b.*\b(completed|done|had|held|finished)\b.*\b(internships?|co ?ops?)\b/.test(n)) return null;
  const done = (profile.experience ?? []).filter(
    (e) => /\bintern(ship)?\b|\bco ?-?op\b/i.test(e.title ?? "") && Boolean(e.endDate?.trim()) && !/\b(present|current|now|ongoing)\b/i.test(e.endDate ?? "")
  );
  if (isBooleanQuestion(q)) return booleanResult(done.length > 0, q, "internship:history");
  if (q.kind !== "text" && q.kind !== "longText") return null;
  if (done.length === 0) return answer("No", "internship:none");
  const named = done.map((e) => `${e.title} at ${e.company}` + (e.startDate && e.endDate ? ` (${e.startDate} to ${e.endDate})` : ""));
  return answer(`Yes, ${named.join("; ")}`, "internship:history");
}

/**
 * "Do you have a school schedule that allows you to work part-time from our
 * Foster City office…?" (Zoox on Lever, live 2026-10-03: "Yes" for a developer
 * out of school). No school, no schedule: No. A student's timetable is theirs
 * to know; the AI could only guess it.
 */
function resolveSchoolSchedule(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\b(school|class|academic|course|university|college) (schedule|timetable)\b/.test(n) || !isBooleanQuestion(q)) return null;
  const entries = facts.education.entries;
  if (entries.length > 0 && entries.every((e) => e.completed === true)) return booleanResult(false, q, "school-schedule:not-enrolled");
  return abstain("school-schedule:unknown");
}

/**
 * "Are you available to participate in a full double-block co-op from January
 * 2027 through August 2027?" (Mindex on Workable, live 2026-10-03): a co-op is
 * a placement for enrolled students, so a graduate is not available for one.
 * A student's availability is the term's (resolvePeriodAvailability).
 */
function resolveCoop(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\bco ?op\b/.test(n) || !/\b(available|able|eligible) to (participate|complete|do|take part|join)\b|\bparticipate in\b/.test(n)) return null;
  if (!isBooleanQuestion(q)) return null;
  const entries = facts.education.entries;
  return entries.length > 0 && entries.every((e) => e.completed === true) ? booleanResult(false, q, "co-op:not-enrolled") : null;
}

/** The degree level a question names ("PhD program", "master's student"), as a rank. */
function degreeLevelAsked(n: string): number | null {
  if (/\b(phd|ph d|doctoral|doctorate)\b/.test(n)) return 6;
  if (/\b(masters?|graduate (program|student|degree)|mba)\b/.test(n) && !/\bundergraduate\b/.test(n)) return 5;
  if (/\b(bachelors?|undergraduate)\b/.test(n)) return 4;
  return null;
}

/** Is the applicant in a program at that level right now? From the rows in progress. */
function programAtLevel(q: QuestionInput, level: number, facts: ProfileFacts, rule: string): QuestionResult {
  const inProgress = facts.education.entries.filter((x) => x.completed === false);
  if (inProgress.length === 0) {
    return isHigh(facts.education.currentlyEnrolled) && facts.education.currentlyEnrolled.value === false
      ? booleanResult(false, q, rule)
      : abstain(rule + ":unknown");
  }
  if (inProgress.some((x) => x.rank === null)) return abstain(rule + ":unknown");
  return booleanResult(inProgress.some((x) => x.rank === level), q, rule);
}

/**
 * "Which degree are you currently pursuing?" (Superhuman on Ashby, live
 * 2026-10-03): the level of the degree in progress, ranked like the options.
 * A graduate pursues none: the list's own "not a student" option, else blank
 * and kept from the AI, which could only pick a degree they are not taking.
 */
function resolvePursuedDegree(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\b(which|what)\b.*\b(degree|program|level)\b.*\b(pursuing|working towards?|enrolled in|studying for)\b/.test(n)) return null;
  if (/\bor (have |has )?(completed|graduated|earned|obtained)\b|\bmost recent\b|\bhighest\b/.test(n)) return null;
  if (isBooleanQuestion(q) || !q.options?.length) return null;
  const entries = facts.education.entries;
  const inProgress = entries.filter((x) => x.completed === false);
  if (inProgress.length === 0) {
    if (entries.length === 0 || entries.some((x) => x.completed !== true)) return abstain("pursuing:unknown");
    const none = q.options.filter((o) => /\bnot (currently )?(pursuing|enrolled|a student)\b|^(none|n a|not applicable)\b/.test(qnorm(o)));
    return none.length === 1 ? answer(none[0], "pursuing:none") : abstain("pursuing:not-enrolled");
  }
  if (inProgress.some((x) => x.rank === null)) return abstain("pursuing:unranked");
  const top = Math.max(...inProgress.map((x) => x.rank as number));
  const hits = q.options.filter((o) => optionRank(o) === top);
  return hits.length === 1 ? answer(hits[0], "pursuing") : abstain("pursuing:no-unique-option");
}

/** "Are you currently an advanced PhD candidate?" (NTT DATA on Ashby, live 2026-10-03). */
function resolveDegreeCandidate(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\bare you (currently )?(a |an )?(advanced )?\w*\s?(phd|ph d|doctoral|doctorate|masters?|mba|undergraduate|bachelors?) (candidate|student)\b/.test(n)) return null;
  if (!isBooleanQuestion(q) && q.controlType !== "combobox") return null;
  const level = degreeLevelAsked(n);
  return level === null ? null : programAtLevel(q, level, facts, "degree-candidate");
}

/** "Are you attending or a recent graduate of the University of X?" */
function resolveSchoolMembership(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const m = /\b(?:attend(?:ing|ed)?|graduate(?:d)? (?:of|from)|student (?:at|of)|alum(?:nus|na|ni)? of|studying at)\s+(?:the\s+)?((?:university|college|institute|school|polytechnic)\b[^?,]*|[a-z .&-]+ (?:university|college|institute))/.exec(n);
  if (!m || !isBooleanQuestion(q)) return null;
  const named = qnorm(m[1]).replace(/^the /, "");
  // "…or have graduated from a university?" names no school: an education question.
  if (/^(a|an|any|some|one|your|accredited)\b/.test(named)) return null;
  const entries = facts.education.entries;
  if (entries.length === 0) return abstain("school-membership:no-education");
  const hit = entries.some((e) => {
    const s = qnorm(e.school);
    return s && (s.includes(named) || named.includes(s));
  });
  return booleanResult(hit, q, "school-membership");
}

function resolveGraduation(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  // "When do you expect to complete your degree?" (Stripe, question bank
  // 2026-10-05) got the degree's name: it asks when it ends.
  const completes = /\bwhen\b[^?]*\b(complete|completing|finish|finishing)\b[^?]*\b(degree|program|programme|studies|education)\b/.test(n);
  if (!completes && (!/\bgraduat(e|ed|ion|ing)\b/.test(n) || !/\b(year|date|when|month|term|semester|expected|anticipated)\b/.test(n))) return null;
  if (q.kind === "boolean") return null;
  if (completes && !q.options?.length && q.kind !== "date") {
    const p = facts.education.primary;
    if (!p?.graduation) return abstain("graduation:unknown");
    if (p.completed === true && /\bexpect|\bwill\b/.test(n)) return abstain("graduation:not-enrolled");
    const g = p.graduation;
    const y = String(g.earliest.getUTCFullYear());
    return answer(g.precision === "year" ? y : `${g.earliest.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${y}`, "graduation:completion");
  }
  // "…degree result, or expected result if you have not yet graduated?"
  // (Canonical, question bank 2026-10-05) asks for a grade: resolveGpa's.
  if (/\b(degree|university|academic|final|expected) (result|results|grade|grades|classification)\b/.test(n)) return null;
  // "What year did you / will you graduate from university (undergrad)?" (K1
  // on JazzHR, regression 2026-10-05) got the master's year: the degree of
  // the level asked, when the profile has exactly one.
  const levelAsked = /\b(undergrad|undergraduate|bachelor s|bachelors|bachelor)\b/.test(n) ? 4 : /\b(master s|masters|master|graduate degree|graduate school|grad school)\b/.test(n) ? 5 : null;
  const atLevel = levelAsked === null ? [] : facts.education.entries.filter((e) => e.rank === levelAsked);
  if (levelAsked !== null && atLevel.length === 0 && facts.education.entries.length > 0 && facts.education.entries.every((e) => e.rank !== null)) return abstain("graduation:no-such-degree");
  const primary = atLevel.length === 1 ? atLevel[0] : facts.education.primary;
  const g = primary?.graduation;
  if (!g) return abstain("graduation:unknown");
  const year = String(g.earliest.getUTCFullYear());
  const monthName = g.earliest.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  if (q.options && q.options.length) {
    // Year-only options take the year; month-bearing options need the month.
    const yearOnly = q.options.filter((o) => new RegExp(`^\\s*${year}\\s*$`).test(o));
    if (yearOnly.length === 1) return answer(yearOnly[0], "graduation:year");
    if (g.precision !== "year") {
      const hit = pickOption(q.options, `${monthName} ${year}`);
      if (hit) return answer(hit, "graduation:month-year");
      // "January - June 2027", "December 2026 - November 2027", "Spring 2027":
      // the one option whose months contain the graduation month.
      const at = g.earliest.getUTCFullYear() * 12 + g.earliest.getUTCMonth();
      const containing = q.options.filter((o) => {
        const span = optionMonthSpan(o);
        return span !== null && span[0] <= at && at <= span[1];
      });
      if (containing.length === 1) return answer(containing[0], "graduation:month-range");
    }
    // "Earlier than Fall 2026" / "Later than Summer 2027" (Databricks) and
    // "Already graduated" (Riot; question bank 2026-10-05): open ends,
    // compared with the whole span the graduation could be in.
    const first = g.earliest.getUTCFullYear() * 12 + g.earliest.getUTCMonth();
    const last = g.latest.getUTCFullYear() * 12 + g.latest.getUTCMonth();
    const open = q.options.filter((o) => {
      const m = /^(earlier than|before|prior to|later than|after)\b/.exec(qnorm(o));
      const span = m ? optionMonthSpan(o) : null;
      if (!m || !span) return false;
      return /^(earlier|before|prior)/.test(m[1]) ? last < span[0] : first > span[1];
    });
    if (open.length === 1) return answer(open[0], "graduation:open-range");
    const graduated = q.options.filter((o) => /\b(already graduated|graduated already|have already graduated)\b/.test(qnorm(o)));
    if (graduated.length === 1 && primary.completed === true) return answer(graduated[0], "graduation:already-graduated");
    const withYear = q.options.filter((o) => o.includes(year));
    if (withYear.length === 1) return answer(withYear[0], "graduation:only-option-in-year");
    // A year list without theirs, beside its "Other" (Palantir's 2022-2030
    // for a 2016 graduate, live 2026-10-03): "Other" is the true one.
    const other = q.options.filter((o) => /^\s*other\b/i.test(o));
    if (other.length === 1 && q.options.filter((o) => /^\s*(19|20)\d{2}\s*$/.test(o)).length >= 2) return answer(other[0], "graduation:other-year");
    // An EXPECTED graduation asked of a graduate: there is none to give, and
    // the AI could only invent one (Superhuman on Ashby, live 2026-10-03).
    if (primary.completed === true && /\b(expected|anticipated|projected)\b|\bwhen (will|do) you graduate\b/.test(n)) {
      return abstain("graduation:not-enrolled");
    }
    return abstain("graduation:no-unique-option");
  }
  // "…expected month and year of graduation?" in a text box (NinjaHoldings on
  // Breezy, live 2026-10-03: "2027" for December 2027): the month it asks
  // for, or nothing when the profile knows only the year.
  if (/\bmonths?\b/.test(n) && q.kind !== "date") {
    return g.precision === "year" ? abstain("graduation:month-unknown") : answer(`${monthName} ${year}`, "graduation:month-year");
  }
  if (q.kind === "date" || /\bdate\b/.test(n)) {
    if (g.precision === "year") return answer(year, "graduation:year-as-date", "high");
    // A month is not a day: "April 2027" suits a text box and a month control,
    // and a day-precise picker gets nothing (dateControl), never an invented
    // 1st (Ashby's "Pick date..." got 04/01/2027, live 2026-10-03).
    if (g.precision === "month") return answer(`${monthName} ${year}`, "graduation:month-as-date");
    return answer(formatDateFor(g.earliest, q), "graduation:date");
  }
  return answer(year, "graduation:year");
}

const MONTH_WORDS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Academic seasons as months (0-11): graduation in April / May is Spring. */
const SEASON_MONTHS: Record<string, [number, number]> = { spring: [2, 4], summer: [5, 7], fall: [8, 11], autumn: [8, 11] };

/**
 * The absolute months [from, to] (year * 12 + month) an option covers, or null:
 * "December 2027", "May/June 2028", "January - June 2027",
 * "December 2026 - November 2027", "Spring 2027". Winter is left out: it means
 * Dec-Feb in one convention and Jan-Apr in another (Canadian co-op terms).
 */
export function optionMonthSpan(option: string): [number, number] | null {
  const t = qnorm(option);
  const years = (t.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number);
  if (years.length === 0 || years.length > 2) return null;
  const season = /\b(spring|summer|fall|autumn)\b/.exec(t);
  if (season && years.length === 1) {
    const [a, b] = SEASON_MONTHS[season[1]];
    return [years[0] * 12 + a, years[0] * 12 + b];
  }
  const months: number[] = [];
  for (const w of t.split(" ")) {
    const i = MONTH_WORDS.indexOf(w.slice(0, 3));
    if (i >= 0 && /^[a-z]+$/.test(w) && (w.length === 3 || w.startsWith(MONTH_WORDS[i]))) months.push(i);
  }
  if (months.length === 0 || months.length > 2) return null;
  if (years.length === 2) {
    if (months.length !== 2) return null;
    return [years[0] * 12 + months[0], years[1] * 12 + months[1]];
  }
  const y = years[0];
  return [y * 12 + months[0], y * 12 + months[months.length - 1]];
}

// ----- GPA --------------------------------------------------------------------------

/** "GPA", "Cumulative GPA", "Grade point average": the applicant's stated GPA;
 *  a graduate / doctorate GPA they cannot have is that list's "N/A". */
function resolveGpa(q: QuestionInput, n: string, profile: UserApplicationProfile, facts: ProfileFacts): QuestionResult {
  // "What was your bachelor's university degree result…? Please include the
  // grading system" (Canonical, question bank 2026-10-05) is the GPA too.
  const result = /\b(degree|university|academic|final) (result|results|grade|grades|classification)\b|\bexpected result\b/.test(n);
  if (!/\b(gpa|cgpa|grade point average|cumulative average)\b/.test(n) && !result) return null;
  if (/\b(scale|out of|maximum|max)\b/.test(n) && !/\byour\b/.test(n)) return null;
  const higher = /\b(graduate|masters?|doctorate|doctoral|phd|mba)\b/.test(n) && !/\bundergraduate\b/.test(n);
  const rank = facts.education.highestRank?.value ?? null;
  if (higher && rank !== null && rank < 5) {
    const na = (q.options ?? []).filter((o) => /^(n a|na|none|i do not have|no graduate)\b|\bnot applicable\b/.test(qnorm(o)));
    return na.length === 1 ? answer(na[0], "gpa:not-applicable") : abstain("gpa:no-graduate-degree");
  }
  // The profile holds one GPA, the main degree's: an undergraduate GPA asked
  // of someone whose main degree is a master's is not it (Duolingo, question
  // bank 2026-10-05: an OPT holder's master's 3.85 as her undergraduate GPA).
  const primaryRank = facts.education.primary ? degreeRank(facts.education.primary.degree) : null;
  if (/\b(undergraduate|undergrad|bachelor s|bachelors|bachelor|first degree)\b/.test(n) && primaryRank !== null && primaryRank >= 5) return abstain("gpa:graduate-degree-gpa");
  const stated = (profile.gpa ?? "").trim();
  if (!stated) return abstain("gpa:unknown");
  const num = /\d+(\.\d+)?/.exec(stated)?.[0] ?? null;
  if (q.options && q.options.length) {
    const hit = (num && pickOption(q.options, num)) || pickOption(q.options, stated);
    return hit ? answer(hit, "gpa:option") : abstain("gpa:no-matching-option");
  }
  if (q.kind === "number") return num ? answer(num, "gpa:number") : abstain("gpa:not-numeric");
  return answer(stated, "gpa:stated");
}

/**
 * "If selected for the internship, what would be your preferred start date?"
 * offered as dates ("May 3, 2027" | "May 17, 2027" | "June 1, 2027", The
 * Exploration Company on Ashby, live 2026-10-03): the applicant's earliest
 * start when it is one of them, else the first date on or after it.
 */
function resolveStartDateChoice(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\b(start|starting|join|joining|availability|available)\b[^?]*\bdate\b|\bwhen (can|could|would) you (start|begin|join)\b/.test(n)) return null;
  if (!q.options || q.options.length < 2) return null;
  const av = facts.availability.earliestStart;
  const dated = q.options
    .map((o) => ({ o, d: /\d{4}/.test(o) ? new Date(o.replace(/(\d)(st|nd|rd|th)\b/, "$1") + " UTC") : null }))
    .filter((x): x is { o: string; d: Date } => x.d !== null && !Number.isNaN(x.d.getTime()));
  if (dated.length < 2 || dated.length !== q.options.filter((o) => o.trim()).length) return null;
  if (!isHigh(av)) return abstain("start-date-choice:unknown");
  const day = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const target = day(av.value);
  const onOrAfter = dated.filter((x) => day(x.d) >= target).sort((a, b) => day(a.d) - day(b.d));
  return onOrAfter.length > 0 ? answer(onOrAfter[0].o, "start-date-choice") : abstain("start-date-choice:all-earlier");
}

/** An option's span in days from now ("Immediately", "2 to 4 weeks from offer
 *  acceptance", "12+ weeks", "Over a month from offer"), or null. */
function durationRange(option: string): [number, number] | null {
  const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12 };
  const t = qnorm(option).replace(/\b(an?|one|two|three|four|five|six|eight|ten|twelve)\b(?= (day|week|month)s?\b)/g, (w) => String(WORDS[w]));
  if (/\b(immediately|immediate|asap|right away)\b/.test(t)) return [0, 7];
  const unit = (u: string): number => (u.startsWith("day") ? 1 : u.startsWith("week") ? 7 : 30);
  let m: RegExpExecArray | null;
  if ((m = /\b(\d+)\s*(?:to\s+|\s)(\d+)\s*(day|week|month)s?\b/.exec(t))) return [+m[1] * unit(m[3]), +m[2] * unit(m[3])];
  if ((m = /\b(\d+)\s*\+\s*(day|week|month)s?\b/.exec(t))) return [+m[1] * unit(m[2]), Infinity];
  if ((m = /\b(more than|over|longer than|after|beyond)\s+(\d+)\s*(day|week|month)s?\b/.exec(t))) return [+m[2] * unit(m[3]) + 1, Infinity];
  if ((m = /\b(within|less than|under|up to|no more than)\s+(\d+)\s*(day|week|month)s?\b/.exec(t))) return [0, +m[2] * unit(m[3])];
  if ((m = /\b(\d+)\s*(day|week|month)s?\b/.exec(t))) {
    const d = +m[1] * unit(m[2]);
    return [Math.max(0, d - 3), d + 3];
  }
  return null;
}

/**
 * "Availability?" / "earliest available start date" answered with spans from
 * now ("Immediately" | "Two weeks from offer" | "Over a month from offer",
 * Agiloft on Lever; "2 to 4 weeks … 12+ weeks from offer acceptance",
 * Striveworks): the span holding the days until the applicant's earliest start.
 */
function resolveStartBucket(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!q.options || q.options.length < 2) return null;
  if (!/\b(availability|available|start|starting|join|joining|begin)\b/.test(n)) return null;
  const spans = q.options.map((o) => ({ o, r: durationRange(o) })).filter((x): x is { o: string; r: [number, number] } => x.r !== null);
  if (spans.length < 2) return null;
  const av = facts.availability.earliestStart;
  if (!isHigh(av)) return abstain("start-bucket:unknown");
  const days = Math.max(0, Math.ceil((av.value.getTime() - facts.today.getTime()) / 86400000));
  const hits = spans.filter((x) => days >= x.r[0] && days <= x.r[1]).sort((a, b) => a.r[1] - a.r[0] - (b.r[1] - b.r[0]));
  return hits.length > 0 ? answer(hits[0].o, "start-bucket") : abstain("start-bucket:no-matching-option");
}

/** Time zones by region; a state split between zones is left out (not guessed). */
const ZONE_OF_REGION: Record<string, string> = {
  // Canada
  "CA-BC": "pacific", "CA-AB": "mountain", "CA-SK": "central", "CA-MB": "central", "CA-ON": "eastern", "CA-QC": "eastern",
  "CA-NB": "atlantic", "CA-NS": "atlantic", "CA-PE": "atlantic", "CA-NL": "newfoundland", "CA-NT": "mountain",
  // United States (whole states only)
  "US-NY": "eastern", "US-NJ": "eastern", "US-PA": "eastern", "US-MA": "eastern", "US-CT": "eastern", "US-RI": "eastern",
  "US-VT": "eastern", "US-NH": "eastern", "US-ME": "eastern", "US-DE": "eastern", "US-MD": "eastern", "US-DC": "eastern",
  "US-VA": "eastern", "US-WV": "eastern", "US-NC": "eastern", "US-SC": "eastern", "US-GA": "eastern", "US-OH": "eastern",
  "US-IL": "central", "US-WI": "central", "US-MN": "central", "US-IA": "central", "US-MO": "central", "US-AR": "central",
  "US-LA": "central", "US-MS": "central", "US-AL": "central", "US-OK": "central",
  "US-CO": "mountain", "US-UT": "mountain", "US-WY": "mountain", "US-MT": "mountain", "US-NM": "mountain", "US-AZ": "mountain",
  "US-CA": "pacific", "US-WA": "pacific", "US-NV": "pacific",
};
const ZONE_OPTION: Record<string, RegExp> = {
  pacific: /\b(p[sd]?t|pacific)\b/, mountain: /\b(m[sd]?t|mountain)\b/, central: /\b(c[sd]?t|central)\b/,
  eastern: /\b(e[sd]?t|eastern)\b/, atlantic: /\b(a[sd]?t|atlantic)\b/, newfoundland: /\b(n[sd]?t|newfoundland)\b/,
};
/** "Which timezone are you currently located in?" [PST|MST|CST|EST] (Veeva on Lever). */
function resolveTimezone(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\btime ?zone\b/.test(n) || !q.options?.length) return null;
  if (/\b(prefer|preferred|willing|able to work|overlap|collaborat)\w*\b/.test(n)) return null; // a preference, not where they are
  const region = isHigh(facts.location.region) ? facts.location.region.value : null;
  const zone = region ? ZONE_OF_REGION[region.country + "-" + region.code] : undefined;
  if (!zone) return abstain("timezone:unknown");
  const hits = q.options.filter((o) => ZONE_OPTION[zone].test(qnorm(o)));
  return hits.length === 1 ? answer(hits[0], "timezone") : abstain("timezone:no-matching-option");
}

/** Currencies an option list names, by the words a form uses. */
const CURRENCY_OPTION: Record<string, RegExp> = {
  USD: /\b(us|u s|united states) dollars?\b|\busd\b/,
  CAD: /\bcanadian dollars?\b|\bcad\b/,
  GBP: /\b(british )?pounds? sterling\b|\bbritish pounds?\b|\bgbp\b/,
  EUR: /\beuros?\b|\beur\b/,
  AUD: /\baustralian dollars?\b|\baud\b/,
  INR: /\bindian rupees?\b|\binr\b/,
  JPY: /\bjapanese yen\b|\bjpy\b/,
};
const DOLLAR_BY_COUNTRY: Record<string, string> = { US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD" };

/**
 * A salary's currency or pay period asked as its own select beside the amount
 * (Breezy: "US Dollar ($)" … and "Hourly | Weekly | Monthly | Yearly", left
 * blank on every live page, 2026-10-03). Both read off the stated salary: the
 * symbol or code ("£", "€", "CAD"), "$" by the applicant's country; "/hour"
 * is Hourly, an annual-sized figure Yearly.
 */
function resolveSalaryUnit(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile): QuestionResult {
  const opts = (q.options ?? []).filter((o) => o.trim());
  if (opts.length < 2 || isBooleanQuestion(q)) return null;
  if (q.category !== "salary" && !/\b(salary|compensation|pay|wage|rate)\b/.test(n)) return null;
  const salary = (profile.salaryExpectation || "").trim();
  const s = salary.toLowerCase();
  const isCurrencyList = opts.filter((o) => /\b(dollar|euro|pound|rupee|yen|franc|peso|yuan|krona|krone|rand|real)s?\b/i.test(o)).length >= 3;
  if (isCurrencyList) {
    if (!salary) return abstain("salary-currency:unknown");
    const home = isHigh(facts.location.country) ? facts.location.country.value.code : null;
    const code = /£|\bgbp\b|\bpounds?\b/.test(s) ? "GBP"
      : /€|\beur\b|\beuros?\b/.test(s) ? "EUR"
      : /₹|\binr\b|\brupees?\b/.test(s) ? "INR"
      : /¥|￥|\bjpy\b|\byen\b/.test(s) ? "JPY"
      : /\bcad\b|\bc\$/.test(s) ? "CAD"
      : /\busd\b|\bus\$/.test(s) ? "USD"
      : /\$/.test(s) && home ? DOLLAR_BY_COUNTRY[home] ?? null
      : null;
    const re = code ? CURRENCY_OPTION[code] : undefined;
    const hits = re ? opts.filter((o) => re.test(qnorm(o))) : [];
    return hits.length === 1 ? answer(hits[0], "salary-currency") : abstain("salary-currency:unknown");
  }
  const periods = opts.filter((o) => /^(hourly|daily|weekly|bi ?weekly|monthly|yearly|annually|annual|per (hour|day|week|month|year|annum))$/.test(qnorm(o)));
  if (periods.length >= 2) {
    if (!salary) return abstain("salary-period:unknown");
    const per = /\/\s*(h|hr|hour)\b|\b(hourly|per hour|an hour)\b/.test(s) ? /\b(hour|hourly)\b/
      : /\/\s*(wk|week)\b|\b(weekly|per week)\b/.test(s) ? /\b(week|weekly)\b/
      : /\/\s*(mo|month)\b|\b(monthly|per month)\b/.test(s) ? /\b(month|monthly)\b/
      : /\/\s*(yr|year)\b|\b(yearly|annual|annually|per year|per annum|a year)\b/.test(s) || Number((s.match(/\d[\d\s,.]*/)?.[0] ?? "").replace(/[\s,]/g, "")) >= 1000
        ? /\b(year|yearly|annual|annually|annum)\b/
        : null;
    const hits = per ? opts.filter((o) => per.test(qnorm(o))) : [];
    return hits.length === 1 ? answer(hits[0], "salary-period") : abstain("salary-period:unknown");
  }
  return null;
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Academic terms by the month they start ("next Spring (January 2027 …)"). */
const TERM_START: Record<string, number> = { winter: 0, spring: 0, summer: 4, fall: 8, autumn: 8 };

/**
 * Availability for a period the question dates: "Are you available for a
 * full-time onsite internship next Spring (January 2027 - April/May 2027)?"
 * got Yes from the requirement default for an applicant who cannot start
 * before late May (Zipline's embedded Greenhouse form, live 2026-10-03). An
 * earliest start more than a month after the period begins is No; otherwise
 * the other rules (on-site, relocation) decide.
 */
function resolvePeriodAvailability(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\bavailab(le|ility)\b/.test(n) || !isBooleanQuestion(q)) return null;
  const month = new RegExp(`\\b(${MONTH_NAMES.join("|")})\\s+(\\d{4})\\b`).exec(n);
  const term = month ? null : /\b(winter|spring|summer|fall|autumn)\s+(?:term\s+|semester\s+)?(\d{4})\b/.exec(n);
  const start = month
    ? Date.UTC(Number(month[2]), MONTH_NAMES.indexOf(month[1]), 1)
    : term
      ? Date.UTC(Number(term[2]), TERM_START[term[1]], 1)
      : null;
  if (start === null) return null;
  const earliest = facts.availability.earliestStart;
  if (!isHigh(earliest)) return null;
  return earliest.value.getTime() > start + 31 * 86400000 ? booleanResult(false, q, "period-availability:starts-later") : null;
}

/** "Did you Graduate?" (Paylocity's education row, live 2026-10-03): whether
 *  the education the profile means (in progress first) is finished. */
function resolveDidGraduate(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/^(did|have) you graduate(d)?\b/.test(n) || !isBooleanQuestion(q)) return null;
  const done = facts.education.primary?.completed;
  return done === true || done === false ? booleanResult(done, q, "education:graduated") : abstain("education:graduated-unknown");
}

/** A zone named in running text: full names and three-letter codes only ("at"
 *  and "et" are words). */
const ZONE_IN_TEXT: Record<string, RegExp> = {
  pacific: /\b(pacific|p[sd]t)\b/, mountain: /\b(mountain|m[sd]t)\b/, central: /\b(central|c[sd]t)\b/,
  eastern: /\b(eastern|e[sd]t)\b/, atlantic: /\b(atlantic|a[sd]t)\b/, newfoundland: /\b(newfoundland|n[sd]t)\b/,
};

/**
 * "This role requires regular collaboration during Eastern or Pacific Time
 * business hours. Are you available to work within these time zones?" (Voldex
 * on Ashby, left blank 2026-10-03): Yes for an applicant who lives in one of
 * the zones named. Anyone else's answer is a willingness, theirs to give.
 */
function resolveZoneAvailability(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\btime ?zones?\b|\btime business hours\b/.test(n)) return null;
  if (!/\b(available|able) to work\b|\bwork (within|during|in) (these|those|this|the following|the|our)\b/.test(n)) return null;
  if (q.options?.length && !isBooleanQuestion(q)) return null; // "which zone": resolveTimezone
  const named = Object.keys(ZONE_IN_TEXT).filter((z) => ZONE_IN_TEXT[z].test(n));
  if (named.length === 0) return null;
  const region = isHigh(facts.location.region) ? facts.location.region.value : null;
  const zone = region ? ZONE_OF_REGION[region.country + "-" + region.code] : undefined;
  if (!zone) return abstain("timezone:unknown");
  return named.includes(zone) ? booleanResult(true, q, "timezone:lives-in-zone") : abstain("timezone:willingness");
}

/**
 * "This internship will be held in our Chicago office in a hybrid model. Will
 * you be local to Chicago for the summer of 2027?" (Enova on Greenhouse, left
 * blank 2026-10-03): yes for an applicant who lives there or will relocate,
 * no for one who lives elsewhere and will not.
 */
function resolveLocalTo(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile): QuestionResult {
  // "Are you local to Colorado?" (now): where the applicant lives today, by
  // state, province or country as well as city. "If you are not local to
  // Colorado, are you willing to relocate?" stayed blank for a Seattle
  // applicant who will not move (Anduril on Greenhouse, live 2026-10-05).
  const now = /^(?:are you|you are) (?:currently )?(?:local|located|based|living) (?:to|in|near) (?:the )?([a-z ]+?)(?: area| region)?$/.exec(n);
  // "Are you local to or willing to relocate?" (Shield AI on Lever) names no
  // place: the relocation rule's.
  if (now && isBooleanQuestion(q) && !/\b(or|relocat\w*|move|willing)\b/.test(now[1])) {
    const named = now[1].trim();
    const region = regionFromText(named);
    const country = region ? null : countryFromName(named);
    const home = facts.location;
    if (region && isHigh(home.region)) {
      return booleanResult(home.region.value.code === region.code && home.region.value.country === region.country, q, "local:region");
    }
    if (country && isHigh(home.country)) return booleanResult(home.country.value.code === country.code, q, "local:country");
    const city = isHigh(home.city) ? qnorm(home.city.value) : null;
    if (city && named === city) return booleanResult(true, q, "local:lives-there");
    return abstain("local:unknown");
  }
  const m = /\bwill you (?:be|live|reside) (?:local|located|living|based) (?:to|in|near) (?:the )?([a-z ]+?)(?: area| region| office)?(?: for| during| this| next| by| in|$)/.exec(n);
  if (!m || !isBooleanQuestion(q)) return null;
  const named = m[1].trim();
  const city = isHigh(facts.location.city) ? qnorm(facts.location.city.value) : null;
  if (city && named === city) return booleanResult(true, q, "local:lives-there");
  const relocate = polarityOf(profile.willingToRelocate || "");
  if (relocate === true) return booleanResult(true, q, "local:will-relocate");
  if (relocate === false && city) return booleanResult(false, q, "local:lives-elsewhere");
  return abstain("local:unknown");
}

/**
 * "What is the address from which you plan on working? If you would need to
 * relocate, please type "relocating"." (Anthropic on Greenhouse, a real
 * profile, 2026-10-03: the home address was typed for an in-office role in
 * another country). The page's word for an applicant who must move and will;
 * the address (category answer) only when the job is in their own city.
 * Another city at home may be a commute: the applicant's call.
 */
function resolveRelocationInstruction(q: QuestionInput, raw: string, facts: ProfileFacts, profile: UserApplicationProfile, ctx: QuestionContext): QuestionResult {
  if (q.kind !== "text" && q.kind !== "longText") return null;
  const m = /\bif you (?:would |will )?(?:need|plan|intend|have) to (?:relocate|move)\b[^"“'‘]{0,40}["“'‘]([^"”'’]{2,30})["”'’]/i.exec(raw);
  if (!m) return null;
  // Not moving: they work from where they live, wherever the job is (a
  // veteran in Austin who will not relocate, Anthropic, live 2026-10-03).
  if (polarityOf(profile.willingToRelocate || "") === false) return null;
  const home = isHigh(facts.location.country) ? facts.location.country.value.code : null;
  if (!ctx.jobCountry || !home) return abstain("relocate-instruction:unknown");
  if (ctx.jobCountry === home) {
    const city = isHigh(facts.location.city) ? qnorm(facts.location.city.value) : null;
    return city && ctx.jobCity && qnorm(ctx.jobCity) === city ? null : abstain("relocate-instruction:unknown");
  }
  return polarityOf(profile.willingToRelocate || "") === true ? answer(m[1].trim(), "relocate-instruction:moving") : abstain("relocate-instruction:unknown");
}

/**
 * "Please indicate your school, program/faculty, and expected month/year of
 * graduation" in a text box (Arc'teryx on Lever, live 2026-10-03): it got
 * "2027". The three facts together, from the education row in progress (or
 * the most recent one).
 */
function resolveEducationSummary(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (q.kind !== "text" && q.kind !== "longText") return null;
  // A degree's RESULT is a grade, not the school and degree (Canonical,
  // question bank 2026-10-05): resolveGpa's.
  if (/\b(result|results|grade|grades|classification|gpa)\b/.test(n)) return null;
  const asksSchool = /\b(school|university|college|institution)\b/.test(n);
  const asksProgram = /\b(program|programme|faculty|degree|major|field of study|discipline)\b/.test(n);
  // The graduation DATE, not the verb: "What school are you currently attending
  // / did you graduate from?" (ZipRecruiter) asks for the school alone.
  const asksGrad =
    /\b(graduation|completion) (date|year|month|term)\b|\b(month|year|date|term)s?( \w+)? of (graduation|completion)\b|\bexpected (month|year|date|term)\b|\bwhen (will|do|would) you graduate\b/.test(n);
  if ([asksSchool, asksProgram, asksGrad].filter(Boolean).length < 2) return null;
  const e = facts.education.primary;
  if (!e?.school) return abstain("education-summary:unknown");
  const parts: string[] = [];
  if (asksSchool) parts.push(e.school);
  if (asksProgram && e.degree) parts.push(e.degree);
  if (asksGrad && e.graduation) {
    const g = e.graduation;
    const y = g.earliest.getUTCFullYear();
    const when = g.precision === "year" ? String(y) : g.earliest.toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + " " + y;
    parts.push((e.completed === false ? "expected graduation " : "graduated ") + when);
  }
  return parts.length >= 2 ? answer(parts.join(", "), "education-summary") : abstain("education-summary:partial");
}

/**
 * "SAT Score*" / "ACT" / "GRE" (SpaceX, live 2026-10-03): the profile holds no
 * test scores. When the list offers a "did not take / do not recall" option,
 * that is the answer that claims nothing; otherwise blank.
 */
function resolveTestScore(q: QuestionInput, n: string): QuestionResult {
  if (!/\b(sat|act|gre|gmat|lsat|mcat|toefl|ielts|psat)\b/.test(n) || !/\b(score|scores|result|results|test)\b/.test(n)) return null;
  if (!q.options?.length) return q.kind === "text" || q.kind === "number" ? abstain("test-score:unknown") : null;
  const na = q.options.filter((o) => /\b(did not take|have not taken|havent taken|not taken|do not recall|dont recall|not applicable|n a|none)\b/.test(qnorm(o)));
  // "Did not take/Do not recall" beside "Other - did not take" (SpaceX's GRE,
  // left blank 2026-10-03): the plain one.
  const plain = na.length > 1 ? na.filter((o) => !/\bother\b/.test(qnorm(o))) : na;
  return plain.length === 1 ? answer(plain[0], "test-score:none-stated") : abstain("test-score:unknown");
}

/**
 * "Language Skill(s) (Check all that apply)" (Palantir on Lever, live
 * 2026-10-03: "English (ENG)", "French (FRA)", …): the profile's languages
 * among the options, any level but a beginner's.
 */
function resolveLanguageChoice(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (!/\blanguages?\b/.test(n) || !q.options?.length) return null;
  if (q.controlType !== "checkboxGroup" && q.kind !== "multiChoice") return null;
  const spoken = (profile.languages || "")
    .split(/[,;\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/\((basic|beginner|elementary|limited|a1|a2)\b/i.test(l))
    .map((l) => qnorm(l.replace(/\(.*$/, "")))
    .filter(Boolean);
  if (spoken.length === 0) return abstain("language:unknown");
  const picks = q.options.filter((o) => spoken.some((l) => (" " + qnorm(o) + " ").includes(" " + l + " ")));
  return picks.length > 0 ? answer(picks.join(", "), "language:choice") : abstain("language:no-matching-option");
}

/**
 * "Are you open to relocation?" answered with WHERE (Twitch, live 2026-10-03:
 * "No", "No, but I'm open to a remote position", "San Francisco, CA", …):
 * willing → the job's own city when it is offered; not willing → "No", or the
 * remote alternative for an applicant who prefers remote work.
 */
function resolveRelocationChoice(q: QuestionInput, n: string, profile: UserApplicationProfile, ctx: QuestionContext): QuestionResult {
  if (!/\b(willing|open|able|prepared) to (relocate|move)\b|\brelocat(e|ion)\b/.test(n) || /\b(assistance|package|support|expenses?|reimburse)\b/.test(n)) return null;
  const opts = (q.options ?? []).filter((o) => o.trim());
  const places = opts.filter((o) => optionPolarity(o) === null && !/\b(remote|anywhere|other|none|n\/a)\b/i.test(o));
  if (places.length < 2) return null;
  const willing = polarityOf(profile.willingToRelocate || "");
  if (willing === false) {
    const remote = opts.filter((o) => optionPolarity(o) === false && /\bremote\b/i.test(o));
    if (/^remote$/i.test((profile.workPreference || "").trim()) && remote.length === 1) return answer(remote[0], "relocation:choice-remote");
    const no = opts.filter((o) => /^no$/i.test(o.trim()));
    return no.length === 1 ? answer(no[0], "relocation:choice-no") : abstain("relocation:no-matching-option");
  }
  if (willing === true && ctx.jobCity) {
    const city = qnorm(ctx.jobCity);
    const hit = places.filter((o) => (" " + qnorm(o) + " ").includes(" " + city + " "));
    if (hit.length === 1) return answer(hit[0], "relocation:choice-job-city");
  }
  return abstain("relocation:choice-unknown");
}

/**
 * U.S. export-control / "U.S. person" status (SpaceX "Citizenship Status",
 * Astranis, Hermeus; live 2026-10-03): U.S. citizen or national, lawful
 * permanent resident, refugee, asylee (DACA). Every one of those may work in
 * the US, so an applicant NOT authorized to work there is none of them: the
 * "Other" / "None of the above" / "Foreign person" option. A citizen or
 * permanent resident of the US picks theirs; anything else stays blank.
 */
const US_STATUS_OPTION = /\b(u ?s citizen|citizen of the united states|national of the united states|u ?s national|lawful permanent resident|permanent resident of the u|green card|refugee|asylee|daca|u ?s person|foreign person)\b/;
const NONE = /^(\(?[a-z]\)?\s+)?other\b|\bnone of the above\b|\bforeign person\b|\bnot a u ?s (person|citizen)\b/;
function resolveUsPersonStatus(q: QuestionInput, facts: ProfileFacts, profile: UserApplicationProfile): QuestionResult {
  const opts = (q.options ?? []).filter((o) => o.trim());
  if (opts.filter((o) => US_STATUS_OPTION.test(qnorm(o))).length < 2) return null;
  const us = facts.workAuth.byCountry.get("US");
  // "Not a US citizen or permanent resident" names the statuses it denies
  // (Accenture Federal, live 2026-10-05): never one of them.
  const pick = (re: RegExp): QuestionResult => {
    const hits = opts.filter((o) => re.test(qnorm(o)) && (re === NONE || !/\bnot\b/.test(qnorm(o))));
    return hits.length === 1 ? answer(hits[0], "us-person-status") : abstain("us-person-status:no-matching-option");
  };
  if (us?.authorized === false) return pick(NONE);
  // A temporary visa (H-1B, F-1 and its OPT, TN…) makes no one a U.S. person:
  // the H-1B and OPT holders abstained (Astranis, SpaceX; question bank
  // 2026-10-05). A statement naming any U.S.-person status keeps it theirs.
  const stated = (profile.workAuthorization || "").toLowerCase();
  if (/\b(h-?1 ?b|h-?4|l-?1|e-?3|o-?1|tn|f-?1|j-?1|m-?1|opt|cpt|visa)\b/.test(stated) && !/\b(citizen|national|permanent resident|green card|refugee|asylee|asylum|daca)\b/.test(stated)) {
    return pick(NONE);
  }
  if (us?.basis === "citizen") return pick(/\bu ?s citizen\b|\bcitizen (or national )?of the united states\b|^u ?s person\b/);
  if (us?.basis === "permanent_resident") return pick(/\blawful permanent resident\b|\bgreen card\b/);
  return abstain("us-person-status:unknown");
}

/** "What school do you attend?", "Where did you complete your undergraduate degree?" */
function resolveSchoolName(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const asks =
    /\b(name of (the |your )?(school|university|college|institution)|which (school|university|college|institution)|what (school|university|college|institution)|where (did|do) you (complete|study|go to school|attend|earn|get|obtain)|school (you are )?(currently )?attending)\b/.test(n);
  if (!asks || q.kind === "boolean") return null;
  const entries = facts.education.entries;
  let entry = null as (typeof entries)[number] | null;
  // "…currently attending OR did you last attend?" (Palantir on Lever, live
  // 2026-10-03) is the main school either way: in progress, else the latest.
  if (/\bor (did you |have you )?(last |most recently |previously )?(attend(ed)?|graduated?|studied)\b/.test(n)) {
    entry = facts.education.primary;
  } else if (/\bcurrently attending|currently enrolled|you attend\b|\bdo you attend\b|\bare you attending\b/.test(n)) {
    entry = entries.find((e) => e.completed === false) ?? null;
    if (!entry) return abstain("school-name:not-enrolled");
  } else if (/\bundergrad/.test(n)) {
    const bachelors = entries.filter((e) => e.rank === 4);
    entry = bachelors.length === 1 ? bachelors[0] : null;
  } else if (/\bgraduate (degree|school|studies)\b|\bmaster/.test(n)) {
    const grads = entries.filter((e) => (e.rank ?? 0) >= 5);
    entry = grads.length === 1 ? grads[0] : null;
  } else {
    entry = facts.education.primary;
  }
  if (!entry?.school) return abstain("school-name:unknown");
  if (q.options && q.options.length) {
    const hit = pickOption(q.options, entry.school);
    if (hit) return answer(hit, "school-name");
    // A full list (a native select) without the school: its own "not listed"
    // option. A search box's loaded options are only what matched the search.
    if (q.controlType === "select") {
      const unlisted = q.options.filter((o) => /\bnot (listed|in (the|this) list|found)\b|\bunlisted\b/i.test(o));
      if (unlisted.length === 1) return answer(unlisted[0], "school-name:not-listed");
    }
    return abstain("school-name:no-matching-option");
  }
  return answer(entry.school, "school-name");
}

// ----- Employment ----------------------------------------------------------------

const CORP_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|group|holdings|technologies|technology)\b/g;
const companyKey = (s: string): string => qnorm(s).replace(CORP_SUFFIX, " ").replace(/\s+/g, " ").trim();

function sameCompany(a: string, b: string): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.length >= 4 && (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)));
}

/**
 * "SpaceX & SpaceXAI Employment History" (live 2026-10-03): the label names the
 * company and only the OPTIONS say it is asking whether you worked there ("I
 * have never worked for SpaceX, …", "I am a former SpaceX … employee"). The
 * never-worked option, when no employer on the profile is one of the companies
 * the label names.
 */
function resolveEmploymentHistoryChoice(q: QuestionInput, n: string, raw: string, facts: ProfileFacts): QuestionResult {
  if (!/\bemployment history\b|\bwork history\b/.test(n) || !q.options?.length) return null;
  const never = q.options.filter((o) => /\b(never (worked|been employed)|have not (worked|been employed)|no prior employment)\b/.test(qnorm(o)));
  if (never.length !== 1) return null;
  const names = (raw.match(/[A-Z][\w.'-]*/g) ?? []).filter((w) => !/^(Employment|History|Work|The|And|Of)$/.test(w));
  if (names.length === 0 || facts.employment.employers.length === 0) return abstain("former-employee:no-history");
  const worked = facts.employment.employers.some((e) => names.some((c) => sameCompany(e, c)));
  return worked ? abstain("former-employee:history-choice") : answer(never[0], "former-employee:never");
}

/** Capitalized words in an employer question that are not a company's name. */
const NOT_A_COMPANY =
  /^(are|were|have|has|had|do|did|you|your|current|currently|former|formerly|past|previous|previously|prior|employee|employees|employed|intern|interns|vendor|vendors|contractor|contractors|temp|temps|member|members|extended|workforce|team|including|include|and|or|other|its|their|subsidiaries|subsidiary|affiliates|affiliate|company|companies|please|if|yes|no|i|the|a|an|of|required|select|any|all|e\.?g\.?)$/i;

/** Every company a question names ("…Alphabet employee … (including Google and
 *  other Alphabet subsidiaries)"): a job at any of them is a job there. */
function companiesNamedIn(raw: string): string[] {
  const found = (raw.match(/[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2}/g) ?? [])
    .map((s) => s.split(/\s+/).filter((w) => !NOT_A_COMPANY.test(w.replace(/[,.;:]+$/, ""))).join(" ").replace(/[,.;:]+$/, ""))
    .filter((s) => s.length >= 2);
  return [...new Set(found)];
}

function resolveFormerEmployee(q: QuestionInput, n: string, raw: string, facts: ProfileFacts, ctx: QuestionContext): QuestionResult {
  const history = resolveEmploymentHistoryChoice(q, n, raw, facts);
  if (history) return history;
  // "HISTORY WITH ANDURIL" [Yes | No] (Anduril on Greenhouse, live
  // 2026-10-05): a history with the company named, its jobs first.
  const withCo = /^(?:employment |work |prior |previous )?history with ([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*){0,2})$/i.exec(raw.replace(/[\s*✱:?]+$/, "").trim());
  if (withCo && isBooleanQuestion(q)) {
    if (facts.employment.employers.length === 0) return abstain("former-employee:no-history");
    const co = withCo[1];
    const cur = facts.employment.currentCompany;
    const worked = Boolean(isHigh(cur) && sameCompany(cur.value, co)) || facts.employment.employers.some((e) => sameCompany(e, co));
    return booleanResult(worked, q, "former-employee:history-with");
  }
  const shape =
    /\b(current|former|past|previous|prior)(ly)?\b[^?]*\b(employee|employed|worked|contractor)\b|\bworked (for|at) (us|\w+)|\b(ever|previously) (been )?(employed|worked)\b|\bemployed by\b|\b(provided|done|performed|did) (any )?(contract |consulting |freelance )?(work|services) for\b/.test(n);
  if (!shape) return null;
  if (/\b(relative|family|friend|spouse|referr|government|federal|military|public sector)\b/.test(n)) return null;
  // The company: a capitalized name in the question ("…employee of ActioNet",
  // "a Twitch employee"), else an explicit pointer at the hiring company ("for
  // us", "this company"). Anything else ("worked at a startup") names no
  // company we can check.
  const named =
    /\b(?:of|by|for|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(raw) ??
    // "a current MongoDB employee" (MongoDB's embedded form, live 2026-10-03):
    // a qualifier may sit between the article and the name, or two ("a
    // current or former Alphabet employee", Waymo, live 2026-10-05).
    /\b(?:a|an)\s+(?:(?:current|former|past|previous|prior|full[- ]time|part[- ]time)(?:\s*(?:or|and|\/)\s*(?:current|former|past|previous|prior))?\s+)?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})\s+(?:employee|contractor|intern)\b/.exec(raw);
  const pointsHere = /\b(for us|with us|here|this company|our company|the company|this organi[sz]ation|our organi[sz]ation)\b/.test(n);
  // "Are you a current or former employee?" (Carvana's embedded Greenhouse,
  // live 2026-10-05) names no company and no other place: on the employer's
  // own form it asks about the employer.
  const bare =
    /\b(are|were) you (a |an )?((current|former|past|previous|prior)( or | and | ))+(employee|team member|intern|contractor)s?\b/.test(n) &&
    !/\b(of|at|with|for|by|from|government|agency)\b/.test(n);
  const company = named && !/^(us|our|the|this|any|a|an)$/i.test(named[1])
    ? named[1].replace(/[,.]+$/, "")
    : pointsHere || bare
      ? ctx.company
      : "";
  if (!company) return abstain("former-employee:no-company");
  if (facts.employment.employers.length === 0) return abstain("former-employee:no-history");
  const companies = [company, ...(named ? companiesNamedIn(raw) : [])];
  const current = facts.employment.currentCompany;
  const isCurrent = Boolean(isHigh(current) && companies.some((c) => sameCompany(current.value, c)));
  const isPast = !isCurrent && facts.employment.employers.some((e) => companies.some((c) => sameCompany(e, c)));
  const opts = q.options ?? [];
  if (opts.length > 0 && !isBooleanOptionSet(opts)) {
    const pick = (re: RegExp): string | null => {
      const hits = opts.filter((o) => re.test(qnorm(o)));
      return hits.length === 1 ? hits[0] : null;
    };
    // "Current or Former member of Alphabet extended workforce" (Waymo) says
    // both: the option saying only the one that holds wins.
    const only = (re: RegExp, other: RegExp): string | null => {
      const hits = opts.filter((o) => re.test(qnorm(o)) && !other.test(qnorm(o)));
      return hits.length === 1 ? hits[0] : pick(re);
    };
    const v = isCurrent
      ? only(/\bcurrent\b/, /\b(past|former|previous|prior)\b/)
      : isPast
        ? only(/\b(past|former|previous|prior)\b/, /\bcurrent\b/)
        : pick(/\b(neither|none|no|not|never)\b/);
    return v ? answer(v, "former-employee:choice") : abstain("former-employee:no-matching-option");
  }
  // Written: "Have you ever worked for ConsumerAffairs? If yes, what was your
  // position…?" (Workable, live 2026-10-05). No such job: "No". One there is
  // the applicant's to describe.
  if (!q.options?.length && (q.kind === "text" || q.kind === "longText")) {
    return isCurrent || isPast ? null : answer("No", "former-employee:never-text");
  }
  if (!isBooleanQuestion(q)) return null;
  // "Are you a CURRENT employee?" vs "have you EVER worked here?"
  const asksCurrentOnly = /\b(currently|current) (employed|employee|work)\b/.test(n) && !/\b(former|past|previous|ever|or)\b/.test(n);
  return booleanResult(asksCurrentOnly ? isCurrent : isCurrent || isPast, q, "former-employee");
}

function resolveCurrentlyEmployed(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  if (!/\bare you (currently|presently) (employed|working)\b|\bcurrently employed\b/.test(n) || !isBooleanQuestion(q)) return null;
  if (/\bby\b|\bat\b|\bwith\b/.test(n)) return null;
  const e = facts.employment.currentlyEmployed;
  return isHigh(e) ? booleanResult(e.value, q, "currently-employed") : abstain("currently-employed:unknown");
}

// ----- Availability -------------------------------------------------------------

const pad = (x: number): string => String(x).padStart(2, "0");

/** Format a date the way this field asks for it (placeholder, input type). */
export function formatDateFor(d: Date, q: QuestionInput): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (q.inputType === "date") return `${y}-${pad(m)}-${pad(day)}`;
  if (q.inputType === "month") return `${y}-${pad(m)}`;
  const ph = (q.placeholder || "").toLowerCase();
  if (/dd[./-]mm[./-]yyyy/.test(ph)) return `${pad(day)}/${pad(m)}/${y}`;
  if (/yyyy[./-]mm[./-]dd/.test(ph)) return `${y}-${pad(m)}-${pad(day)}`;
  if (/mm[./-]yyyy/.test(ph) && !/dd/.test(ph)) return `${pad(m)}/${y}`;
  return `${pad(m)}/${pad(day)}/${y}`;
}

function resolveAvailability(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const av = facts.availability;
  // "Are there any days you absolutely cannot work? Please highlight any
  // partial availability" (Glossier, question bank 2026-10-05) got the start
  // date: a weekly schedule, which no profile holds.
  if (/\b(days|hours|shifts|times) (that )?you (absolutely )?(cannot|can not|can t|are unable to|are not able to) work\b|\bpartial availability\b|\bweekly (availability|schedule)\b|\bwhich days\b/.test(n)) {
    return abstain("availability:schedule-unknown");
  }
  // "I am available to begin a potential full-time role before September
  // 2028" (Coinbase, question bank 2026-10-05): the earliest start against it.
  const bound = /\b(available|able) to (start|begin|join|commence)\b[^?]*\b(before|by|no later than)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+((?:19|20)\d{2})\b/.exec(n);
  if (bound && isBooleanQuestion(q)) {
    if (!isHigh(av.earliestStart)) return abstain("start-before:unknown");
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(bound[4]);
    const year = Number(bound[5]);
    // "before September" ends with August; "by September" includes it.
    const limit = bound[3] === "before" ? Date.UTC(year, month, 1) : Date.UTC(year, month + 1, 1);
    return booleanResult(av.earliestStart.value.getTime() < limit, q, "start-before");
  }
  // "Year you expect to begin full time employment" (Jane Street, question
  // bank 2026-10-05): the earliest start's year.
  if (/\byear\b/.test(n) && /\b(begin|start|commence)\w*\b[^?]*\b(full ?time|employment|work|working|career)\b/.test(n) && !/\b(graduat|end|finish)\w*\b/.test(n)) {
    if (!isHigh(av.earliestStart)) return abstain("start-year:unknown");
    const y = String(av.earliestStart.value.getUTCFullYear());
    if (q.options?.length) {
      const hit = q.options.filter((o) => new RegExp(`^\\s*${y}\\s*$`).test(o));
      return hit.length === 1 ? answer(hit[0], "start-year") : abstain("start-year:no-matching-option");
    }
    return answer(y, "start-year");
  }
  // "Are you available to start within 2 weeks / by January 5?"
  const within = /\b(start|begin|join|available)\b[^?]*\bwithin\s+(\d+)\s*(day|week|month)s?\b/.exec(n);
  if (within && isBooleanQuestion(q)) {
    if (!isHigh(av.earliestStart)) return abstain("start-within:unknown");
    const days = Number(within[2]) * (within[3] === "day" ? 1 : within[3] === "week" ? 7 : 30);
    const limit = new Date(facts.today.getTime() + days * 86400000);
    return booleanResult(av.earliestStart.value <= limit, q, "start-within");
  }
  // AVAILABILITY wording only: a bare "Start Date" is just as often an
  // employment row's start date (category experienceStartDate), which this
  // must never answer with the applicant's availability.
  const startQ =
    (q.category === "startDate" ||
      /\b(earliest|when (can|could|would) you (start|begin|join|commence)|when (are|would) you (be )?(able|available) to (start|begin|join|commence|onboard)|available to (start|begin|join|onboard)|availability|date available|available (from|on|starting)|start availability|joining date|(desired|preferred|potential|anticipated|expected|possible|proposed) (start|starting) date|how soon can you start|when (are|would) you (be )?available|available for (employment|work|hire))\b/.test(n)) &&
    // "…available for employment?" is availability (Kenect on Breezy, live
    // 2026-10-03); an employment row's dates are not.
    !/\b(end|finish|graduat|interview|employment (start|end|dates?|history|record)|position held|worked)\b/.test(n);
  if (startQ && (q.kind === "date" || q.kind === "text") && !(q.options && q.options.length)) {
    if (!isHigh(av.earliestStart)) return abstain("start-date:unknown");
    return answer(formatDateFor(av.earliestStart.value, q), "start-date");
  }
  // A notice PERIOD, not any notice: "…I have read and understand the
  // E-verify notice" (Riot Games, question bank 2026-10-05) asked nothing.
  if (/\bnotice period\b|\b(how much|what) notice\b|\bnotice (do|would|will) you\b|\bnotice (required|to give)\b|\b(your|current|required|giving) notice\b|^notice$/.test(n) && !isBooleanQuestion(q)) {
    if (!av.noticeText) return abstain("notice:unknown");
    if (q.options && q.options.length) {
      const hit = pickOption(q.options, av.noticeText);
      return hit ? answer(hit, "notice:choice") : abstain("notice:no-matching-option");
    }
    return answer(av.noticeText, "notice:text");
  }
  return null;
}

// ----- Stated yes/no facts --------------------------------------------------------

function statedBoolean(q: QuestionInput, value: string | undefined, rule: string): QuestionResult {
  const p = polarityOf(value || "");
  if (p === null) return abstain(`${rule}:unknown`);
  return booleanResult(p, q, rule);
}

/** The country a clearance question's own words belong to ("Public Trust",
 *  "TS/SCI", DOE "Q" are US; "Reliability Status" is Canadian). */
function clearanceCountry(n: string): string | null {
  if (/\bpublic trust\b|\bts sci\b|\btop secret sci\b|\bdoe (l|q)\b|\bpolygraph\b|\bdod\b|\b(u s|us|united states) (government |security )?clearance\b/.test(n)) return "US";
  if (/\breliability status\b|\benhanced reliability\b|\bgovernment of canada\b|\bcanadian (security )?clearance\b/.test(n)) return "CA";
  if (/\bbpss\b|\bnppv\b|\bdeveloped vetting\b|\b(sc|dv) (clearance|cleared)\b/.test(n)) return "GB";
  return null;
}

function resolveStatedFacts(q: QuestionInput, n: string, profile: UserApplicationProfile, facts: ProfileFacts, ctx: QuestionContext): QuestionResult {
  if (!isBooleanQuestion(q)) {
    // "…are you willing to commute and/or relocate for this role? If not,
    // please explain:" in a text box (Relativity, question bank 2026-10-05)
    // got the applicant's city: Yes from someone who will move; the rest is
    // theirs to explain.
    if ((q.kind === "text" || q.kind === "longText") && !q.options?.length && /\b(willing|open|able|prepared) to (\w+ (and|or|and or) )?(relocate|move)\b/.test(n) && !/\b(assistance|package|expenses?|reimburse)\b/.test(n)) {
      return polarityOf(profile.willingToRelocate || "") === true ? answer("Yes", "relocation:text") : abstain("relocation:text-unknown");
    }
    // "Clearance type / level" select: "None" when the applicant holds none.
    if (/\bclearance\b/.test(n) && q.options?.length && /^none$/i.test((profile.securityClearance || "").trim())) {
      const none = q.options.filter((o) => /^none\b/i.test(o.trim()));
      if (none.length === 1) return answer(none[0], "clearance:none");
    }
    // The level the profile names, as an option exactly ("Secret" is "Secret
    // Clearance", never "Interim Secret" or "Top Secret"). A clearance stated
    // with no level ("Active clearance") cannot pick one, and the AI could only
    // guess it (ActioNet's eleven types, a veteran, live 2026-10-03).
    const stated = (profile.securityClearance || "").trim();
    if (/\bclearance (type|level)\b|\b(type|level) of (security )?clearance\b/.test(n) && q.options?.length && stated && !/^none$/i.test(stated)) {
      const level = (s: string): string => qnorm(s).replace(/\b(active|current|currently|held|clearance|security)\b/g, " ").replace(/\s+/g, " ").trim();
      const want = level(stated);
      if (!want) return abstain("clearance:level-unknown");
      const hits = q.options.filter((o) => level(o) === want);
      return hits.length === 1 ? answer(hits[0], "clearance:level") : abstain("clearance:level-unknown");
    }
    return null;
  }
  if (/\b(willing|open|able|prepared) to (relocate|move)\b|\brelocat(e|ion)\b/.test(n) && !/\b(assistance|package|support|expenses?|benefits?|allowance|reimburse)\b/.test(n)) {
    if (/\b(live|reside|located|based)\b/.test(n)) return null; // residence shape owns it
    return statedBoolean(q, profile.willingToRelocate, "relocation");
  }
  if (/\bdrivers? (s )?licen[cs]e\b|\bdriving licen[cs]e\b/.test(n) && !/\bnumber\b/.test(n)) {
    // "…a valid U.S. driver's license for at least three (3) consecutive
    // years…" (Nuro, question bank 2026-10-05) got Yes from Toronto and
    // Berlin: the profile says a licence is held, not where, nor for how long.
    if (/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)( \d+)? (consecutive |full )?(years?|months?)\b/.test(n)) return abstain("drivers-license:duration-unknown");
    const named = countryNamedIn(q.label);
    const home = isHigh(facts.location.country) ? facts.location.country.value.code : null;
    if (named && named !== "this-country" && named.code !== home) return abstain("drivers-license:other-country");
    return statedBoolean(q, profile.driversLicense, "drivers-license");
  }
  if (/\bclearance\b/.test(n) && !/\b(customs|credit|medical)\b/.test(n)) {
    const c = (profile.securityClearance || "").trim().toLowerCase();
    if (!c) return abstain("clearance:unknown");
    // A clearance is a national credential, held where it was granted, taken
    // as the applicant's own country. A question in another country's words
    // ("Public Trust") or on a job abroad is not answered from it: a Canadian
    // profile said Yes to a US contractor's "Active Clearance/Public Trust?"
    // (ActioNet on Jobvite, a real profile, 2026-10-03). "None" holds anywhere.
    const home = isHigh(facts.location.country) ? facts.location.country.value.code : null;
    const asked = clearanceCountry(n) ?? ctx.jobCountry;
    if (c !== "none" && home && asked && asked !== home) return abstain("clearance:other-country");
    const active = /\bactive\b/.test(c);
    const eligible = /\beligible|previously\b/.test(c);
    // A U.S. clearance goes to U.S. citizens: a permanent resident or visa
    // holder is not ABLE to obtain one (Pinpoint, a green-card student, live
    // 2026-10-03). Willingness is another question.
    const usBasis = facts.workAuth.byCountry.get("US");
    const notCitizen = usBasis !== undefined && ["permanent_resident", "work_permit", "student", "denied"].includes(usBasis.basis);
    if (asked === "US" && /\b(able|eligible) to (obtain|get|acquire|hold|maintain)\b/.test(n) && notCitizen) {
      return booleanResult(false, q, "clearance:us-citizens-only");
    }
    if (/\b(able|eligible|willing) to (obtain|get|acquire)\b/.test(n)) return eligible || active ? booleanResult(true, q, "clearance:obtainable") : abstain("clearance:obtainable-unknown");
    if (c === "none") return booleanResult(false, q, "clearance");
    if (active) return booleanResult(true, q, "clearance");
    if (eligible && /\b(active|current|hold|have)\b/.test(n)) return booleanResult(false, q, "clearance");
    return abstain("clearance:unknown");
  }
  // "…others that we may choose to speak with" (ConsumerAffairs on Workable,
  // live 2026-10-05) is talking to someone, not a language.
  const lang = /\b(speak(?! (with|to)\b)|fluent|proficient|bilingual|fluency|read and write|written and spoken)\b/.exec(n);
  if (lang) {
    const langs = (profile.languages || "").toLowerCase();
    if (!langs.trim()) return abstain("language:unknown");
    const asked = ["english", "french", "spanish", "german", "mandarin", "cantonese", "portuguese", "italian", "japanese", "korean", "hindi", "arabic", "punjabi", "tagalog", "vietnamese", "russian", "dutch", "polish"].filter((l) => n.includes(l));
    if (asked.length === 0) return abstain("language:unspecified");
    const levelOk = (l: string): boolean | null => {
      const m = new RegExp(`${l}\\s*\\(([^)]*)\\)`, "i").exec(profile.languages || "");
      if (!langs.includes(l)) return false;
      if (!m) return /\b(fluent|proficient|bilingual)\b/.test(n) ? null : true;
      return /\b(native|fluent|bilingual|professional|full|advanced|c1|c2)\b/i.test(m[1]) ? true : null;
    };
    const verdicts = asked.map(levelOk);
    if (verdicts.some((v) => v === null)) return abstain("language:level-unknown");
    if (verdicts.every((v) => v === true)) return booleanResult(true, q, "language");
    return abstain("language:not-listed");
  }
  return null;
}

// ----- Phone country code -----------------------------------------------------------

function resolvePhoneCode(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile): QuestionResult {
  if (q.category !== "phoneCountryCode" && !/\b(country|dial(ing)?|phone|area) code\b|\bcountry calling\b/.test(n)) return null;
  if (/\barea code\b/.test(n)) return null;
  const digits = /^\s*\+(\d{1,3})/.exec(profile.phone || "")?.[1] ?? null;
  const country = isHigh(facts.location.country) ? facts.location.country.value : null;
  const callingCode = digits ?? (country && (country.code === "US" || country.code === "CA") ? "1" : null);
  if (!q.options || q.options.length === 0) {
    if (q.controlType === "combobox" || q.controlType === "customDropdown") {
      return country ? answer(country.name, "phone-code:country-name") : abstain("phone-code:unknown");
    }
    return callingCode ? answer(`+${callingCode}`, "phone-code:text") : abstain("phone-code:unknown");
  }
  const byCountry = country ? q.options.filter((o) => countryNamedIn(o) !== null && (countryNamedIn(o) as { code: string }).code === country.code) : [];
  if (byCountry.length === 1) return answer(byCountry[0], "phone-code:country");
  if (callingCode) {
    const byCode = q.options.filter((o) => new RegExp(`\\+\\s?${callingCode}(?!\\d)`).test(o));
    if (byCode.length === 1) return answer(byCode[0], "phone-code:calling-code");
  }
  return abstain("phone-code:no-unique-option");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Questions about opinions, motivations, a referrer's name, or criminal
 *  history: nothing on a profile answers them and no default may (a guess there
 *  reads as the applicant's own statement). Recognized so they are never filled
 *  by a category fallback. Channels, prior applications, relatives, conflicts,
 *  background checks and the like are answered by defaultAnswers.ts. */
const UNANSWERABLE =
  /\bwho referred\b|\breferred by (whom|who)\b|\b(name|names) of (the |your )?(referr\w*|employee)\b|\bdo you think\b|\bin your opinion\b|\bwhat do you think\b|\bwhy (do|are|did|would) you\b|\bdescribe (a|an)\b|\btell us about (a|an|yourself)\b|\bwhat interests you\b|\bcriminal\b|\bconvicted\b|\bfelony\b/;

/** A follow-up conditioned on an earlier ANSWER. */
const FOLLOW_UP =
  /^if ([a-z] )?(yes|no|so|other|applicable|not|not applicable|you (answered|selected|chose|checked|said|indicated|replied|ticked|heard)|your answer|the answer|any of the above|none of the above|referred|referral)\b/;

// ---------------------------------------------------------------------------
// Conditional questions: "If you <condition>, <question>"
// ---------------------------------------------------------------------------

/** Words that open the question after its condition ("…, please provide…"). */
const MAIN_CLAUSE =
  /^(please|kindly|what|which|how|when|where|who|whom|whose|why|are|is|was|were|have|has|had|do|does|did|will|would|can|could|should|list|provide|enter|state|describe|explain|indicate|specify|tell|share|include|select|choose|name|give|identify|confirm)\b/i;
/** A hypothetical the applicant answers as if it held ("If you are offered the
 *  position, will you require sponsorship?"). */
const HYPOTHETICAL = /\b(hired|selected|offered|successful|chosen|an offer|invited|moved? forward|join(ing)? (us|our|the team))\b/;
/** The auxiliary a condition opens with, and whether it negates. */
const CONDITION_AUX: Record<string, [string, boolean]> = {
  are: ["Are", false], were: ["Were", false], have: ["Have", false], had: ["Had", false],
  do: ["Do", false], did: ["Did", false], will: ["Will", false], would: ["Would", false],
  can: ["Can", false], could: ["Could", false],
  arent: ["Are", true], werent: ["Were", true], havent: ["Have", true], hadnt: ["Had", true],
  dont: ["Do", true], didnt: ["Did", true], wont: ["Will", true], cant: ["Can", true], cannot: ["Can", true],
};
/** An option saying the question does not apply ("I am not a current or former
 *  government employee", "N/A"). */
const NOT_APPLICABLE =
  /\b(not applicable|n ?a|does not apply|doesnt apply|i am not|im not|i have not|i havent|i was not|i do not|i dont|i did not|i didnt|never been|none of the above)\b/;

/** "you are a current or former government employee" → "Are you a current or
 *  former government employee?" (and whether the condition was negated). */
function conditionQuestion(condition: string): { question: string; negated: boolean } | null {
  const t = condition.trim().replace(/[’‘]/g, "'").split(/\s+/);
  const first = (t[0] ?? "").toLowerCase();
  let aux: string;
  let negated = false;
  let i = 1;
  if (first === "you're" || first === "youre") aux = "Are";
  else if (first === "you've" || first === "youve") aux = "Have";
  else if (first === "you") {
    const known = CONDITION_AUX[(t[1] ?? "").toLowerCase().replace(/'/g, "")];
    if (known) {
      [aux, negated] = known;
      i = 2;
    } else aux = "Do"; // "you currently work, or have previously worked, at X"
  } else return null; // a condition on something else ("If the role is remote, …")
  if ((t[i] ?? "").toLowerCase() === "not") {
    negated = !negated;
    i++;
  }
  const rest = t.slice(i).join(" ");
  return rest ? { question: [aux, "you", rest].join(" ") + "?", negated } : null;
}

/**
 * A question that applies only when a condition on the applicant holds. The
 * condition is answered as its own yes/no question first: false → the option
 * saying it does not apply, or blank; true (or a hypothetical "if hired") →
 * the question itself; unknown → blank. ActioNet on Jobvite (live 2026-10-03):
 * "If you are a current or former government employee, have you recused
 * yourself…?" was answered "No" for an applicant who is neither.
 * undefined = not a condition on the applicant: resolve the label as usual.
 */
function resolveConditional(q: QuestionInput, raw: string, facts: ProfileFacts, profile: UserApplicationProfile, ctx: QuestionContext): QuestionResult | undefined {
  const m = /^\s*if\s+([\s\S]+)$/i.exec(raw);
  if (!m) return undefined;
  const body = m[1];
  let condition = "";
  let rest = "";
  const sep = /[,;]\s*|\s[-–—]\s*/g;
  for (let s = sep.exec(body); s; s = sep.exec(body)) {
    const after = body.slice(s.index + s[0].length);
    if (MAIN_CLAUSE.test(after)) {
      condition = body.slice(0, s.index);
      rest = after.trim();
      break;
    }
  }
  if (!condition) return /^you\b|^youre\b|^you'/i.test(body.trim()) ? abstain("conditional:unparsed") : undefined;
  const restQ: QuestionInput = { ...q, label: rest };
  if (HYPOTHETICAL.test(qnorm(condition))) return resolveQuestion(restQ, facts, profile, ctx);
  const asked = conditionQuestion(condition);
  if (!asked) return undefined;
  const held = resolveQuestion(
    { label: asked.question, controlType: "radioGroup", options: ["Yes", "No"], category: "unknown", kind: "boolean" },
    facts,
    profile,
    ctx
  );
  // A condition kept from the AI keeps its follow-up from it too.
  if (!held || held.status !== "answer") {
    return { status: "abstain", rule: "conditional:unknown", blockBackend: held?.status === "abstain" && held.blockBackend === true };
  }
  if ((held.value === "Yes") !== asked.negated) {
    const inner = resolveQuestion(restQ, facts, profile, ctx);
    // The field's category came from the whole label, its condition included:
    // "If you do require sponsorship…, please list the type of support you may
    // require" (Pinterest, question bank 2026-10-05) is a sponsorship field
    // whose category value, the profile's bare Yes/No, answers the condition,
    // never the question. Legal status is not filled that way.
    if (inner === null && (q.category === "sponsorship" || q.category === "workAuthorization")) {
      return abstain(q.category === "sponsorship" ? "sponsorship:follow-up-open" : "work-auth:follow-up-open");
    }
    return inner;
  }
  const na = (q.options ?? []).filter((o) => o.trim() && !/^(yes|no)$/i.test(o.trim()) && NOT_APPLICABLE.test(qnorm(o)));
  return na.length === 1 ? answer(na[0], "conditional:does-not-apply") : abstain("conditional:does-not-apply");
}

/** Abstentions that only mean "the profile is silent": the default answer, if
 *  one applies, takes over (a profile fact always runs first). */
const DEFAULTABLE = /^(relocation:unknown|former-employee:no-history|former-employee:no-company|age-gate:no-dob)/;

/** A question about the applicant's HIGH school (its name, year, grades), which
 *  no profile education row describes. */
const HIGH_SCHOOL = /\b(high school|secondary school)\b/;
const HIGH_SCHOOL_DETAIL = /\b(name|year|graduat\w*|date|attend\w*|where|which|gpa|grades?|location|city)\b/;

export function resolveQuestion(
  q: QuestionInput,
  facts: ProfileFacts,
  profile: UserApplicationProfile,
  ctx: QuestionContext
): QuestionResult {
  const raw = (q.label || "").trim();
  if (!raw) return null;
  const n = qnorm(raw);
  // Conditional follow-ups ("If 'Other' selected…", "If yes, please explain"):
  // what they ask depends on an answer we did not give. A condition on the
  // APPLICANT ("If you are currently enrolled…, what is your GPA?") is an
  // ordinary question (Shield AI on Lever, live 2026-10-03).
  if (FOLLOW_UP.test(n) || /^if\s*['"“‘]/i.test(raw) || /^(other|if other|other please (specify|explain|describe)|please specify)$/.test(n)) {
    // "If no, will you require sponsorship in the future?" (Hermeus on Lever,
    // live 2026-10-03) is a question of its own after the condition: answered
    // when the profile settles it, whatever was answered before it.
    const m = /^\s*if (?:yes|no|so)\s*[,:;-]?\s+(.+)$/i.exec(raw);
    if (m && /\?\W*$/.test(m[1]) && /^(will|would|do|does|are|is|can|could|have|has|did)\b/i.test(m[1].trim())) {
      const inner = resolveQuestion({ ...q, label: m[1] }, facts, profile, ctx);
      if (inner?.status === "answer") return inner;
    }
    return abstain("conditional-follow-up");
  }
  const conditional = resolveConditional(q, raw, facts, profile, ctx);
  if (conditional !== undefined) return conditional;
  // "How did you hear about this position? If referred, by who?" (Kenect on
  // Breezy, live 2026-10-03): an add-on starting with "if" asks only when it
  // applies, so the question is judged by its first sentence.
  const sentences = raw.split(/(?<=\?)\s*/);
  const asked = sentences.length > 1 && /^\s*if\b/i.test(sentences.slice(1).join(" ")) ? qnorm(sentences[0]) : n;
  if (UNANSWERABLE.test(asked)) return abstain("unanswerable-from-profile");
  // A phone extension: no profile holds one, and a guess (the AI's, or the
  // phone number again, as Workday's "phone-extension" once got) dials wrong.
  if (/^(phone |telephone )?ext(ension)?( number)?$/.test(asked)) return abstain("phone-extension:not-in-profile");
  // The profile's education rows are post-secondary: their school and year
  // answer the university question, never "High School Name" / "Year of High
  // School Graduation" (Palantir on Lever, live 2026-10-03). A yes/no about a
  // diploma is left to the education-level shapes below.
  if (HIGH_SCHOOL.test(n) && HIGH_SCHOOL_DETAIL.test(n) && !isBooleanQuestion(q)) {
    // Its year, from a list that starts after the applicant's first finished
    // degree: high school ended before that, so the list's "Other" (Palantir's
    // 2020-2030, a 2015 graduate, live 2026-10-03).
    if (/\b(year|graduat\w*|date)\b/.test(n) && q.options?.length) {
      const years = q.options.map((o) => /^\s*((?:19|20)\d{2})\s*$/.exec(o)?.[1]).filter((y): y is string => Boolean(y)).map(Number);
      const other = q.options.filter((o) => /^\s*other\b/i.test(o));
      const done = facts.education.entries.filter((e) => e.completed === true && e.graduation).map((e) => e.graduation!.earliest.getUTCFullYear());
      if (years.length >= 2 && other.length === 1 && done.length && Math.min(...done) < Math.min(...years)) {
        return answer(other[0], "high-school:before-listed-years");
      }
    }
    return abstain("high-school:not-in-profile");
  }

  const resolved =
    resolveRelocationInstruction(q, raw, facts, profile, ctx) ??
    resolveSanctionedList(q, n, facts) ??
    resolveWorkAuthorization(q, n, facts, profile, ctx) ??
    resolveUsPersonStatus(q, facts, profile) ??
    resolveLaterResidency(q, n, facts) ??
    resolveCitizenship(q, n, facts, ctx) ??
    resolveAge(q, n, facts) ??
    resolveSchoolMembership(q, n, facts) ??
    resolveMovePlan(q, n, profile) ??
    resolveResidence(q, n, facts, profile) ??
    resolveRegionChoice(q, n, facts) ??
    resolveLocatedChoice(q, n, facts) ??
    resolveFormerEmployee(q, n, raw, facts, ctx) ??
    resolveCurrentlyEmployed(q, n, facts) ??
    resolveYearsOfExperience(q, n, facts) ??
    resolvePursuedDegree(q, n, facts) ??
    resolveEducationLevel(q, n, facts) ??
    resolveDegreeCandidate(q, n, facts) ??
    resolveEnrollment(q, n, facts) ??
    resolveCoop(q, n, facts) ??
    resolvePreviousInternship(q, n, profile) ??
    resolveSchoolSchedule(q, n, facts) ??
    resolveEducationSummary(q, n, facts) ??
    resolveGraduation(q, n, facts) ??
    resolveGpa(q, n, profile, facts) ??
    resolveTestScore(q, n) ??
    resolveStartDateChoice(q, n, facts) ??
    resolveStartBucket(q, n, facts) ??
    resolveTimezone(q, n, facts) ??
    resolveZoneAvailability(q, n, facts) ??
    resolveDidGraduate(q, n, facts) ??
    resolvePeriodAvailability(q, n, facts) ??
    resolveSalaryUnit(q, n, facts, profile) ??
    resolveLocalTo(q, n, facts, profile) ??
    resolveSchoolName(q, n, facts) ??
    resolveAvailability(q, n, facts) ??
    resolveRelocationChoice(q, n, profile, ctx) ??
    resolveLanguageChoice(q, n, profile) ??
    resolveStatedFacts(q, n, profile, facts, ctx) ??
    resolvePhoneCode(q, n, facts, profile) ??
    null;
  if (resolved && (resolved.status === "answer" || !DEFAULTABLE.test(resolved.rule))) return resolved;
  // An adult-applicant gate with no date of birth: 18 or older is the default;
  // a higher bar (21) stays the applicant's to answer.
  // No work history at all: never this company's employee either ("Have you
  // previously worked for D2L in any capacity?", a new graduate, live
  // 2026-10-03). The "no", "never" or "neither" option, or No.
  if (resolved?.rule === "former-employee:no-history") {
    const opts = (q.options ?? []).filter((o) => o.trim());
    if (opts.length === 0 || isBooleanOptionSet(opts)) return booleanResult(false, q, "default:no-history");
    const never = opts.filter((o) => /^(no|never|neither|none|n a|not applicable)\b/.test(qnorm(o)) || /\b(have not|havent|never)\b/.test(qnorm(o)));
    return never.length === 1 ? answer(never[0], "default:no-history") : resolved;
  }
  if (resolved?.rule === "age-gate:no-dob") {
    const min = Number(AGE_MIN.exec(n)?.slice(1).find(Boolean) ?? NaN);
    return min <= 18 && !AGE_UNDER.test(n) ? booleanResult(true, q, "default:adult") : resolved;
  }
  return resolveDefault(q, n, profile, facts, ctx) ?? resolved;
}
