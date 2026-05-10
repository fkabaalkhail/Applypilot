/**
 * TaskQueue — manages form fill tasks with priority ordering and configurable delays.
 */

import type { FormField } from "./form-detector"

export interface FillTask {
  field: FormField
  value: string
  priority: number
  status: "pending" | "filling" | "done" | "failed"
}

/** Default delay between fills in milliseconds (anti-detection) */
const DEFAULT_DELAY_MS = 150

export class TaskQueue {
  private queue: FillTask[] = []
  private delayMs: number

  constructor(delayMs: number = DEFAULT_DELAY_MS) {
    this.delayMs = delayMs
  }

  /**
   * Add a fill task to the queue, sorted by priority (lower number = higher priority).
   */
  enqueue(task: FillTask): void {
    task.status = "pending"
    this.queue.push(task)
    // Sort by priority — lower number means higher priority
    this.queue.sort((a, b) => a.priority - b.priority)
  }

  /**
   * Process the next pending task in the queue.
   * Returns true if a task was processed, false if queue is empty.
   */
  async processNext(): Promise<boolean> {
    const task = this.queue.find((t) => t.status === "pending")
    if (!task) return false

    task.status = "filling"

    // Wait for configured delay (anti-detection)
    await this.delay(this.delayMs)

    return true
  }

  /**
   * Mark a task as done.
   */
  markDone(task: FillTask): void {
    task.status = "done"
  }

  /**
   * Mark a task as failed.
   */
  markFailed(task: FillTask): void {
    task.status = "failed"
  }

  /**
   * Get all tasks that failed and need user intervention.
   */
  getFailedTasks(): FillTask[] {
    return this.queue.filter((t) => t.status === "failed")
  }

  /**
   * Get all pending tasks.
   */
  getPendingTasks(): FillTask[] {
    return this.queue.filter((t) => t.status === "pending")
  }

  /**
   * Get all completed tasks.
   */
  getCompletedTasks(): FillTask[] {
    return this.queue.filter((t) => t.status === "done")
  }

  /**
   * Get the next pending task without processing it.
   */
  peek(): FillTask | undefined {
    return this.queue.find((t) => t.status === "pending")
  }

  /**
   * Get total number of tasks in the queue.
   */
  get size(): number {
    return this.queue.length
  }

  /**
   * Check if all tasks are complete (done or failed).
   */
  get isComplete(): boolean {
    return this.queue.every((t) => t.status === "done" || t.status === "failed")
  }

  /**
   * Clear all tasks from the queue.
   */
  clear(): void {
    this.queue = []
  }

  /**
   * Set the delay between fills.
   */
  setDelay(ms: number): void {
    this.delayMs = ms
  }

  /**
   * Promise-based delay utility.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
