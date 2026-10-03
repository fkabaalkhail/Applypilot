/**
 * On-device closest-option matcher for EEO / demographic dropdowns. Given the
 * user's profile value and the widget's REAL options, returns the nearest
 * available option, so "Arab" fills a US-Census race dropdown as "White" or a
 * MENA option when offered. Never sent to any server; demographic answers stay
 * on the device by policy.
 */
import type { FieldCategory } from "../shared/types";

const DECLINE_PATTERNS = [
  "prefer not",
  "decline",
  "do not wish",
  "wish to answer", // catches "I don't wish to answer" (apostrophe → space on normalize)
  "not to disclose",
  "not disclosed",
  "choose not",
  "rather not",
];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** `needle` appears in `hay` as whole words. Substrings read "male" inside
 *  "female" and "man" inside "woman" (2026-10-03). */
const hasWords = (hay: string, needle: string): boolean => ` ${hay} `.includes(` ${needle} `);

/** Priority-ordered option substrings for a normalized profile value. */
const RACE: Record<string, string[]> = {
  "arab": ["middle eastern", "north african", "mena", "white"],
  "middle eastern": ["middle eastern", "north african", "mena", "white"],
  "north african": ["north african", "middle eastern", "mena", "white"],
  "persian": ["middle eastern", "mena", "white", "asian"],
  "hispanic": ["hispanic", "latino", "latinx"],
  "latino": ["hispanic", "latino", "latinx"],
  "south asian": ["asian", "south asian"],
  "east asian": ["asian", "east asian"],
  "desi": ["asian", "south asian"],
  "caucasian": ["white", "caucasian"],
  "black": ["black", "african american", "african"],
  "african american": ["black", "african american", "african"],
  "indigenous": ["native", "indigenous", "aboriginal", "first nations"],
  "native american": ["native", "indigenous", "american indian"],
  "mixed": ["two or more", "multiracial", "mixed"],
  "biracial": ["two or more", "multiracial", "mixed"],
};

const GENDER: Record<string, string[]> = {
  "man": ["male", "man"],
  "male": ["male", "man"],
  "woman": ["female", "woman"],
  "female": ["female", "woman"],
  "non binary": ["non binary", "nonbinary", "genderqueer"],
};

const VETERAN: Record<string, string[]> = {
  "no": ["not a protected veteran", "not a veteran", "no"],
  "not a veteran": ["not a protected veteran", "not a veteran", "no"],
  "yes": ["identify as one or more", "protected veteran", "yes"],
  "protected veteran": ["identify as one or more", "protected veteran", "yes"],
  "veteran": ["protected veteran", "veteran", "yes"],
};

const DISABILITY: Record<string, string[]> = {
  "no": ["no i do not", "do not have", "no"],
  "yes": ["yes i have", "have a disability", "yes"],
};

const ORIENTATION: Record<string, string[]> = {
  "straight": ["heterosexual", "straight"],
  "heterosexual": ["heterosexual", "straight"],
  "gay": ["gay", "lesbian", "homosexual"],
  "lesbian": ["lesbian", "gay", "homosexual"],
  "homosexual": ["gay", "lesbian", "homosexual"],
  "bisexual": ["bisexual", "bi"],
  "queer": ["queer", "lgbtq"],
  "asexual": ["asexual"],
  "pansexual": ["pansexual", "bisexual"],
};

function tableFor(category: FieldCategory): Record<string, string[]> | null {
  switch (category) {
    case "eeoRace":
    case "eeoHispanic":
      return RACE;
    case "eeoGender":
    case "eeoGenderIdentity":
      return GENDER;
    case "eeoVeteran":
      return VETERAN;
    case "eeoDisability":
      return DISABILITY;
    case "eeoSexualOrientation":
      return ORIENTATION;
    default:
      return null;
  }
}

/** The option that declines to answer ("I don't wish to answer", "Decline To
 *  Self Identify"), when the list has exactly one. */
export function declineOption(options: string[]): string | null {
  const hits = options.filter((o) => DECLINE_PATTERNS.some((d) => norm(o).includes(d)));
  return hits.length === 1 ? hits[0] : null;
}

export function closestDemographicOption(
  category: FieldCategory,
  value: string,
  options: string[]
): string | null {
  const opts = options.map((o) => ({ raw: o, n: norm(o) })).filter((o) => o.n.length > 0);
  const v = norm(value);
  if (opts.length === 0 || !v) return null;

  // 1. The answer itself, then the one option holding it ("Asian" in "Asian
  //    (Not Hispanic or Latino)"), then the longest option it holds ("No" in
  //    "No, I do not have a disability"). Several options holding it are each
  //    NARROWER than the answer: "Asian" names none of East, South and
  //    Southeast Asian, and the first listed won (a real profile on Robinhood,
  //    2026-10-03). Ambiguity is no answer, and no decline either: the user
  //    gave one, so the field is left for them to pick.
  const exact = opts.find((o) => o.n === v);
  if (exact) return exact.raw;
  const holding = opts.filter((o) => hasWords(o.n, v));
  if (holding.length > 0) return holding.length === 1 ? holding[0].raw : null;
  const inside = opts.filter((o) => hasWords(v, o.n));
  if (inside.length > 0) {
    const longest = Math.max(...inside.map((o) => o.n.length));
    const best = inside.filter((o) => o.n.length === longest);
    return best.length === 1 ? best[0].raw : null;
  }

  // 2. Synonym / nearest-neighbour candidates, in priority order: the option
  //    that IS the candidate, else the one option holding it. "man" is held by
  //    "Cisgender man" and "Transgender man" alike: no answer.
  for (const cand of tableFor(category)?.[v] ?? []) {
    const same = opts.find((o) => o.n === cand);
    if (same) return same.raw;
    const hits = opts.filter((o) => hasWords(o.n, cand));
    if (hits.length > 0) return hits.length === 1 ? hits[0].raw : null;
  }

  // 3. Decline / prefer-not-to-say fallback.
  const decline = opts.find((o) => DECLINE_PATTERNS.some((d) => o.n.includes(d)));
  return decline ? decline.raw : null;
}
