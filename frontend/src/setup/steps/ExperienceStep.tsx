import type { StepProps } from "../types";
import { EXPERIENCE_OPTIONS } from "../../components/JobFilterBar";

// "Internship" is deliberately absent — the experience question above owns that
// concept, and offering it in both places is what made the page ambiguous.
const JOB_TYPES = [
  { value: "full_time", label: "Full-time" },
  { value: "part_time", label: "Part-time" },
  { value: "contract", label: "Contract" },
];

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function ExperienceStep({ answers, update }: StepProps) {
  return (
    <>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>I'm looking for</label>
        <div className="setup-checkgrid">
          {EXPERIENCE_OPTIONS.map((opt) => (
            <label key={opt.value} className={`setup-check${answers.experience_level === opt.value ? " checked" : ""}`}>
              <input type="radio" name="experience" checked={answers.experience_level === opt.value}
                onChange={() => update({ experience_level: opt.value })} />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className="setup-field">
        <label className="setup-label">Job Type</label>
        <div className="setup-checkgrid">
          {JOB_TYPES.map((t) => (
            <label key={t.value} className={`setup-check${answers.job_types.includes(t.value) ? " checked" : ""}`}>
              <input type="checkbox" checked={answers.job_types.includes(t.value)}
                onChange={() => update({ job_types: toggle(answers.job_types, t.value) })} />
              {t.label}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
