import axios, { type AxiosInstance } from "axios";

export interface EmbedJob {
  title: string;
  company: string;
  description: string;
  url: string;
}

export interface AttachFile {
  dataBase64: string;
  filename: string;
  contentType: string;
}

/**
 * Bridge between an /embed/* page (running framed inside an arbitrary ATS page)
 * and the extension content script that framed it. Communication is over a
 * private MessageChannel so the access token never touches the host page's main
 * world or a query string.
 *
 * Protocol (this iframe ⇄ the parent content script):
 *   iframe → parent (window.parent.postMessage): { type: "ready" } + transfers port2
 *   parent → iframe (port):  { type: "init", token, job }
 *   iframe → parent (port):  { type: "need-token" }
 *   parent → iframe (port):  { type: "token", token }
 *   iframe → parent (port):  { type: "attach", kind, dataBase64, filename, contentType }
 *   iframe → parent (port):  { type: "close" }
 */
export function createEmbedBridge(parentOrigin = "*") {
  const channel = new MessageChannel();
  const port = channel.port1;
  let token = "";
  let pendingToken: ((t: string) => void) | null = null;

  const ready = new Promise<{ token: string; job: EmbedJob }>((resolve) => {
    port.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === "init") {
        token = msg.token;
        resolve({ token: msg.token, job: msg.job });
      } else if (msg?.type === "token") {
        token = msg.token;
        pendingToken?.(msg.token);
        pendingToken = null;
      }
    };
  });
  port.start?.();
  window.parent.postMessage({ type: "ready" }, parentOrigin, [channel.port2]);

  return {
    ready,
    getToken: () => token,
    requestFreshToken: () =>
      new Promise<string>((resolve) => {
        pendingToken = resolve;
        port.postMessage({ type: "need-token" });
      }),
    attach: (kind: "resume" | "cover", file: AttachFile) =>
      port.postMessage({ type: "attach", kind, ...file }),
    close: () => port.postMessage({ type: "close" }),
  };
}

/**
 * Same-origin axios instance authorized with the port-provided token. On a 401
 * it asks the parent for a fresh token (the extension owns silent refresh) and
 * retries once.
 */
export function createEmbedAxios(
  getToken: () => string,
  onUnauthorized: () => Promise<string>,
): AxiosInstance {
  const inst = axios.create({ baseURL: "" }); // same-origin as the app
  inst.interceptors.request.use((cfg) => {
    const t = getToken();
    if (t) cfg.headers.Authorization = `Bearer ${t}`;
    return cfg;
  });
  inst.interceptors.response.use(
    (r) => r,
    async (error) => {
      const orig = error.config;
      if (error.response?.status === 401 && orig && !orig._retry) {
        orig._retry = true;
        const t = await onUnauthorized();
        orig.headers.Authorization = `Bearer ${t}`;
        return inst(orig);
      }
      return Promise.reject(error);
    },
  );
  return inst;
}
