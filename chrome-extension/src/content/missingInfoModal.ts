/**
 * Frame-local "we don't have an answer for this" modal.
 *
 * Autofill fills silently, but a job form often asks something that isn't in the
 * user's profile or answer bank — and that the AI couldn't answer either. Rather
 * than leave a required field blank, we ask the user once, right here in the same
 * frame that owns the form, then fill their answer and save it so the next
 * application fills it automatically (see contentScript → SAVE_ANSWER).
 *
 * Self-contained: its own shadow root and inline styles, with no dependency on
 * the side-panel overlay, so it works whether the form lives in the top frame or
 * an embedded ATS iframe (that's the frame fillOnce runs in).
 */

export interface MissingFieldPrompt {
  /** DetectedField id — used to fill the control after the user answers. */
  id: string;
  /** The question as shown on the form (also the key we remember it under). */
  label: string;
  multiline?: boolean;
}

const HOST_ID = "tailrd-missing-info-host";

/**
 * Show the modal for the given questions. Resolves with a { fieldId: answer } map
 * containing only the questions the user actually answered, or null if they
 * skipped / dismissed it.
 */
export function promptForMissingFields(
  prompts: MissingFieldPrompt[]
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    // Never stack two prompts (e.g. a second fill pass while one is open).
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    (document.body ?? document.documentElement).appendChild(host);

    let settled = false;
    const done = (result: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener("keydown", onKey, true);

    const rows = prompts
      .map(
        (p, i) => `
        <label class="mi-row">
          <span class="mi-q">${escapeHtml(p.label)}</span>
          ${
            p.multiline
              ? `<textarea data-i="${i}" rows="3" placeholder="Type your answer"></textarea>`
              : `<input data-i="${i}" type="text" placeholder="Type your answer" />`
          }
        </label>`
      )
      .join("");

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .mi-backdrop {
          position: fixed; inset: 0; z-index: 2147483647;
          display: flex; align-items: center; justify-content: center;
          background: rgba(15, 23, 42, 0.55); padding: 20px;
        }
        .mi-card {
          width: 100%; max-width: 460px; max-height: 88vh; overflow-y: auto;
          background: #fff; border-radius: 14px;
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
          animation: mi-in 0.16s ease;
        }
        @keyframes mi-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .mi-head { padding: 22px 24px 8px; }
        .mi-head h2 { margin: 0 0 6px; font-size: 17px; font-weight: 700; color: #0f172a; }
        .mi-head p { margin: 0; font-size: 13px; line-height: 1.5; color: #64748b; }
        .mi-body { padding: 8px 24px 4px; display: flex; flex-direction: column; gap: 14px; }
        .mi-row { display: flex; flex-direction: column; gap: 6px; }
        .mi-q { font-size: 13px; font-weight: 600; color: #334155; }
        .mi-body input, .mi-body textarea {
          width: 100%; padding: 10px 12px; font-size: 13.5px; color: #0f172a;
          border: 1px solid #d5dbe5; border-radius: 8px; background: #fff;
          resize: vertical; font-family: inherit;
        }
        .mi-body input:focus, .mi-body textarea:focus {
          outline: none; border-color: #635bff; box-shadow: 0 0 0 3px rgba(99, 91, 255, 0.15);
        }
        .mi-foot {
          padding: 16px 24px 22px; display: flex; justify-content: flex-end; gap: 10px;
        }
        .mi-foot button {
          padding: 10px 18px; font-size: 13.5px; font-weight: 600; border-radius: 8px; cursor: pointer;
          border: 1px solid transparent;
        }
        .mi-skip { background: #fff; border-color: #d5dbe5; color: #475569; }
        .mi-skip:hover { background: #f8fafc; }
        .mi-save { background: #635bff; color: #fff; }
        .mi-save:hover { background: #4f46e5; }
      </style>
      <div class="mi-backdrop">
        <div class="mi-card" role="dialog" aria-modal="true" aria-labelledby="mi-title">
          <div class="mi-head">
            <h2 id="mi-title">A few details we don't have yet</h2>
            <p>This application asks something that isn't in your profile. Answer once and we'll save it to your profile for next time.</p>
          </div>
          <div class="mi-body">${rows}</div>
          <div class="mi-foot">
            <button class="mi-skip" type="button">Skip</button>
            <button class="mi-save" type="button">Save &amp; fill</button>
          </div>
        </div>
      </div>
    `;

    const collect = (): Record<string, string> => {
      const out: Record<string, string> = {};
      shadow.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i]").forEach((el) => {
        const i = Number(el.dataset.i);
        const val = el.value.trim();
        if (val && prompts[i]) out[prompts[i].id] = val;
      });
      return out;
    };

    shadow.querySelector(".mi-skip")!.addEventListener("click", () => done(null));
    shadow.querySelector(".mi-save")!.addEventListener("click", () => {
      const answers = collect();
      done(Object.keys(answers).length ? answers : null);
    });
    shadow.querySelector(".mi-backdrop")!.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) done(null);
    });

    (shadow.querySelector("[data-i]") as HTMLElement | null)?.focus();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
