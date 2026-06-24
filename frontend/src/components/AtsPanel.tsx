import { useMemo, useState } from "react";
import type { ResumeDocument } from "../lib/resumeDocument";
import { analyzeKeywords } from "../lib/keywordMatch";
import "./ats-panel.css";

// Live ATS panel (Phase 3). Recomputes keyword coverage against the CURRENT
// document on every edit, lists matched/missing keywords, and lets the user add
// missing ones to the Skills section in one click (deterministic, no LLM).

interface AtsPanelProps {
  keywords: string[];
  document: ResumeDocument;
  suggestions?: string[];
  onAddSkills: (skills: string[]) => void;
  highlightOn: boolean;
  onToggleHighlight: () => void;
}

export default function AtsPanel({
  keywords,
  document: doc,
  suggestions = [],
  onAddSkills,
  highlightOn,
  onToggleHighlight,
}: AtsPanelProps) {
  const analysis = useMemo(() => analyzeKeywords(keywords, doc), [keywords, doc]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const missing = analysis.results.filter((r) => r.status === "red");
  const present = analysis.results.filter((r) => r.status !== "red");
  const validSelected = [...selected].filter((k) => missing.some((m) => m.keyword === k));

  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const apply = (skills: string[]) => {
    if (!skills.length) return;
    onAddSkills(skills);
    setSelected(new Set());
  };

  const cov = analysis.coverage;
  const covColor = cov >= 80 ? "#16a34a" : cov >= 55 ? "#d97706" : "#dc2626";

  if (analysis.total === 0) return null;

  return (
    <div className="ats-panel">
      <div className="ats-head">
        <span className="ats-title">ATS keyword match</span>
        <span className="ats-cov-num" style={{ color: covColor }}>{cov}%</span>
      </div>
      <div className="ats-cov-bar">
        <div className="ats-cov-fill" style={{ width: `${cov}%`, background: covColor }} />
      </div>
      <div className="ats-sub">
        {analysis.matched}/{analysis.total} matched{analysis.partial ? ` · ${analysis.partial} partial` : ""}
      </div>

      <label className="ats-toggle">
        <input type="checkbox" checked={highlightOn} onChange={onToggleHighlight} />
        Highlight matches on resume
      </label>

      {missing.length > 0 && (
        <div className="ats-group">
          <div className="ats-group-label">
            <span>Missing ({missing.length})</span>
            <button className="ats-link" onClick={() => apply(missing.map((m) => m.keyword))}>
              Add all
            </button>
          </div>
          <div className="ats-chips">
            {missing.map((m) => {
              const on = validSelected.includes(m.keyword);
              return (
                <button key={m.keyword} className={`ats-kw red${on ? " sel" : ""}`} onClick={() => toggle(m.keyword)}>
                  {on ? "✓ " : "+ "}
                  {m.keyword}
                </button>
              );
            })}
          </div>
          {validSelected.length > 0 && (
            <button className="ats-apply" onClick={() => apply(validSelected)}>
              Add {validSelected.length} to Skills
            </button>
          )}
        </div>
      )}

      {present.length > 0 && (
        <div className="ats-group">
          <div className="ats-group-label">
            <span>Matched ({present.length})</span>
          </div>
          <div className="ats-chips">
            {present.map((m) => (
              <span key={m.keyword} className={`ats-kw ${m.status}`}>
                {m.keyword}
              </span>
            ))}
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="ats-group">
          <div className="ats-group-label">
            <span>Suggestions</span>
          </div>
          <ul className="ats-suggest">
            {suggestions.slice(0, 4).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
