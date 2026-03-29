/**
 * API client — all backend calls.
 */

import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// --- Applications ---

export interface Application {
  id: number;
  platform: string;
  company: string;
  role: string;
  url: string | null;
  status: string;
  applied_at: string;
  notes: string | null;
}

export interface Stats {
  total: number;
  this_week: number;
  by_platform: Record<string, number>;
  by_status: Record<string, number>;
}

export const fetchApplications = async (params?: Record<string, string>) => {
  const { data } = await api.get<Application[]>("/applications", { params });
  return data;
};

export const fetchStats = async () => {
  const { data } = await api.get<Stats>("/applications/stats");
  return data;
};

// --- Scraped Jobs ---

export interface ScrapedJob {
  id: number;
  platform: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  easy_apply: boolean;
  status: string;
  scraped_at: string;
  match_score: number;
  requirements_met: number;
  requirements_total: number;
  match_summary: string;
  requirements_detail: Array<{ requirement: string; met: boolean }>;
  salary_range: string;
  company_size: string;
  company_description: string;
  company_logo: string;
  ats_type: string;
}

export interface PendingQuestion {
  id: number;
  job_id: number;
  question: string;
  field_type: string;
  options: string[];
  answer: string | null;
  created_at: string;
}

export const scrapeJobs = async () => {
  const { data } = await api.post<{ task_id: string }>("/jobs/scrape");
  return data;
};

export const analyzeJobs = async () => {
  const { data } = await api.post<{ task_id: string }>("/jobs/analyze");
  return data;
};

export const connectLinkedIn = async () => {
  const { data } = await api.post<{ task_id: string; message: string }>("/jobs/connect");
  return data;
};

export const fetchJobs = async (params?: Record<string, string>) => {
  const { data } = await api.get<ScrapedJob[]>("/jobs", { params });
  return data;
};

export const applyToJob = async (jobId: number) => {
  const { data } = await api.post<{ task_id: string }>(`/jobs/${jobId}/apply`);
  return data;
};

export const fetchQuestions = async (jobId: number) => {
  const { data } = await api.get<PendingQuestion[]>(`/jobs/${jobId}/questions`);
  return data;
};

export const fetch2FAQuestion = async () => {
  const { data } = await api.get<PendingQuestion[]>(`/jobs/0/questions`);
  return data;
};

export const answerQuestion = async (questionId: number, answer: string) => {
  const { data } = await api.post<PendingQuestion>(
    `/jobs/questions/${questionId}/answer`,
    { answer }
  );
  return data;
};

export const resumeApply = async (jobId: number) => {
  const { data } = await api.post<{ task_id: string }>(`/jobs/${jobId}/resume-apply`);
  return data;
};

// --- Autopilot ---

export interface AutopilotStatus {
  running: boolean;
  task_id: string | null;
  applied_today: number;
  applied_this_week: number;
  total_interviews: number;
}

/** Raw shape returned by the backend /jobs/autopilot/status endpoint */
interface AutopilotStatusResponse {
  applied_today: number;
  applied_this_week: number;
  current_run: {
    task_id: string;
    status: string;
    started_at: string | null;
    stopped_at: string | null;
    total_applied: number;
    total_skipped: number;
    total_failed: number;
    total_waiting: number;
  } | null;
}

export interface RecentApplication {
  id: number;
  company: string;
  company_logo: string;
  title: string;
  applied_at: string;
}

export const startAutopilot = async () => {
  const { data } = await api.post<{ task_id: string }>("/jobs/autopilot/start");
  return data;
};

export const stopAutopilot = async () => {
  const { data } = await api.post<{ message: string }>("/jobs/autopilot/stop");
  return data;
};

export const fetchAutopilotStatus = async () => {
  const { data } = await api.get<AutopilotStatusResponse>("/jobs/autopilot/status");
  // Normalize backend response into the shape the frontend expects
  const running = data.current_run?.status === "running";
  return {
    running,
    task_id: data.current_run?.task_id ?? null,
    applied_today: data.applied_today,
    applied_this_week: data.applied_this_week,
    total_interviews: 0, // derived from application records with status "interviewing"
  } as AutopilotStatus;
};

export const fetchRecentApplications = async () => {
  // Fetch the 10 most recent applications and map to RecentApplication shape
  const { data } = await api.get<Application[]>("/applications", {
    params: { page: "1", page_size: "10" },
  });
  return data.map((app) => ({
    id: app.id,
    company: app.company,
    company_logo: "",
    title: app.role,
    applied_at: app.applied_at,
  })) as RecentApplication[];
};

// --- Connection Requests ---

export interface ConnectionRequest {
  id: number;
  contact_name: string;
  contact_title: string;
  company: string;
  role_applied: string;
  message_sent: string;
  status: string;
  sent_at: string;
}

export const fetchConnectionRequests = async () => {
  const { data } = await api.get<ConnectionRequest[]>("/jobs/connections");
  return data;
};

export const connectHiringManagers = async (jobId: number) => {
  const { data } = await api.post<{ task_id: string }>(`/jobs/${jobId}/connect`);
  return data;
};

// --- Pause Before Submit ---

export const approveSubmit = async (taskId: string) => {
  const { data } = await api.post(`/jobs/approve-submit/${taskId}`);
  return data;
};

export const cancelSubmit = async (taskId: string) => {
  const { data } = await api.post(`/jobs/cancel-submit/${taskId}`);
  return data;
};

// --- Settings ---

export interface Settings {
  linkedin_email: string;
  linkedin_password_set: boolean;
  linkedin_cookies_set: boolean;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  city: string;
  linkedin_url: string;
  website: string;
  resume_uploaded: boolean;
  resume_file_name: string;
  job_title: string;
  location: string;
  remote_only: boolean;
  max_applications_per_run: number;
  experience_levels: string[];
  work_type: string;
  regions: string[];
  prefilled_answers: Record<string, string>;
  autopilot_enabled: boolean;
  company_blacklist: string[];
  keyword_blacklist: string[];
  min_salary: number | null;
  max_salary: number | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  daily_apply_limit: number;
  weekly_apply_limit: number;
  apply_delay_min: number;
  apply_delay_max: number;
  pause_before_submit: boolean;
  follow_companies: boolean;
  hr_outreach_enabled: boolean;
  hr_daily_connect_limit: number;
  smooth_scrolling: boolean;
  resume_tailoring_enabled: boolean;
}

export const fetchSettings = async () => {
  const { data } = await api.get<Settings>("/settings");
  return data;
};

export const saveSettings = async (update: Record<string, unknown>) => {
  const { data } = await api.put<Settings>("/settings", update);
  return data;
};

// --- Application Review & Export ---

export interface ApplicationReview {
  id: number;
  platform: string;
  company: string;
  role: string;
  url: string | null;
  status: string;
  applied_at: string;
  notes: string | null;
  resume_version: string;
  screenshot_path: string;
  failure_screenshot_path: string;
  cover_letter_text: string;
  questions_answered: Array<{ question: string; answer: string; source: string }>;
  ats_type: string;
}

export const fetchReviewApplications = async (params?: Record<string, string>) => {
  const { data } = await api.get<ApplicationReview[]>("/applications/review", { params });
  return data;
};

export const exportApplicationsCSV = async () => {
  const response = await api.get("/applications/export", { responseType: "blob" });
  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", "applications_export.csv");
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
};
