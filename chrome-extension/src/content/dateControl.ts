/**
 * Date controls take a WHOLE value in ONE format. A date picker re-parses
 * whatever is typed into it: Ashby's react-datepicker turned a graduation year
 * "2027" into 12/31/2026 (`new Date("2027")` is UTC midnight, the previous
 * evening in Toronto; live 2026-10-03), and an ISO date typed into an
 * MM/DD/YYYY picker lands a day early the same way. A native date input simply
 * rejects a partial value.
 *
 * So a control recognised as a date control gets a format, and a value is
 * written to it only when it carries every part that format needs, re-emitted
 * in exactly that format. Otherwise the field stays blank: the profile does
 * not know the day, and a picker must not be left to invent one.
 */

export type DateFormat = "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM" | "MM/YYYY";

/** Datepicker widgets, by the class names their libraries give the input or
 *  its wrapper (react-datepicker, flatpickr, jQuery UI, bootstrap, MUI X). */
const PICKER_CLASS =
  /(^|\s)(react-datepicker__input-container|react-datepicker-wrapper|flatpickr-input|hasDatepicker|datepicker|date-picker|ashby-application-form-input-date|MuiPickersInputBase-root|MuiPickersTextField-root)(\s|$)/i;

/** The format a control displays, or null when it is not a date control. */
export function dateFormatFor(
  el: HTMLElement | null,
  inputType: string | undefined,
  placeholder: string | undefined
): DateFormat | null {
  const t = (inputType || "").toLowerCase();
  if (t === "date") return "YYYY-MM-DD";
  if (t === "month") return "YYYY-MM";
  const ph = (placeholder || "").toLowerCase().replace(/\s+/g, "");
  if (/dd[./-]mm[./-]y{2,4}/.test(ph)) return "DD/MM/YYYY";
  if (/mm[./-]dd[./-]y{2,4}/.test(ph)) return "MM/DD/YYYY";
  if (/y{4}[./-]mm[./-]dd/.test(ph)) return "YYYY-MM-DD";
  if (/^mm[./-]y{2,4}$/.test(ph)) return "MM/YYYY";
  if (/^y{4}[./-]mm$/.test(ph)) return "YYYY-MM";
  let picker = /^(pick|select|choose|enter)(a)?date/.test(ph);
  for (let a: HTMLElement | null = el, i = 0; !picker && a && i < 3; a = a.parentElement, i++) {
    const cls = typeof a.className === "string" ? a.className : "";
    picker = PICKER_CLASS.test(cls) || a.getAttribute("data-provide") === "datepicker";
  }
  // A picker that does not state its format: react-datepicker's (and most
  // US-built pickers') default display.
  return picker ? "MM/DD/YYYY" : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const monthNum = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

interface DateParts {
  y: number;
  m?: number;
  d?: number;
}

function validParts(p: DateParts): boolean {
  if (p.y < 1900 || p.y > 2100) return false;
  if (p.m !== undefined && (p.m < 1 || p.m > 12)) return false;
  if (p.d !== undefined) {
    if (p.m === undefined || p.d < 1) return false;
    const days = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
    if (p.d > days) return false;
  }
  return true;
}

/** Year / month / day of a written date, or null when it is not one.
 *  `slashOrder` reads an ambiguous "05/06/2027" in the control's own order. */
function parseDate(value: string, slashOrder: "MD" | "DM"): DateParts | null {
  const v = value.trim();
  let m: RegExpExecArray | null;
  let p: DateParts | null = null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v))) p = { y: +m[1], m: +m[2], d: +m[3] };
  else if ((m = /^(\d{4})-(\d{1,2})$/.exec(v))) p = { y: +m[1], m: +m[2] };
  else if ((m = /^(\d{4})$/.exec(v))) p = { y: +m[1] };
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v)))
    p = slashOrder === "MD" ? { y: +m[3], m: +m[1], d: +m[2] } : { y: +m[3], m: +m[2], d: +m[1] };
  else if ((m = /^(\d{1,2})[/.-](\d{4})$/.exec(v))) p = { y: +m[2], m: +m[1] };
  else if ((m = new RegExp(`^${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i").exec(v))) p = { y: +m[3], m: monthNum(m[1]), d: +m[2] };
  else if ((m = new RegExp(`^(\\d{1,2})\\s+${MONTH_RE},?\\s+(\\d{4})$`, "i").exec(v))) p = { y: +m[3], m: monthNum(m[2]), d: +m[1] };
  else if ((m = new RegExp(`^${MONTH_RE},?\\s+(\\d{4})$`, "i").exec(v))) p = { y: +m[2], m: monthNum(m[1]) };
  return p && validParts(p) ? p : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * `value` as `format` shows it, or null when the value is not a date or lacks
 * a part the format needs (a bare year for a day-precise picker).
 */
export function fitDate(value: string, format: DateFormat): string | null {
  const p = parseDate(value, format === "DD/MM/YYYY" ? "DM" : "MD");
  if (!p) return null;
  const needsDay = format.includes("DD");
  if (p.m === undefined || (needsDay && p.d === undefined)) return null;
  switch (format) {
    case "YYYY-MM-DD":
      return `${p.y}-${pad(p.m)}-${pad(p.d!)}`;
    case "MM/DD/YYYY":
      return `${pad(p.m)}/${pad(p.d!)}/${p.y}`;
    case "DD/MM/YYYY":
      return `${pad(p.d!)}/${pad(p.m)}/${p.y}`;
    case "YYYY-MM":
      return `${p.y}-${pad(p.m)}`;
    case "MM/YYYY":
      return `${pad(p.m)}/${p.y}`;
  }
}
