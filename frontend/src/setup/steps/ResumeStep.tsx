import { useRef } from "react";
import { FileArrowUp, CheckCircle, CircleNotch } from "@phosphor-icons/react";
import { useResumeUpload, RESUME_UPLOAD_TIPS } from "../../hooks/useResumeUpload";

type Props = { uploadedResumeId: number | null; onUploaded: (id: number) => void };

export function ResumeStep({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, tipIndex, fileError, apiError, upload, reset } = useResumeUpload({
    onSuccess: (r) => onUploaded(r.id),
  });

  return (
    <div className="setup-resume">
      {state === "progress" ? (
        <div className="setup-resume-card filled" aria-busy="true">
          <span className="setup-resume-icon"><CircleNotch size={26} weight="bold" className="spin" /></span>
          <span className="setup-resume-title">Analyzing your resume…</span>
          <span className="setup-resume-hint">{RESUME_UPLOAD_TIPS[tipIndex]}</span>
        </div>
      ) : state === "success" ? (
        <div className="setup-resume-card filled">
          <span className="setup-resume-icon"><CheckCircle size={26} weight="fill" /></span>
          <span className="setup-resume-filename"><CheckCircle size={18} weight="fill" /> Resume analyzed</span>
          <button type="button" className="setup-resume-change" onClick={reset}>
            Upload a different file
          </button>
        </div>
      ) : (
        <label className="setup-resume-card">
          <span className="setup-resume-icon"><FileArrowUp size={26} weight="bold" /></span>
          <span className="setup-resume-title">Upload your resume</span>
          <span className="setup-resume-hint">PDF or Word · up to 10MB</span>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
          />
        </label>
      )}
      {(fileError || apiError) && <div className="setup-error" role="alert">{fileError || apiError}</div>}
      <p className="setup-resume-privacy">
        We use your resume only to match you with the right jobs and tailor your applications —
        it's never shared with third parties.
      </p>
    </div>
  );
}
