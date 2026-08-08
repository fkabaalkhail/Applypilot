// chrome-extension/src/content/adapters/workdaySelectors.ts
/**
 * THE single source of truth for every Workday `data-automation-id` the
 * extension depends on.
 *
 * Workday's visible labels are generic and its CSS classes are hashed per
 * tenant, but `data-automation-id` is stable across tenants and releases — it is
 * the only selector surface worth targeting. When a tenant renames one, this is
 * the ONLY file that should need editing: everything here is data, no logic.
 *
 * Deliberately a dependency-free leaf module (types only). It must never import
 * `./registry` — `adapters/workday.ts` registers itself on import, and modules
 * like comboboxEngine/accountFlow pull selectors from here without wanting that
 * side effect.
 */
import type { FieldCategory } from "../../shared/types";

/** Workday tenant hosts (`acme.wd5.myworkdayjobs.com`, `*.myworkdaysite.com`, …). */
export const WD_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

// ---------------------------------------------------------------------------
// Field classification — automation-id → category
// ---------------------------------------------------------------------------

/**
 * Matched IN ORDER against a control's own automation-id, first hit wins.
 * ORDER IS LOAD-BEARING: the narrow phone widgets must precede the broad
 * `country` / `phone` rules, or `countryPhoneCode` reads as the country field
 * and `phoneType` as the phone-number field.
 */
export const FIELD_RULES: ReadonlyArray<readonly [RegExp, FieldCategory]> = [
  // -- narrow phone widgets (must stay above `country` / `phone`) ------------
  [/countryphonecode|phonecode|dialcode/i, "phoneCountryCode"],
  [/phonetype|phonedevicetype|devicetype/i, "phoneDeviceType"],
  // -- identity --------------------------------------------------------------
  [/firstname|givenname/i, "firstName"],
  [/lastname|familyname/i, "lastName"],
  [/email/i, "email"],
  [/phone.*number|^phone/i, "phone"],
  [/country|region/i, "country"],
  [/(address)?.*city/i, "addressCity"],
  // -- work-experience rows (`formField-jobTitle` / `formField-companyName`) --
  // Plain "Company"/"Job Title" aren't caught by the generic matcher, so the
  // whole repeating section went unfilled on Workday without these.
  [/job.?title|jobtitle/i, "currentTitle"],
  [/company.?name|companyname|employer/i, "currentCompany"],
];

/** Section automation-ids (on an ANCESTOR, not the input) marking file uploads. */
export const RESUME_SECTION_RE = /resume|curriculum.?vitae/i;
export const COVER_LETTER_SECTION_RE = /cover.?letter/i;

/** Ancestor automation-id marking the segmented month/day/year date widget. */
export const DATE_CONTAINER_RE = /date/i;
/** Automation-id fragments of the three spinbutton inputs inside that widget. */
export const DATE_PART_FRAGMENTS = { month: "month", day: "day", year: "year" } as const;

/** Any one of the widget's part inputs. */
export const DATE_PART_SELECTOR =
  'input[data-automation-id*="dateSection" i], input[role="spinbutton"]';

/**
 * The date WIDGET a part input belongs to — never the part itself, and never a
 * widget the element merely sits NEXT TO.
 *
 * `Element.closest()` matches the element it is called on, and a part's own
 * automation-id ("dateSectionYear-input") satisfies DATE_CONTAINER_RE, so
 * `el.closest("[data-automation-id]")` returned the INPUT and every
 * `container.querySelector("input[...]")` searched an empty subtree.
 *
 * Resolution is deliberately narrow, because DATE_CONTAINER_RE also matches
 * "candi-DATE-EducationSection", and such a section can hold a plain
 * "Graduation Year" input alongside a real date widget:
 *
 *   - a PART resolves to its nearest date-ish ancestor holding a SECOND part.
 *     A wrapper holding only `el` ("dateSectionYear-display") wraps the part,
 *     not the widget — climbing stops there and month/day never get written.
 *     A genuinely single-part widget falls back to that innermost wrapper.
 *   - anything else resolves only to ITSELF, so an input standing beside a date
 *     widget can never claim it.
 */
export function dateContainerOf(el: HTMLElement): HTMLElement | null {
  const partCount = (node: HTMLElement): number => node.querySelectorAll(DATE_PART_SELECTOR).length;
  const dateish = (node: HTMLElement): boolean =>
    DATE_CONTAINER_RE.test(node.getAttribute("data-automation-id") || "");

  // Not a part: only a wrapper handed to us directly can be the widget.
  if (!el.matches(DATE_PART_SELECTOR)) return dateish(el) && partCount(el) > 0 ? el : null;

  let onlyWrapper: HTMLElement | null = null;
  let node: HTMLElement | null = el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    if (!dateish(node)) continue;
    const count = partCount(node);
    if (count > 1) return node;
    if (count === 1 && !onlyWrapper) onlyWrapper = node;
  }
  return onlyWrapper;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * The step footer's Next / Save-and-Continue button. Two footer generations
 * ship in the wild: `bottom-navigation-*` (current) and `pageFooter*` (older
 * tenants). NB Workday reuses these ids for the FINAL submit too — callers must
 * still apply the terminal-text check before clicking.
 */
export const ADVANCE_BUTTON_SELECTOR =
  '[data-automation-id="bottom-navigation-next-button"], button[data-automation-id="pageFooterNextButton"]';

/**
 * Entry into the application from a job posting: the posting's Apply button
 * (`adventureButton`) or the resume-a-draft button (`continueButton`). The
 * apply-method chooser that follows (Autofill with Resume / Apply Manually /
 * Use My Last Application) carries NO stable automation-ids — applyEntry.ts
 * picks "Apply Manually" from anchored button text instead.
 */
export const ENTRY_BUTTON_SELECTOR =
  '[data-automation-id="adventureButton"], [data-automation-id="continueButton"]';

// ---------------------------------------------------------------------------
// Account wall (create account / sign in)
// ---------------------------------------------------------------------------

/** Link that switches Workday's sign-in card into create-account mode. */
export const CREATE_ACCOUNT_LINK_SELECTOR = '[data-automation-id="createAccountLink"]';

/** Automation-ids that mark the form as a create-account (signup) form. */
export const SIGNUP_MARKER_RE = /createaccount|verifypassword|verifynewpassword|confirmpassword/i;

/**
 * Workday's create-account consent checkbox. It is a native checkbox rendered
 * visually hidden behind a styled control, with no `required` attribute and no
 * agreement-worded label — nothing but this automation-id identifies it.
 */
export const CONSENT_MARKER_RE = /createaccountcheckbox/i;

// ---------------------------------------------------------------------------
// Custom widgets
// ---------------------------------------------------------------------------

/** Opener inside a Workday prompt (button-style dropdown). */
export const PROMPT_BUTTON_SELECTOR = '[data-automation-id="promptButton"]';
/** Option rows in an OPEN Workday prompt list (portalled to the document). */
export const PROMPT_OPTION_SELECTOR = '[data-automation-id="promptOption"]';

/**
 * Workday's multiselect ("Type to Add Skills", Country Phone Code) exposes no
 * ARIA multi signal — the container automation-id is the only reliable marker.
 * Used as a case-insensitive `*=` fragment.
 */
export const MULTISELECT_CONTAINER_FRAGMENT = "multiselect";
/** Committed chips in a multiselect (`selectedItem`), as a `*=` fragment. */
export const SELECTED_ITEM_FRAGMENT = "selecteditem";

/** Validation-error containers, as a `*=` fragment (stuck-page diagnostics). */
export const ERROR_FRAGMENT = "error";

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The nearest automation-id at or above `el`, lower-cased ("" when none). */
export function automationId(el: HTMLElement): string {
  return (el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "").toLowerCase();
}

/**
 * Every automation-id from `el` up through `depth` ancestors, lower-cased and
 * space-joined. Workday tags the SECTION (résumé, cover letter, create-account)
 * while the input's own id is generic ("file-upload-input-ref"), so the chain —
 * not the element — is what carries the meaning.
 */
export function automationIdChain(el: HTMLElement, depth = 6): string {
  const ids: string[] = [];
  let node: HTMLElement | null = el;
  for (let i = 0; node && i < depth; i++, node = node.parentElement) {
    const id = node.getAttribute("data-automation-id");
    if (id) ids.push(id.toLowerCase());
  }
  return ids.join(" ");
}
