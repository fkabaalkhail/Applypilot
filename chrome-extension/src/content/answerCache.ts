/**
 * Per-frame, in-memory session cache for backend answers, keyed by NORMALIZED
 * QUESTION TEXT (a page is one job, so field ids churn across re-scans but the
 * question is stable). Dedupes /api/fill calls across the frequent MutationObserver
 * re-scans/re-fills. Cleared on navigation (module lifetime); the backend keeps
 * cross-session memory, so no persistence is needed here.
 */
import type { DetectedField } from "../shared/types";
import type { PlannedAnswer } from "./aiFillPlanner";

/** Cached answer, id-agnostic (keyed by question). */
type CachedAnswer = Omit<PlannedAnswer, "id">;

const cache = new Map<string, CachedAnswer>();

/** Normalize a question label for stable keying. */
export function normalizeQuestion(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Split backend-bound fields into cache hits (answers ready) and misses (to fetch). */
export function splitByCache(fields: DetectedField[]): { hits: PlannedAnswer[]; misses: DetectedField[] } {
  const hits: PlannedAnswer[] = [];
  const misses: DetectedField[] = [];
  for (const f of fields) {
    const key = normalizeQuestion(f.label);
    const c = key ? cache.get(key) : undefined;
    if (c) hits.push({ id: f.id, ...c });
    else misses.push(f);
  }
  return { hits, misses };
}

/** Store non-empty answers by their field's normalized question. */
export function cacheAnswers(fields: DetectedField[], answers: PlannedAnswer[]): void {
  const byId = new Map(answers.map((a) => [a.id, a]));
  for (const f of fields) {
    const a = byId.get(f.id);
    const key = normalizeQuestion(f.label);
    if (a && a.answer && a.answer.trim() && key) {
      const { id, ...rest } = a;
      cache.set(key, rest);
    }
  }
}

/** Test-only reset. */
export function __resetCache(): void {
  cache.clear();
}
