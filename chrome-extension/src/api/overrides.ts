/**
 * Server-override fetch + cache (the hot-fix layer). Runs in the SW; the cached
 * rules are handed to content scripts via GET_OVERRIDES. The endpoint is public
 * (field-mapping hints, no user data), so this uses an unauthenticated request
 * and works even before the user connects.
 */
import { publicRequest } from "./client";
import type { AutofillOverrideRule } from "../shared/types";

const CACHE_KEY = "apAutofillOverrides";

interface OverrideRulePayload {
  host: string;
  label_pattern: string;
  category: string;
  value_synonyms: Record<string, string>;
}
interface OverridesPayload {
  version: string;
  rules: OverrideRulePayload[];
}

/** Fetch the current rules and cache them. Best-effort; caller swallows errors. */
export async function fetchAndCacheOverrides(): Promise<void> {
  const payload = await publicRequest<OverridesPayload>("/autofill/overrides");
  await chrome.storage.local.set({ [CACHE_KEY]: { ...payload, ts: Date.now() } });
}

/** Cached rules in the extension's camelCase shape (empty when never fetched). */
export async function getCachedOverrideRules(): Promise<AutofillOverrideRule[]> {
  const got = await chrome.storage.local.get(CACHE_KEY);
  const cached = got?.[CACHE_KEY] as OverridesPayload | undefined;
  if (!cached?.rules) return [];
  return cached.rules.map((r) => ({
    host: r.host,
    labelPattern: r.label_pattern,
    category: r.category,
    valueSynonyms: r.value_synonyms ?? {},
  }));
}
