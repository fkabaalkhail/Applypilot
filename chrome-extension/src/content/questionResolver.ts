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
const BLOCK_BACKEND_RULES = /^(work-auth|sponsorship|citizenship|age-gate|conditional:does-not-apply)/;
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

function targetCountry(q: QuestionInput, ctx: QuestionContext): string | null {
  const named = countryNamedIn(q.label);
  if (named === "this-country") return ctx.jobCountry;
  if (named) return named.code;
  return ctx.jobCountry;
}

const residenceOf = (facts: ProfileFacts): string | null =>
  isHigh(facts.location.country) ? facts.location.country.value.code : null;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const WORK_RIGHT =
  /\b(authori[sz]ed|eligible|entitled|permitted|allowed|legally able|legal right|right|permission) to (legally )?work\b|\bwork authori[sz]ation\b|\bwork permit\b|\blegally (work|be employed|employed)\b|\bauthori[sz]ation to work\b|\bwork legally\b|\b(eligible|authori[sz]ed|permitted|allowed) to (legally )?(begin|start|commence|accept|take up) (employment|work)\b|\beligible for employment\b/;

/** "Are you able to work…" is a work RIGHT question only when it names a
 *  country and no arrangement: "able to work from our Kepler office" (Lever,
 *  live 2026-10-03) is about the office, and was answered as authorization. */
function isAbleToWorkInCountry(n: string, raw: string): boolean {
  if (!/\bable to work\b/.test(n)) return false;
  if (/\b(office|onsite|on site|in person|remote|remotely|hybrid|weekends?|nights?|shifts?|overtime|hours|travel|commute|schedule|full time|part time|days a week)\b/.test(n)) return false;
  const c = countryNamedIn(raw);
  return c !== null;
}
const SPONSOR = /\bsponsor(ship|ed|ing)?\b|\b(visa|immigration) (status|support|assistance|transfer)\b|\bh ?1 ?b\b/;
/** Asks whether sponsorship is NEEDED ("will you require / do you need … sponsorship"). */
const REQUIRES_SPONSOR = /\b(require|requires|requiring|need|needs|needing)\b[^?]{0,60}\bsponsor/;
/** Asks for the work RIGHT itself ("are you legally authorized…", "do you have the right to work…"). */
const ASKS_RIGHT =
  /\b(are|is) (you|the applicant)\b[^?]{0,25}\b(authori[sz]ed|eligible|entitled|permitted|allowed|legally able)\b|\bdo you (have|hold|possess)\b[^?]{0,25}\b(right|authori[sz]ation|permit)\b/;
/** Asks WHICH sponsorship or visa, not whether: no profile answer states it. */
const SPONSOR_TYPE = /\b(what|which) (type of |kind of |form of )?(visa )?(sponsorship|visa|work permit)\b|\b(type|kind|form) of (visa |work )?(sponsorship|visa|permit)\b/;
const WITHOUT_SPONSOR = /\bwithout (the )?(need (for|of) |needing |requiring |requirement (for|of) )?(any )?(current or future )?(visa |employer |employment |immigration |company )?sponsor/;

function resolveWorkAuthorization(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile, ctx: QuestionContext): QuestionResult {
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
  const country = targetCountry(q, ctx);
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
    if (!isBooleanQuestion(q)) {
      // Free text: the applicant's own stated answer, verbatim, when it covers this country.
      const s = needsSponsorshipIn(facts.workAuth, country, residence);
      if (isHigh(s) && profile.requiresSponsorship?.trim() && q.kind !== "number" && q.kind !== "date") {
        return answer(s.value ? "Yes" : "No", "sponsorship:text");
      }
      return abstain("sponsorship:unknown");
    }
    const s = needsSponsorshipIn(facts.workAuth, country, residence);
    // A question phrased as the inverse ("Can you work WITHOUT sponsorship?")
    // without a work-right phrase ("…work for us without sponsorship").
    const inverted = /\bwithout\b/.test(n) && !/\b(require|need)\b/.test(n);
    if (isHigh(s)) return booleanResult(inverted ? !s.value : s.value, q, "sponsorship");
    return abstain("sponsorship:unknown");
  }

  // Work authorization proper.
  if (isBooleanQuestion(q)) {
    const a = authorizedIn(facts.workAuth, country, residence);
    if (isHigh(a)) return booleanResult(a.value, q, "work-auth");
    return abstain("work-auth:unknown");
  }
  // A status choice ("What is your work authorization status?"), or free text.
  if (q.options && q.options.length > 0) {
    return resolveStatusChoice(q, facts, country) ?? abstain("work-auth-status:unknown");
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

function resolveCitizenship(q: QuestionInput, n: string, facts: ProfileFacts, ctx: QuestionContext): QuestionResult {
  if (!CITIZEN_Q.test(n)) return null;
  const country = countryNamedIn(q.label);
  const code = country === "this-country" ? ctx.jobCountry : country?.code ?? null;
  const known = facts.workAuth.byCountry;
  if (isBooleanQuestion(q)) {
    if (!code) return abstain("citizenship:no-country");
    const c = known.get(code);
    if (!c) return abstain("citizenship:unknown");
    const orPr = /\bpermanent resident|green card\b/.test(n);
    if (c.basis === "citizen") return booleanResult(true, q, "citizenship");
    if (c.basis === "permanent_resident") return booleanResult(orPr, q, "citizenship:pr");
    if (c.basis === "work_permit" || c.basis === "student") return booleanResult(false, q, "citizenship:visa");
    return abstain("citizenship:unknown");
  }
  // "Country of citizenship" choice/text.
  const citizenOf = [...known.entries()].filter(([, a]) => a.basis === "citizen").map(([cc]) => countryByCode(cc)!);
  if (citizenOf.length !== 1) return abstain("citizenship:unknown");
  return renderCountry(citizenOf[0], q, "citizenship:country");
}

// ----- Residence ------------------------------------------------------------

const RESIDE = /\b(live|living|reside|residing|resident|located|based|currently in|located within|within commuting distance)\b/;

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
 *  2026-10-03). */
const APPLICANT_RESIDES =
  /\b(do|are|have|did) you\b[^?]{0,60}?\b(live|living|reside|residing|located|based|resident|currently in)\b|\bare you (a |an )?(current )?resident\b|\byour (current )?(location|residence|city of residence|place of residence)\b|\bwhere (do|are) you\b/;

function resolveResidence(q: QuestionInput, n: string, facts: ProfileFacts, profile: UserApplicationProfile): QuestionResult {
  if (!RESIDE.test(n) || !APPLICANT_RESIDES.test(n) || !isBooleanQuestion(q)) return null;
  if (/\b(willing|open|able|plan|planning) to (relocate|move)\b/.test(n) && !/\b(live|reside|located|based)\b/.test(n)) return null;
  const place = placeIn(q.label);
  if (!place) return null;
  const loc = facts.location;
  const residenceCountry = isHigh(loc.country) ? loc.country.value : null;
  const relocateClause = /\b(or|if not)\b[^?]*\b(relocat|move)/.test(n);
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

/** "Which state do you reside in?" / a State or Province select. */
function resolveRegionChoice(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const asksRegion = q.category === "addressState" || /\b(which|what) (state|province)\b|\bstate (or province )?(of|you) (residence|reside|live)\b|\bprovince of residence\b/.test(n);
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
  if (!/\bwhere (are you|do you) (currently )?(located|based|live|reside)\b|\b(current|your) location\b|\bregion of residence\b/.test(n)) return null;
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
  const continent = geoNorm(country.continent);
  const byContinent = q.options.filter((o) => geoNorm(o) === continent || geoNorm(o).includes(continent));
  if (byContinent.length === 1) return answer(byContinent[0], "located-choice:continent");
  return abstain("located-choice:no-matching-option");
}

// ----- Age -----------------------------------------------------------------

const AGE_MIN = /\b(?:at least|minimum(?: age)?(?: of)?|older than|over(?: the age of)?|above)\s+(\d{1,2})\b|\b(\d{1,2})\s*(?:\+|years? of age|years? old|or older|or above|or over|and older|and over)/;
const AGE_UNDER = /\b(?:under|younger than|below|less than)\s+(?:the age of\s+)?(\d{1,2})\b/;

function resolveAge(q: QuestionInput, n: string, facts: ProfileFacts): QuestionResult {
  const ageWord = /\bage\b|\bold\b|\byears of age\b/.test(n);
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
  const narrowed =
    /\bexperience\b(?:\s+(?:do|did|have|has|you|of|that|which|would|say|in total)){0,5}\s+(?:with|in|using|on|as|doing|working with|working in|leading|managing)\s+(?:a |an |the )?([a-z0-9 +#.-]{2,40})/.exec(n);
  if (narrowed) {
    const obj = narrowed[1].trim();
    if (!/^(total|industry|the industry|professional (setting|capacity|environment)s?|similar roles?|this field|the field|related fields?|the workforce|a professional|full time|paid)\b/.test(obj)) {
      domainWords.push(...obj.split(/\s+/).slice(0, 3));
      const dom = DOMAINS.find((d) => d.q.test(obj));
      if (!dom) return abstain("years-experience:narrowed");
    }
  }
  const total = facts.employment.totalYears;
  if (!isHigh(total)) return abstain("years-experience:unknown");
  if (domainWords.length > 0) {
    const phrase = domainWords.join(" ");
    const dom = DOMAINS.find((d) => d.q.test(phrase));
    const titles = facts.employment.titles;
    if (!dom || titles.length === 0 || !titles.every((t) => dom.title.test(t.toLowerCase()))) {
      return abstain("years-experience:domain-unproven");
    }
  }
  const years = total.value;
  if (isBooleanQuestion(q)) {
    // "Do you have at least 3 years of experience?" / "3+ years" / "more than 5 years"
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
  // "…currently enrolled in OR have graduated from a university?": either one.
  if (/\bor (have |has )?(graduated|completed)\b|\bor (a )?(recent )?graduate\b/.test(n)) {
    if (isHigh(e) && e.value) return booleanResult(true, q, "enrollment:or-graduated");
    if (facts.education.entries.some((x) => x.completed === true)) return booleanResult(true, q, "enrollment:or-graduated");
    return abstain("enrollment:unknown");
  }
  if (isHigh(e)) return booleanResult(e.value, q, "enrollment");
  return abstain("enrollment:unknown");
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
  if (!/\bgraduat(e|ed|ion|ing)\b/.test(n) || !/\b(year|date|when|month|term|semester|expected|anticipated)\b/.test(n)) return null;
  if (q.kind === "boolean") return null;
  const primary = facts.education.primary;
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
    const withYear = q.options.filter((o) => o.includes(year));
    if (withYear.length === 1) return answer(withYear[0], "graduation:only-option-in-year");
    return abstain("graduation:no-unique-option");
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
  if (!/\b(gpa|cgpa|grade point average|cumulative average)\b/.test(n)) return null;
  if (/\b(scale|out of|maximum|max)\b/.test(n) && !/\byour\b/.test(n)) return null;
  const higher = /\b(graduate|masters?|doctorate|doctoral|phd|mba)\b/.test(n) && !/\bundergraduate\b/.test(n);
  const rank = facts.education.highestRank?.value ?? null;
  if (higher && rank !== null && rank < 5) {
    const na = (q.options ?? []).filter((o) => /^(n a|na|none|i do not have|no graduate)\b|\bnot applicable\b/.test(qnorm(o)));
    return na.length === 1 ? answer(na[0], "gpa:not-applicable") : abstain("gpa:no-graduate-degree");
  }
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
 * "SAT Score*" / "ACT" / "GRE" (SpaceX, live 2026-10-03): the profile holds no
 * test scores. When the list offers a "did not take / do not recall" option,
 * that is the answer that claims nothing; otherwise blank.
 */
function resolveTestScore(q: QuestionInput, n: string): QuestionResult {
  if (!/\b(sat|act|gre|gmat|lsat|mcat|toefl|ielts|psat)\b/.test(n) || !/\b(score|scores|result|results|test)\b/.test(n)) return null;
  if (!q.options?.length) return q.kind === "text" || q.kind === "number" ? abstain("test-score:unknown") : null;
  const na = q.options.filter((o) => /\b(did not take|have not taken|havent taken|not taken|do not recall|dont recall|not applicable|n a|none)\b/.test(qnorm(o)));
  return na.length === 1 ? answer(na[0], "test-score:none-stated") : abstain("test-score:unknown");
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
function resolveUsPersonStatus(q: QuestionInput, facts: ProfileFacts): QuestionResult {
  const opts = (q.options ?? []).filter((o) => o.trim());
  if (opts.filter((o) => US_STATUS_OPTION.test(qnorm(o))).length < 2) return null;
  const us = facts.workAuth.byCountry.get("US");
  const pick = (re: RegExp): QuestionResult => {
    const hits = opts.filter((o) => re.test(qnorm(o)));
    return hits.length === 1 ? answer(hits[0], "us-person-status") : abstain("us-person-status:no-matching-option");
  };
  if (us?.authorized === false) return pick(/^(\(?[a-z]\)?\s+)?other\b|\bnone of the above\b|\bforeign person\b|\bnot a u ?s person\b/);
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
  if (/\bcurrently attending|currently enrolled|you attend\b|\bdo you attend\b|\bare you attending\b/.test(n)) {
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
    return hit ? answer(hit, "school-name") : abstain("school-name:no-matching-option");
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

function resolveFormerEmployee(q: QuestionInput, n: string, raw: string, facts: ProfileFacts, ctx: QuestionContext): QuestionResult {
  const history = resolveEmploymentHistoryChoice(q, n, raw, facts);
  if (history) return history;
  const shape =
    /\b(current|former|past|previous|prior)(ly)?\b[^?]*\b(employee|employed|worked|contractor)\b|\bworked (for|at) (us|\w+)|\b(ever|previously) (been )?(employed|worked)\b|\bemployed by\b/.test(n);
  if (!shape) return null;
  if (/\b(relative|family|friend|spouse|referr|government|federal|military|public sector)\b/.test(n)) return null;
  // The company: a capitalized name in the question ("…employee of ActioNet",
  // "a Twitch employee"), else an explicit pointer at the hiring company ("for
  // us", "this company"). Anything else ("worked at a startup") names no
  // company we can check.
  const named =
    /\b(?:of|by|for|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(raw) ??
    /\b(?:a|an)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})\s+(?:employee|contractor|intern)\b/.exec(raw);
  const pointsHere = /\b(for us|with us|here|this company|our company|the company|this organi[sz]ation|our organi[sz]ation)\b/.test(n);
  const company = named && !/^(us|our|the|this|any|a|an)$/i.test(named[1])
    ? named[1].replace(/[,.]+$/, "")
    : pointsHere
      ? ctx.company
      : "";
  if (!company) return abstain("former-employee:no-company");
  if (facts.employment.employers.length === 0) return abstain("former-employee:no-history");
  const current = facts.employment.currentCompany;
  const isCurrent = Boolean(isHigh(current) && sameCompany(current.value, company));
  const isPast = !isCurrent && facts.employment.employers.some((e) => sameCompany(e, company));
  const opts = q.options ?? [];
  if (opts.length > 0 && !isBooleanOptionSet(opts)) {
    const pick = (re: RegExp): string | null => {
      const hits = opts.filter((o) => re.test(qnorm(o)));
      return hits.length === 1 ? hits[0] : null;
    };
    const v = isCurrent
      ? pick(/\bcurrent\b/)
      : isPast
        ? pick(/\b(past|former|previous|prior)\b/)
        : pick(/\b(neither|none|no|not|never)\b/);
    return v ? answer(v, "former-employee:choice") : abstain("former-employee:no-matching-option");
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
      /\b(earliest|when (can|could|would) you (start|begin|join|commence)|when (are|would) you (be )?(able|available) to (start|begin|join|commence)|available to (start|begin|join)|availability|date available|available (from|on|starting)|start availability|joining date|(desired|preferred|potential|anticipated|expected|possible|proposed) (start|starting) date|how soon can you start)\b/.test(n)) &&
    !/\b(end|finish|graduat|interview|employment|position held|worked)\b/.test(n);
  if (startQ && (q.kind === "date" || q.kind === "text") && !(q.options && q.options.length)) {
    if (!isHigh(av.earliestStart)) return abstain("start-date:unknown");
    return answer(formatDateFor(av.earliestStart.value, q), "start-date");
  }
  if (/\bnotice( period)?\b/.test(n) && !isBooleanQuestion(q)) {
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

function resolveStatedFacts(q: QuestionInput, n: string, profile: UserApplicationProfile): QuestionResult {
  if (!isBooleanQuestion(q)) {
    // "Clearance type / level" select: "None" when the applicant holds none.
    if (/\bclearance\b/.test(n) && q.options?.length && /^none$/i.test((profile.securityClearance || "").trim())) {
      const none = q.options.filter((o) => /^none\b/i.test(o.trim()));
      if (none.length === 1) return answer(none[0], "clearance:none");
    }
    return null;
  }
  if (/\b(willing|open|able|prepared) to (relocate|move)\b|\brelocat(e|ion)\b/.test(n) && !/\b(assistance|package|support|expenses?|benefits?|allowance|reimburse)\b/.test(n)) {
    if (/\b(live|reside|located|based)\b/.test(n)) return null; // residence shape owns it
    return statedBoolean(q, profile.willingToRelocate, "relocation");
  }
  if (/\bdrivers? (s )?licen[cs]e\b|\bdriving licen[cs]e\b/.test(n) && !/\bnumber\b/.test(n)) {
    return statedBoolean(q, profile.driversLicense, "drivers-license");
  }
  if (/\bclearance\b/.test(n) && !/\b(customs|credit|medical)\b/.test(n)) {
    const c = (profile.securityClearance || "").trim().toLowerCase();
    if (!c) return abstain("clearance:unknown");
    const active = /\bactive\b/.test(c);
    const eligible = /\beligible|previously\b/.test(c);
    if (/\b(able|eligible|willing) to (obtain|get|acquire)\b/.test(n)) return eligible || active ? booleanResult(true, q, "clearance:obtainable") : abstain("clearance:obtainable-unknown");
    if (c === "none") return booleanResult(false, q, "clearance");
    if (active) return booleanResult(true, q, "clearance");
    if (eligible && /\b(active|current|hold|have)\b/.test(n)) return booleanResult(false, q, "clearance");
    return abstain("clearance:unknown");
  }
  const lang = /\b(speak|fluent|proficient|bilingual|fluency|read and write|written and spoken)\b/.exec(n);
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
  if (!held || held.status !== "answer") return abstain("conditional:unknown");
  if ((held.value === "Yes") !== asked.negated) return resolveQuestion(restQ, facts, profile, ctx);
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
  if (FOLLOW_UP.test(n) || /^if\s*['"“‘]/i.test(raw)) return abstain("conditional-follow-up");
  const conditional = resolveConditional(q, raw, facts, profile, ctx);
  if (conditional !== undefined) return conditional;
  if (UNANSWERABLE.test(n)) return abstain("unanswerable-from-profile");
  // The profile's education rows are post-secondary: their school and year
  // answer the university question, never "High School Name" / "Year of High
  // School Graduation" (Palantir on Lever, live 2026-10-03). A yes/no about a
  // diploma is left to the education-level shapes below.
  if (HIGH_SCHOOL.test(n) && HIGH_SCHOOL_DETAIL.test(n) && !isBooleanQuestion(q)) {
    return abstain("high-school:not-in-profile");
  }

  const resolved =
    resolveWorkAuthorization(q, n, facts, profile, ctx) ??
    resolveUsPersonStatus(q, facts) ??
    resolveCitizenship(q, n, facts, ctx) ??
    resolveAge(q, n, facts) ??
    resolveSchoolMembership(q, n, facts) ??
    resolveResidence(q, n, facts, profile) ??
    resolveRegionChoice(q, n, facts) ??
    resolveLocatedChoice(q, n, facts) ??
    resolveFormerEmployee(q, n, raw, facts, ctx) ??
    resolveCurrentlyEmployed(q, n, facts) ??
    resolveYearsOfExperience(q, n, facts) ??
    resolveEducationLevel(q, n, facts) ??
    resolveEnrollment(q, n, facts) ??
    resolveGraduation(q, n, facts) ??
    resolveGpa(q, n, profile, facts) ??
    resolveTestScore(q, n) ??
    resolveSchoolName(q, n, facts) ??
    resolveAvailability(q, n, facts) ??
    resolveRelocationChoice(q, n, profile, ctx) ??
    resolveLanguageChoice(q, n, profile) ??
    resolveStatedFacts(q, n, profile) ??
    resolvePhoneCode(q, n, facts, profile) ??
    null;
  if (resolved && (resolved.status === "answer" || !DEFAULTABLE.test(resolved.rule))) return resolved;
  // An adult-applicant gate with no date of birth: 18 or older is the default;
  // a higher bar (21) stays the applicant's to answer.
  if (resolved?.rule === "age-gate:no-dob") {
    const min = Number(AGE_MIN.exec(n)?.slice(1).find(Boolean) ?? NaN);
    return min <= 18 && !AGE_UNDER.test(n) ? booleanResult(true, q, "default:adult") : resolved;
  }
  return resolveDefault(q, n, profile, facts, ctx) ?? resolved;
}
