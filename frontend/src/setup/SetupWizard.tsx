import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import api from "../auth/api";
import { SetupLayout } from "./SetupLayout";
import { SETUP_STEPS } from "./setupConfig";
import { ResumeStep } from "./steps/ResumeStep";
import { answersToFilters } from "./answersToFilters";
import { emptyAnswers, type SetupAnswers, type SetupStep } from "./types";

// The appended resume step only needs id + headline: it is rendered specially
// below (via the `step.id === "resume"` check), never through `step.Component`.
type WizardStep = Pick<SetupStep, "id" | "headline"> & Partial<Omit<SetupStep, "id" | "headline">>;

const FILTER_STORAGE_KEY = "job-aggregator-filters";

export default function SetupWizard() {
  const { user, setSetupComplete } = useAuth();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [answers, setAnswers] = useState<SetupAnswers>(() => ({
    ...emptyAnswers,
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
  }));

  // Resume is the final step, appended after the config steps.
  const resumeStep: WizardStep = useMemo(
    () => ({ id: "resume", headline: "One last step — <b>level up</b> your search with your resume." }),
    [],
  );
  const steps: WizardStep[] = useMemo(() => [...SETUP_STEPS, resumeStep], [resumeStep]);
  const isLast = index === steps.length - 1;
  const step = steps[index];

  const update = (patch: Partial<SetupAnswers>) => setAnswers((a) => ({ ...a, ...patch }));

  const persist = async () => {
    // 1) Settings (durable). Failure surfaces but does not trap the user.
    try {
      await api.put("/settings", {
        first_name: answers.first_name,
        last_name: answers.last_name,
        job_title: answers.job_functions[0] ?? "",
        location: answers.city,
        remote_only: answers.open_to_remote,
        work_type: answers.open_to_remote ? "remote" : "",
        experience_levels: answers.experience_level ? [answers.experience_level] : [],
        regions: answers.country ? [answers.country] : [],
        prefilled_answers: {
          job_types: answers.job_types.join(","),
          work_authorization: answers.work_authorization.join(","),
          target_titles: answers.target_titles.join(","),
        },
      });
    } catch {
      /* non-fatal: user can re-save in Settings */
    }
    // 2) Resume upload (optional). Failure is non-fatal.
    if (resumeFile) {
      try {
        const fd = new FormData();
        fd.append("file", resumeFile);
        await api.post("/settings/resume", fd);
      } catch {
        /* non-fatal */
      }
    }
    // 3) Seed dashboard filters so first load is personalized.
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(answersToFilters(answers)));
    } catch {
      /* ignore quota */
    }
  };

  const handleNext = async () => {
    if (step.validate) {
      const msg = step.validate(answers);
      if (msg) { setError(msg); return; }
    }
    setError(null);
    if (!isLast) { setIndex((i) => i + 1); return; }
    // finish
    setSubmitting(true);
    await persist();
    try {
      await setSetupComplete(true);
      navigate("/app");
    } catch {
      setError("Something went wrong finishing setup. Please try again.");
      setSubmitting(false);
    }
  };

  const handleBack = () => { setError(null); setIndex((i) => Math.max(0, i - 1)); };

  return (
    <SetupLayout headline={step.headline} stepIndex={index} total={steps.length}>
      {step.id === "resume"
        ? <ResumeStep answers={answers} update={update} file={resumeFile} onFile={setResumeFile} />
        : step.Component && <step.Component answers={answers} update={update} />}
      {error && <div className="setup-error" role="alert">{error}</div>}
      <div className="setup-footer">
        {index > 0
          ? <button className="setup-back" onClick={handleBack} disabled={submitting}>Back</button>
          : <span />}
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {isLast && <button className="setup-skip" onClick={handleNext} disabled={submitting}>I'll do this later</button>}
          <button className="setup-btn" onClick={handleNext} disabled={submitting}>
            {isLast ? (submitting ? "Starting…" : "Start Matching") : "Next"}
          </button>
        </div>
      </div>
    </SetupLayout>
  );
}
