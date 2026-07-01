import { useState } from "react";
import type { StepProps } from "../types";

export function TargetTitlesStep({ answers, update }: StepProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !answers.target_titles.includes(v)) update({ target_titles: [...answers.target_titles, v] });
    setDraft("");
  };
  return (
    <div className="setup-field">
      <label className="setup-label">Target roles or industries (optional)</label>
      <input className="setup-input" value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        placeholder="e.g. Frontend Engineer — press Enter to add" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {answers.target_titles.map((t) => (
          <span key={t} className="setup-check checked" style={{ padding: "6px 12px" }}
            onClick={() => update({ target_titles: answers.target_titles.filter((x) => x !== t) })}>
            {t} ✕
          </span>
        ))}
      </div>
    </div>
  );
}
