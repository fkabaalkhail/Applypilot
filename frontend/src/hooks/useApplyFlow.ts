import { useState, useEffect, useCallback } from "react";

const API_BASE = "";

/**
 * Hook to manage apply flow state for a specific job.
 * Tracks whether a tailored resume and cover letter are available,
 * so the ApplyFlowModal can display the correct checklist state.
 */

interface ApplyFlowState {
  /** Whether a tailored resume has been generated and accepted for this job */
  hasTailoredResume: boolean;
  /** Whether a cover letter has been generated for this job */
  hasCoverLetter: boolean;
  /** Whether the state is still loading */
  loading: boolean;
  /** Current apply session ID if an apply flow is in progress */
  sessionId: string | null;
  /** Whether the apply flow is currently active */
  isApplying: boolean;
  /** Refresh the state (e.g., after generating a new resume or cover letter) */
  refresh: () => void;
}

export function useApplyFlow(jobId: number): ApplyFlowState {
  const [hasTailoredResume, setHasTailoredResume] = useState(false);
  const [hasCoverLetter, setHasCoverLetter] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const fetchState = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Check if a tailored resume exists for this job
      const resumeRes = await fetch(`${API_BASE}/ai/tailor-resume/${jobId}/status`);
      if (resumeRes.ok) {
        const data = await resumeRes.json();
        setHasTailoredResume(data.has_accepted === true);
      } else {
        // Endpoint may not exist yet — fall back to checking via job data
        setHasTailoredResume(false);
      }
    } catch {
      setHasTailoredResume(false);
    }

    try {
      // Check if a cover letter exists for this job
      const coverRes = await fetch(`${API_BASE}/ai/cover-letter/${jobId}/status`);
      if (coverRes.ok) {
        const data = await coverRes.json();
        setHasCoverLetter(data.has_cover_letter === true);
      } else {
        setHasCoverLetter(false);
      }
    } catch {
      setHasCoverLetter(false);
    }

    setLoading(false);
  }, [jobId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Listen for apply flow session updates
  useEffect(() => {
    if (!sessionId) return;

    setIsApplying(true);

    // Poll for session completion
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/apply/${sessionId}/progress`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === "complete") {
            setIsApplying(false);
            setSessionId(null);
            clearInterval(interval);
          }
        }
      } catch {
        // Continue polling
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [sessionId]);

  return {
    hasTailoredResume,
    hasCoverLetter,
    loading,
    sessionId,
    isApplying,
    refresh: fetchState,
  };
}
