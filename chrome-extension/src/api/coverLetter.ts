/**
 * Calls the backend cover-letter endpoints (POST /api/cover-letter,
 * POST /api/render-cover-letter) from the service worker. Mirrors
 * api/tailorResume.ts: authedRequest handles auth + silent token refresh.
 * The server returns snake_case; these helpers normalize to camelCase.
 */
import type { JobContext } from "../shared/types";
import { authedRequest } from "./client";

export function buildCoverLetterRequestBody(
  resumeId: number | null,
  jobContext: JobContext,
  tone?: string | null,
  baseText?: string | null
): {
  resume_id: number | null;
  job_description: string;
  job_title: string;
  company: string;
  tone: string | null;
  base_text: string | null;
} {
  return {
    resume_id: resumeId,
    job_description: jobContext.jobDescription,
    job_title: jobContext.jobTitle,
    company: jobContext.company,
    tone: tone ?? null,
    base_text: baseText ?? null,
  };
}

export async function generateCoverLetter(
  resumeId: number | null,
  jobContext: JobContext,
  tone?: string | null,
  baseText?: string | null
): Promise<{ text: string }> {
  const raw = await authedRequest<{ text: string }>("/api/cover-letter", {
    method: "POST",
    body: JSON.stringify(buildCoverLetterRequestBody(resumeId, jobContext, tone, baseText)),
  });
  return { text: raw.text ?? "" };
}

export async function renderCoverLetter(
  text: string,
  filename?: string
): Promise<{ dataBase64: string; name: string; contentType: string }> {
  const res = await authedRequest<{ data_base64: string; name: string; content_type: string }>(
    "/api/render-cover-letter",
    { method: "POST", body: JSON.stringify({ text, filename: filename ?? null }) }
  );
  return { dataBase64: res.data_base64, name: res.name, contentType: res.content_type };
}
