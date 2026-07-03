/**
 * Saves a user-approved application answer to the Question Memory
 * (POST /api/answers). Runs in the service worker, where authedRequest handles
 * auth + silent token refresh.
 *
 * This is the only write path into the answer bank: the backend canonicalizes,
 * categorizes, embeds, and dedupes. Called only after the user accepts or edits
 * a suggestion in the review card — never automatically.
 */
import type { JobContext, SavedAnswerItem } from "../shared/types";
import { authedRaw, authedRequest } from "./client";

export interface SaveAnswerResult {
  id: number;
  category: string;
}

interface SavedAnswerRow {
  id: number;
  question_raw: string;
  answer: string;
  category: string;
  times_reused: number;
}

/** List the user's remembered answers (Question Memory) for the Autofill
 *  Information → Remembered answers list. */
export async function listAnswers(): Promise<SavedAnswerItem[]> {
  const rows = await authedRequest<SavedAnswerRow[]>("/api/answers", { method: "GET" });
  return rows.map((r) => ({
    id: r.id,
    question: r.question_raw,
    answer: r.answer,
    category: r.category,
    timesReused: r.times_reused ?? 0,
  }));
}

/** Edit a remembered answer's text in place (keyed by id — never forks a row). */
export async function updateAnswer(id: number, answer: string): Promise<void> {
  await authedRequest<SavedAnswerRow>(`/api/answers/${id}`, {
    method: "PUT",
    body: JSON.stringify({ answer }),
  });
}

/** Forget a remembered answer. */
export async function deleteAnswer(id: number): Promise<void> {
  await authedRaw(`/api/answers/${id}`, { method: "DELETE" });
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
