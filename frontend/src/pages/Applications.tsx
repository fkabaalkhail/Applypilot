import { useState, useEffect } from "react";
import api from "../auth/api";
import { avatarColor } from "../lib/companyLogo";
import { ArrowSquareOut, Calendar } from "@phosphor-icons/react";

interface ApplicationRecord {
  id: number;
  platform: string;
  company: string;
  role: string;
  url: string | null;
  status: string;
  applied_at: string;
  notes: string | null;
  resume_version: string | null;
}

function formatAppliedDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Applications() {
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApplications();
  }, []);

  async function fetchApplications() {
    setLoading(true);
    try {
      const res = await api.get("/jobs/applications");
      setApplications(res.data);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="jobs-page">
      <header className="jobs-header">
        <h1>Applications</h1>
      </header>

      <div className="jobs-content-area">
        <div className="jobs-feed">
          {loading && <p className="loading-text">Loading applications...</p>}
          {!loading && applications.length === 0 && (
            <p className="empty-text">No applications yet — jobs you apply to will show up here.</p>
          )}

          {applications.map((application) => (
            <div key={application.id} className="job-card">
              <div className="job-card-body">
                <div className="job-card-header">
                  <div className="company-logo-wrapper">
                    <div
                      className="company-logo"
                      style={{ backgroundColor: avatarColor(application.company) }}
                    >
                      {application.company.charAt(0).toUpperCase()}
                    </div>
                  </div>
                  <div className="job-card-info">
                    <div className="job-card-badges">
                      <span className="badge-time applied-date-badge">
                        <Calendar size={13} weight="duotone" /> Applied {formatAppliedDate(application.applied_at)}
                      </span>
                    </div>
                    <h2 className="job-title">{application.role}</h2>
                    <p className="job-company">{application.company}</p>
                  </div>
                </div>

                <div className="job-card-footer">
                  {application.url && (
                    <a href={application.url} target="_blank" rel="noopener noreferrer" className="btn-outline-detail">
                      <ArrowSquareOut size={16} weight="bold" /> View Posting
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
