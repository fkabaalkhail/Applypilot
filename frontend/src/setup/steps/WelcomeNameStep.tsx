import type { StepProps } from "../types";

export function WelcomeNameStep({ answers, update }: StepProps) {
  return (
    <>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>First name</label>
        <input className="setup-input" value={answers.first_name}
          onChange={(e) => update({ first_name: e.target.value })} placeholder="Jane" />
      </div>
      <div className="setup-field">
        <label className="setup-label"><span className="req">*</span>Last name</label>
        <input className="setup-input" value={answers.last_name}
          onChange={(e) => update({ last_name: e.target.value })} placeholder="Doe" />
      </div>
    </>
  );
}
