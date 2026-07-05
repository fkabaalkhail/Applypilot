// REAL SAP SuccessFactors application markup, captured verbatim from
// career2.successfactors.eu (Ericsson) on 2026-07-04 (scripts/handlers trimmed).
// This is the actual `rcmpaginatedselect` widget — an input[role=combobox] whose
// options render as <ul role=listbox><li role=option><a>…</a></li> and commit via
// SF's `juic.fire(...,'_selectItem',N)`. It replaces the earlier fixture, which
// (wrongly) modelled SF as UI5 shadow-DOM native <select> elements.

/** One SF EEO/custom picklist row. `owns`/`lbId` wire the combobox to its (open)
 *  listbox so getListbox() can resolve it via aria-owns, exactly as on the page. */
function picklist(opts: {
  label: string;
  hiddenName: string;
  inputId: string;
  owns: string;
  required?: boolean;
}): string {
  const req = opts.required ? '<span class="required">*</span>' : "";
  const ariaReq = opts.required ? ' aria-required="true"' : "";
  return `
<tr>
  <th class="formFieldLabel"><label id="label_${opts.hiddenName}" for="${opts.hiddenName}">${opts.label}${req}</label></th>
  <td>
    <div class="displayInlineBlock" id="picklist_${opts.hiddenName}"><span class="sfCascadingPicklist">
      <div class="paginatedPicklistContainer fd-input-group">
        <input aria-label="${opts.label}" autocomplete="off" type="text" placeholder="No Selection"
               aria-owns="${opts.owns}" role="combobox"${ariaReq}
               class="rcmpaginatedselectinput rcmpaginatedselectitem fd-input" aria-expanded="false"
               id="${opts.inputId}">
        <button aria-label="${opts.label}" tabindex="-1"
                class="rcmpaginatedselectbutton fd-button" type="button" id="${opts.inputId.replace("_input", "_selectButton")}"></button>
      </div>
    </span></div>
    <input id="${opts.hiddenName}" name="${opts.hiddenName}" value="" type="hidden" aria-hidden="true">
  </td>
</tr>`;
}

/** An OPEN SF option list (as rendered while the widget is expanded). */
function openListbox(id: string, options: string[]): string {
  const items = options
    .map(
      (label, i) =>
        `<li role="option" id="${id}item${i}" class="sf-list-item"><a title="${label}" role="menuitem">${label}</a></li>`
    )
    .join("");
  return `<ul id="${id}" class="sf-list-select fd-list" role="listbox" aria-expanded="true">${items}</ul>`;
}

export const SF_RACE_OPTIONS = [
  "No Selection",
  "American Indian or Alaska Native (not Hispanic or Latino)",
  "Asian (not Hispanic or Latino)",
  "Black or African American (not Hispanic or Latino)",
  "Hispanic or Latino",
  "White (not Hispanic or Latino)",
  "Two or More Races (not Hispanic or Latino)",
  "Decline to self-identify",
];

/** The full self-identification section: gender, race (with its listbox mounted
 *  open so option-matching is exercised), veteran, plus a custom Yes/No question. */
export function successFactorsEeoHtml(): string {
  return `<table><tbody>
${picklist({ label: "Please state your gender:", hiddenName: "tor__fcustGender", inputId: "36:_input", owns: "37:_listSelect", required: true })}
${picklist({ label: "Race/Ethnicity", hiddenName: "tor__fcust_US_Ethnicity", inputId: "40:_input", owns: "41:_listSelect", required: true })}
${picklist({ label: "Protected Veteran", hiddenName: "tor__fcust_US_Veteran", inputId: "44:_input", owns: "45:_listSelect", required: true })}
${picklist({ label: "Do you have a potential Conflict of Interest as described above? (Yes or No)", hiddenName: "tor__fcustConflictInterest", inputId: "52:_input", owns: "53:_listSelect", required: true })}
</tbody></table>
${openListbox("41:_listSelect", SF_RACE_OPTIONS)}`;
}
