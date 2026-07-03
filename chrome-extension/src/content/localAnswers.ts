/**
 * Device-local memory for sensitive answers that have no profile slot.
 *
 * The five standard EEO questions (gender, race, hispanic/latino, veteran,
 * disability) persist into the user's profile. Everything else the modal asks
 * that is classified sensitive — "I identify as transgender…", sexual
 * orientation, pronouns — must never leave the machine (the fill pipeline's
 * privacy rule: sensitive fields are never transmitted, see aiFillPlanner).
 * So those answers live here, in chrome.storage.local, keyed by the normalized
 * question text, and refill silently whenever the same question appears on a
 * future application.
 *
 * Exact-normalized matching only, on purpose: fuzzy matching is how a sensitive
 * answer ends up in the wrong question's dropdown. ATS vendors repeat these
 * questions verbatim across companies, so exact matching covers the real world.
 */
import { normalize } from "./fieldMatcher";

const STORE_KEY = "ap_local_answers";
/** Bound the store so it can't grow unattended forever. */
const MAX_ENTRIES = 200;

interface LocalAnswerEntry {
  answer: string;
  savedAt: number;
}

type LocalAnswerStore = Record<string, LocalAnswerEntry>;

async function readStore(): Promise<LocalAnswerStore> {
  const data = await chrome.storage.local.get(STORE_KEY);
  return (data[STORE_KEY] as LocalAnswerStore | undefined) ?? {};
}

/** Chains writes so concurrent saves (the modal saves one per answered field)
 *  never lose each other's entry to a read-modify-write race. */
let writeQueue: Promise<void> = Promise.resolve();

/** Save a sensitive answer under its normalized question. No-op on blank input. */
export function saveLocalAnswer(question: string, answer: string): Promise<void> {
  const key = normalize(question);
  if (!key || !answer.trim()) return Promise.resolve();
  const task = writeQueue.then(async () => {
    const store = await readStore();
    store[key] = { answer: answer.trim(), savedAt: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      // Drop the oldest entries beyond the cap.
      keys
        .sort((a, b) => store[a].savedAt - store[b].savedAt)
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => delete store[k]);
    }
    await chrome.storage.local.set({ [STORE_KEY]: store });
  });
  writeQueue = task.catch(() => {});
  return task;
}

/** All stored answers as a normalized-question → answer map. */
export async function getLocalAnswers(): Promise<Map<string, string>> {
  const store = await readStore();
  return new Map(Object.entries(store).map(([q, e]) => [q, e.answer]));
}

/** The stored answer for one question, or null. */
export async function getLocalAnswer(question: string): Promise<string | null> {
  const store = await readStore();
  return store[normalize(question)]?.answer ?? null;
}
