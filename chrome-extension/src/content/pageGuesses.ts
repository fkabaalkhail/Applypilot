/**
 * Values a page puts in its own boxes from where the visitor is, not from
 * anything the applicant said. Workable guesses the Address from the
 * requester's IP: its public form JSON (GET /api/v1/jobs/<code>/form) serves
 * that field with `prefilledByLocation: true` and the value it guessed, and
 * the page shows it. Someone applying from elsewhere (a trip, a VPN) got the
 * page's city sent as theirs, because the fill never overwrites a value
 * already there. A box still holding the guess is empty to the fill, like a
 * dial-code picker's preset; a box the person changed is theirs.
 */

/** Guessed values by field id (Workable's ids are the inputs' ids and names). */
let guesses = new Map<string, string>();

export function setPageGuesses(next: Map<string, string>): void {
  guesses = next;
}

/** A Workable posting's code in its application address. */
export function workableShortcode(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "apply.workable.com") return null;
    return /\/j\/([A-Z0-9]{6,})(?:\/|$)/i.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The fields Workable filled from the visitor's location, with the value it put in. */
export function prefilledGuesses(formJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.prefilledByLocation === true && typeof o.id === "string" && typeof o.value === "string" && o.value.trim()) {
      out.set(o.id, o.value);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(formJson);
  return out;
}

/**
 * Read the posting's form once (one GET, the request the page itself makes)
 * and remember what it guessed. A failed read leaves no guesses: the boxes
 * then stay as they are, as before.
 */
export async function loadWorkableGuesses(
  url: string,
  fetchImpl: (input: string) => Promise<Response> = (input) => fetch(input, { credentials: "omit" })
): Promise<void> {
  const code = workableShortcode(url);
  if (!code) return;
  try {
    const resp = await fetchImpl(`https://apply.workable.com/api/v1/jobs/${code}/form`);
    if (!resp.ok) return;
    setPageGuesses(prefilledGuesses(await resp.json()));
  } catch {
    // Offline or blocked: no guesses, nothing is overwritten.
  }
}

/** The box still shows exactly what the page guessed for it. */
export function holdsPageGuess(el: HTMLElement): boolean {
  if (guesses.size === 0 || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  const guess = guesses.get(el.id) ?? guesses.get(el.name);
  return guess !== undefined && el.value.trim() === guess.trim();
}
