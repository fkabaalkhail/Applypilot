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
}

const SIGNUP_RE = /create (an? )?account|sign ?up|register|new user|créer (un|mon) compte|s'?inscrire/i;
const LOGIN_RE = /sign ?in|log ?in|already registered|se connecter|connexion/i;

/** Wall verbs the advance search accepts ONLY while a wall is detected. */
export const WALL_ADVANCE_RE =
  /\b(create( an| my)? account|sign ?up|register|sign ?in|log ?in|créer (un|mon) compte|s'?inscrire|se connecter)\b/i;

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
  return { kind, passwordEls, emailEl };
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
    if (email) await saveCredential(origin, email, password);
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
