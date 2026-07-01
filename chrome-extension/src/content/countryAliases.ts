/**
 * Country-name aliases → the canonical label ATS dropdowns actually list.
 *
 * Users write "USA" / "US" / "U.S.A." / "UK"; the option is "United States" /
 * "United Kingdom". Without this bridge a country dropdown only fills when the
 * profile location literally contains the option label — the long-standing
 * Workday country literal-match bug. Shared by comboboxEngine's search-query
 * generator (so the option gets rendered by the widget's own search) AND by
 * writeEngine's matchOption (so the rendered option is actually matched, which
 * also covers native <select> country fields).
 *
 * Keys are pre-normalized with normalize(): "U.S.A." → "u s a", "USA" → "usa".
 * Conservative on purpose — only unambiguous aliases (no England→UK, which some
 * forms list separately).
 */
import { normalize } from "./fieldMatcher";

const COUNTRY_ALIASES: Record<string, string> = {
  // United States
  usa: "United States",
  us: "United States",
  "u s a": "United States",
  "u s": "United States",
  "united states of america": "United States",
  america: "United States",
  // United Kingdom
  uk: "United Kingdom",
  "u k": "United Kingdom",
  "great britain": "United Kingdom",
  britain: "United Kingdom",
  // United Arab Emirates
  uae: "United Arab Emirates",
  "u a e": "United Arab Emirates",
  // Others commonly abbreviated on forms
  drc: "Democratic Republic of the Congo",
  "south korea": "Korea, Republic of",
  "north korea": "Korea, Democratic People's Republic of",
};

/** The canonical country label for an alias, or null if `text` isn't an alias. */
export function countryAlias(text: string): string | null {
  return COUNTRY_ALIASES[normalize(text)] ?? null;
}
