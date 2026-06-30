import { useEffect, useState } from "react";
import api from "../auth/api";
import { downloadDocx } from "../lib/docx";
import type { AIJob } from "./CustomResumeModal";
import "./ai-flow.css";

interface ResumeOption {
  id: number;
  name: string;
  is_primary: boolean;
}

const TONES = ["Professional", "Formal", "Enthusiastic", "Concise", "Technical"];

function errorMessage(err: unknown, fallback: string): string {
  const r = (err as { response?: { data?: { detail?: string }; status?: number } })?.response;
  if (r?.status === 400) return r.data?.detail || "Upload a resume first to generate a cover letter.";
  if (r?.status === 503) return "AI is temporarily unavailable. Please try again in a moment.";
  return r?.data?.detail || fallback;
}

export default function CoverLetterModal({ job, onClose }: { job: AIJob; onClose: () => void }) {
  const [resumes, setResumes] = useState<ResumeOption[]>([]);
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyTone, setBusyTone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Edit + save parity with the resume flow: track unsaved edits + a transient
  // "Saved ✓" confirmation. Fresh/regenerated text is considered already-clean.
  const [tone, setTone] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function generate(rid: number | null, tone?: string, base?: string) {
    if (tone) setBusyTone(tone);
    else setLoading(true);
    setError("");
    try {
      const res = await api.post<{ text: string }>(`/ai/cover-letter/${job.id}`, {
        resume_id: rid,
        tone: tone?.toLowerCase() ?? null,
        base_text: base ?? null,
      });
      setText(res.data.text);
      setTone(tone?.toLowerCase() ?? null);
      setDirty(false);
      setSaved(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't generate the cover letter. Please try again."));
    } finally {
      setLoading(false);
      setBusyTone(null);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.post("/ai/cover-letters", {
        job_id: job.id,
        company: job.company,
        job_title: job.title,
        job_url: job.url,
        text,
        tone: tone ?? "",
        set_active: true,
      });
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the cover letter. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  // On open: load resumes, then auto-generate with the default resume.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<ResumeOption[]>("/resumes");
        if (cancelled) return;
        setResumes(res.data);
        const def = res.data.find((r) => r.is_primary) ?? res.data[0];
        const rid = def?.id ?? null;
        setResumeId(rid);
        await generate(rid);
      } catch {
        if (!cancelled) await generate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPickResume(id: number) {
    setResumeId(id);
    void generate(id);
  }

  function download() {
    const slug = job.company.toLowerCase().replace(/\s+/g, "-");
    void downloadDocx(`cover-letter-${slug}.docx`, text, {
      title: `Cover Letter — ${job.company}`,
    });
  }

  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const busy = loading || busyTone !== null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="ai-modal" style={{ width: "min(760px, 94vw)", height: "min(760px, 90vh)" }} onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-head">
          <div className="ai-head-top">
            <button className="ai-modal-close" onClick={onClose} aria-label="Close">✕</button>
            <span className="ai-modal-title">Generate Cover Letter</span>
            <span className="ai-modal-sub">{job.title} · {job.company}</span>
          </div>
        </div>

        <div className="ai-modal-body">
          <div className="ai-overview" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
            <div className="ai-ov-cell">
              <span className="ai-ov-eyebrow">Based on your resume</span>
              <select
                className="ai-resume-pick"
                value={resumeId ?? ""}
                onChange={(e) => onPickResume(Number(e.target.value))}
                disabled={resumes.length === 0 || busy}
              >
                {resumes.length === 0 && <option>No resume uploaded</option>}
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{r.is_primary ? " (default)" : ""}</option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <div className="ai-loading">
              <div className="ai-spinner" />
              <div className="ai-loading-title">Writing your cover letter…</div>
            </div>
          ) : error ? (
            <div className="ai-error-box">
              <p>{error}</p>
              <button className="ai-btn ai-btn-soft" onClick={() => generate(resumeId)}>Try again</button>
            </div>
          ) : (
            <>
              <textarea
                className="ai-cl-textarea"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                  setSaved(false);
                }}
                spellCheck
              />
              <div className="ai-card-label" style={{ marginTop: 16 }}>Adjust tone</div>
              <div className="ai-tones">
                {TONES.map((t) => (
                  <button
                    key={t}
                    className="ai-tone"
                    disabled={busy}
                    onClick={() => generate(resumeId, t, text)}
                  >
                    {busyTone === t ? "…" : `Make More ${t}`}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="ai-modal-foot">
          <button className="ai-btn ai-btn-ghost ai-foot-left" onClick={() => generate(resumeId)} disabled={busy}>
            Regenerate
          </button>
          <button className="ai-btn ai-btn-ghost" onClick={copy} disabled={busy || !text}>{copied ? "Copied!" : "Copy"}</button>
          <button className="ai-btn ai-btn-soft" onClick={save} disabled={busy || saving || !text || !dirty}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
          <button className="ai-btn ai-btn-soft" onClick={download} disabled={busy || !text}>Download .docx</button>
          <a className="ai-btn ai-btn-primary" href={job.url} target="_blank" rel="noopener noreferrer">Apply Now</a>
        </div>
      </div>
    </div>
  );
}
