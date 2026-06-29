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

/** A resume available for syncing / auto-upload (mirrors a sync snapshot item). */
export interface ResumeSummary {
  id: number;
  name: string;
  isPrimary: boolean;
  /** True when the original PDF/DOCX is stored and can be auto-uploaded. */
  hasFile: boolean;
  fileName?: string;
  fileContentType?: string;
  updatedAt?: string | null;
}

/** A saved cover letter (mirrors a sync snapshot item). */
export interface CoverLetterSummary {
  id: number;
  jobTitle: string;
  company: string;
  text: string;
  tone: string;
  isActive: boolean;
  updatedAt?: string | null;
}

/** A job-specific / AI / user resume version (mirrors a sync snapshot item). */
export interface CustomResumeSummary {
  id: number;
  label: string;
  jobId: number | null;
  source: string;
  createdAt?: string | null;
}

/** Subscription status — forward-compatible stub until billing exists. */
export interface Subscription {
  tier: string;
  status: string;
}

/** Usage limits — forward-compatible stub until metering exists. */
export interface Usage {
  aiCreditsUsed: number;
  aiCreditsLimit: number | null;
}

/** Server-side settings the extension cares about. */
export interface SyncSettings {
  jobTitle: string;
  prefilledAnswers: Record<string, string>;
}

/**
 * One-shot snapshot of everything the extension syncs from the web app.
 * Mirrors GET /api/extension/sync. The web app is the source of truth.
 */
export interface ExtensionSyncSnapshot {
  version: number;
  updatedAt: string | null;
  profile: UserApplicationProfile;
  resumes: ResumeSummary[];
  activeResumeId: number | null;
  coverLetters: CoverLetterSummary[];
  customResumes: CustomResumeSummary[];
  settings: SyncSettings;
  subscription: Subscription;
  usage: Usage;
}

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
  | "combobox"
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
// AI-assisted fill (backend POST /api/fill)
// ---------------------------------------------------------------------------

/** A field handed to the backend AI fill endpoint (mirrors backend FormField). */
export interface AiFillField {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "radio" | "checkbox";
  options: string[];
  required: boolean;
}

/** Scraped page context that improves AI answers. Empty strings are fine. */
export interface JobContext {
  jobDescription: string;
  jobTitle: string;
  company: string;
}

/** One answer from the backend (mirrors backend FieldAnswer). */
export interface AiFillAnswer {
  id: string;
  label: string;
  answer: string;
  confidence: string;
  /** rule | profile | memory | ai — how the answer was produced. */
  source?: string;
  /** AI suggestions + company-specific memory matches need user review. */
  needsReview?: boolean;
  category?: string;
  canonicalQuestion?: string;
}

/** Background-worker reply for an AI_FILL request. */
export interface AiFillResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  answers: AiFillAnswer[];
  errors: string[];
}

/** An answer awaiting user review (Accept/Edit/Skip) before it fills + saves. */
export interface AiDraft {
  fieldId: string;
  label: string;
  value: string;
  /** "memory" (from a past application) | "ai" (suggestion) — drives the badge. */
  source?: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Résumé retailoring (backend POST /api/tailor-resume, /api/render-resume)
// ---------------------------------------------------------------------------

/** Opaque structured résumé document (backend ResumeDocument); passed through. */
export type ResumeDoc = Record<string, unknown>;

/** Options for a tailor request, chosen in the overlay. */
export interface TailorResumeOpts {
  resumeId: number | null;
  sections?: string[];
  /** null/undefined -> weave all missing keywords; a list -> exactly that set. */
  addKeywords?: string[] | null;
}

/** Normalized tailor result the overlay renders (camelCase). */
export interface TailorResult {
  document: ResumeDoc;
  originalScore: number;
  newScore: number;
  atsScore: number;
  keywordCoverage: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  diffSummary: string;
}

/** Background reply for TAILOR_RESUME. */
export interface TailorResumeResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  result?: TailorResult;
}

/** Background reply for RENDER_RESUME (mirrors ResumeFileResponse). */
export interface RenderResumeResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  dataBase64?: string;
  name: string;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Cover-letter generation (backend POST /api/cover-letter, /api/render-cover-letter)
// ---------------------------------------------------------------------------

/** Options for a cover-letter generate request, chosen in the overlay. */
export interface CoverLetterGenOpts {
  resumeId: number | null;
  tone?: string | null;
  /** null/undefined -> fresh letter; a string -> rewrite this text in `tone`. */
  baseText?: string | null;
}

/** Background reply for GENERATE_COVER_LETTER. */
export interface GenerateCoverLetterResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  text?: string;
}

/** Background reply for RENDER_COVER_LETTER (mirrors RenderResumeResponse). */
export interface RenderCoverLetterResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  dataBase64?: string;
  name: string;
  contentType: string;
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
  | { type: "FILL_FIELDS"; instructions: FillInstruction[] }
  | FormOpRequest
  | RemoteFormAvailable
  | RemoteFieldsUpdated;

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
// Cross-frame form support (form lives in a child iframe; panel in top frame)
// ---------------------------------------------------------------------------

/** Every OverlayCallbacks method name — the generic form-op surface. */
export type FormOpName =
  | "onAutofill"
  | "onInsertAnswer"
  | "onSaveAnswer"
  | "onRescan"
  | "onListResumes"
  | "onUploadResume"
  | "onTailorResume"
  | "onAttachTailored"
  | "onDownloadTailored"
  | "onGenerateCoverLetter"
  | "onInsertCoverLetter"
  | "onDownloadCoverLetter"
  | "onCopyCoverLetter"
  | "onProfileResolved";

/** One overlay operation, marshaled for execution in the form-owning frame. */
export interface FormOpRequest {
  type: "FORM_OP";
  op: FormOpName;
  args: unknown[];
}

/** Result of a FORM_OP, wrapping the callback's return value. */
export interface FormOpResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** A child frame telling the top frame it owns a real form. */
export interface RemoteFormAvailable {
  type: "REMOTE_FORM_AVAILABLE";
  frameId: number;
  recognized: number;
  fields: DetectedField[];
}

/** A child host pushing fresh fields (rescan / profile / mutation) to the top. */
export interface RemoteFieldsUpdated {
  type: "REMOTE_FIELDS_UPDATED";
  fields: DetectedField[];
}

/** Child → background: "I own a form." Background forwards as REMOTE_FORM_AVAILABLE. */
export interface FormHostAnnounce {
  type: "FORM_HOST_ANNOUNCE";
  recognized: number;
  fields: DetectedField[];
}

/** Top → background → host frame: run this overlay op in the owning frame. */
export interface RelayFormOp {
  type: "RELAY_FORM_OP";
  frameId: number;
  op: FormOpName;
  args: unknown[];
}

/** Host → background → top frame (frameId 0): deliver a push payload. */
export interface RelayToTop {
  type: "RELAY_TO_TOP";
  payload: RemoteFormAvailable | RemoteFieldsUpdated;
}

// ---------------------------------------------------------------------------
// Popup <-> background messages
// ---------------------------------------------------------------------------

export type BackgroundRequest =
  | { type: "GET_STATUS" }
  | { type: "CONNECT" }
  | { type: "LOGOUT" }
  | { type: "GET_PROFILE"; forceRefresh?: boolean }
  | { type: "GET_RESUMES" }
  | { type: "GET_SYNC"; forceRefresh?: boolean }
  | { type: "DOWNLOAD_RESUME"; resumeId: number }
  | { type: "OPEN_DASHBOARD" }
  | { type: "AI_FILL"; fields: AiFillField[]; jobContext: JobContext }
  | { type: "SAVE_ANSWER"; question: string; answer: string; jobContext: JobContext }
  | {
      type: "TAILOR_RESUME";
      resumeId: number | null;
      jobContext: JobContext;
      sections?: string[];
      addKeywords?: string[] | null;
    }
  | { type: "RENDER_RESUME"; document: ResumeDoc; filename?: string }
  | {
      type: "GENERATE_COVER_LETTER";
      resumeId: number | null;
      jobContext: JobContext;
      tone?: string | null;
      baseText?: string | null;
    }
  | { type: "RENDER_COVER_LETTER"; text: string; filename?: string }
  | FormHostAnnounce
  | RelayFormOp
  | RelayToTop;

export interface StatusResponse {
  ok: boolean;
  /** mock = sample data, connected = signed in, sessionExpired = was connected but refresh failed, signedOut = needs to connect */
  mode: "mock" | "connected" | "sessionExpired" | "signedOut";
  email?: string;
  /** Account name from /auth/me — used for the avatar before the profile loads. */
  firstName?: string;
  lastName?: string;
  apiBaseUrl: string;
  /** Subscription + usage from the cached snapshot (when connected). */
  subscription?: Subscription;
  usage?: Usage;
}

/** Full sync snapshot for the popup, with provenance. */
export interface SyncResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  snapshot?: ExtensionSyncSnapshot;
  source?: ProfileSource;
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

export interface ResumesResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  resumes: ResumeSummary[];
}

/** Resume file bytes (base64) for content-script injection into ATS forms. */
export interface ResumeFileResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  dataBase64?: string;
  name: string;
  contentType: string;
}

export interface SimpleResponse {
  ok: boolean;
  error?: string;
}
