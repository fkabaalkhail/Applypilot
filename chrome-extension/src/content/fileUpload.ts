/**
 * Resume file injection engine.
 *
 * Browsers forbid setting an <input type=file> value from script, but a file
 * CAN be attached by building a DataTransfer, assigning its `.files` to the
 * input, and dispatching the input/change events frameworks listen for. For
 * drag-and-drop "dropzone" widgets (Greenhouse, Ashby, Workday) we simulate a
 * real drop with DataTransfer-carrying drag events.
 *
 * This never submits the form — it only attaches the file, exactly as if the
 * user had picked it. Triggered by an explicit user click in the overlay.
 */
import { flashHighlight } from "./domUtils";

export interface UploadResult {
  ok: boolean;
  reason?: string;
}

/** Rebuild a File from the base64 bytes the background worker downloaded. */
export function base64ToFile(b64: string, name: string, type: string): File {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name || "resume", { type: type || "application/octet-stream" });
}

/** Locate the real <input type=file> for a detected resume-upload control. */
export function findFileInput(el: HTMLElement): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === "file") return el;
  // Dropzone widgets usually hide a file input within the same container.
  const scope =
    el.closest("form, [class*='dropzone' i], [class*='upload' i], [class*='attach' i]") ||
    el.ownerDocument;
  return scope.querySelector<HTMLInputElement>('input[type="file"]:not([disabled])');
}

function assignToInput(input: HTMLInputElement, file: File): boolean {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  if (input.files.length !== 1) return false;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function simulateDrop(target: HTMLElement, file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  for (const type of ["dragenter", "dragover", "drop"] as const) {
    const ev = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: dt,
    });
    target.dispatchEvent(ev);
  }
}

/**
 * Attach `file` to the upload control represented by `target`.
 *
 * Strategy, in order: (1) assign to the nearest real file input via
 * DataTransfer; (2) if that doesn't take, simulate a drag-and-drop on the
 * surrounding dropzone. Returns a clear ok/reason for the overlay to display.
 */
export function injectResumeFile(target: HTMLElement, file: File): UploadResult {
  if (!target.isConnected) {
    return { ok: false, reason: "Upload field was removed — rescan the page." };
  }

  const input = findFileInput(target);
  if (input) {
    try {
      if (assignToInput(input, file)) {
        flashHighlight(input.labels?.[0] ?? input);
        return { ok: true };
      }
    } catch {
      // Some frameworks lock the input — fall through to drop simulation.
    }
  }

  const zone =
    (target.closest("[class*='dropzone' i],[class*='drop' i],[class*='upload' i]") as HTMLElement) ||
    target;
  try {
    simulateDrop(zone, file);
    flashHighlight(zone);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Could not attach the file — upload manually.",
    };
  }
}

/** Trigger a browser download of base64 bytes (the "Download PDF" action). */
export function downloadBase64File(b64: string, name: string, type: string): void {
  const file = base64ToFile(b64, name, type);
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
