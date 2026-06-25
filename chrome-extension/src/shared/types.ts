/**
 * Shared types used across the popup, content script, background worker
 * and API client.
 */

// ---------------------------------------------------------------------------
// User application profile
// ---------------------------------------------------------------------------

export interface EducationEntry {
  school: string;
  degree: string;
  graduationYear: string;
}

export interface ExperienceEntry {
  company: string;
  title: string;
  startDate: string;
  endDate: string;
  description: string;
}

/**
 * Optional EEO / demographic answers. These are ONLY used when the user
 * explicitly enables "Fill EEO fields" in the extension settings.
 */
export interface EeoAnswers {
  gender?: string;
  race?: string;
  hispanicLatino?: string;
  veteranStatus?: string;
  disabilityStatus?: string;
}

/**
 * The canonical profile shape the extension fills from.
 * Mirrors GET /api/user/application-profile (see src/api/client.ts).
 */
export interface UserApplicationProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentCompany: string;
  currentTitle: string;
  workAuthorization: string;
  requiresSponsorship: string;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  skills: string[];
  coverLetter: string;
  salaryExpectation?: string;
  eeo?: EeoAnswers;
}

/** Where a profile came from — shown in the popup so the user always knows. */
export type ProfileSource = "api" | "api-settings" | "cache" | "mock";

// ---------------------------------------------------------------------------
// Field detection
// ---------------------------------------------------------------------------

export type FieldCategory =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "location"
  | "linkedin"
  | "github"
  | "portfolio"
  | "resumeUpload"
  | "coverLetter"
  | "workAuthorization"
  | "sponsorship"
  | "education"
  | "school"
  | "degree"
  | "graduationYear"
  | "experience"
  | "currentCompany"
  | "currentTitle"
  | "salary"
  // EEO / demographic — detected but never autofilled unless explicitly enabled
  | "eeoGender"
  | "eeoRace"
  | "eeoHispanic"
  | "eeoVeteran"
  | "eeoDisability"
  | "eeoOther"
  | "unknown";

export type ControlType =
  | "text"
  | "textarea"
  | "select"
  | "checkbox"
  | "radioGroup"
  | "file"
  | "contenteditable"
  | "customDropdown";

/**
 * Serializable summary of a detected form field, sent from the content
 * script to the popup for review before any filling happens.
 */
export interface DetectedField {
  /** Stable id, prefixed with the owning frame's token (e.g. "x7ab2-3"). */
  id: string;
  category: FieldCategory;
  /** 0..1 — how confident the matcher is about the category. */
  confidence: number;
  /** Best human-readable label found for the field. */
  label: string;
  controlType: ControlType;
  required: boolean;
  /** Value resolved from the profile; null when we have nothing to fill. */
  proposedValue: string | null;
  /** Whether the autofill engine can write this control at all. */
  fillable: boolean;
  /** EEO / demographic flag — excluded from autofill unless enabled. */
  sensitive: boolean;
  /** Short note shown in the review panel (e.g. file-upload guidance). */
  note?: string;
  /** Available options for selects / radio groups (trimmed for display). */
  options?: string[];
  /** Current value already present in the control, if any. */
  currentValue?: string;
}

// ---------------------------------------------------------------------------
// Popup <-> content script messages
// ---------------------------------------------------------------------------

export type ContentRequest =
  | { type: "PING" }
  | { type: "TOGGLE_PANEL" }
  | {
      type: "SCAN_PAGE";
      profile: UserApplicationProfile | null;
      fillEEO: boolean;
    }
  | { type: "FILL_FIELDS"; instructions: FillInstruction[] };

export interface PingResponse {
  ok: true;
  frameToken: string;
}

export interface ScanResponse {
  ok: boolean;
  error?: string;
  url: string;
  frameToken: string;
  fields: DetectedField[];
}

export interface FillInstruction {
  fieldId: string;
  value: string;
}

export interface FillOutcome {
  fieldId: string;
  ok: boolean;
  reason?: string;
}

export interface FillResponse {
  ok: boolean;
  error?: string;
  outcomes: FillOutcome[];
}

/** Fired by the content script when MutationObserver sees the form change. */
export interface FieldsUpdatedEvent {
  type: "FIELDS_UPDATED";
  url: string;
  fieldCount: number;
}

// ---------------------------------------------------------------------------
// Popup <-> background messages
// ---------------------------------------------------------------------------

export type BackgroundRequest =
  | { type: "GET_STATUS" }
  | { type: "LOGIN"; email: string; password: string }
  | { type: "GOOGLE_LOGIN" }
  | { type: "LOGOUT" }
  | { type: "GET_PROFILE"; forceRefresh?: boolean }
  | { type: "OPEN_DASHBOARD" };

export interface StatusResponse {
  ok: boolean;
  /** mock = sample data, connected = signed in, signedOut = needs login */
  mode: "mock" | "connected" | "signedOut";
  email?: string;
  /** Account name from /auth/me — used for the avatar before the profile loads. */
  firstName?: string;
  lastName?: string;
  apiBaseUrl: string;
}

export interface ProfileResponse {
  ok: boolean;
  error?: string;
  /** True when the user must sign in before a real profile can be fetched. */
  needsLogin?: boolean;
  profile?: UserApplicationProfile;
  source?: ProfileSource;
}

export interface LoginResponse {
  ok: boolean;
  error?: string;
}

export interface SimpleResponse {
  ok: boolean;
  error?: string;
}
