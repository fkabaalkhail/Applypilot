/**
 * FormDetector — detects all fillable form fields on a page, including inside iframes.
 */

export interface FormField {
  element: HTMLElement
  type: "text" | "email" | "select" | "radio" | "checkbox" | "textarea"
  label: string
  name: string
  required: boolean
  inIframe: boolean
  iframeIndex?: number
}

type FieldType = FormField["type"]

const INPUT_TYPE_MAP: Record<string, FieldType> = {
  text: "text",
  email: "email",
  tel: "text",
  url: "text",
  number: "text",
  password: "text",
  search: "text",
  radio: "radio",
  checkbox: "checkbox"
}

export class FormDetector {
  /**
   * Detect all visible, enabled form fields on the current page.
   * Searches the main document and all accessible iframes.
   */
  detectFields(): FormField[] {
    const fields: FormField[] = []

    // Detect fields in main document
    fields.push(...this.detectFieldsInDocument(document, false))

    // Detect fields inside iframes
    const iframes = document.querySelectorAll("iframe")
    iframes.forEach((iframe, index) => {
      try {
        const iframeFields = this.detectFieldsInIframe(iframe)
        iframeFields.forEach((f) => {
          f.iframeIndex = index
        })
        fields.push(...iframeFields)
      } catch {
        // Cross-origin iframe — skip silently
      }
    })

    return fields
  }

  /**
   * Switch to iframe context and detect fields within.
   */
  detectFieldsInIframe(iframe: HTMLIFrameElement): FormField[] {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document
      if (!iframeDoc) return []
      return this.detectFieldsInDocument(iframeDoc, true)
    } catch {
      // Cross-origin iframe — cannot access
      return []
    }
  }

  /**
   * Detect fields within a specific document context.
   */
  private detectFieldsInDocument(doc: Document, inIframe: boolean): FormField[] {
    const fields: FormField[] = []

    // Detect input elements
    const inputs = doc.querySelectorAll<HTMLInputElement>("input")
    inputs.forEach((input) => {
      if (!this.isVisible(input) || input.disabled) return

      const inputType = input.type.toLowerCase()
      const fieldType = INPUT_TYPE_MAP[inputType]
      if (!fieldType) return

      fields.push({
        element: input,
        type: fieldType,
        label: this.extractLabel(input, doc),
        name: input.name || input.id || "",
        required: input.required || input.getAttribute("aria-required") === "true",
        inIframe
      })
    })

    // Detect select elements
    const selects = doc.querySelectorAll<HTMLSelectElement>("select")
    selects.forEach((select) => {
      if (!this.isVisible(select) || select.disabled) return

      fields.push({
        element: select,
        type: "select",
        label: this.extractLabel(select, doc),
        name: select.name || select.id || "",
        required: select.required || select.getAttribute("aria-required") === "true",
        inIframe
      })
    })

    // Detect textarea elements
    const textareas = doc.querySelectorAll<HTMLTextAreaElement>("textarea")
    textareas.forEach((textarea) => {
      if (!this.isVisible(textarea) || textarea.disabled) return

      fields.push({
        element: textarea,
        type: "textarea",
        label: this.extractLabel(textarea, doc),
        name: textarea.name || textarea.id || "",
        required:
          textarea.required || textarea.getAttribute("aria-required") === "true",
        inIframe
      })
    })

    return fields
  }

  /**
   * Extract the label text for a form element.
   * Checks: associated <label>, aria-label, aria-labelledby, placeholder, parent label.
   */
  private extractLabel(element: HTMLElement, doc: Document): string {
    // Check for associated label via "for" attribute
    const id = element.id
    if (id) {
      const label = doc.querySelector<HTMLLabelElement>(`label[for="${id}"]`)
      if (label) return label.textContent?.trim() || ""
    }

    // Check aria-label
    const ariaLabel = element.getAttribute("aria-label")
    if (ariaLabel) return ariaLabel.trim()

    // Check aria-labelledby
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy) {
      const labelEl = doc.getElementById(labelledBy)
      if (labelEl) return labelEl.textContent?.trim() || ""
    }

    // Check placeholder
    const placeholder = element.getAttribute("placeholder")
    if (placeholder) return placeholder.trim()

    // Check parent label element
    const parentLabel = element.closest("label")
    if (parentLabel) {
      const text = parentLabel.textContent?.trim() || ""
      // Remove the element's own text content from the label
      const elementText = element.textContent?.trim() || ""
      return text.replace(elementText, "").trim()
    }

    // Fallback to name attribute
    return element.getAttribute("name") || ""
  }

  /**
   * Check if an element is visible and interactable.
   */
  private isVisible(element: HTMLElement): boolean {
    if (element.offsetParent === null && element.style.position !== "fixed") {
      return false
    }

    const style = window.getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false
    }

    // Check if element has dimensions
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      return false
    }

    return true
  }
}
