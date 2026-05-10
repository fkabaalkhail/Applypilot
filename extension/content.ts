import type { PlasmoCSConfig } from "plasmo"
import { FormDetector } from "./src/form-detector"
import { FieldMapper } from "./src/field-mapper"
import { FormFiller } from "./src/form-filler"
import { TaskQueue } from "./src/task-queue"
import { ProgressTracker } from "./src/progress-tracker"
import { reportComplete, reportError } from "./src/messaging"

export const config: PlasmoCSConfig = {
  matches: [
    "https://www.linkedin.com/*",
    "https://jobs.lever.co/*",
    "https://boards.greenhouse.io/*",
    "https://*.myworkdayjobs.com/*"
  ]
}

// Content script — handles form detection and autofill on job application pages
console.log("[ApplyPilot] Content script loaded")

/**
 * Listen for START_FILL message from the background worker.
 * When received, orchestrate the full form fill flow:
 * 1. Detect form fields (FormDetector)
 * 2. Map fields to profile data (FieldMapper)
 * 3. Enqueue fill tasks (TaskQueue)
 * 4. Execute fills with progress tracking (FormFiller + ProgressTracker)
 * 5. Report completion or errors back to the dashboard
 */
chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: { profile?: Record<string, string>; sessionId?: string } }, _sender, sendResponse) => {
    if (message.type !== "START_FILL") {
      return false
    }

    const profile = message.payload?.profile ?? {}
    const sessionId = message.payload?.sessionId ?? ""

    // Run the fill flow asynchronously
    executeFillFlow(profile, sessionId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: (err as Error).message }))

    // Return true to keep the message channel open for async response
    return true
  }
)

/**
 * Execute the complete form fill flow.
 */
async function executeFillFlow(
  profile: Record<string, string>,
  sessionId: string
): Promise<void> {
  const detector = new FormDetector()
  const mapper = new FieldMapper()
  const filler = new FormFiller()
  const queue = new TaskQueue(200) // 200ms delay between fills for anti-detection
  const tracker = new ProgressTracker()

  try {
    // Step 1: Detect all form fields
    const fields = detector.detectFields()

    if (fields.length === 0) {
      reportError({ error: "No form fields detected on this page.", sessionId })
      return
    }

    // Step 2: Map fields to profile values and enqueue fill tasks
    let priority = 0
    for (const field of fields) {
      const value = mapper.mapFieldToProfile(field, profile)
      if (value) {
        queue.enqueue({
          field,
          value,
          priority: priority++,
          status: "pending"
        })
      }
    }

    const totalTasks = queue.size
    if (totalTasks === 0) {
      reportError({ error: "No fields could be mapped to profile data.", sessionId })
      return
    }

    // Step 3: Process fill tasks with progress tracking
    let filledCount = 0
    let failedCount = 0

    while (!queue.isComplete) {
      const task = queue.peek()
      if (!task) break

      // Process next (applies delay)
      const hasTask = await queue.processNext()
      if (!hasTask) break

      // Fill the field
      const success = filler.fillField(task.field, task.value)

      if (success) {
        queue.markDone(task)
        filledCount++
      } else {
        queue.markFailed(task)
        failedCount++
      }

      // Update progress
      tracker.update(
        filledCount + failedCount,
        totalTasks,
        task.field.label || task.field.name || "field"
      )
    }

    // Step 4: Report completion
    if (filledCount > 0) {
      tracker.setStatus("complete")
      reportComplete({ sessionId, filledCount, failedCount })
    } else {
      tracker.setStatus("error")
      reportError({ error: "Failed to fill any fields.", sessionId })
    }
  } catch (err) {
    tracker.setStatus("error")
    reportError({ error: (err as Error).message, sessionId })
  }
}
