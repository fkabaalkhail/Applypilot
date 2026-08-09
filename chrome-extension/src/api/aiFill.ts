/**
 * Calls the backend AI form-fill endpoint (POST /api/fill). The endpoint does
 * rule-based answers first, then Claude for the rest, and pulls the user's
 * resume from the DB — so we send an empty resumeText. Runs in the service
 * worker, where authedRequest handles auth + silent token refresh.
 */
import type {
  AiFillAnswer,
  AiFillField,
  ApplicantProfile,
  DroppedAnswer,
  JobContext,
} from "../shared/types";
import { authedRequest } from "./client";

interface FillApiResponse {
  answers: AiFillAnswer[];
  errors: string[];
  /** Candidate values the backend's grounding gate refused, with a reason.
   *  Absent from older backends — callers must treat it as optional. */
  dropped?: DroppedAnswer[];
}

export function buildFillRequestBody(
  fields: AiFillField[],
  jobContext: JobContext,
  profile?: ApplicantProfile
): {
  fields: AiFillField[];
  resumeText: string;
  jobDescription: string;
  jobTitle: string;
  company: string;
  profile?: ApplicantProfile;
} {
  return {
    fields,
    resumeText: "",
    jobDescription: jobContext.jobDescription,
    jobTitle: jobContext.jobTitle,
    company: jobContext.company,
    ...(profile ? { profile } : {}),
  };
}

export async function aiFillFields(
  fields: AiFillField[],
  jobContext: JobContext,
  profile?: ApplicantProfile
): Promise<FillApiResponse> {
  return authedRequest<FillApiResponse>("/api/fill", {
    method: "POST",
    body: JSON.stringify(buildFillRequestBody(fields, jobContext, profile)),
  });
}
