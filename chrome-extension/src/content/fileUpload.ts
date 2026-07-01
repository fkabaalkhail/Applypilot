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
import { cleanText, flashHighlight } from "./domUtils";

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
  // Scope strictly to THIS widget — its own subtree or the nearest drop-zone /
  // upload wrapper. Never the whole document or a shared <form>: an input-less
  // zone must resolve to null (so we fall back to a simulated drop) rather than
  // grabbing an unrelated file input (e.g. a separate cover-letter upload).
  const scope =
    (el.closest(
      "[class*='dropzone' i], [class*='upload' i], [class*='attach' i]," +
        " [data-automation-id*='file-upload' i], [data-automation-id*='drop-zone' i]"
    ) as HTMLElement) || el;
  return scope.querySelector<HTMLInputElement>('input[type="file"]:not([disabled])');
}

function assignToInput(input: HTMLInputElement, file: File): boolean {
  const dt = new DataTransfer();
  dt.items.add(file);
  try {
    input.files = dt.files;
  } catch {
    /* some frameworks trap the instance-level write — fall through to native */
  }
  if ((input.files?.length ?? 0) !== 1) {
    // Retry via the native prototype 'files' setter (bypasses a framework trap).
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (setter) {
      try {
        setter.call(input, dt.files);
      } catch {
        /* ignore — reported as failure below */
      }
    }
  }
  if ((input.files?.length ?? 0) !== 1) return false;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Whether the widget currently displays `file`'s name (a filename chip / item).
 *  Scoped to the upload widget — never the whole <form> (a filename appearing in
 *  an unrelated field would otherwise mask a real rejection). */
function widgetShowsFilename(scope: HTMLElement, file: File): boolean {
  const name = cleanText(file.name);
  if (!name) return false;
  if (cleanText(scope.textContent).includes(name)) return true;
  const wrap = scope.closest(
    "[class*='upload' i], [class*='attach' i], [data-automation-id*='file' i], [data-automation-id*='drop' i]"
  ) as HTMLElement | null;
  return Boolean(wrap && wrap !== scope && cleanText(wrap.textContent).includes(name));
}

/**
 * Confirm the input-assign upload was accepted, tolerant of async rendering:
 * poll (up to ~2.4s) for positive evidence — the file still held by the input,
 * a filename chip / uploaded item, or the input being swapped out post-upload.
 * Biased toward success (the synchronous write already happened) so a slow
 * network-backed accept is never mis-reported as a failure; only a cleared input
 * that never shows a chip, or an explicit aria-invalid, counts as rejected.
 */
async function inputUploadAccepted(
  widget: HTMLElement,
  input: HTMLInputElement,
  file: File
): Promise<boolean> {
  if (input.isConnected && input.getAttribute("aria-invalid") === "true") return false;
  for (let i = 0; i < 12; i++) {
    if (!input.isConnected) return true; // swapped out after reading the file
    if ((input.files?.length ?? 0) >= 1) return true; // still holds it → accepted
    if (widgetShowsFilename(widget, file) || widget.querySelector(ITEM_SEL)) return true;
    await delay(200);
  }
  return false; // input cleared and no filename ever rendered → rejected
}

/** Uploaded-file item / chip markers (shared by clear + verify). */
const ITEM_SEL =
  "[data-automation-id='file-upload-item'], [data-automation-id*='fileUploadItem' i]," +
  " [class*='file-item' i], [class*='uploaded-file' i], [class*='attachment-item' i]";

/**
 * Remove an already-attached file so re-runs (and multi-step re-fills) don't
 * stack duplicates or get the second file rejected. Only clicks a delete control
 * WITHIN the upload widget and only while evidence of an attached file remains,
 * bounded so it can never spin. Safe no-op when nothing is attached.
 */
async function clearExistingUpload(
  scope: HTMLElement,
  input: HTMLInputElement | null
): Promise<void> {
  const DELETE_SEL =
    "[data-automation-id='delete-file'], [data-automation-id*='delete' i]," +
    " button[aria-label*='remove' i], button[aria-label*='delete' i]," +
    " button[title*='remove' i], button[title*='delete' i]";
  for (let i = 0; i < 15; i++) {
    const hasFile = (input?.files?.length ?? 0) > 0 || !!scope.querySelector(ITEM_SEL);
    if (!hasFile) return;
    const del = scope.querySelector<HTMLElement>(DELETE_SEL);
    if (!del) return; // nothing we can click — leave it to overwrite semantics
    del.click();
    await delay(150);
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Did the zone actually accept the simulated drop? Synthetic DragEvents are
 * untrusted, and some widgets (Workday's "Autofill with Resume") ignore them —
 * so confirm rather than assume. Evidence of acceptance: a file input the
 * handler created/populated within this widget, or a filename chip appearing.
 */
async function dropWasAccepted(zone: HTMLElement, file: File): Promise<boolean> {
  await delay(350); // let an async drop handler run
  const input = findFileInput(zone);
  if (input?.files && input.files.length > 0) return true;
  return widgetShowsFilename(zone, file);
}

/**
 * Attach `file` to the upload control represented by `target`.
 *
 * Strategy, in order: (0) remove any already-attached file so re-runs don't
 * stack duplicates; (1) assign to the nearest real file input via DataTransfer,
 * then confirm the form didn't reject it; (2) if there is no reachable input,
 * simulate a drag-and-drop on the drop zone AND verify it was accepted before
 * reporting success — a silent synthetic drop that the page ignores must not
 * read as "attached".
 */
export async function injectResumeFile(target: HTMLElement, file: File): Promise<UploadResult> {
  if (!target.isConnected) {
    return { ok: false, reason: "Upload field was removed — rescan the page." };
  }

  const widget =
    (target.closest(
      "[class*='dropzone' i], [class*='upload' i], [class*='attach' i]," +
        " [data-automation-id*='file-upload' i], [data-automation-id*='drop-zone' i]"
    ) as HTMLElement) || target;
  const input = findFileInput(target);

  // Idempotency: clear a previously-attached file first — scoped as TIGHTLY as
  // possible to THIS field (its own form-field / fieldset / list-item container),
  // never the broad upload wrapper, so we can't delete a different upload (e.g. a
  // separate cover-letter file) that happens to share an ancestor.
  const clearScope =
    (input?.closest(
      "[data-automation-id^='formField-'], [aria-labelledby], fieldset, li"
    ) as HTMLElement) ||
    (target.closest(
      "[data-automation-id*='file-upload' i], [data-automation-id*='drop-zone' i], [class*='dropzone' i]"
    ) as HTMLElement) ||
    widget;
  await clearExistingUpload(clearScope, input);

  if (input) {
    try {
      if (assignToInput(input, file)) {
        flashHighlight(input.labels?.[0] ?? input);
        // Confirm acceptance (tolerant of async chip rendering; biased to success
        // so a slow network-backed accept is never mis-reported as a failure).
        if (await inputUploadAccepted(widget, input, file)) return { ok: true };
        return { ok: false, reason: "The form didn't accept the file — attach it manually." };
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
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Could not attach the file — upload manually.",
    };
  }
  if (await dropWasAccepted(zone, file)) {
    flashHighlight(zone);
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "Couldn't confirm the file attached — use the form's “Select file” button to attach it manually.",
  };
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
