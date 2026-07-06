import { useCallback, useEffect, useRef, useState } from "react";
import api from "./useAuthFetch";

export type UploadState = "upload" | "progress" | "success" | "error";

export interface UploadResult {
  id: number;
  profile: { name?: string; [k: string]: unknown };
}

export const RESUME_UPLOAD_TIPS = [
  "Extracting text from your resume...",
  "Identifying your skills and experience...",
  "Analyzing education and certifications...",
  "Building your structured profile...",
];

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const ACCEPTED_EXTENSIONS = [".pdf", ".docx"];

export function isValidResumeFile(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  return ACCEPTED_EXTENSIONS.includes(ext);
}

export function useResumeUpload(opts?: { onSuccess?: (r: UploadResult) => void }) {
  const [state, setState] = useState<UploadState>("upload");
  const [tipIndex, setTipIndex] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const tipTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onSuccess = opts?.onSuccess;

  useEffect(() => {
    if (state === "progress") {
      tipTimer.current = setInterval(
        () => setTipIndex((p) => (p + 1) % RESUME_UPLOAD_TIPS.length),
        3000,
      );
    } else if (tipTimer.current) {
      clearInterval(tipTimer.current);
      tipTimer.current = null;
    }
    return () => { if (tipTimer.current) clearInterval(tipTimer.current); };
  }, [state]);

  const upload = useCallback(async (file: File) => {
    setFileError(null);
    setApiError(null);
    if (!isValidResumeFile(file)) {
      setFileError("Only PDF and DOCX files are accepted.");
      return;
    }
    setState("progress");
    setTipIndex(0);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post("/resumes/upload", fd);
      const data = res.data as UploadResult;
      setResult(data);
      setState("success");
      onSuccess?.(data);
    } catch (err: any) {
      setApiError(err?.response?.data?.detail || err?.message || "Upload failed.");
      setState("error");
    }
  }, [onSuccess]);

  const reset = useCallback(() => {
    setApiError(null);
    setFileError(null);
    setState("upload");
  }, []);

  return { state, tipIndex, fileError, apiError, result, upload, reset };
}
