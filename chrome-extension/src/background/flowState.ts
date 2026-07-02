/**
 * Per-tab multi-page flow state, session-scoped so it dies with the browser.
 * The background owns it because content scripts learn their tab id only from
 * a message sender — they read/write via FLOW_STATE_GET / FLOW_STATE_SET.
 */
import type { FlowState } from "../shared/types";

const KEY = "apFlowState";

type FlowMap = Record<string, FlowState>;

async function readMap(): Promise<FlowMap> {
  const got = await chrome.storage.session.get(KEY);
  return (got?.[KEY] as FlowMap) ?? {};
}

export async function getFlowState(tabId: number): Promise<FlowState | null> {
  const map = await readMap();
  return map[String(tabId)] ?? null;
}

export async function setFlowState(tabId: number, state: FlowState | null): Promise<void> {
  const map = await readMap();
  if (state) map[String(tabId)] = state;
  else delete map[String(tabId)];
  await chrome.storage.session.set({ [KEY]: map });
}

/** Forget a tab's flow when the tab closes. Call once at background startup. */
export function watchTabRemoval(): void {
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    void setFlowState(tabId, null);
  });
}
