import { timeAgo } from "../../lib/datetime";
import type { AnalysisReport } from "../../lib/resumeProfile";
import SeverityRail, { SEVERITIES, SEVERITY_LABEL } from "./SeverityRail";

const VERDICT: Record<string, string> = {
  EXCELLENT: "Interview-ready",
  GOOD: "Nearly there",
  FAIR: "Needs work",
};

export function countsOf(report: AnalysisReport) {
  return {
    urgent: report.urgent_fix_count,
    critical: report.critical_fix_count,
    optional: report.optional_fix_count,
  };
}

/** No report yet: the one thing to do is obvious, so say only that. */
export function UnanalyzedStrip({ onAnalyze, analyzing }: { onAnalyze: () => void; analyzing: boolean }) {
  return (
    <div className="rd-unanalyzed">
      <div style={{ flex: 1 }}>
        <h2>This resume hasn't been analyzed</h2>
        <p>
          Get a graded breakdown of your impact, wording, structure, and ATS readiness,
          with the exact lines to fix.
        </p>
        {analyzing && <div className="rd-progress"><span /></div>}
      </div>
      <button className="rd-btn rd-btn-primary rd-btn-lg" onClick={onAnalyze} disabled={analyzing}>
        {analyzing ? "Analyzing…" : "Analyze resume"}
      </button>
    </div>
  );
}

export default function ResumeScoreStrip({
  report,
  analyzedAt,
  analyzing,
  onAnalyze,
  onViewReport,
  onFocusSeverity,
}: {
  report: AnalysisReport;
  analyzedAt: string | null;
  analyzing: boolean;
  onAnalyze: () => void;
  onViewReport: () => void;
  onFocusSeverity: (severity: string) => void;
}) {
  const counts = countsOf(report);
  const total = counts.urgent + counts.critical + counts.optional;

  return (
    <div className="rd-score">
      <div className="rd-plaque" aria-hidden="true">
        <span className="rd-plaque-letter">{report.letter_grade || report.overall_grade.charAt(0)}</span>
        {report.score > 0 && <span className="rd-plaque-score">{report.score}/100</span>}
      </div>

      <div className="rd-score-body">
        <div className="rd-score-head">
          <span className="rd-score-verdict">
            {VERDICT[report.overall_grade] ?? report.overall_grade}
          </span>
          <span className="rd-score-when">
            {total === 0 ? "Nothing to fix" : `${total} fix${total === 1 ? "" : "es"} suggested`}
            {analyzedAt ? ` · analyzed ${timeAgo(analyzedAt)}` : ""}
          </span>
        </div>

        <SeverityRail counts={counts} />

        <div className="rd-legend">
          {SEVERITIES.map((severity) => (
            <button
              key={severity}
              type="button"
              className="rd-legend-item"
              onClick={() => onFocusSeverity(severity)}
            >
              <span className="rd-legend-dot" data-severity={severity} />
              <span className="rd-legend-count">{counts[severity]}</span>
              {SEVERITY_LABEL[severity]}
            </button>
          ))}
        </div>

        {analyzing && <div className="rd-progress"><span /></div>}
      </div>

      <div className="rd-score-actions">
        <button className="rd-btn rd-btn-primary" onClick={onViewReport}>
          View full report <i className="fa-solid fa-arrow-right" />
        </button>
        <button className="rd-btn" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? "Analyzing…" : "Re-analyze"}
        </button>
      </div>
    </div>
  );
}
