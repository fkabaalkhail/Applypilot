/**
 * Account-wall sub-flow: Workday-style signup/login pages that gate the real
 * application. Signup walls get a generated password (saved device-locally —
 * see credentialStore's security posture); login walls replay saved
 * credentials or pause for the user. Verification/2FA walls always pause
 * (flowChecks.isVerificationWall) — that part is human-only.
 */
import { cleanText, deepQueryAll, isHiddenButLabeled, isVisible } from "./domUtils";
import { generatePassword } from "./passwordGen";
import { getCredential, saveCredential } from "./credentialStore";
import type { WriteResult } from "./writeEngine";

export type WallKind = "signup" | "login";

export interface WallInfo {
  kind: WallKind;
  passwordEls: HTMLInputElement[];
  emailEl: HTMLInputElement | null;
  /** Required consent/agreement checkboxes gating the signup (native + ARIA). */
  agreeEls: HTMLElement[];
}

const SIGNUP_RE = /create (an? )?account|sign ?up|register|new user|créer (un|mon) compte|s'?inscrire/i;
const LOGIN_RE = /sign ?in|log ?in|already registered|se connecter|connexion/i;

/** Wall verbs the advance search accepts ONLY while a wall is detected. */
export const WALL_ADVANCE_RE =
  /\b(create( an| my)? account|sign ?up|register|sign ?in|log ?in|créer (un|mon) compte|s'?inscrire|se connecter)\b/i;

/** Consent/agreement checkbox labels a signup gate requires ticked. */
const AGREE_RE = /agree|consent|i have read|read and|\bterms\b|privacy|policy|acknowledge|gdpr/i;

/** Accessible label text for a control (aria-label, aria-labelledby, <label>). */
function controlLabelText(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const t = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (cleanText(t)) return t;
  }
  if (el instanceof HTMLInputElement && el.labels && el.labels.length) return el.labels[0].textContent ?? "";
  return el.closest("label")?.textContent ?? "";
}

/** Unchecked consent/agreement checkboxes (native + role=checkbox) in `scope`:
 *  required ones, or ones whose label reads like a terms/privacy agreement.
 *  Marketing opt-ins (not required, no agreement wording) are left alone. */
function agreementCheckboxes(scope: HTMLElement): HTMLElement[] {
  return (deepQueryAll(scope, 'input[type="checkbox"], [role="checkbox"]') as HTMLElement[]).filter((el) => {
    if ((el as HTMLInputElement).disabled) return false;
    const checked = el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true";
    if (checked) return false;
    if (!(isVisible(el) || isHiddenButLabeled(el))) return false;
    const required = (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true";
    return required || AGREE_RE.test(cleanText(controlLabelText(el)));
  });
}

/** Tick a consent checkbox — native (click + change) or ARIA (click + aria-checked). */
function checkBox(el: HTMLElement): void {
  el.click();
  if (el instanceof HTMLInputElement) {
    if (!el.checked) {
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (el.getAttribute("aria-checked") !== "true") {
    el.setAttribute("aria-checked", "true");
  }
}

export function detectWall(scope: HTMLElement): WallInfo | null {
  const passwordEls = (deepQueryAll(scope, 'input[type="password"]') as HTMLInputElement[]).filter(
    (el) => !el.disabled && (isVisible(el) || isHiddenButLabeled(el))
  );
  if (passwordEls.length === 0) return null;
  const text = cleanText(scope.textContent).slice(0, 4000);
  const kind: WallKind =
    passwordEls.length >= 2 ? "signup"
    : SIGNUP_RE.test(text) ? "signup"
    : LOGIN_RE.test(text) ? "login"
    : "signup";
  const emailEl =
    (deepQueryAll(
      scope,
      'input[type="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i]'
    ) as HTMLInputElement[]).filter(
      (el) => !el.disabled && el.type !== "password" && (isVisible(el) || isHiddenButLabeled(el))
    )[0] ?? null;
  return { kind, passwordEls, emailEl, agreeEls: agreementCheckboxes(scope) };
}

export interface AccountWallOutcome {
  extraAdvance?: RegExp;
  pause?: "account";
  filled: number;
}

export async function runAccountWall(
  wall: WallInfo,
  origin: string,
  profileEmail: string,
  write: (el: HTMLInputElement, value: string) => WriteResult
): Promise<AccountWallOutcome> {
  let filled = 0;
  if (wall.kind === "signup") {
    // Revisits reuse the saved password so email+password always stay a pair.
    const existing = await getCredential(origin);
    const password = existing?.password ?? generatePassword();
    const email = wall.emailEl?.value || profileEmail || existing?.email || "";
    if (wall.emailEl && !wall.emailEl.value && email && write(wall.emailEl, email).written) filled++;
    for (const el of wall.passwordEls) {
      if (!el.value && write(el, password).written) filled++;
    }
    // Workday's create-account gate won't submit until a required consent
    // checkbox is ticked — the missing step that left "Create Account" inert.
    for (const box of wall.agreeEls) {
      checkBox(box);
      filled++;
    }
    if (email) await saveCredential(origin, email, password);
    console.log(
      `[Tailrd flow] account wall: signup, ${wall.passwordEls.length} password field(s), ` +
        `${wall.agreeEls.length} agreement box(es), filled ${filled}`
    );
    return { extraAdvance: WALL_ADVANCE_RE, filled };
  }
  const cred = await getCredential(origin);
  if (!cred) return { pause: "account", filled };
  if (wall.emailEl && !wall.emailEl.value && write(wall.emailEl, cred.email).written) filled++;
  for (const el of wall.passwordEls) {
    if (!el.value && write(el, cred.password).written) filled++;
  }
  return { extraAdvance: WALL_ADVANCE_RE, filled };
}
