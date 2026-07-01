import type { StepProps } from "../types";
import { FileArrowUp } from "@phosphor-icons/react";

type Props = StepProps & { file: File | null; onFile: (f: File | null) => void };

export function ResumeStep({ file, onFile }: Props) {
  return (
    <div className="setup-field" style={{ textAlign: "center" }}>
      <label className="setup-check" style={{ justifyContent: "center", cursor: "pointer", padding: "16px" }}>
        <FileArrowUp size={20} weight="bold" />
        {file ? file.name : "Upload your resume"}
        <input type="file" accept=".pdf,.docx" hidden
          onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      </label>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 12 }}>
        PDF or Word, up to 10MB. Your resume is used only for job matching.
      </p>
    </div>
  );
}
