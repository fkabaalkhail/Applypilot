import { useState, useEffect } from "react";
import api from "../auth/api";
import { avatarColor, resolveLogoUrl } from "../lib/companyLogo";
import { ArrowSquareOut, Calendar } from "@phosphor-icons/react";
import { PageIntro } from "../onboarding";

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
  company_logo?: string | null;
  company_domain?: string | null;
  company_url?: string | null;
}

function formatAppliedDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Same fallback behavior as the dashboard: hide a broken logo image so the
// letter avatar underneath shows through instead.
function handleLogoError(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.target as HTMLImageElement).style.display = "none";
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
    <div className="jobs-page" data-tour="applications-page">
      <PageIntro page="applications" />
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
                    {(() => {
                      const logoUrl = resolveLogoUrl(application);
                      return logoUrl ? (
                        <img
                          src={logoUrl}
                          alt=""
                          className="company-logo-img-overlay"
                          loading="lazy"
                          onError={handleLogoError}
                        />
                      ) : null;
                    })()}
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
