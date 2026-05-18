import React, { useEffect, useState, useCallback } from "react";
import api from "../auth/api";

interface TailoredResumeOverlayProps {
  jobId: number;
  jobTitle: string;
  company: string;
  onClose: () => void;
}

interface TailoredResult {
  tailored_text: string;
  diff_summary: string;
  status: string;
}

interface ResumeSection {
  title: string;
  content: string;
  expanded: boolean;
}

function parseSections(text: string): ResumeSection[] {
  const sectionTitles = [
    "Personal Info",
    "Education",
    "Experience",
    "Projects",
    "Technologies",
  ];

  const sections: ResumeSection[] = [];
  const lines = text.split("\n");
  let currentTitle = "Personal Info";
  let currentLines: string[] = [];

  for (const line of lines) {
    const matchedTitle = sectionTitles.find(
      (t) =>
        line.toLowerCase().includes(t.toLowerCase()) &&
        (line.startsWith("#") || line.startsWith("**") || line.toUpperCase() === line.trim())
    );

    if (matchedTitle && matchedTitle !== currentTitle) {
      if (currentLines.length > 0 || sections.length === 0) {
        sections.push({
          title: currentTitle,
          content: currentLines.join("\n").trim(),
          expanded: true,
        });
      }
      currentTitle = matchedTitle;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      title: currentTitle,
      content: currentLines.join("\n").trim(),
      expanded: true,
    });
  }

  // If no sections were parsed, return the whole text as one section
  if (sections.length === 0) {
    sections.push({
      title: "Resume",
      content: text,
      expanded: true,
    });
  }

  return sections;
}

const TailoredResumeOverlay: React.FC<TailoredResumeOverlayProps> = ({
  jobId,
  jobTitle,
  company,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TailoredResult | null>(null);
  const [sections, setSections] = useState<ResumeSection[]>([]);

  const generateResume = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.post<TailoredResult>(
        `/ai/tailor-resume/${jobId}`
      );
      setResult(response.data);
      setSections(parseSections(response.data.tailored_text));
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to generate tailored resume. Please try again.";
      if (
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { data?: { detail?: string } } }).response?.data?.detail === "string"
      ) {
        setError((err as { response: { data: { detail: string } } }).response.data.detail);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    generateResume();
  }, [generateResume]);

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([result.tailored_text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resume-${company.toLowerCase().replace(/\s+/g, "-")}-${jobId}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleSection = (index: number) => {
    setSections((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, expanded: !s.expanded } : s
      )
    );
  };

  const handleSectionEdit = (index: number, newContent: string) => {
    setSections((prev) =>
      prev.map((s, i) => (i === index ? { ...s, content: newContent } : s))
    );
  };

  return (
    <div className="tailor-overlay-backdrop" onClick={onClose}>
      <div
        className="tailor-overlay-container"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          className="tailor-overlay-close"
          onClick={onClose}
          aria-label="Close overlay"
        >
          ✕
        </button>

        {/* Main content area */}
        {loading ? (
          <div className="tailor-overlay-loading">
            <div className="tailor-overlay-spinner" />
            <p className="tailor-overlay-loading-text">
              Tailoring your resume...
            </p>
            <p className="tailor-overlay-loading-sub">
              Analyzing job requirements and optimizing your resume for {company}
            </p>
          </div>
        ) : error ? (
          <div className="tailor-overlay-error">
            <div className="tailor-overlay-error-icon">⚠️</div>
            <h3>Something went wrong</h3>
            <p>{error}</p>
            <button
              className="tailor-overlay-btn tailor-overlay-btn-regenerate"
              onClick={generateResume}
            >
              Try Again
            </button>
          </div>
        ) : (
          <div className="tailor-overlay-content">
            {/* Left column - Job info */}
            <aside className="tailor-overlay-left">
              <div className="tailor-overlay-job-info">
                <h3 className="tailor-overlay-job-label">Tailored For</h3>
                <h2 className="tailor-overlay-job-title">{jobTitle}</h2>
                <p className="tailor-overlay-job-company">{company}</p>
                {result?.diff_summary && (
                  <div className="tailor-overlay-diff">
                    <h4>Changes Made</h4>
                    <p>{result.diff_summary}</p>
                  </div>
                )}
              </div>
            </aside>

            {/* Center column - Resume preview */}
            <main className="tailor-overlay-center">
              <div className="tailor-overlay-preview-header">
                <h3>Resume Preview</h3>
              </div>
              <div className="tailor-overlay-preview-body">
                <pre className="tailor-overlay-resume-text">
                  {result?.tailored_text}
                </pre>
              </div>
            </main>

            {/* Right column - Section editor */}
            <aside className="tailor-overlay-right">
              <div className="tailor-overlay-editor-header">
                <h3>Sections</h3>
              </div>
              <div className="tailor-overlay-sections">
                {sections.map((section, index) => (
                  <div key={index} className="tailor-overlay-section">
                    <button
                      className="tailor-overlay-section-toggle"
                      onClick={() => toggleSection(index)}
                    >
                      <span className="tailor-overlay-section-arrow">
                        {section.expanded ? "▾" : "▸"}
                      </span>
                      <span className="tailor-overlay-section-title">
                        {section.title}
                      </span>
                    </button>
                    {section.expanded && (
                      <textarea
                        className="tailor-overlay-section-textarea"
                        value={section.content}
                        onChange={(e) =>
                          handleSectionEdit(index, e.target.value)
                        }
                        rows={Math.min(
                          12,
                          Math.max(3, section.content.split("\n").length + 1)
                        )}
                      />
                    )}
                  </div>
                ))}
              </div>
            </aside>
          </div>
        )}

        {/* Bottom bar */}
        {!loading && !error && (
          <div className="tailor-overlay-bottom">
            <button
              className="tailor-overlay-btn tailor-overlay-btn-download"
              onClick={handleDownload}
            >
              Download Resume
            </button>
            <button
              className="tailor-overlay-btn tailor-overlay-btn-autofill"
              onClick={onClose}
            >
              Continue to Autofill
            </button>
            <button
              className="tailor-overlay-btn tailor-overlay-btn-regenerate"
              onClick={generateResume}
            >
              Regenerate
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TailoredResumeOverlay;
