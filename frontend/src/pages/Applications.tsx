import { useState, useEffect } from "react";
import api from "../auth/api";
import CompanyLogo from "../components/CompanyLogo";
import { ArrowSquareOut, Calendar, Prohibit } from "@phosphor-icons/react";
import { PageIntro } from "../onboarding";
import ApplicationsEmpty from "../components/ApplicationsEmpty";
import { isListingClosed } from "../lib/jobListing";

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
  // Lifecycle of the linked listing; null when it is not one we track.
  listing_status?: string | null;
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
    <div className="jobs-page" data-tour="applications-page">
      <PageIntro page="applications" />
      <header className="jobs-header">
        <h1>Applications</h1>
      </header>

      <div className="jobs-content-area">
        <div className="jobs-feed">
          {loading && <p className="loading-text">Loading applications...</p>}
          {!loading && applications.length === 0 && <ApplicationsEmpty />}

          {applications.map((application) => {
            const closed = isListingClosed(application.listing_status);
            // Only "removed" is proven gone (a check of the posting, or its
            // board no longer lists it). "expired" is age alone and is never
            // rechecked, so that posting may still be up.
            const gone = (application.listing_status || "").toLowerCase() === "removed";
            return (
              <div key={application.id} className="job-card">
                <div className="job-card-body">
                  <div className="job-card-header">
                    <CompanyLogo
                      company={application.company}
                      company_logo={application.company_logo}
                      company_domain={application.company_domain}
                      company_url={application.company_url}
                      size={44}
                    />
                    <div className="job-card-info">
                      <div className="job-card-badges">
                        <span className="badge-time applied-date-badge">
                          <Calendar size={13} weight="duotone" /> Applied {formatAppliedDate(application.applied_at)}
                        </span>
                        {closed && (
                          <span className="listing-closed-badge">
                            <Prohibit size={12} weight="bold" /> No longer accepting applications
                          </span>
                        )}
                      </div>
                      <h2 className="job-title">{application.role}</h2>
                      <p className="job-company">{application.company}</p>
                    </div>
                  </div>

                  <div className="job-card-footer">
                    {application.url && (gone ? (
                      // The posting is gone: its link is dead or lands on a
                      // careers home page, so keep the action but never navigate.
                      <button type="button" className="btn-outline-detail" disabled>
                        <ArrowSquareOut size={16} weight="bold" /> View Posting
                      </button>
                    ) : (
                      <a
                        href={application.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-outline-detail"
                        title={closed ? "This posting may be closed" : undefined}
                      >
                        <ArrowSquareOut size={16} weight="bold" /> View Posting
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
