import { useEffect, useRef } from "react";
import { timeAgo } from "../../lib/datetime";
import type { AnalysisCategory, AnalysisIssue, AnalysisReport, Severity } from "../../lib/resumeProfile";
import SeverityRail, { SEVERITIES } from "./SeverityRail";
import { countsOf } from "./ResumeScoreStrip";

const SEVERITY_HEADING: Record<Severity, string> = {
  urgent: "Fix before you apply",
  critical: "Fix soon",
  optional: "Worth polishing",
};

function categoryCounts(category: AnalysisCategory) {
  return {
    urgent: sum(category, "urgent"),
    critical: sum(category, "critical"),
    optional: sum(category, "optional"),
  };
}

function sum(category: AnalysisCategory, severity: Severity): number {
  return category.issues
    .filter((i) => i.severity === severity)
    .reduce((total, i) => total + i.count, 0);
}

function Issue({ issue }: { issue: AnalysisIssue }) {
  return (
    <div className="rd-issue" data-severity={issue.severity} id={`issue-${issue.id}`}>
      <div className="rd-issue-head">
        <span className="rd-issue-dot" />
        <span className="rd-issue-title">{issue.title}</span>
        <span className="rd-issue-meta">
          {issue.count > 1 ? `${issue.count} places` : "1 place"}
          {issue.section ? ` · ${issue.section}` : ""}
        </span>
      </div>

      {issue.description && <p className="rd-issue-desc">{issue.description}</p>}

      {issue.evidence.length > 0 && (
        <div className="rd-evidence">
          {issue.evidence.map((quote, i) => (
            <blockquote key={i}>{quote}</blockquote>
          ))}
        </div>
      )}

      {issue.suggestion && (
        <div className="rd-fix">
          <span className="rd-eyebrow">How to fix it</span>
          {issue.suggestion}
        </div>
      )}
    </div>
  );
}

function Category({ category, rank }: { category: AnalysisCategory; rank: number }) {
  const grouped = SEVERITIES.map((severity) => ({
    severity,
    issues: category.issues.filter((i) => i.severity === severity),
  })).filter((group) => group.issues.length > 0);

  return (
    <section className="rd-cat" id={`category-${category.id}`}>
      <div className="rd-cat-head">
        <span className="rd-cat-rank">{String(rank).padStart(2, "0")}</span>
        <h3 className="rd-cat-name">{category.name}</h3>
        {rank === 1 && category.issues.length > 0 && <span className="rd-cat-first">Start here</span>}
        <SeverityRail counts={categoryCounts(category)} small />
        <span className="rd-cat-score">{category.score}/100</span>
      </div>

      {grouped.map(({ severity, issues }) => (
        <div className="rd-sev-group" key={severity}>
          <div className="rd-eyebrow rd-sev-label" data-severity={severity}>
            {SEVERITY_HEADING[severity]}
          </div>
          {issues.map((issue) => (
            <Issue key={issue.id} issue={issue} />
          ))}
        </div>
      ))}

      {category.why_it_matters && (
        <details className="rd-why">
          <summary>Why this matters</summary>
          <p>{category.why_it_matters}</p>
        </details>
      )}
    </section>
  );
}

export default function AnalysisReportView({
  report,
  resumeName,
  isPrimary,
  improving,
  onBack,
  onImprove,
  onSetPrimary,
  focusSeverity,
}: {
  report: AnalysisReport;
  resumeName: string;
  isPrimary: boolean;
  improving: boolean;
  onBack: () => void;
  onImprove: () => void;
  onSetPrimary: () => void;
  focusSeverity?: string | null;
}) {
  const counts = countsOf(report);
  const total = counts.urgent + counts.critical + counts.optional;
  const topRef = useRef<HTMLDivElement>(null);

  // Arriving from a legend chip should land on that severity, not the top.
  useEffect(() => {
    if (!focusSeverity) {
      topRef.current?.scrollIntoView({ block: "start" });
      return;
    }
    const first = document.querySelector(`.rd-issue[data-severity="${focusSeverity}"]`);
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusSeverity]);

  return (
    <div className="rd-report" ref={topRef}>
      <button className="rd-report-back" onClick={onBack}>
        <i className="fa-solid fa-arrow-left" /> Back to {resumeName}
      </button>

      <h1>Resume analysis report</h1>
      <div className="rd-score-when" style={{ marginTop: "0.25rem" }}>
        {report.analyzed_at ? `Analyzed ${timeAgo(report.analyzed_at)}` : "Analyzed just now"}
        {total > 0 && ` · ${total} fix${total === 1 ? "" : "es"} suggested`}
      </div>

      <div className="rd-block">
        <h2 className="rd-block-title">Summary</h2>
        <p className="rd-prose">{report.summary}</p>
      </div>

      {report.strengths.length > 0 && (
        <div className="rd-block">
          <h2 className="rd-block-title">What's already working</h2>
          <ul className="rd-strengths">
            {report.strengths.map((strength, i) => (
              <li key={i}>
                <i className="fa-solid fa-check" />
                <span>{strength}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.categories.length > 0 ? (
        <div className="rd-block">
          <h2 className="rd-block-title">What to fix, in order</h2>
          <p className="rd-prose" style={{ marginTop: "0.35rem" }}>
            Ranked by how much each one is costing you. Work down the list.
          </p>
          {report.categories.map((category, i) => (
            <Category key={category.id} category={category} rank={i + 1} />
          ))}
        </div>
      ) : (
        report.highlights.length > 0 && (
          <div className="rd-block">
            <h2 className="rd-block-title">Findings</h2>
            <ul className="rd-strengths">
              {report.highlights.map((highlight, i) => (
                <li key={i}>
                  <i className="fa-solid fa-circle-info" />
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      <div className="rd-cta">
        <div>
          <h3>Let AI apply these fixes</h3>
          <p>
            We'll rewrite your bullets against every finding above, keeping your employers,
            dates, and numbers exactly as they are. You review the changes before anything is
            saved.
          </p>
        </div>
        <div className="rd-cta-actions">
          {!isPrimary && (
            <button className="rd-btn" onClick={onSetPrimary}>
              Make it my primary CV
            </button>
          )}
          <button className="rd-btn rd-btn-primary rd-btn-lg" onClick={onImprove} disabled={improving}>
            {improving ? "Rewriting…" : "Improve my resume"}
          </button>
        </div>
      </div>
    </div>
  );
}
