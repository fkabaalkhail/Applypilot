// REAL Workday "My Information" dropdown markup, captured verbatim from
// bmo.wd3.myworkdayjobs.com/…/apply/applyManually on 2026-07-04 (SVGs/inline
// styles stripped). Unlike fixtures/workday.ts (a reconstruction), this is the
// actual DOM the extension must handle, used to reproduce the production
// autofill_reports failures for these three dropdowns.

/** Country Phone Code: a Workday *multiselect*. Its trigger is a plain
 *  `<input data-uxi-widget-type="selectinput">` with NO role="combobox" and NO
 *  aria-haspopup, so the generic scanner misread it as a text field and typed
 *  "Canada" into the search box instead of selecting the "Canada (+1)" option. */
export const WD_COUNTRY_PHONE_CODE = `
<div data-automation-id="formField-countryPhoneCode" data-fkit-id="phoneNumber--countryPhoneCode">
  <label for="phoneNumber--countryPhoneCode"><span>Country Phone Code<abbr aria-hidden="true">*</abbr></span></label>
  <div><div><div>
    <div dir="ltr" tabindex="-1" data-automation-id="multiSelectContainer" id="wd-cpc"
         data-uxi-widget-type="multiselect">
      <div data-automation-id="multiselectInputContainer" dir="ltr">
        <div data-automation-hiddensearch="false">
          <input dir="ltr" placeholder="Search" aria-invalid="false" aria-disabled="false"
                 aria-required="true" autocomplete="off" tabindex="0"
                 data-uxi-element-id="selectinput-wd-cpc" data-uxi-widget-type="selectinput"
                 data-uxi-multiselect-id="wd-cpc" id="phoneNumber--countryPhoneCode" value="">
          <div data-automation-id="promptSelectionLabel"></div>
        </div>
      </div>
    </div>
  </div></div></div>
</div>`;

/** Phone Device Type: Workday button dropdown: `<button aria-haspopup="listbox">`
 *  with a hidden mirror `<input type="text">`. The real button carries NO
 *  aria-controls/aria-owns (the reconstruction fixture wrongly added one). */
export const WD_PHONE_DEVICE_TYPE = `
<div data-automation-id="formField-phoneType" data-fkit-id="phoneNumber--phoneType">
  <label for="phoneNumber--phoneType"><span>Phone Device Type<abbr aria-hidden="true">*</abbr></span></label>
  <div><div><div>
    <button aria-haspopup="listbox" type="button" value="99ba898c88ac017a7b269900f201d905"
            aria-label="Phone Device Type Personal Primary Required" name="phoneType"
            id="phoneNumber--phoneType">Personal Primary</button>
    <input type="text" value="99ba898c88ac017a7b269900f201d905">
    <span class="menu-icon"></span>
  </div></div></div>
</div>`;

/** How Did You Hear About Us?, same button-dropdown pattern, unselected. */
export const WD_HOW_DID_YOU_HEAR = `
<div role="group" aria-labelledby="source-section">
  <div data-automation-id="formField-source" data-fkit-id="source--source">
    <label for="source--source"><span>How Did You Hear About Us?<abbr aria-hidden="true">*</abbr></span></label>
    <div><div><div>
      <button aria-haspopup="listbox" type="button" value=""
              aria-label="How Did You Hear About Us? Select One Required" name="source"
              id="source--source">Select One</button>
      <input type="text" value="">
      <span class="menu-icon"></span>
    </div></div></div>
  </div>
</div>`;

export const WD_REAL_DROPDOWNS = `<form>${WD_COUNTRY_PHONE_CODE}${WD_PHONE_DEVICE_TYPE}${WD_HOW_DID_YOU_HEAR}</form>`;
