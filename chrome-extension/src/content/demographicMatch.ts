/**
 * On-device closest-option matcher for EEO / demographic dropdowns. Given the
 * user's profile value and the widget's REAL options, returns the nearest
 * available option — so "Arab" fills a US-Census race dropdown as "White" or a
 * MENA option when offered. Never sent to any server; demographic answers stay
 * on the device by policy.
 */
import type { FieldCategory } from "../shared/types";

const DECLINE_PATTERNS = ["prefer not", "decline", "do not wish", "not to disclose", "not disclosed", "choose not"];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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

function tableFor(category: FieldCategory): Record<string, string[]> | null {
  switch (category) {
    case "eeoRace":
    case "eeoHispanic":
      return RACE;
    case "eeoGender":
      return GENDER;
    case "eeoVeteran":
      return VETERAN;
    case "eeoDisability":
      return DISABILITY;
    default:
      return null;
  }
}

export function closestDemographicOption(
  category: FieldCategory,
  value: string,
  options: string[]
): string | null {
  const opts = options.map((o) => ({ raw: o, n: norm(o) })).filter((o) => o.n.length > 0);
  const v = norm(value);
  if (opts.length === 0 || !v) return null;

  // 1. Direct containment either direction.
  const direct = opts.find((o) => o.n === v || o.n.includes(v) || v.includes(o.n));
  if (direct) return direct.raw;

  // 2. Synonym / nearest-neighbour candidates, in priority order.
  for (const cand of tableFor(category)?.[v] ?? []) {
    const hit = opts.find((o) => o.n.includes(cand));
    if (hit) return hit.raw;
  }

  // 3. Decline / prefer-not-to-say fallback.
  const decline = opts.find((o) => DECLINE_PATTERNS.some((d) => o.n.includes(d)));
  return decline ? decline.raw : null;
}
