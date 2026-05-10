/**
 * Messaging protocol — defines message types and handlers for extension ↔ dashboard communication.
 */

// ─── Message Types ───────────────────────────────────────────────────────────

export const MessageTypes = {
  /** Dashboard → Extension: Start form autofill */
  FILL_FORM: "FILL_FORM",
  /** Extension → Dashboard: Progress update during fill */
  FILL_PROGRESS: "FILL_PROGRESS",
  /** Extension → Dashboard: Fill completed successfully */
  FILL_COMPLETE: "FILL_COMPLETE",
  /** Extension → Dashboard: Fill encountered an error */
  FILL_ERROR: "FILL_ERROR",
  /** Extension → Dashboard: A question needs user answer */
  NEED_ANSWER: "NEED_ANSWER",
  /** Extension → Background: Request match score for current page */
  GET_MATCH_SCORE: "GET_MATCH_SCORE",
  /** Background → Extension: Match score result */
  MATCH_SCORE_RESULT: "MATCH_SCORE_RESULT"
} as const

export type MessageType = (typeof MessageTypes)[keyof typeof MessageTypes]

// ─── Message Payloads ────────────────────────────────────────────────────────

export interface FillFormPayload {
  url: string
  sessionId?: string
}

export interface FillProgressPayload {
  totalFields: number
  filledFields: number
  percentage: number
  currentField: string
  status: "filling" | "waiting_user" | "complete" | "error"
}

export interface FillCompletePayload {
  sessionId: string
  filledCount: number
  failedCount: number
}

export interface FillErrorPayload {
  error: string
  sessionId?: string
}

export interface NeedAnswerPayload {
  sessionId: string
  fieldLabel: string
  fieldName: string
  context: string
}

export interface GetMatchScorePayload {
  url: string
}

export interface MatchScoreResultPayload {
  overallScore: number
  label: string
  experienceScore: number
  skillScore: number
  industryScore: number
}

// ─── Message Interfaces ──────────────────────────────────────────────────────

export interface ExtensionMessage {
  type: MessageType
  payload?: unknown
}

export interface MessageResponse {
  success: boolean
  data?: unknown
  error?: string
}

// ─── API Client ──────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:8000"

async function apiCall<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

// ─── Background Message Handlers ─────────────────────────────────────────────

/**
 * Register message handlers in the background service worker.
 * Call this from background.ts to set up the messaging protocol.
 */
export function registerMessageHandlers(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: MessageResponse) => void
    ) => {
      switch (message.type) {
        case MessageTypes.FILL_FORM:
          handleFillForm(message.payload as FillFormPayload, sender)
            .then((response) => sendResponse(response))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            )
          return true // Keep channel open for async response

        case MessageTypes.GET_MATCH_SCORE:
          handleGetMatchScore(message.payload as GetMatchScorePayload)
            .then((response) => sendResponse(response))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            )
          return true

        case MessageTypes.FILL_PROGRESS:
          // Forward progress to any listening dashboard tabs
          forwardToDashboard(message)
          sendResponse({ success: true })
          return false

        case MessageTypes.FILL_COMPLETE:
          handleFillComplete(message.payload as FillCompletePayload)
            .then((response) => sendResponse(response))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            )
          return true

        case MessageTypes.FILL_ERROR:
          forwardToDashboard(message)
          sendResponse({ success: true })
          return false

        case MessageTypes.NEED_ANSWER:
          handleNeedAnswer(message.payload as NeedAnswerPayload)
            .then((response) => sendResponse(response))
            .catch((err) =>
              sendResponse({ success: false, error: err.message })
            )
          return true

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` })
          return false
      }
    }
  )
}

// ─── Handler Implementations ─────────────────────────────────────────────────

/**
 * Handle FILL_FORM: Initiate form fill on the active tab.
 */
async function handleFillForm(
  payload: FillFormPayload,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  try {
    // Get fill profile from backend
    const sessionId = payload.sessionId
    let profileData: unknown = null

    if (sessionId) {
      profileData = await apiCall(`/apply/${sessionId}/profile`)
    }

    // Send fill command to the content script on the active tab
    const tabId = sender.tab?.id
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: "START_FILL",
        payload: { profile: profileData, sessionId }
      })
    }

    return { success: true, data: { sessionId } }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/**
 * Handle GET_MATCH_SCORE: Fetch match score from backend API.
 */
async function handleGetMatchScore(
  payload: GetMatchScorePayload
): Promise<MessageResponse> {
  try {
    // Look up job by URL and get match score
    const data = await apiCall<MatchScoreResultPayload>(
      `/jobs/match-by-url?url=${encodeURIComponent(payload.url)}`
    )
    return { success: true, data }
  } catch {
    // Match score not available — not an error, just no data
    return { success: true, data: null }
  }
}

/**
 * Handle FILL_COMPLETE: Report completion to backend.
 */
async function handleFillComplete(
  payload: FillCompletePayload
): Promise<MessageResponse> {
  try {
    if (payload.sessionId) {
      await apiCall(`/apply/${payload.sessionId}/complete`, {
        method: "POST",
        body: JSON.stringify({
          filled_count: payload.filledCount,
          failed_count: payload.failedCount
        })
      })
    }
    forwardToDashboard({ type: MessageTypes.FILL_COMPLETE, payload })
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/**
 * Handle NEED_ANSWER: Create a pending question in the backend.
 */
async function handleNeedAnswer(
  payload: NeedAnswerPayload
): Promise<MessageResponse> {
  try {
    if (payload.sessionId) {
      await apiCall(`/apply/${payload.sessionId}/question`, {
        method: "POST",
        body: JSON.stringify({
          field_label: payload.fieldLabel,
          field_name: payload.fieldName,
          context: payload.context
        })
      })
    }
    forwardToDashboard({ type: MessageTypes.NEED_ANSWER, payload })
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/**
 * Forward a message to all dashboard tabs (localhost:5173).
 */
function forwardToDashboard(message: ExtensionMessage): void {
  chrome.tabs.query({ url: "http://localhost:5173/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message)
      }
    }
  })
}

// ─── Content Script Helpers ──────────────────────────────────────────────────

/**
 * Send a message from content script to background worker.
 */
export function sendToBackground(
  message: ExtensionMessage
): Promise<MessageResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse) => {
      resolve(response || { success: false, error: "No response" })
    })
  })
}

/**
 * Send progress update from content script.
 */
export function reportProgress(payload: FillProgressPayload): void {
  chrome.runtime.sendMessage({
    type: MessageTypes.FILL_PROGRESS,
    payload
  })
}

/**
 * Report fill completion from content script.
 */
export function reportComplete(payload: FillCompletePayload): void {
  chrome.runtime.sendMessage({
    type: MessageTypes.FILL_COMPLETE,
    payload
  })
}

/**
 * Report fill error from content script.
 */
export function reportError(payload: FillErrorPayload): void {
  chrome.runtime.sendMessage({
    type: MessageTypes.FILL_ERROR,
    payload
  })
}

/**
 * Request an answer for an unfillable field.
 */
export function requestAnswer(payload: NeedAnswerPayload): void {
  chrome.runtime.sendMessage({
    type: MessageTypes.NEED_ANSWER,
    payload
  })
}
