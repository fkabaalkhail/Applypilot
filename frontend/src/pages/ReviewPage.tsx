import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchReviewApplications,
  exportApplicationsCSV,
  ApplicationReview,
} from "../api";

const STATUS_OPTIONS = [
  "all",
  "applied",
  "failed",
  "skipped",
  "interviewing",
  "rejected",
  "offer",
] as const;

export default function ReviewPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const params: Record<string, string> = { page: String(page), page_size: "50" };
  if (search) params.search = search;
  if (statusFilter !== "all") params.status = statusFilter;

  const { data: applications = [], isLoading } = useQuery({
    queryKey: ["review", search, statusFilter, page],
    queryFn: () => fetchReviewApplications(params),
  });

  const handleExport = async () => {
    try {
      await exportApplicationsCSV();
    } catch {
      alert("Export failed. Please try again.");
    }
  };

  const toggleExpand = (id: number) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div>
      <h2>Application Review</h2>

      {/* Search and filters */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search company, role, or status..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{ flex: 1, minWidth: "200px", padding: "0.5rem" }}
          aria-label="Search applications"
        />
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              style={{
                padding: "0.4rem 0.75rem",
                background: statusFilter === s ? "#4a90d9" : "#e0e0e0",
                color: statusFilter === s ? "#fff" : "#333",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
              aria-pressed={statusFilter === s}
            >
              {s}
            </button>
          ))}
        </div>
        <button onClick={handleExport} style={{ padding: "0.5rem 1rem", cursor: "pointer" }}>
          Export CSV
        </button>
      </div>

      {isLoading ? (
        <p>Loading applications...</p>
      ) : applications.length === 0 ? (
        <p>No applications found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #ccc", textAlign: "left" }}>
              <th style={{ padding: "0.5rem" }}>Company</th>
              <th style={{ padding: "0.5rem" }}>Role</th>
              <th style={{ padding: "0.5rem" }}>Platform</th>
              <th style={{ padding: "0.5rem" }}>Status</th>
              <th style={{ padding: "0.5rem" }}>Applied</th>
              <th style={{ padding: "0.5rem" }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                expanded={expandedId === app.id}
                onToggle={() => toggleExpand(app.id)}
              />
            ))}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", justifyContent: "center" }}>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span style={{ padding: "0.5rem" }}>Page {page}</span>
        <button disabled={applications.length < 50} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    applied: "#4caf50",
    failed: "#f44336",
    skipped: "#ff9800",
    interviewing: "#2196f3",
    rejected: "#9e9e9e",
    offer: "#8bc34a",
  };
  return (
    <span
      style={{
        padding: "0.2rem 0.5rem",
        borderRadius: "4px",
        background: colors[status] || "#ccc",
        color: "#fff",
        fontSize: "0.85rem",
      }}
    >
      {status}
    </span>
  );
}

function AppRow({
  app,
  expanded,
  onToggle,
}: {
  app: ApplicationReview;
  expanded: boolean;
  onToggle: () => void;
}) {
  const appliedDate = new Date(app.applied_at).toLocaleDateString();

  return (
    <>
      <tr style={{ borderBottom: "1px solid #eee" }}>
        <td style={{ padding: "0.5rem" }}>{app.company}</td>
        <td style={{ padding: "0.5rem" }}>
          {app.url ? (
            <a href={app.url} target="_blank" rel="noopener noreferrer">{app.role}</a>
          ) : (
            app.role
          )}
        </td>
        <td style={{ padding: "0.5rem" }}>{app.ats_type || app.platform}</td>
        <td style={{ padding: "0.5rem" }}><StatusBadge status={app.status} /></td>
        <td style={{ padding: "0.5rem" }}>{appliedDate}</td>
        <td style={{ padding: "0.5rem" }}>
          <button onClick={onToggle} style={{ cursor: "pointer" }}>
            {expanded ? "Hide" : "Show"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: "1rem", background: "#f9f9f9" }}>
            <ExpandedDetails app={app} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedDetails({ app }: { app: ApplicationReview }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div>
        <strong>Resume version:</strong> {app.resume_version}
      </div>

      {app.screenshot_path && (
        <div>
          <strong>Pre-submit screenshot:</strong>
          <br />
          <img
            src={`/data/${app.screenshot_path}`}
            alt="Pre-submit screenshot"
            style={{ maxWidth: "100%", maxHeight: "300px", marginTop: "0.25rem", border: "1px solid #ddd" }}
          />
        </div>
      )}

      {app.failure_screenshot_path && (
        <div>
          <strong>Failure screenshot:</strong>
          <br />
          <img
            src={`/data/${app.failure_screenshot_path}`}
            alt="Failure screenshot"
            style={{ maxWidth: "100%", maxHeight: "300px", marginTop: "0.25rem", border: "1px solid #ddd" }}
          />
        </div>
      )}

      {app.cover_letter_text && (
        <div>
          <strong>Cover letter:</strong>
          <pre style={{ whiteSpace: "pre-wrap", background: "#fff", padding: "0.5rem", border: "1px solid #ddd", maxHeight: "200px", overflow: "auto" }}>
            {app.cover_letter_text}
          </pre>
        </div>
      )}

      {app.questions_answered && app.questions_answered.length > 0 && (
        <div>
          <strong>Questions answered:</strong>
          <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
            {app.questions_answered.map((qa, i) => (
              <li key={i}>
                <em>{qa.question}</em> → {qa.answer}{" "}
                <span style={{ color: "#888", fontSize: "0.8rem" }}>({qa.source})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {app.notes && (
        <div>
          <strong>Notes:</strong> {app.notes}
        </div>
      )}
    </div>
  );
}
