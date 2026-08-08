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
import { activateElement } from "./comboboxEngine";
import { FILE_DROP_ZONE_SELECTOR, FILE_INPUT_SELECTOR } from "./adapters/workdaySelectors";

export interface UploadResult {
  ok: boolean;
  reason?: string;
  /** True when the site's upload can't be scripted at all (a custom button that
   *  opens a native picker with no persistent <input type=file>, e.g. SAP
   *  SuccessFactors). The caller should download the file so the user can pick
   *  it in the site's own dialog. */
  manual?: boolean;
}

/** Rebuild a File from the base64 bytes the background worker downloaded. */
export function base64ToFile(b64: string, name: string, type: string): File {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name || "resume", { type: type || "application/octet-stream" });
}

/** Locate the real <input type=file> for a detected resume-upload control.
 *  Climbs from the control outward (nearest first) so it finds an input that is
 *  a sibling/uncle several levels up — SuccessFactors keeps its hidden file
 *  input beside the visible upload button, not inside it. Bounded and stops at
 *  the form so it never reaches an unrelated field. */
export function findFileInput(el: HTMLElement): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === "file") return el;
  let node: HTMLElement | null =
    el.closest<HTMLElement>(
      `form, ${FILE_DROP_ZONE_SELECTOR}, [class*='dropzone' i], [class*='upload' i], [class*='attach' i], [class*='field' i]`
    ) ?? el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    // Workday's input is a SIBLING of the zone, so prefer the attribute match
    // before the generic one — its classes are hashed and match nothing.
    const wd = node.querySelector<HTMLInputElement>(`input${FILE_INPUT_SELECTOR}:not([disabled])`);
    if (wd) return wd;
    const input = node.querySelector<HTMLInputElement>('input[type="file"]:not([disabled])');
    if (input) return input;
    if (node.tagName === "FORM") break;
  }
  return null;
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

/** Assign via DataTransfer, highlighting the input on success. */
function tryAssign(input: HTMLInputElement, file: File): boolean {
  try {
    if (assignToInput(input, file)) {
      flashHighlight(input.labels?.[0] ?? input);
      return true;
    }
  } catch {
    // Some frameworks lock the input — caller falls back.
  }
  return false;
}

/** Poll for a scriptable file input to appear. SuccessFactors mounts its
 *  "Upload from device" <input type=file> only AFTER the upload button is
 *  clicked, so we wait for it. Prefers one inside the widget, then any enabled
 *  one anywhere (SF portals the menu). */
async function waitForRevealedInput(
  near: HTMLElement,
  budgetMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<HTMLInputElement | null> {
  const doc = near.ownerDocument;
  const pollMs = 60;
  for (let elapsed = 0; elapsed <= budgetMs; elapsed += pollMs) {
    const scoped = findFileInput(near);
    if (scoped) return scoped;
    const any = doc.querySelector<HTMLInputElement>('input[type="file"]:not([disabled])');
    if (any) return any;
    await sleep(pollMs);
  }
  return null;
}

/**
 * Attach `file` to the upload control represented by `target`.
 *
 * Order: (1) a scriptable `<input type=file>` already present → assign via
 * DataTransfer; (2) a dropzone → simulate a drop; (3) a custom upload button
 * (SAP SuccessFactors) → click it to REVEAL its "Upload from device" input,
 * then assign to that — never clicking the device option itself, which would
 * open the OS dialog (this is how Jobright attaches on SF); (4) nothing
 * scriptable turned up → `manual`, so the caller can download the file for a
 * manual pick.
 */
export async function injectResumeFile(
  target: HTMLElement,
  file: File,
  opts: { revealWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<UploadResult> {
  if (!target.isConnected) {
    return { ok: false, reason: "Upload field was removed — rescan the page." };
  }
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const existing = findFileInput(target);
  if (existing && tryAssign(existing, file)) return { ok: true };

  const dropzone = target.closest(
    `${FILE_DROP_ZONE_SELECTOR},[class*='dropzone' i],[class*='drop' i]`
  ) as HTMLElement | null;
  if (dropzone) {
    try {
      simulateDrop(dropzone, file);
      flashHighlight(dropzone);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "Could not attach the file — upload manually." };
    }
  }

  // Custom upload button (SF): click it to reveal its file input, then attach.
  if (target.matches('[role="button"], button') || target.closest("[class*='attach' i]")) {
    activateElement(target);
    const revealed = await waitForRevealedInput(target, opts.revealWaitMs ?? 1500, sleep);
    if (revealed && tryAssign(revealed, file)) return { ok: true };
    return {
      ok: false,
      manual: true,
      reason: "This site needs the résumé attached manually — auto-attach isn't available here.",
    };
  }

  // An upload zone without a recognised drop/attach class — try a drop.
  const zone = (target.closest("[class*='upload' i]") as HTMLElement) || target;
  try {
    simulateDrop(zone, file);
    flashHighlight(zone);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not attach the file — upload manually." };
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
