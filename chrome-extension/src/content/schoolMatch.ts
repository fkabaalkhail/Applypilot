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

/** Some option is the school, perhaps one campus of several ("University of
 *  Washington - Seattle" | "- Bothell" | "- Tacoma"): never "not listed". */
export function schoolOffered(options: string[], value: string): boolean {
  const want = schoolWords(value);
  if (want.size === 0) return false;
  const kinds = schoolKind(value);
  return options.some((o) => {
    const has = schoolWords(o);
    const k = schoolKind(o);
    const kindOk = kinds.types.size === 0 || k.types.size === 0 || (k.of === kinds.of && k.types.size === kinds.types.size && [...k.types].every((t) => kinds.types.has(t)));
    return has.size > 0 && [...want].every((w) => has.has(w)) && kindOk;
  });
}

/** Which kinds of school a name says it is, and whether as "<kind> of …". */
function schoolKind(s: string): { types: Set<string>; of: boolean } {
  const t = (s || "").toLowerCase().replace(/\([^)]*\)/g, " ");
  const types = new Set((t.match(/\b(university|college|school|institute|academy)\b/g) ?? []) as string[]);
  return { types, of: /\b(university|college|school|institute|academy) of\b/.test(t) };
}

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
  // The kind of school is part of its name: "University of Washington" is not
  // "Washington College", which shares its one own word (Palantir on Lever,
  // question bank 2026-10-08). A list naming schools without their kind
  // ("Stanford") is still read by its words.
  const kinds = schoolKind(value);
  const sameKind = (o: string): boolean => {
    const k = schoolKind(o);
    return kinds.types.size === 0 || k.types.size === 0 || (k.of === kinds.of && k.types.size === kinds.types.size && [...k.types].every((t) => kinds.types.has(t)));
  };
  // An option holding every word of the name ("Imperial College London - ICL")
  // beats one whose few words are inside it ("University of London" is only
  // {london}): both fitting, Imperial was "not listed" (Palantir on Lever,
  // regression 2026-10-05). The looser fit is only for a name longer than
  // the option ("University of Waterloo, Ontario").
  const holding = options.filter((o) => {
    const has = schoolWords(o);
    return has.size > 0 && [...want].every((w) => has.has(w)) && sameKind(o);
  });
  const fits = holding.length > 0
    ? holding
    : options.filter((o) => {
        const has = schoolWords(o);
        return has.size > 0 && [...has].every((w) => want.has(w)) && sameKind(o);
      });
  if (fits.length === 1) return fits[0];
  const same = fits.filter((o) => {
    const has = schoolWords(o);
    return has.size === want.size && [...want].every((w) => has.has(w));
  });
  return same.length > 0 && same.every((o) => o.trim() === same[0].trim()) ? same[0] : null;
}
