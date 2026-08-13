// REAL Greenhouse markup, captured verbatim from
// job-boards.greenhouse.io/embed/job_app?for=lyft&token=8697534002 on
// 2026-08-12 (inline styles, SVG paths and remix-css hashes stripped).
//
// This is the form behind autofill_reports #167: 24 fields, 11 filled, 13
// failed. Unlike a reconstruction, these are the exact shapes the extension
// has to handle, in particular:
//
//  * There is NOT ONE <select> on the page. Every dropdown is a react-select v5
//    `<input type="text" role="combobox">` whose option list mounts only when
//    opened, so options are empty at scan time.
//  * The employment row index is a SUFFIX ("start-date-month-0"), with nothing
//    after it.
//  * "Start date" is not a date picker: it is a month combobox plus a separate
//    free-text year input.
//  * The certification field is a plain text input whose label is 431 characters
//    of legal prose mentioning "Employer" three times.

/** react-select v5 combobox: the shape every Greenhouse dropdown really has. */
function reactSelect(id: string, label: string): string {
  return `
<div class="select-wrapper">
  <label id="${id}-label" for="${id}" class="label label">${label}<span aria-hidden="true">*</span></label>
  <div class="select__control">
    <div class="select__value-container">
      <div class="select__placeholder" id="react-select-${id}-placeholder">Select...</div>
      <div class="select__input-container" data-value="">
        <input class="select__input" autoCapitalize="none" autoComplete="off" autoCorrect="off"
               id="${id}" spellcheck="false" tabindex="0" type="text"
               aria-autocomplete="list" aria-expanded="false" aria-haspopup="true"
               aria-errormessage="${id}-error" aria-invalid="false"
               aria-labelledby="${id}-label" aria-required="true" role="combobox"
               aria-activedescendant="" aria-describedby="react-select-${id}-placeholder" value=""/>
      </div>
    </div>
    <div class="select__indicators">
      <button type="button" class="icon-button" aria-label="Toggle flyout" tabindex="-1"></button>
    </div>
  </div>
  <input required="" tabindex="-1" aria-hidden="true" class="requiredInput" value=""/>
</div>`;
}

/** The employment row: company/title text, split month+year dates, current-role box. */
export const GH_EXPERIENCE_ROW = `
<div class="education-experience-block">
  <div class="text-input-wrapper"><div class="input-wrapper">
    <label id="company-name-0-label" for="company-name-0" class="label label">Company name<span aria-hidden="true">*</span></label>
    <input id="company-name-0" class="input input__single-line" aria-label="Company name" type="text"/>
  </div></div>
  <div class="text-input-wrapper"><div class="input-wrapper">
    <label id="title-0-label" for="title-0" class="label label">Title<span aria-hidden="true">*</span></label>
    <input id="title-0" class="input input__single-line" aria-label="Title" type="text"/>
  </div></div>
  ${reactSelect("start-date-month-0", "Start date month")}
  <div class="text-input-wrapper"><div class="input-wrapper">
    <label id="start-date-year-0-label" for="start-date-year-0" class="label label">Start date year<span aria-hidden="true">*</span></label>
    <input id="start-date-year-0" class="input input__single-line" aria-label="Start date year"
           aria-required="true" type="text" maxLength="4"/>
  </div></div>
  ${reactSelect("end-date-month-0", "End date month")}
  <div class="text-input-wrapper"><div class="input-wrapper">
    <label id="end-date-year-0-label" for="end-date-year-0" class="label label">End date year<span aria-hidden="true">*</span></label>
    <input id="end-date-year-0" class="input input__single-line" aria-label="End date year"
           aria-required="true" type="text" maxLength="4"/>
  </div></div>
  <div class="checkbox" id="current-role-0"><div class="checkbox__wrapper"><div class="checkbox__input">
    <input aria-required="false" type="checkbox" id="current-role-0_1" name="current-role-0"
           aria-describedby="current-role-0-description current-role-0-error" value="1"/>
    <label for="current-role-0_1" class="label">Current role</label>
  </div></div></div>
</div>`;

/** The education row: three react-select comboboxes, index suffixed with `--0`. */
export const GH_EDUCATION_ROW = `
<div class="education-block">
  ${reactSelect("school--0", "School")}
  ${reactSelect("degree--0", "Degree")}
  ${reactSelect("discipline--0", "Discipline")}
</div>`;

/** The 431-char certification statement. A plain text input, label AND
 *  aria-label both carrying the full prose, which says "Employer" three times. */
export const GH_CERTIFICATION_STATEMENT =
  "I certify that the facts set forth in this Application for Employment are true " +
  "and complete to the best of my knowledge. I understand that if I am employed, " +
  "false statements, omissions or misrepresentations may result in my dismissal. " +
  "I authorize the Employer to make an investigation of any of the facts set forth " +
  "in this application and release the Employer from any liability. The employer " +
  "may contact any provided references.";

export const GH_CERTIFICATION = `
<div class="text-input-wrapper"><div class="input-wrapper">
  <label id="question_37728590002-label" for="question_37728590002" class="label label">${GH_CERTIFICATION_STATEMENT} <span aria-hidden="true">*</span></label>
  <input id="question_37728590002" class="input input__single-line"
         aria-label="${GH_CERTIFICATION_STATEMENT}" aria-required="true" type="text"/>
</div></div>`;

/** Screening questions: all react-select comboboxes, all Yes/No or a list. */
export const GH_SCREENING = `
<div class="screening">
  ${reactSelect("question_37728582002", "May we contact your current employer?")}
  ${reactSelect("question_37728583002", "Work Authorization")}
  ${reactSelect("question_37728585002", "Please share your gender pronouns.")}
</div>`;

/** The whole application form, as one document body. */
export const GH_LYFT_FORM = `
<form id="application-form">
  ${GH_EXPERIENCE_ROW}
  ${GH_EDUCATION_ROW}
  ${GH_SCREENING}
  ${GH_CERTIFICATION}
</form>`;
