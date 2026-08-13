/**
 * Greenhouse (`*.greenhouse.io`). Greenhouse forms are well-labeled, so the
 * generic pipeline handles most fields; this adapter reinforces the few quirks:
 * custom social-URL questions (name="...urls[LinkedIn]...") whose visible label
 * is often just the network name, exact EEO option casing, and the SPLIT
 * employment dates below.
 */
import type { FieldCategory } from "../../shared/types";
import { ADAPTERS } from "./registry";
import type { AnswerContext, SiteAdapter } from "./types";

const NAME_RULES: Array<[RegExp, FieldCategory]> = [
  [/urls\[linked ?in\]|linked ?in_url/i, "linkedin"],
  [/urls\[git ?hub\]|git ?hub_url/i, "github"],
  [/urls\[(website|portfolio|other)\]/i, "portfolio"],
];

/** Greenhouse's month list spells the month out ("June"), never "06". */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m.slice(0, 3).toLowerCase(), i]));

/**
 * One stored experience date split into the two controls Greenhouse actually
 * renders. It does NOT have a date picker: "Start date" is a month COMBOBOX
 * spelling the month out, plus a separate free-text YEAR input
 * (`start-date-month-0` / `start-date-year-0`). Handing either of them the
 * stored "2023-06" fills nothing, which is exactly what happened on the real
 * Lyft form (autofill_reports #167, 2026-08-12).
 *
 * Accepts the canonical "YYYY-MM" the profile stores, plus the shapes a
 * hand-typed résumé produces. Returns null for anything it cannot read with
 * certainty (including "Present"), so an unparsable date fills nothing rather
 * than committing a wrong month.
 */
export function splitGreenhouseDate(value: string): { month: string; year: string } | null {
  const v = (value || "").trim();
  if (!v) return null;

  // "2023-06" / "2023-06-01" / "2023/06"
  const iso = v.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/);
  if (iso) {
    const m = Number(iso[2]);
    if (m < 1 || m > 12) return null;
    return { month: MONTHS[m - 1], year: iso[1] };
  }

  // "06/2023" / "6-2023"
  const numericFirst = v.match(/^(\d{1,2})[-/](\d{4})$/);
  if (numericFirst) {
    const m = Number(numericFirst[1]);
    if (m < 1 || m > 12) return null;
    return { month: MONTHS[m - 1], year: numericFirst[2] };
  }

  // "June 2023" / "Jun 2023" / "June, 2023"
  const named = v.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (named) {
    const idx = MONTH_INDEX.get(named[1].slice(0, 3).toLowerCase());
    if (idx === undefined) return null;
    return { month: MONTHS[idx], year: named[2] };
  }

  // A bare year answers the year control and abstains on the month.
  const bare = v.match(/^(\d{4})$/);
  if (bare) return { month: "", year: bare[1] };

  return null;
}

/** Which half of a split date this control is, from its id/name/aria-label. */
function datePartOf(el: HTMLElement): "month" | "year" | null {
  const key = [el.id, el.getAttribute("name"), el.getAttribute("aria-label")]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\bmonth\b|-month-|_month_/.test(key)) return "month";
  if (/\byear\b|-year-|_year_/.test(key)) return "year";
  return null;
}

/** The stored date for this row, or "" when the row/date is absent. */
function rowDate(ctx: AnswerContext): string {
  const row = ctx.profile.experience?.[ctx.control.groupIndex ?? 0];
  if (!row) return "";
  return (ctx.category === "experienceStartDate" ? row.startDate : row.endDate) || "";
}

export const greenhouseAdapter: SiteAdapter = {
  id: "greenhouse",
  label: "Greenhouse",
  match: (host) => /(^|\.)greenhouse\.io$/i.test(host),

  classify(ctx) {
    const name = ctx.el.getAttribute("name") || ctx.el.id || "";
    for (const [re, category] of NAME_RULES) {
      if (re.test(name)) return { category, confidence: 0.95, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Split employment dates: month name into the month combobox, bare year
    // into the year input. Claims the field either way (null = fill nothing),
    // because the generic "2023-06" is wrong for BOTH controls.
    if (ctx.category === "experienceStartDate" || ctx.category === "experienceEndDate") {
      const part = datePartOf(ctx.el);
      if (!part) return undefined; // a single combined date input: generic wins
      const parts = splitGreenhouseDate(rowDate(ctx));
      // A current role has no end date, and an unreadable one is not guessed:
      // leave the control blank rather than commit a month nobody stated.
      return parts ? parts[part] || null : null;
    }

    // Greenhouse EEO gender options are exact-cased ("Male"/"Female"/"Decline To
    // Self Identify"); map common profile values to a real option.
    if (ctx.category === "eeoGender") {
      if (!ctx.fillEEO) return undefined;
      const g = (ctx.profile.eeo?.gender || "").toLowerCase();
      if (!g) return undefined;
      if (g.startsWith("m")) return "Male";
      if (g.startsWith("f") || g.startsWith("w")) return "Female";
      return "Decline To Self Identify";
    }
    return undefined;
  },
};

ADAPTERS.push(greenhouseAdapter);
