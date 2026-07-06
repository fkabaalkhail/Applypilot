/**
 * Opens the real Tailrd app AI modals (résumé rewrite / cover letter) inside an
 * iframe overlay on a live application page, and bridges them to the extension.
 *
 * The app's /embed/* page and this content script talk over a private
 * MessageChannel (see frontend/src/pages/embed/embedApi.ts for the iframe side):
 *   iframe → us (window.postMessage): { type: "ready" } + transfers a port
 *   us → iframe (port):  { type: "init", token, job }
 *   iframe → us (port):  { type: "need-token" } → we reply { type: "token", token }
 *   iframe → us (port):  { type: "attach", kind, dataBase64, filename, contentType }
 *   iframe → us (port):  { type: "close" }
 *
 * The token never touches the host page's main world (it rides the port).
 */
export interface AttachFile {
  dataBase64: string;
  filename: string;
  contentType: string;
}

export interface AiModalJob {
  title: string;
  company: string;
  description: string;
  url: string;
}

interface BridgeCtx {
  job: AiModalJob;
  token: string;
  refreshToken: () => Promise<string>;
  onAttach: (kind: "resume" | "cover", file: AttachFile) => Promise<void>;
  postInit: (init: { type: "init"; token: string; job: AiModalJob }) => void;
  postToken: (t: string) => void;
  close: () => void;
}

/**
 * Pure message router (unit-tested). `port-open` is our synthetic trigger fired
 * once the iframe's "ready" has been received and the port is live.
 */
export async function handleBridgeMessage(msg: any, ctx: BridgeCtx): Promise<void> {
  switch (msg?.type) {
    case "port-open":
      ctx.postInit({ type: "init", token: ctx.token, job: ctx.job });
      return;
    case "need-token": {
      const t = await ctx.refreshToken();
      ctx.token = t;
      ctx.postToken(t);
      return;
    }
    case "attach":
      await ctx.onAttach(msg.kind, {
        dataBase64: msg.dataBase64,
        filename: msg.filename,
        contentType: msg.contentType,
      });
      return;
    case "close":
      ctx.close();
      return;
  }
}

export interface OpenAiModalOpts {
  kind: "resume" | "cover";
  appOrigin: string;
  job: AiModalJob;
  /** Current access token (already fresh). */
  getToken: () => Promise<string>;
  /** Force a refresh, returning the new token. */
  refreshToken: () => Promise<string>;
  onAttach: (kind: "resume" | "cover", file: AttachFile) => Promise<void>;
  /** Element to append the full-screen overlay to (usually document.body). */
  mount: HTMLElement;
}

/** Mount the iframe overlay and wire the MessageChannel bridge. */
export function openAiModal(opts: OpenAiModalOpts): { close: () => void } {
  const path = opts.kind === "resume" ? "/embed/custom-resume" : "/embed/cover-letter";

  const wrap = document.createElement("div");
  wrap.setAttribute("data-tailrd-ai-modal", "1");
  Object.assign(wrap.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    background: "rgba(15, 23, 42, 0.55)",
    display: "block",
  } as CSSStyleDeclaration);

  const iframe = document.createElement("iframe");
  iframe.src = `${opts.appOrigin}${path}`;
  iframe.allow = "clipboard-write";
  Object.assign(iframe.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    border: "none",
    background: "transparent",
  } as CSSStyleDeclaration);
  wrap.appendChild(iframe);
  opts.mount.appendChild(wrap);

  let port: MessagePort | null = null;
  const close = () => {
    port?.close();
    wrap.remove();
    window.removeEventListener("message", onReady);
  };

  const onReady = async (e: MessageEvent) => {
    if (e.origin !== opts.appOrigin) return;
    if (e.data?.type !== "ready" || !e.ports?.[0]) return;
    port = e.ports[0];
    const ctx: BridgeCtx = {
      job: opts.job,
      token: await opts.getToken(),
      refreshToken: opts.refreshToken,
      onAttach: opts.onAttach,
      postInit: (m) => port?.postMessage(m),
      postToken: (t) => port?.postMessage({ type: "token", token: t }),
      close,
    };
    port.onmessage = (ev) => {
      void handleBridgeMessage(ev.data, ctx);
    };
    port.start?.();
    void handleBridgeMessage({ type: "port-open" }, ctx);
  };
  window.addEventListener("message", onReady);

  return { close };
}
