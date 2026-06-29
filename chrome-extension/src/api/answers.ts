/**
 * Saves a user-approved application answer to the Question Memory
 * (POST /api/answers). Runs in the service worker, where authedRequest handles
 * auth + silent token refresh.
 *
 * This is the only write path into the answer bank: the backend canonicalizes,
 * categorizes, embeds, and dedupes. Called only after the user accepts or edits
 * a suggestion in the review card — never automatically.
 */
import type { JobContext } from "../shared/types";
import { authedRequest } from "./client";

export interface SaveAnswerResult {
  id: number;
  category: string;
}

export async function saveAnswer(
  question: string,
  answer: string,
  jobContext: JobContext,
  fieldType = "text"
): Promise<SaveAnswerResult> {
  return authedRequest<SaveAnswerResult>("/api/answers", {
    method: "POST",
    body: JSON.stringify({
      question,
      answer,
      company: jobContext.company,
      jobTitle: jobContext.jobTitle,
      fieldType,
    }),
  });
}
