import type { Severity } from "../../lib/resumeProfile";

export const SEVERITIES: Severity[] = ["urgent", "critical", "optional"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  urgent: "Urgent",
  critical: "Critical",
  optional: "Optional",
};

export interface SeverityCounts {
  urgent: number;
  critical: number;
  optional: number;
}

/**
 * The composition of a resume's problems, drawn to scale.
 *
 * Three numbers side by side don't tell you whether a resume is mostly broken or
 * mostly polished. One proportional rail does, before you read a digit. It's the
 * same object everywhere severity appears — the header, a category, a section —
 * so the shape is learnable.
 */
export default function SeverityRail({
  counts,
  small = false,
  className = "",
}: {
  counts: SeverityCounts;
  small?: boolean;
  className?: string;
}) {
  const total = counts.urgent + counts.critical + counts.optional;
  const classes = ["rd-rail", small ? "rd-rail-sm" : "", className].filter(Boolean).join(" ");

  if (total === 0) {
    return (
      <div className={classes} role="img" aria-label="No issues found">
        <span className="rd-rail-clean" />
      </div>
    );
  }

  const label = SEVERITIES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
    .join(", ");

  return (
    <div className={classes} role="img" aria-label={label}>
      {SEVERITIES.map((severity) =>
        counts[severity] > 0 ? (
          <span
            key={severity}
            className="rd-rail-seg"
            data-severity={severity}
            style={{ width: `${(counts[severity] / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}
