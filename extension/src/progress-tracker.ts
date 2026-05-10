/**
 * ProgressTracker — tracks form-fill progress and renders an overlay progress bar.
 */

export interface ProgressState {
  totalFields: number
  filledFields: number
  percentage: number
  currentField: string
  status: "filling" | "waiting_user" | "complete" | "error"
}

export class ProgressTracker {
  private state: ProgressState = {
    totalFields: 0,
    filledFields: 0,
    percentage: 0,
    currentField: "",
    status: "filling"
  }

  private overlayElement: HTMLElement | null = null

  /**
   * Update progress as fields are filled.
   */
  update(filled: number, total: number, currentLabel: string): void {
    this.state.filledFields = filled
    this.state.totalFields = total
    this.state.currentField = currentLabel
    this.state.percentage = total > 0 ? Math.round((filled / total) * 100) : 0

    if (this.state.percentage >= 100) {
      this.state.status = "complete"
    }

    this.render()
    this.reportToDashboard(this.state)
  }

  /**
   * Set the tracker status (e.g., waiting for user input or error).
   */
  setStatus(status: ProgressState["status"]): void {
    this.state.status = status
    this.render()
    this.reportToDashboard(this.state)
  }

  /**
   * Get the current progress state.
   */
  getState(): ProgressState {
    return { ...this.state }
  }

  /**
   * Render progress bar overlay on the page.
   */
  render(): void {
    if (!this.overlayElement) {
      this.overlayElement = this.createOverlay()
      document.body.appendChild(this.overlayElement)
    }

    const progressBar = this.overlayElement.querySelector<HTMLElement>(
      "[data-progress-bar]"
    )
    const progressText = this.overlayElement.querySelector<HTMLElement>(
      "[data-progress-text]"
    )
    const statusText = this.overlayElement.querySelector<HTMLElement>(
      "[data-status-text]"
    )

    if (progressBar) {
      progressBar.style.width = `${this.state.percentage}%`
      progressBar.style.backgroundColor = this.getStatusColor()
    }

    if (progressText) {
      progressText.textContent = `${this.state.filledFields}/${this.state.totalFields} fields (${this.state.percentage}%)`
    }

    if (statusText) {
      statusText.textContent = this.getStatusMessage()
    }

    // Auto-hide after completion
    if (this.state.status === "complete") {
      setTimeout(() => this.destroy(), 3000)
    }
  }

  /**
   * Report progress back to dashboard via chrome.runtime messaging.
   */
  reportToDashboard(state: ProgressState): void {
    try {
      chrome.runtime.sendMessage({
        type: "FILL_PROGRESS",
        payload: state
      })
    } catch {
      // Extension context may not be available
    }
  }

  /**
   * Remove the overlay from the page.
   */
  destroy(): void {
    if (this.overlayElement) {
      this.overlayElement.remove()
      this.overlayElement = null
    }
  }

  /**
   * Create the overlay DOM element.
   */
  private createOverlay(): HTMLElement {
    const overlay = document.createElement("div")
    overlay.id = "applypilot-progress-overlay"
    overlay.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 320px;
      background: #1f2937;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #f9fafb;
    `

    overlay.innerHTML = `
      <div style="display: flex; align-items: center; margin-bottom: 8px;">
        <span style="font-size: 14px; font-weight: 600;">⚡ ApplyPilot</span>
        <span data-status-text style="margin-left: auto; font-size: 12px; color: #9ca3af;"></span>
      </div>
      <div style="background: #374151; border-radius: 6px; height: 8px; overflow: hidden; margin-bottom: 8px;">
        <div data-progress-bar style="height: 100%; width: 0%; background: #8b5cf6; border-radius: 6px; transition: width 0.3s ease;"></div>
      </div>
      <div data-progress-text style="font-size: 12px; color: #d1d5db;">0/0 fields (0%)</div>
    `

    return overlay
  }

  /**
   * Get color based on current status.
   */
  private getStatusColor(): string {
    switch (this.state.status) {
      case "filling":
        return "#8b5cf6"
      case "waiting_user":
        return "#f59e0b"
      case "complete":
        return "#10b981"
      case "error":
        return "#ef4444"
    }
  }

  /**
   * Get human-readable status message.
   */
  private getStatusMessage(): string {
    switch (this.state.status) {
      case "filling":
        return `Filling: ${this.state.currentField}`
      case "waiting_user":
        return "Needs your input"
      case "complete":
        return "✓ Complete"
      case "error":
        return "Error occurred"
    }
  }
}
