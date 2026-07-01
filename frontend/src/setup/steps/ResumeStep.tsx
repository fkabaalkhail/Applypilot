import type { StepProps } from "../types";
import { FileArrowUp, CheckCircle } from "@phosphor-icons/react";

type Props = StepProps & { file: File | null; onFile: (f: File | null) => void };

export function ResumeStep({ file, onFile }: Props) {
  return (
    <div className="setup-resume">
      <label className={`setup-resume-card${file ? " filled" : ""}`}>
        <span className="setup-resume-icon">
          <FileArrowUp size={26} weight="bold" />
        </span>
        {file ? (
          <>
            <span className="setup-resume-filename">
              <CheckCircle size={18} weight="fill" /> {file.name}
            </span>
            <span className="setup-resume-change">Click to choose a different file</span>
          </>
        ) : (
          <>
            <span className="setup-resume-title">Upload your resume</span>
            <span className="setup-resume-hint">PDF or Word · up to 10MB</span>
          </>
        )}
        <input
          type="file"
          accept=".pdf,.docx"
          hidden
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <p className="setup-resume-privacy">
        We use your resume only to match you with the right jobs and tailor your applications —
        it's never shared with third parties.
      </p>
    </div>
  );
}
