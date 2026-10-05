/**
 * Choosing a SCHOOL from a list, by the words that name it.
 */
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
export function snapSchool(options: string[], value: string): string | null {
  // The same text twice is one school (Lever's list carries "University of
  // Waterloo" under two values).
  // A state after the name is still the name: "University of Washington (WA)"
  // is the school, where "Washington College (MD)" shares its own words
  // (SharkNinja's list, question bank 2026-10-05).
  const bare = (s: string): string => s.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  const exact = options.filter((o) => bare(o) === bare(value));
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
