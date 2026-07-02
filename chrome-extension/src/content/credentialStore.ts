/**
 * Device-local store for signup-wall credentials, keyed by origin.
 *
 * SECURITY POSTURE (spec): chrome.storage.local only — never synced, never
 * sent to the Tailrd backend, never included in any AI_FILL payload. The panel
 * shows these under "Saved sign-ins" (reveal/copy/delete); Chrome's own
 * password manager usually also offers to save on submit.
 */

const KEY = "apCredentials";

export interface SavedCredential {
  origin: string;
  email: string;
  password: string;
  createdAt: number;
}

type StoredCredential = Omit<SavedCredential, "origin">;
type CredMap = Record<string, StoredCredential>;

async function readAll(): Promise<CredMap> {
  const got = await chrome.storage.local.get(KEY);
  return (got?.[KEY] as CredMap) ?? {};
}

export async function saveCredential(origin: string, email: string, password: string): Promise<void> {
  const all = await readAll();
  all[origin] = { email, password, createdAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: all });
}

export async function getCredential(origin: string): Promise<SavedCredential | null> {
  const all = await readAll();
  const c = all[origin];
  return c ? { origin, ...c } : null;
}

export async function listCredentials(): Promise<SavedCredential[]> {
  const all = await readAll();
  return Object.entries(all)
    .map(([origin, c]) => ({ origin, ...c }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteCredential(origin: string): Promise<void> {
  const all = await readAll();
  delete all[origin];
  await chrome.storage.local.set({ [KEY]: all });
}
