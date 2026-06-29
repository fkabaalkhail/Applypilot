/**
 * Field classification engine.
 *
 * Scores every text signal of a control (label, aria-label, placeholder,
 * name/id attributes, nearby text, autocomplete token, input type) against
 * per-category regex patterns and produces a category + confidence in 0..1.
 *
 * Design rules:
 *  - Signals are weighted by reliability: a real <label> beats an id attribute,
 *    which beats loose nearby text.
 *  - Negative patterns veto a signal for a category ("Email address" must not
 *    classify as location just because it contains "address").
 *  - Corroboration across multiple signals adds a small bonus.
 *  - Anything under MIN_CATEGORY_CONFIDENCE is reported as "unknown" rather
 *    than guessed — low-confidence guesses are surfaced for review, not filled.
 */
import { MIN_CATEGORY_CONFIDENCE } from "../shared/constants";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../shared/types";
import type { FieldSignals } from "./domUtils";

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Normalize attribute/label text for matching:
 * "candidate-firstName" → "candidate first name"
 */
export function normalize(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // punctuation/separators → space
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Pattern table
// ---------------------------------------------------------------------------

interface PatternSpec {
  re: RegExp;
  /** Pattern strength 0..1 — lower for looser, more ambiguous patterns. */
  weight?: number;
}

interface CategorySpec {
  category: FieldCategory;
  patterns: PatternSpec[];
  /** If this matches a signal, that signal cannot vote for the category. */
  negative?: RegExp;
  sensitive?: boolean;
}

// Order matters only for tie-breaking: more specific categories come first.
const CATEGORY_SPECS: CategorySpec[] = [
  // --- EEO / demographics (sensitive — detected, never filled by default) ---
  {
    category: "eeoGender",
    sensitive: true,
    patterns: [{ re: /\bgender\b/ }, { re: /\bsex\b/, weight: 0.85 }],
    negative: /\bsexual orientation\b/,
  },
  {
    category: "eeoRace",
    sensitive: true,
    patterns: [{ re: /\brace\b/ }, { re: /\bethnicit(y|ies)\b/ }, { re: /\bethnic\b/ }],
  },
  {
    category: "eeoHispanic",
    sensitive: true,
    patterns: [{ re: /\bhispanic\b/ }, { re: /\blatino\b|\blatinx\b/ }],
  },
  {
    category: "eeoVeteran",
    sensitive: true,
    patterns: [{ re: /\bveteran\b/ }, { re: /\bmilitary (status|service)\b/ }],
  },
  {
    category: "eeoDisability",
    sensitive: true,
    patterns: [{ re: /\bdisabilit(y|ies)\b/ }, { re: /\bdisabled\b/ }, { re: /\bhandicap\b/ }],
  },
  {
    category: "eeoOther",
    sensitive: true,
    patterns: [
      { re: /\bpronouns?\b/ },
      { re: /\bsexual orientation\b/ },
      { re: /\blgbtq?\b/ },
      { re: /\btransgender\b/ },
      { re: /\bdemographic\b/ },
      { re: /\bequal employment\b|\beeoc?\b/ },
      { re: /\bdiversity\b/, weight: 0.8 },
    ],
  },

  // --- Identity ---
  {
    category: "firstName",
    patterns: [
      { re: /\b(first|given) name\b/ },
      { re: /\bfirstname\b|\bfname\b|\bforename\b/ },
      { re: /\bpreferred name\b/, weight: 0.75 },
    ],
  },
  {
    category: "lastName",
    patterns: [
      { re: /\b(last|family) name\b/ },
      { re: /\blastname\b|\blname\b|\bsurname\b/ },
    ],
  },
  {
    category: "fullName",
    patterns: [
      { re: /\bfull name\b/ },
      { re: /\blegal name\b/ },
      { re: /^(your )?name$/ },
      { re: /\bcomplete name\b/ },
    ],
    negative: /\bfirst\b|\blast\b|\bgiven\b|\bfamily\b|\bmiddle\b|\buser ?name\b|\bcompany\b|\bemployer\b|\bschool\b|\bfile\b|\bcontact name\b/,
  },
  {
    category: "email",
    patterns: [{ re: /\be ?mail\b/ }],
  },
  {
    category: "phone",
    patterns: [
      { re: /\bphone\b/ },
      { re: /\bmobile\b|\bcell\b|\btelephone\b/ },
    ],
    negative: /\bphone type\b|\bext(ension)?\b|\bcountry code\b|\bdevice type\b/,
  },
  {
    category: "location",
    patterns: [
      { re: /\bcity\b|\btown\b/ },
      { re: /\blocation\b/ },
      { re: /\baddress\b/, weight: 0.85 },
      { re: /\bstate\b|\bprovince\b|\bregion\b/, weight: 0.7 },
      { re: /\bcountry\b/, weight: 0.75 },
      { re: /\bpostal\b|\bzip\b/, weight: 0.7 },
      { re: /\bwhere (are you|do you) (located|based|live)\b/ },
    ],
    negative: /\be ?mail\b|\bip address\b|\bweb ?site\b|\burl\b|\blinked ?in\b|\bgit ?hub\b/,
  },

  // --- Links ---
  {
    category: "linkedin",
    patterns: [{ re: /\blinked ?in\b/ }],
  },
  {
    category: "github",
    patterns: [{ re: /\bgit ?hub\b/ }],
  },
  {
    category: "portfolio",
    patterns: [
      { re: /\bportfolio\b/ },
      { re: /\bpersonal (web ?site|site|url|page)\b/ },
      { re: /\bweb ?site\b/, weight: 0.8 },
      { re: /\bother (url|link|web ?site)\b/, weight: 0.7 },
      { re: /\bblog\b/, weight: 0.6 },
    ],
    negative: /\blinked ?in\b|\bgit ?hub\b|\bcompany (web ?site|url)\b|\btwitter\b|\bfacebook\b/,
  },

  // --- Documents ---
  {
    category: "resumeUpload",
    patterns: [
      { re: /\bresume\b|\bresum\b/ }, // "résumé" loses accents in normalize()
      { re: /\bcv\b|\bcurriculum vitae\b/ },
    ],
    negative: /\bcover letter\b/,
  },
  {
    category: "coverLetter",
    patterns: [
      { re: /\bcover letter\b|\bcoverletter\b/ },
      { re: /\bletter of (motivation|interest)\b|\bmotivation letter\b/ },
      { re: /\bwhy (do you want|are you interested|would you like) /, weight: 0.6 },
    ],
  },

  // --- Screening ---
  {
    category: "sponsorship",
    patterns: [
      { re: /\bsponsorship\b/ },
      { re: /\bsponsor\b/, weight: 0.9 },
      { re: /\b(visa|immigration) (status|support)\b/, weight: 0.8 },
    ],
  },
  {
    category: "workAuthorization",
    patterns: [
      { re: /\bwork authori[sz]ation\b/ },
      { re: /\bauthori[sz]ed to work\b/ },
      { re: /\blegally (authori[sz]ed|eligible|entitled)\b/ },
      { re: /\beligible to work\b|\bright to work\b/ },
      { re: /\bwork permit\b/, weight: 0.85 },
    ],
    negative: /\bsponsor/,
  },

  // --- Education ---
  {
    category: "school",
    patterns: [
      { re: /\bschool\b|\buniversity\b|\bcollege\b/ },
      { re: /\binstitution\b|\balma mater\b/ },
    ],
    negative: /\bhigh school diploma\b/,
  },
  {
    category: "degree",
    patterns: [
      { re: /\bdegree\b/ },
      { re: /\b(highest )?(level of )?education( level)?\b/, weight: 0.75 },
      { re: /\bqualification\b/, weight: 0.7 },
      { re: /\bmajor\b|\bfield of study\b|\bdiscipline\b/, weight: 0.85 },
    ],
  },
  {
    category: "graduationYear",
    patterns: [
      { re: /\bgraduation (year|date)\b|\bgrad year\b/ },
      { re: /\b(year of|expected) graduation\b/ },
      { re: /\bcompletion (year|date)\b/, weight: 0.8 },
    ],
  },
  {
    category: "education",
    patterns: [{ re: /\beducation\b/, weight: 0.7 }],
    negative: /\blevel\b|\bhighest\b/,
  },

  // --- Work history ---
  {
    category: "currentCompany",
    patterns: [
      { re: /\bcurrent (company|employer)\b/ },
      { re: /\b(most recent|recent) (company|employer)\b/ },
      { re: /\bemployer\b/, weight: 0.85 },
      { re: /\bcompany( name)?\b/, weight: 0.7 },
      { re: /\borganization\b/, weight: 0.6 },
    ],
    negative: /\bprevious\b|\bformer\b|\bsponsor\b|\bschool\b|\breferr(al|er)\b/,
  },
  {
    category: "currentTitle",
    patterns: [
      { re: /\b(current |present )?(job )?title\b/, weight: 0.9 },
      { re: /\bcurrent (role|position)\b/ },
      { re: /\bposition\b/, weight: 0.6 },
    ],
    negative: /\bsalutation\b|\bmr\b|\bmrs\b|\bdegree\b|\bapply(ing)?\b|\bapplied\b|\bdesired\b|\binterested\b|\bsong\b/,
  },
  {
    category: "experience",
    patterns: [
      { re: /\byears? of (relevant |professional |work )?experience\b/, weight: 0.9 },
      { re: /\bwork experience\b|\bemployment history\b|\bwork history\b/ },
      { re: /\b(describe|tell us about) your (relevant )?experience\b/ },
      { re: /\bexperience\b/, weight: 0.5 },
    ],
    negative: /\bexperience level\b/,
  },
  {
    category: "salary",
    patterns: [
      { re: /\bsalary\b/ },
      { re: /\bcompensation\b/, weight: 0.9 },
      { re: /\b(desired|expected) (pay|salary|compensation|rate)\b/ },
      { re: /\bpay expectations?\b/ },
      { re: /\b(hourly|daily) rate\b/, weight: 0.8 },
    ],
    negative: /\bcurrent salary\b/,
  },
];

/**
 * HTML autocomplete tokens are the most reliable signal there is — the site
 * itself declared the semantic meaning of the field.
 */
const AUTOCOMPLETE_MAP: Record<string, FieldCategory> = {
  "given-name": "firstName",
  "additional-name": "unknown", // middle name — we have no data for it
  "family-name": "lastName",
  name: "fullName",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "address-level1": "location",
  "address-level2": "location",
  "street-address": "location",
  "address-line1": "location",
  "postal-code": "location",
  country: "location",
  "country-name": "location",
  organization: "currentCompany",
  "organization-title": "currentTitle",
};

/** Reliability of each signal source. */
const SOURCE_WEIGHTS: Array<{ key: keyof FieldSignals; weight: number }> = [
  { key: "label", weight: 0.95 },
  { key: "ariaLabel", weight: 0.92 },
  { key: "placeholder", weight: 0.82 },
  { key: "nameAttr", weight: 0.72 },
  { key: "idAttr", weight: 0.66 },
  { key: "nearby", weight: 0.6 },
];

export interface Classification {
  category: FieldCategory;
  confidence: number;
  sensitive: boolean;
}

export function classifyField(signals: FieldSignals): Classification {
  // Pre-normalize every text source once.
  const texts: Array<{ weight: number; text: string }> = [];
  for (const { key, weight } of SOURCE_WEIGHTS) {
    const raw = signals[key];
    if (raw) {
      const text = normalize(raw);
      if (text) texts.push({ weight, text });
    }
  }

  let best: Classification = { category: "unknown", confidence: 0, sensitive: false };

  for (const spec of CATEGORY_SPECS) {
    let max = 0;
    let matchedSources = 0;
    for (const { weight, text } of texts) {
      if (spec.negative?.test(text)) continue;
      let sourceBest = 0;
      for (const { re, weight: pw } of spec.patterns) {
        if (re.test(text)) sourceBest = Math.max(sourceBest, weight * (pw ?? 1));
      }
      if (sourceBest > 0) {
        matchedSources++;
        max = Math.max(max, sourceBest);
      }
    }

    // Native input type hints.
    if (signals.typeHint === "email" && spec.category === "email") max = Math.max(max, 0.9);
    if (signals.typeHint === "tel" && spec.category === "phone") max = Math.max(max, 0.9);
    if (signals.typeHint === "url" && spec.category === "portfolio") max = Math.max(max, 0.45);

    // The site's own autocomplete declaration is near-certain.
    const acCategory = AUTOCOMPLETE_MAP[signals.autocomplete];
    if (acCategory && acCategory === spec.category) max = Math.max(max, 0.98);

    if (max > 0) {
      // Small corroboration bonus when several independent signals agree.
      const score = Math.min(0.99, max + 0.04 * Math.max(0, matchedSources - 1));
      if (score > best.confidence) {
        best = { category: spec.category, confidence: score, sensitive: spec.sensitive ?? false };
      }
    }
  }

  if (best.confidence < MIN_CATEGORY_CONFIDENCE) {
    return { category: "unknown", confidence: best.confidence, sensitive: false };
  }
  return { ...best, confidence: Math.round(best.confidence * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Profile value resolution
// ---------------------------------------------------------------------------

function hasYesNoOptions(options: string[] | undefined): boolean {
  if (!options || options.length === 0) return false;
  const norm = options.map((o) => normalize(o));
  return norm.some((o) => o.startsWith("yes")) && norm.some((o) => o.startsWith("no"));
}

/** A control answered with a Yes/No choice: explicit Yes/No options, or a
 *  custom dropdown whose options we can't read at scan time. */
function isYesNoChoice(control: { controlType: ControlType; options?: string[] }): boolean {
  return hasYesNoOptions(control.options) || control.controlType === "combobox";
}

/** "Authorized to work in Canada" → Yes; "Not authorized" / "No" → No. */
function toYesNo(statement: string): string {
  return /^\s*(no\b|not\b|none\b)/i.test(statement) ? "No" : "Yes";
}

function formatExperience(profile: UserApplicationProfile): string | null {
  if (profile.experience.length === 0) return null;
  return profile.experience
    .map((e) => {
      const dates = [e.startDate, e.endDate].filter(Boolean).join(" to ");
      const header = [e.title, e.company].filter(Boolean).join(" — ");
      return [`${header}${dates ? ` (${dates})` : ""}`, e.description].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function formatEducation(profile: UserApplicationProfile): string | null {
  const ed = profile.education[0];
  if (!ed) return null;
  const parts = [ed.degree, ed.school].filter(Boolean).join(", ");
  return parts ? `${parts}${ed.graduationYear ? ` (${ed.graduationYear})` : ""}` : null;
}

export const LONG_TEXT: ControlType[] = ["textarea", "contenteditable"];

/**
 * Map a classified field to the profile value it should receive.
 * Returns null when the profile has no usable data (the field then shows up
 * in the review panel instead of being silently skipped).
 */
export function resolveProfileValue(
  category: FieldCategory,
  profile: UserApplicationProfile,
  control: { controlType: ControlType; options?: string[] },
  fillEEO: boolean
): string | null {
  const orNull = (v: string | undefined): string | null => (v && v.trim() ? v : null);

  switch (category) {
    case "firstName":
      return orNull(profile.firstName);
    case "lastName":
      return orNull(profile.lastName);
    case "fullName":
      return orNull([profile.firstName, profile.lastName].filter(Boolean).join(" "));
    case "email":
      return orNull(profile.email);
    case "phone":
      return orNull(profile.phone);
    case "location":
      return orNull(profile.location);
    case "linkedin":
      return orNull(profile.linkedin);
    case "github":
      return orNull(profile.github);
    case "portfolio":
      return orNull(profile.portfolio);
    case "currentCompany":
      return orNull(profile.currentCompany);
    case "currentTitle":
      return orNull(profile.currentTitle);
    case "salary":
      return orNull(profile.salaryExpectation);
    case "school":
      return orNull(profile.education[0]?.school);
    case "degree":
      return orNull(profile.education[0]?.degree);
    case "graduationYear":
      return orNull(profile.education[0]?.graduationYear);
    case "education":
      return formatEducation(profile);

    case "workAuthorization": {
      const v = orNull(profile.workAuthorization);
      if (!v) return null;
      // Yes/No controls get a Yes/No answer; free-text gets the statement. A
      // custom dropdown's options aren't known at scan time, but these screeners
      // are virtually always Yes/No — so a combobox is treated as a choice.
      return isYesNoChoice(control) ? toYesNo(v) : v;
    }
    case "sponsorship": {
      const v = orNull(profile.requiresSponsorship);
      if (!v) return null;
      return isYesNoChoice(control) ? toYesNo(v) : v;
    }

    case "coverLetter":
      // Only into long-text controls; a cover-letter *file* input can't be filled.
      return LONG_TEXT.includes(control.controlType) ? orNull(profile.coverLetter) : null;
    case "experience":
      // Free-form summaries only — a "years of experience" number we don't have.
      return LONG_TEXT.includes(control.controlType) ? formatExperience(profile) : null;

    case "resumeUpload":
      return null; // browsers do not allow scripted file selection

    // EEO: only resolved when the user explicitly enabled it AND the profile
    // actually contains the answer.
    case "eeoGender":
      return fillEEO ? orNull(profile.eeo?.gender) : null;
    case "eeoRace":
      return fillEEO ? orNull(profile.eeo?.race) : null;
    case "eeoHispanic":
      return fillEEO ? orNull(profile.eeo?.hispanicLatino) : null;
    case "eeoVeteran":
      return fillEEO ? orNull(profile.eeo?.veteranStatus) : null;
    case "eeoDisability":
      return fillEEO ? orNull(profile.eeo?.disabilityStatus) : null;
    case "eeoOther":
      return null;

    case "unknown":
      return null;
  }
}
