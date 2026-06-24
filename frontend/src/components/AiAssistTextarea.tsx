import { createContext, useContext, useRef, useState } from "react";
import api from "../auth/api";
import "./assist.css";

// Inline AI editing assistant (Phase 5 / spec Step 11). A textarea that, when
// the user selects text, floats a toolbar of actions. Each action sends ONLY the
// selected snippet to /ai/edit-snippet and replaces the selection with the
// result — the rest of the resume is untouched, no full regeneration.

interface AssistCtx {
  jobId?: number | null;
}
const AssistContext = createContext<AssistCtx>({});
export const AssistProvider = AssistContext.Provider;

const ACTIONS: { key: string; label: string }[] = [
  { key: "rewrite", label: "Rewrite" },
  { key: "shorten", label: "Shorten" },
  { key: "expand", label: "Expand" },
  { key: "professional", label: "Professional" },
  { key: "ats", label: "ATS" },
  { key: "impact", label: "Impact" },
  { key: "grammar", label: "Grammar" },
];

interface Props {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}

export default function AiAssistTextarea({ value, onChange, rows, placeholder, className }: Props) {
  const { jobId } = useContext(AssistContext);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const syncSel = () => {
    const el = ref.current;
    if (!el) return;
    if (el.selectionStart !== el.selectionEnd) {
      setSel({ start: el.selectionStart, end: el.selectionEnd });
      setErr("");
    } else {
      setSel(null);
    }
  };

  async function run(action: string) {
    if (!sel) return;
    const selected = value.slice(sel.start, sel.end);
    if (!selected.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const res = await api.post<{ text: string }>("/ai/edit-snippet", {
        text: selected,
        action,
        job_id: jobId ?? null,
      });
      onChange(value.slice(0, sel.start) + (res.data.text ?? selected) + value.slice(sel.end));
      setSel(null);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      setErr(status === 503 ? "AI busy — try again." : "Couldn't edit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="assist-wrap">
      <textarea
        ref={ref}
        className={className}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSelect={syncSel}
        onMouseUp={syncSel}
        onKeyUp={syncSel}
      />
      {sel && (
        <div className="assist-bar" onMouseDown={(e) => e.preventDefault()}>
          <span className="assist-spark">✨</span>
          {busy ? (
            <span className="assist-busy">Working…</span>
          ) : (
            <>
              {ACTIONS.map((a) => (
                <button key={a.key} type="button" className="assist-btn" onClick={() => run(a.key)}>
                  {a.label}
                </button>
              ))}
              {err && <span className="assist-err">{err}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
