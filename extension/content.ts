import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: [
    "https://www.linkedin.com/*",
    "https://*.lever.co/*",
    "https://*.greenhouse.io/*",
    "https://*.myworkdayjobs.com/*",
    "https://*.ashbyhq.com/*",
    "https://*.smartrecruiters.com/*"
  ]
}

console.log("[Tailrd] Content script loaded")

// --- Field keyword mapping ---

interface FieldMapping {
  keywords: string[]
  profileKey: string
  fallback?: string // default value if profile doesn't have it
  type?: "text" | "select" | "radio"
}

const FIELD_MAPPINGS: FieldMapping[] = [
  { keywords: ["full name", "your name"], profileKey: "full_name" },
  { keywords: ["first name", "first_name", "given name"], profileKey: "first_name" },
  { keywords: ["last name", "last_name", "surname", "family name"], profileKey: "last_name" },
  { keywords: ["email", "e-mail"], profileKey: "email" },
  { keywords: ["phone", "telephone", "mobile", "cell"], profileKey: "phone" },
  { keywords: ["location", "city", "current location", "address"], profileKey: "location" },
  { keywords: ["linkedin"], profileKey: "linkedin_url" },
  { keywords: ["github"], profileKey: "github_url" },
  { keywords: ["portfolio", "website", "personal site"], profileKey: "website" },
  { keywords: ["current company", "company", "employer"], profileKey: "company" },
  { keywords: ["salary", "desired salary", "compensation"], profileKey: "salary", fallback: "70000" },
  { keywords: ["authorized", "eligible", "sponsorship"], profileKey: "work_authorization", fallback: "Yes", type: "radio" },
  { keywords: ["18 years", "at least 18"], profileKey: "age_18", fallback: "Yes", type: "radio" },
  { keywords: ["how did you hear", "hear about"], profileKey: "hear_about", fallback: "LinkedIn", type: "select" },
  { keywords: ["pronouns"], profileKey: "pronouns", fallback: "He/him", type: "select" },
  { keywords: ["preferred language"], profileKey: "preferred_language", fallback: "English" },
  { keywords: ["translator"], profileKey: "translator", fallback: "No", type: "radio" },
]

// --- Utility functions ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false
  const style = getComputedStyle(el)
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  return true
}

function getLabel(el: HTMLElement): string {
  // 1. Associated label via for attribute
  const id = el.id
  if (id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`)
    if (label?.textContent) return label.textContent.trim()
  }

  // 2. aria-label
  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel) return ariaLabel.trim()

  // 3. aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby")
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy)
    if (labelEl?.textContent) return labelEl.textContent.trim()
  }

  // 4. Placeholder
  const placeholder = el.getAttribute("placeholder")
  if (placeholder) return placeholder.trim()

  // 5. Parent label
  const parentLabel = el.closest("label")
  if (parentLabel?.textContent) return parentLabel.textContent.trim()

  // 6. Previous sibling or nearby text
  const prev = el.previousElementSibling
  if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN" || prev.tagName === "DIV")) {
    if (prev.textContent) return prev.textContent.trim()
  }

  // 7. Parent container text (for Lever-style forms where label is in a parent div)
  const parent = el.closest(".application-question, .field, .form-group, [class*='field'], [class*='question']")
  if (parent) {
    const labelEl = parent.querySelector("label, .label, [class*='label'], legend")
    if (labelEl?.textContent) return labelEl.textContent.trim()
  }

  // 8. Name attribute
  return el.getAttribute("name") || ""
}

function matchField(label: string, profile: Record<string, string>): { value: string; type?: string } | null {
  const normalized = label.toLowerCase().trim()
  if (!normalized) return null

  // Special case: if the input type is email, map to email
  for (const mapping of FIELD_MAPPINGS) {
    for (const keyword of mapping.keywords) {
      if (normalized.includes(keyword)) {
        const value = profile[mapping.profileKey] || mapping.fallback || ""
        if (value) {
          return { value, type: mapping.type }
        }
        return null
      }
    }
  }

  // Fallback: check if "name" appears alone (not first/last) → full_name
  if (normalized === "name" || normalized === "your name") {
    const val = profile["full_name"] || ""
    if (val) return { value: val }
  }

  return null
}

// --- Fill functions ---

function fillInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus()
  el.dispatchEvent(new Event("focus", { bubbles: true }))

  // Use native setter to bypass React's controlled input
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set

  if (nativeSetter) {
    nativeSetter.call(el, value)
  } else {
    el.value = value
  }

  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  el.dispatchEvent(new Event("blur", { bubbles: true }))
}

function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const normalized = value.toLowerCase().trim()

  for (const option of Array.from(el.options)) {
    const optText = (option.textContent || "").toLowerCase().trim()
    const optVal = option.value.toLowerCase().trim()

    if (optVal === normalized || optText === normalized || optText.includes(normalized) || normalized.includes(optText)) {
      el.focus()
      el.value = option.value
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      el.dispatchEvent(new Event("blur", { bubbles: true }))
      return true
    }
  }
  return false
}

function fillRadio(el: HTMLInputElement, value: string): boolean {
  const name = el.name
  if (!name) return false

  const normalized = value.toLowerCase().trim()
  const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`)

  for (const radio of Array.from(radios)) {
    const radioVal = radio.value.toLowerCase().trim()
    // Check radio value
    if (radioVal === normalized) {
      radio.focus()
      radio.checked = true
      radio.dispatchEvent(new Event("input", { bubbles: true }))
      radio.dispatchEvent(new Event("change", { bubbles: true }))
      radio.dispatchEvent(new Event("click", { bubbles: true }))
      return true
    }
    // Check radio label
    const radioLabel = getLabel(radio).toLowerCase().trim()
    if (radioLabel === normalized || radioLabel.includes(normalized)) {
      radio.focus()
      radio.checked = true
      radio.dispatchEvent(new Event("input", { bubbles: true }))
      radio.dispatchEvent(new Event("change", { bubbles: true }))
      radio.dispatchEvent(new Event("click", { bubbles: true }))
      return true
    }
  }
  return false
}

// --- Main fill function ---

async function runFill(profile: Record<string, string>): Promise<number> {
  let filledCount = 0
  const processed = new Set<HTMLElement>()

  // Find all inputs
  const inputs = document.querySelectorAll<HTMLInputElement>("input")
  for (const input of Array.from(inputs)) {
    if (!isVisible(input) || input.disabled || input.readOnly) continue
    if (processed.has(input)) continue

    const inputType = input.type.toLowerCase()

    // Skip file, hidden, submit, button inputs
    if (["file", "hidden", "submit", "button", "image", "reset"].includes(inputType)) continue

    const label = getLabel(input)
    const match = matchField(label, profile)
    if (!match) continue

    // Also check if input type is email → force email mapping
    if (inputType === "email" && profile["email"]) {
      fillInput(input, profile["email"])
      processed.add(input)
      filledCount++
      await delay(150)
      continue
    }

    if (inputType === "radio") {
      if (fillRadio(input, match.value)) {
        // Mark all radios in this group as processed
        const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${input.name}"]`)
        radios.forEach((r) => processed.add(r))
        filledCount++
        await delay(150)
      }
      continue
    }

    // Text-like inputs
    if (["text", "email", "tel", "url", "number", "search"].includes(inputType)) {
      fillInput(input, match.value)
      processed.add(input)
      filledCount++
      await delay(150)
    }
  }

  // Find all textareas
  const textareas = document.querySelectorAll<HTMLTextAreaElement>("textarea")
  for (const textarea of Array.from(textareas)) {
    if (!isVisible(textarea) || textarea.disabled || textarea.readOnly) continue
    if (processed.has(textarea)) continue

    const label = getLabel(textarea)
    const match = matchField(label, profile)
    if (!match) continue

    fillInput(textarea, match.value)
    processed.add(textarea)
    filledCount++
    await delay(150)
  }

  // Find all selects
  const selects = document.querySelectorAll<HTMLSelectElement>("select")
  for (const select of Array.from(selects)) {
    if (!isVisible(select) || select.disabled) continue
    if (processed.has(select)) continue

    const label = getLabel(select)
    const match = matchField(label, profile)
    if (!match) continue

    if (fillSelect(select, match.value)) {
      processed.add(select)
      filledCount++
      await delay(150)
    }
  }

  return filledCount
}

// --- Message listener ---

chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: { profile?: Record<string, string>; sessionId?: string } }, _sender, sendResponse) => {
    if (message.type !== "START_FILL") return false

    const profile = message.payload?.profile ?? {}

    runFill(profile)
      .then((count) => {
        sendResponse({ success: count > 0, filledCount: count })
      })
      .catch((err) => {
        sendResponse({ success: false, error: (err as Error).message })
      })

    return true // keep channel open for async response
  }
)
