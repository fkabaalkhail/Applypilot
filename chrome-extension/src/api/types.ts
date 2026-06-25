/**
 * Wire types for the ApplyPilot backend (FastAPI).
 * Field names use snake_case because that is what the API returns.
 */

/** POST /auth/login and /auth/refresh response. */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  email_verified?: boolean;
}

/** GET /auth/me response. */
export interface MeResponse {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  email_verified?: boolean;
}

/**
 * Subset of GET /settings we map into the application profile.
 * Used as a fallback until GET /api/user/application-profile exists.
 */
export interface BackendSettings {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  location?: string;
  linkedin_url?: string;
  website?: string;
  job_title?: string;
  resume_uploaded?: boolean;
  resume_file_name?: string;
  prefilled_answers?: Record<string, string>;
}

/** GET /resumes item (snake_case wire shape). */
export interface ResumeListItemWire {
  id: number;
  name: string;
  is_primary: boolean;
  has_file?: boolean;
  status?: string;
}

/** FastAPI error body. */
export interface ApiErrorBody {
  detail?: string;
}
