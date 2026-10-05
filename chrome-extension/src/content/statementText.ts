/**
 * What a long STATEMENT asks. A policy or certification paragraph mentions
 * many things it does not ask about: Flourish Research's equal-opportunity
 * policy names "gender identity" and asks for a name; SSCI's certification
 * names "disability-related information" and "a criminal records check" and
 * asks for an Accept; Credence's drug-test notice says "permitted to commence
 * work" and asks for initials (Workable bank, 2026-10-05). From this many
 * words on, only the parts that ask are read: its questions, its requests
 * ("Please indicate your current … status."), its last sentence that is not a
 * note, and a short title before a dash or colon ("School - …").
 */
export const STATEMENT_WORDS = 40;

const REQUEST = /^(please )?(select|indicate|enter|provide|list|choose|confirm|specify|state|share|tell|describe|type|write|check|mark|tick|identify|initial|sign)\b/i;
const NOTE = /^(\*+\s*)?(please )?(note|nb|n\.b\.)\b/i;

/** The sentences of a label, a sentence ending only before a capital or digit
 *  ("…work in the U.S. without sponsorship?" is one), after any closing quote. */
export function sentencesOf(raw: string): string[] {
  return (raw || "").split(/(?<=[.?!]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}

/** The asking parts of a statement, as written; the whole label when short. */
export function askedOfStatement(raw: string, words: number): string {
  if (words < STATEMENT_WORDS) return raw;
  const sentences = sentencesOf(raw);
  const said = sentences.filter((s) => !NOTE.test(s));
  const last = said[said.length - 1] ?? sentences[sentences.length - 1] ?? "";
  const asking = sentences.filter((s) => s !== last && (/\?\W*$/.test(s) || REQUEST.test(s)));
  const title = /^([^.?!:–-]{1,40}?)\s*[–:-]\s+/.exec(raw)?.[1] ?? "";
  return [title.split(/\s+/).length <= 5 ? title : "", ...asking, last].filter(Boolean).join(" ");
}
