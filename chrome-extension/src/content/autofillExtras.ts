/**
 * Device-local autofill extras: the user's own edits and additions layered over
 * the synced profile, kept in chrome.storage.local (never sent to the backend).
 *
 * The web-app profile is the source of truth for résumé-derived data, but the
 * user must be able to (a) edit fields the sync has no write path for (work
 * experience), and (b) add their own labelled fields for questions the profile
 * has no slot for. Those live here and are merged back in two places:
 *   - the profile the panel shows + the fill/AI context use (mergeProfileWithExtras)
 *   - the answer map the silent-refill path matches by label
 *     (customFieldAnswers), keyed by exact-normalized label
 *
 * Only non-empty values are persisted, so clearing a field falls back to the
 * synced value rather than masking it forever.
 */
import type { ExperienceEntry, UserApplicationProfile } from "../shared/types";
import { normalize } from "./fieldMatcher";

const STORE_KEY = "ap_autofill_extras";

/**
 * Scalar overrides that are NO LONGER device-local and must never be read back.
 *
 * `github` used to be edited here because the profile API had no write path for
 * it. It has one now (2026-08-09 profile-parity contract), so a stale local
 * value would permanently shadow whatever the user sets on the web app, the
 * exact bug the contract set out to kill. Dropping the key on READ makes that
 * unreachable, and the next saveExtras() (which prunes the normalized draft)
 * removes it from storage for good.
 */
const RETIRED_FIELD_KEYS: ReadonlySet<string> = new Set(["github"]);

/** A user-added labelled field the profile has no standard slot for. */
export interface CustomField {
  id: string;
  /** Which modal section it was added under (personal / experience / …). */
  section: string;
  label: string;
  value: string;
}

export interface AutofillExtras {
  /** Legacy overrides for scalar profile fields. Nothing in the UI writes these
   *  any more, every scalar the modal shows now round-trips through the
   *  profile API, but the merge is kept so an older stored blob still fills. */
  fields: Record<string, string>;
  /** User-edited work experience: null means "use the synced experience". */
  experience: ExperienceEntry[] | null;
  /** User-added labelled fields, filled by exact-normalized label match. */
  customFields: CustomField[];
}

export function emptyExtras(): AutofillExtras {
  return { fields: {}, experience: null, customFields: [] };
}

/** Coerce a possibly-partial/legacy stored blob into a well-formed AutofillExtras. */
export function normalizeExtras(raw: unknown): AutofillExtras {
  const r = (raw ?? {}) as Partial<AutofillExtras>;
  const fields: Record<string, string> = {};
  if (r.fields && typeof r.fields === "object") {
    for (const [k, v] of Object.entries(r.fields)) {
      if (RETIRED_FIELD_KEYS.has(k)) continue;
      if (typeof v === "string" && v.trim()) fields[k] = v;
    }
  }
  const experience = Array.isArray(r.experience)
    ? r.experience.filter((e): e is ExperienceEntry => !!e && typeof e === "object")
    : null;
  const customFields = Array.isArray(r.customFields)
    ? r.customFields
        .filter((c): c is CustomField => !!c && typeof c === "object" && typeof c.label === "string")
        .map((c) => ({
          id: String(c.id ?? cryptoId()),
          section: String(c.section ?? "personal"),
          label: String(c.label ?? ""),
          value: String(c.value ?? ""),
        }))
    : [];
  return { fields, experience, customFields };
}

/** Drop empty values so a cleared field falls back to the synced profile. */
export function pruneExtras(extras: AutofillExtras): AutofillExtras {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(extras.fields)) {
    if (typeof v === "string" && v.trim()) fields[k] = v.trim();
  }
  const customFields = extras.customFields
    .map((c) => ({ ...c, label: c.label.trim(), value: c.value.trim() }))
    .filter((c) => c.label && c.value);
  return { fields, experience: extras.experience, customFields };
}

export async function getExtras(): Promise<AutofillExtras> {
  try {
    const data = await chrome.storage.local.get(STORE_KEY);
    return normalizeExtras(data[STORE_KEY]);
  } catch {
    return emptyExtras();
  }
}

export async function saveExtras(extras: AutofillExtras): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORE_KEY]: pruneExtras(extras) });
  } catch {
    // Storage unavailable: the in-memory draft stays so a retry can persist it.
  }
}

/**
 * Apply the local overrides over the synced profile: non-empty scalar overrides
 * win, and a user-edited experience array replaces the synced one. Pure, never
 * mutates the input. This is the single merge used by the panel, the scanner and
 * the AI context, so what the user sees is exactly what fills.
 */
export function mergeProfileWithExtras(
  profile: UserApplicationProfile,
  extras: AutofillExtras
): UserApplicationProfile {
  const merged: UserApplicationProfile = { ...profile };
  for (const [k, v] of Object.entries(extras.fields)) {
    if (typeof v === "string" && v.trim()) {
      (merged as unknown as Record<string, string>)[k] = v.trim();
    }
  }
  if (extras.experience && extras.experience.length > 0) {
    merged.experience = extras.experience;
  }
  return merged;
}

/** Custom fields as a normalized-label → value map for the silent-refill path. */
export function customFieldAnswers(extras: AutofillExtras): Map<string, string> {
  const m = new Map<string, string>();
  for (const cf of extras.customFields) {
    const key = normalize(cf.label);
    const value = cf.value.trim();
    if (key && value) m.set(key, value);
  }
  return m;
}

/** Short unique id for a new custom field / experience entry. */
export function cryptoId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}
