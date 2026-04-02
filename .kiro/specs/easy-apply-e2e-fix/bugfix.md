# Bugfix Requirements Document

## Introduction

The Easy Apply end-to-end flow is broken in two places. First, form field values set via `FormFillerSelenium._set_react_value` do not persist inside iframes because the method does not focus/click the element before typing and does not send a TAB key afterward to trigger React's validation cycle. The working reference implementation (`smart_form_filler.py::_fill_field`) clicks the element, types via `send_keys`, and tabs out — this is what makes values stick in React-controlled forms. Second, the `_do_easy_apply` function searches only the default (top-level) browsing context for Next/Submit/Review buttons, but LinkedIn's Easy Apply modal renders these buttons inside iframes. The working reference (`test_easy_apply.py::do_easy_apply`) searches all iframes for navigation buttons. Together, these two bugs prevent the full Easy Apply flow from completing.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `_set_react_value` fills an input inside an iframe THEN the system types the value but it does not persist because the element is not clicked/focused before `send_keys` and no TAB key is sent afterward to trigger React's blur/validation handlers

1.2 WHEN `_set_react_value` falls back to the JavaScript native setter on a `<textarea>` element THEN the system only tries `HTMLInputElement.prototype` descriptor and may silently fail because it does not correctly resolve the prototype for textarea elements

1.3 WHEN `_set_react_value` completes (either path) THEN the system does not dispatch a TAB/blur action to move focus away from the field, so React's controlled component state may not update

1.4 WHEN `_do_easy_apply` looks for the "Submit application" button THEN the system searches only the default content (top-level document) and misses the button when it is rendered inside an iframe

1.5 WHEN `_do_easy_apply` looks for the "Review your application" button THEN the system searches only the default content and misses the button when it is rendered inside an iframe

1.6 WHEN `_do_easy_apply` looks for the "Continue to next step" button THEN the system searches only the default content and misses the button when it is rendered inside an iframe

### Expected Behavior (Correct)

2.1 WHEN `_set_react_value` fills an input inside an iframe THEN the system SHALL click the element to focus it, clear it, type via `send_keys`, verify the value stuck, and send a TAB key to trigger blur/validation — matching the approach in `smart_form_filler.py::_fill_field`

2.2 WHEN `_set_react_value` falls back to the JavaScript native setter on a `<textarea>` element THEN the system SHALL resolve the correct prototype descriptor (`HTMLTextAreaElement.prototype` for textareas, `HTMLInputElement.prototype` for inputs) based on the element's tag name

2.3 WHEN `_set_react_value` completes THEN the system SHALL ensure focus leaves the field (via TAB or explicit blur dispatch) so React's controlled component state updates

2.4 WHEN `_do_easy_apply` looks for the "Submit application" button THEN the system SHALL search the default content first, then iterate through all iframes to find the button

2.5 WHEN `_do_easy_apply` looks for the "Review your application" button THEN the system SHALL search the default content first, then iterate through all iframes to find the button

2.6 WHEN `_do_easy_apply` looks for the "Continue to next step" button THEN the system SHALL search the default content first, then iterate through all iframes to find the button

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `_set_react_value` fills an input on the main page (not inside an iframe) THEN the system SHALL CONTINUE TO set the value correctly using the existing send_keys + JS fallback approach

3.2 WHEN `fill_visible_fields` encounters an already-filled field THEN the system SHALL CONTINUE TO skip it without overwriting

3.3 WHEN `fill_in_iframe` iterates iframes for field filling THEN the system SHALL CONTINUE TO switch back to default content after each iframe

3.4 WHEN `_do_easy_apply` encounters unknown fields that need user answers THEN the system SHALL CONTINUE TO create PendingQuestion records and return "waiting"

3.5 WHEN `_do_easy_apply` completes a successful submission THEN the system SHALL CONTINUE TO take a pre-submit screenshot and store application metadata

3.6 WHEN `_discard_modal` is called after a failure THEN the system SHALL CONTINUE TO close the modal and switch back to default content


---

## Bug Condition Derivation

### Bug Condition 1: React Value Not Persisting

```pascal
FUNCTION isBugCondition_ReactValue(X)
  INPUT: X of type FormFillInput (driver context, element, value)
  OUTPUT: boolean

  // Bug triggers when filling a field inside an iframe context
  // where React controls the input and requires focus + blur cycle
  RETURN X.element_is_inside_iframe AND X.element_is_react_controlled
END FUNCTION
```

```pascal
// Property: Fix Checking — React Value Persistence
FOR ALL X WHERE isBugCondition_ReactValue(X) DO
  result ← _set_react_value'(X.driver, X.element, X.value)
  ASSERT X.element.get_attribute("value") = X.value
END FOR
```

```pascal
// Property: Preservation Checking — Non-iframe fields still work
FOR ALL X WHERE NOT isBugCondition_ReactValue(X) DO
  ASSERT _set_react_value(X) = _set_react_value'(X)
END FOR
```

### Bug Condition 2: Navigation Buttons Not Found in Iframes

```pascal
FUNCTION isBugCondition_ButtonSearch(X)
  INPUT: X of type EasyApplyStep (driver state, step number)
  OUTPUT: boolean

  // Bug triggers when Next/Submit/Review button is inside an iframe
  RETURN X.button_is_inside_iframe
END FUNCTION
```

```pascal
// Property: Fix Checking — Button Found in Iframe
FOR ALL X WHERE isBugCondition_ButtonSearch(X) DO
  result ← _find_form_button'(X.driver)
  ASSERT result IS NOT NULL
END FOR
```

```pascal
// Property: Preservation Checking — Buttons in default content still found
FOR ALL X WHERE NOT isBugCondition_ButtonSearch(X) DO
  ASSERT _find_form_button(X) = _find_form_button'(X)
END FOR
```
