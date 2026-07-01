import type { StepProps } from "../types";
import { EXPERIENCE_OPTIONS } from "../../components/JobFilterBar";

export function ExperienceStep({ answers, update }: StepProps) {
  return (
    <div className="setup-field">
      <label className="setup-label"><span className="req">*</span>Experience level</label>
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
  );
}
