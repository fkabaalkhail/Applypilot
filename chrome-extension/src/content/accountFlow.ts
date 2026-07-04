/**
 * Account-wall sub-flow: Workday-style signup/login pages that gate the real
 * application. Signup walls fill the user's saved account-creation credentials
 * (Autofill Information → Account creation), falling back to a generated
 * password (saved device-locally — see credentialStore's security posture);
 * login walls replay saved credentials or pause for the user. Verification/2FA
 * walls always pause (flowChecks.isVerificationWall) — that part is human-only.
 */
import { cleanText, deepQueryAll, isHiddenButLabeled, isVisible } from "./domUtils";
import { generatePassword } from "./passwordGen";
import { getCredential, getDefaultCredential, saveCredential } from "./credentialStore";
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

/** Kind-specific advance verbs: on a signup wall the flow must click "Create
 *  Account", never the "Sign In" link beside it — and vice versa. */
export const SIGNUP_ADVANCE_RE =
  /\b(create( an| my)? account|sign ?up|register|créer (un|mon) compte|s'?inscrire)\b/i;
export const LOGIN_ADVANCE_RE = /\b(sign ?in|log ?in|se connecter|connexion)\b/i;

/** Links/buttons that flip a sign-in page into its create-account form
 *  (Workday: data-automation-id="createAccountLink"). */
const SIGNUP_TOGGLE_RE = /^(create( an| my)? account|sign ?up|register|new user\??|créer (un|mon) compte|s'?inscrire)$/i;

/**
 * The control that switches a login wall to its registration form, if the page
 * offers one. Workday's sign-in page carries a "Create Account" toggle — when
 * we have no saved credential for this origin, creating an account is the only
 * move that can succeed, so the flow clicks this first.
 */
export function findSignupToggle(scope: HTMLElement): HTMLElement | null {
  const byId = deepQueryAll(scope, '[data-automation-id="createAccountLink"]').find((el) => isVisible(el));
  if (byId) return byId;
  for (const el of deepQueryAll(scope, 'a[href], button, [role="button"], [role="link"]')) {
    if ((el as HTMLButtonElement).disabled || !isVisible(el)) continue;
    const text = cleanText(el.getAttribute("aria-label")) || cleanText(el.textContent);
    if (text && text.length <= 40 && SIGNUP_TOGGLE_RE.test(text)) return el;
  }
  return null;
}

/** Consent/agreement checkbox labels a signup gate requires ticked. */
const AGREE_RE = /agree|consent|i have read|read and|\bterms\b|privacy|policy|acknowledge|gdpr/i;

/** data-automation-id patterns that mark a consent gate (Workday et al.).
 *  Workday's create-account consent is `createAccountCheckbox` — a native
 *  checkbox it renders visually hidden behind a styled control, with no
 *  `required` attribute and no agreement-worded label, so the generic filter
 *  misses it entirely. */
const CONSENT_AUTOMATION_RE = /createaccountcheckbox|agree|consent|privacy|terms|acknowledg|gdpr/i;
/** Automation-ids that mark a Workday create-account (signup) form. */
const SIGNUP_AUTOMATION_RE = /createaccount|verifypassword|verifynewpassword|confirmpassword/i;

/** All data-automation-ids from `el` up through its wrappers, lower-cased and
 *  joined — Workday's real markers often sit on an ancestor, not the input. */
function automationChain(el: HTMLElement): string {
  const ids: string[] = [];
  let node: HTMLElement | null = el;
  for (let i = 0; node && i < 5; i++, node = node.parentElement) {
    const id = node.getAttribute("data-automation-id");
    if (id) ids.push(id);
  }
  return ids.join(" ").toLowerCase();
}

/** True when any control in `scope` carries a Workday create-account marker. */
function hasSignupMarker(scope: HTMLElement): boolean {
  return (deepQueryAll(scope, "[data-automation-id]") as HTMLElement[]).some((el) =>
    SIGNUP_AUTOMATION_RE.test(el.getAttribute("data-automation-id") ?? "")
  );
}

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
 *  required ones, ones labelled like a terms/privacy agreement, or ones a
 *  Workday-style automation-id marks as consent (createAccountCheckbox…).
 *  Marketing opt-ins (not required, no agreement wording) are left alone. */
function agreementCheckboxes(scope: HTMLElement): HTMLElement[] {
  return (deepQueryAll(scope, 'input[type="checkbox"], [role="checkbox"]') as HTMLElement[]).filter((el) => {
    if ((el as HTMLInputElement).disabled) return false;
    const checked = el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true";
    if (checked) return false;
    const consentId = CONSENT_AUTOMATION_RE.test(automationChain(el));
    // Workday hides the native checkbox behind a styled control (no rendered
    // box, no label), so visibility can't gate an automation-id-marked consent.
    if (!consentId && !(isVisible(el) || isHiddenButLabeled(el))) return false;
    const required = (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true";
    return required || consentId || AGREE_RE.test(cleanText(controlLabelText(el)));
  });
}

/** Tick a consent checkbox so its framework registers the change. `el.click()`
 *  runs the native toggle (checked → true) AND fires the click/input/change a
 *  framework listens to — the one primitive that behaves the same in a real
 *  browser and jsdom. Guarded against an already-checked box so a re-tick on a
 *  retry can't switch it back off (callers also filter checked boxes out). */
function checkBox(el: HTMLElement): void {
  if (el instanceof HTMLInputElement) {
    if (el.checked) return;
    el.click();
    if (!el.checked) {
      // A handler that preventDefault'd the toggle — set it and notify anyway.
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (el.getAttribute("aria-checked") !== "true") {
    el.click();
    el.setAttribute("aria-checked", "true");
  }
}

export function detectWall(scope: HTMLElement): WallInfo | null {
  const passwordEls = (deepQueryAll(scope, 'input[type="password"]') as HTMLInputElement[]).filter(
    (el) => !el.disabled && (isVisible(el) || isHiddenButLabeled(el))
  );
  if (passwordEls.length === 0) return null;
  const text = cleanText(scope.textContent).slice(0, 4000);
  // A Workday create-account marker (verify-password / createAccountCheckbox)
  // is decisive — its sign-in and create-account pages read the same in body
  // text, and a slow-loading verify-password field can leave only one password
  // box visible, which would otherwise be misread as a login.
  const kind: WallKind =
    hasSignupMarker(scope) ? "signup"
    : passwordEls.length >= 2 ? "signup"
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
  const defaults = await getDefaultCredential();
  if (wall.kind === "signup") {
    // Password precedence: the pair this site's account was CREATED with wins
    // (revisits must replay it), then the user's preferred account-creation
    // password, then a generated one. Email: what the page already holds, then
    // the user's registration email, then the profile email.
    const existing = await getCredential(origin);
    const password = existing?.password || defaults.password || generatePassword();
    const email = wall.emailEl?.value || defaults.email || profileEmail || existing?.email || "";
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
    return { extraAdvance: SIGNUP_ADVANCE_RE, filled };
  }
  // Login: the per-origin pair (created by a signup wall here) wins; otherwise
  // the user's default credentials from Autofill Information → Account creation.
  const cred =
    (await getCredential(origin)) ??
    (defaults.email && defaults.password ? { origin, email: defaults.email, password: defaults.password, createdAt: 0 } : null);
  if (!cred) return { pause: "account", filled };
  if (wall.emailEl && !wall.emailEl.value && write(wall.emailEl, cred.email).written) filled++;
  for (const el of wall.passwordEls) {
    if (!el.value && write(el, cred.password).written) filled++;
  }
  // A login filled from the defaults becomes this origin's saved pair, so
  // "Saved sign-ins" reflects what was actually used here.
  if (cred.createdAt === 0 && filled > 0) await saveCredential(origin, cred.email, cred.password);
  return { extraAdvance: LOGIN_ADVANCE_RE, filled };
}
