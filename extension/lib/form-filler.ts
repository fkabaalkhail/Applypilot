/**
 * FormFiller — fills form fields with profile data, handling React inputs and event dispatch.
 */

import type { FormField } from "./form-detector"

export class FormFiller {
  /**
   * Fill a single form field with the given value.
   * Returns true if the field was successfully filled, false otherwise.
   */
  fillField(field: FormField, value: string): boolean {
    try {
      const element = field.element

      switch (field.type) {
        case "text":
        case "email":
          return this.fillTextInput(element as HTMLInputElement, value)

        case "textarea":
          return this.fillTextarea(element as HTMLTextAreaElement, value)

        case "select":
          return this.fillSelect(element as HTMLSelectElement, value)

        case "radio":
          return this.fillRadio(element as HTMLInputElement, value)

        case "checkbox":
          return this.fillCheckbox(element as HTMLInputElement, value)

        default:
          return false
      }
    } catch {
      // Field could not be filled — highlight for user
      this.highlightField(field.element)
      return false
    }
  }

  /**
   * Handle React-controlled inputs using native value setter + event dispatch.
   * React overrides the value property, so we need to use the native setter
   * to bypass React's synthetic event system.
   */
  fillReactInput(element: HTMLInputElement, value: string): void {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, value)
    } else {
      element.value = value
    }

    this.dispatchEvents(element)
  }

  /**
   * Dispatch input, change, and blur events to ensure frameworks detect the value change.
   */
  dispatchEvents(element: HTMLElement): void {
    element.dispatchEvent(new Event("focus", { bubbles: true }))
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    element.dispatchEvent(new Event("blur", { bubbles: true }))
  }

  /**
   * Fill a text input field. Tries React-style first, then standard assignment.
   */
  private fillTextInput(element: HTMLInputElement, value: string): boolean {
    // Focus the element first
    element.focus()

    // Use React-compatible fill
    this.fillReactInput(element, value)

    // Verify the value was set
    return element.value === value
  }

  /**
   * Fill a textarea element.
   */
  private fillTextarea(element: HTMLTextAreaElement, value: string): boolean {
    element.focus()

    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set

    if (nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(element, value)
    } else {
      element.value = value
    }

    this.dispatchEvents(element)
    return element.value === value
  }

  /**
   * Fill a select dropdown by matching option text or value.
   */
  private fillSelect(element: HTMLSelectElement, value: string): boolean {
    const normalizedValue = value.toLowerCase().trim()

    // Try exact value match first
    for (const option of Array.from(element.options)) {
      if (option.value.toLowerCase() === normalizedValue) {
        element.value = option.value
        this.dispatchEvents(element)
        return true
      }
    }

    // Try text content match
    for (const option of Array.from(element.options)) {
      if (option.textContent?.toLowerCase().trim() === normalizedValue) {
        element.value = option.value
        this.dispatchEvents(element)
        return true
      }
    }

    // Try partial text match
    for (const option of Array.from(element.options)) {
      const optionText = option.textContent?.toLowerCase().trim() || ""
      if (optionText.includes(normalizedValue) || normalizedValue.includes(optionText)) {
        element.value = option.value
        this.dispatchEvents(element)
        return true
      }
    }

    return false
  }

  /**
   * Fill a radio button by matching value or label text.
   */
  private fillRadio(element: HTMLInputElement, value: string): boolean {
    const normalizedValue = value.toLowerCase().trim()
    const radioName = element.name

    // Find all radio buttons in the same group
    const doc = element.ownerDocument
    const radios = doc.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${radioName}"]`
    )

    for (const radio of Array.from(radios)) {
      const radioValue = radio.value.toLowerCase().trim()
      const radioLabel = this.getRadioLabel(radio, doc)?.toLowerCase().trim() || ""

      if (
        radioValue === normalizedValue ||
        radioLabel === normalizedValue ||
        radioLabel.includes(normalizedValue)
      ) {
        radio.checked = true
        this.dispatchEvents(radio)
        return true
      }
    }

    return false
  }

  /**
   * Fill a checkbox based on truthy/falsy value.
   */
  private fillCheckbox(element: HTMLInputElement, value: string): boolean {
    const shouldCheck = ["true", "yes", "1", "on"].includes(
      value.toLowerCase().trim()
    )

    if (element.checked !== shouldCheck) {
      element.checked = shouldCheck
      this.dispatchEvents(element)
    }

    return true
  }

  /**
   * Get the label text for a radio button.
   */
  private getRadioLabel(radio: HTMLInputElement, doc: Document): string | null {
    // Check for associated label
    if (radio.id) {
      const label = doc.querySelector<HTMLLabelElement>(`label[for="${radio.id}"]`)
      if (label) return label.textContent?.trim() || null
    }

    // Check parent label
    const parentLabel = radio.closest("label")
    if (parentLabel) return parentLabel.textContent?.trim() || null

    return null
  }

  /**
   * Highlight a field that could not be filled automatically.
   */
  private highlightField(element: HTMLElement): void {
    element.style.outline = "2px solid #f59e0b"
    element.style.outlineOffset = "2px"
    element.setAttribute("data-applypilot-needs-attention", "true")
  }
}
