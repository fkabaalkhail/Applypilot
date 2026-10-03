/**
 * Choosing a PLACE from a list of place suggestions ("Toronto, ON, CAN",
 * "Toronto, Ontario, Canada", "Toronto, OH, US", "Toronto, New South Wales,
 * Australia"), compared as places: city, then province/state (by code or
 * name), then country (by name, alias, ISO-2 or ISO-3).
 *
 * Word or token matching is wrong here in both directions: "Canada" never
 * matches the ISO-3 "CAN", and token overlap drops short tokens, which made
 * "Toronto, OH, US" look like a PERFECT match for "Toronto, ON, Canada" (its
 * only long token is "toronto"). Exactly one suggestion must agree with every
 * part the wanted place states, or none is chosen.
 */
import { countryByCode, countryFromName, regionFromText } from "./geo";

const norm = (s: string): string =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export interface Place {
  city: string;
  region: string | null;
  country: string | null;
}

/** City, province/state and country of "Toronto, ON, CAN" / "Toronto, Ontario, Canada". */
export function placeOf(text: string): Place {
  const parts = (text || "").split(",").map((p) => p.trim()).filter(Boolean);
  let region: string | null = null;
  let country: string | null = null;
  for (const p of parts.slice(1)) {
    const two = p.length === 2 && /^(us|ca|uk)$/i.test(p) ? countryByCode(p.toUpperCase() === "UK" ? "GB" : p) : null;
    const c = countryFromName(p) ?? two;
    if (c && !country) {
      country = c.code;
      continue;
    }
    const r = regionFromText(p);
    if (r && !region) {
      region = `${r.country}:${r.code}`;
      if (!country) country = r.country;
    }
  }
  return { city: norm(parts[0] ?? ""), region, country };
}

/** True when a list reads as place suggestions ("City, Region[, Country]"). */
export function looksLikePlaces(options: string[]): boolean {
  const withComma = options.filter((o) => /^[^,]{2,60},\s*\S/.test(o.trim()));
  return withComma.length >= Math.max(1, Math.ceil(options.length / 2));
}

/** Index of the one suggestion that is `wanted`, or -1. */
export function pickPlaceOption(suggestions: string[], wanted: string): number {
  const want = placeOf(wanted);
  if (!want.city) return -1;
  const hits = suggestions
    .map((s, i) => ({ i, place: placeOf(s) }))
    .filter(
      ({ place }) =>
        place.city === want.city &&
        (!want.region || !place.region || place.region === want.region) &&
        (!want.country || !place.country || place.country === want.country)
    );
  if (hits.length === 1) return hits[0].i;
  // Still several: keep the ones that STATE the region/country the wanted
  // place states (a suggestion silent on the country is weaker than one that
  // agrees).
  const explicit = hits.filter(
    ({ place }) => (!want.region || place.region === want.region) && (!want.country || place.country === want.country)
  );
  return explicit.length === 1 ? explicit[0].i : -1;
}
