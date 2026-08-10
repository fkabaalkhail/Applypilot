/**
 * Signup-wall password generation. Local-only: the password is written into
 * the page and saved to chrome.storage.local (credentialStore). It is never
 * sent to the Tailrd backend. Ambiguous glyphs (0/O, 1/l/I) are excluded so a
 * user reading the saved password back never mistypes it. Note that lowercase
 * `i`/`o` remain, only the visually confusable 0/O/1/l/I are dropped.
 */

const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, no L, no O
const DIGITS = "23456789"; // no 0, no 1
const SYMBOLS = "!@#$%^&*-_=+?";

/**
 * Pick `count` characters uniformly-at-random from `set`.
 *
 * `v % set.length` carries a small modulo bias (2^32 is not an exact multiple
 * of any of our set lengths). For a locally-generated, class-guaranteed signup
 * password this bias is negligible and acceptable. It does not weaken the
 * "one of every class + crypto-shuffled" guarantee the tests assert.
 */
function pick(set: string, count: number): string[] {
  const buf = crypto.getRandomValues(new Uint32Array(count));
  return Array.from(buf, (v) => set[v % set.length]);
}

export function generatePassword(length = 20): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  // One guaranteed character from each class, then fill the remainder from the
  // combined pool. Math.max(length - 4, 0) keeps this safe for length < 4.
  const chars = [
    ...pick(LOWER, 1),
    ...pick(UPPER, 1),
    ...pick(DIGITS, 1),
    ...pick(SYMBOLS, 1),
    ...pick(all, Math.max(length - 4, 0)),
  ];
  // Crypto-seeded Fisher-Yates so the guaranteed classes aren't positional.
  const rnd = crypto.getRandomValues(new Uint32Array(chars.length));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  // Slice guards the length < 4 case, where the four guaranteed picks exceed
  // the requested length.
  return chars.slice(0, length).join("");
}
