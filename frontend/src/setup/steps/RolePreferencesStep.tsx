import type { StepProps } from "../types";
import { JOB_FUNCTION_OPTIONS, COUNTRY_OPTIONS } from "../../components/JobFilterBar";

const JOB_TYPES = [
  { value: "full_time", label: "Full-time" },
  { value: "contract", label: "Contract" },
  { value: "part_time", label: "Part-time" },
  { value: "internship", label: "Internship" },
];

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function RolePreferencesStep({ answers, update }: StepProps) {
  return (
    <>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Job Function</label>
        <div className="setup-checkgrid">
          {JOB_FUNCTION_OPTIONS.map((fn) => (
            <label key={fn} className={`setup-check${answers.job_functions.includes(fn) ? " checked" : ""}`}>
              <input type="checkbox" checked={answers.job_functions.includes(fn)}
                onChange={() => update({ job_functions: toggle(answers.job_functions, fn) })} />
              {fn}
            </label>
          ))}
        </div>
      </div>

      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Job Type</label>
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

      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Location</label>
        <div className="setup-checkgrid">
          <select className="setup-select" value={answers.country}
            onChange={(e) => update({ country: e.target.value })}>
            <option value="">Select country</option>
            {COUNTRY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <input className="setup-input" value={answers.city}
            onChange={(e) => update({ city: e.target.value })} placeholder="City (optional)" />
        </div>
        <label className={`setup-check${answers.open_to_remote ? " checked" : ""}`} style={{ marginTop: 10 }}>
          <input type="checkbox" checked={answers.open_to_remote}
            onChange={(e) => update({ open_to_remote: e.target.checked })} />
          Open to Remote
        </label>
      </div>

      <div className="setup-field">
        <label className="setup-label">Work Authorization</label>
        <label className={`setup-check${answers.work_authorization.includes("needs_sponsorship") ? " checked" : ""}`}>
          <input type="checkbox" checked={answers.work_authorization.includes("needs_sponsorship")}
            onChange={() => update({ work_authorization: toggle(answers.work_authorization, "needs_sponsorship") })} />
          I will need visa sponsorship
        </label>
      </div>
    </>
  );
}
