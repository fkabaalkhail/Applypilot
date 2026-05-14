import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../auth/api";
import "../resume.css";

interface ResumeListItem {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

export default function Resume() {
  const [resumes, setResumes] = useState<ResumeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const navigate = useNavigate();

  const fetchResumes = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get("/resumes");
      setResumes(res.data);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Could not load resumes. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchResumes();
  }, [fetchResumes]);

  if (loading) {
    return (
      <div className="resume-list">
        <div className="settings-loading">Loading resumes...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="resume-list">
        <div className="settings-error">
          <p>{error}</p>
          <button className="btn-pill" onClick={fetchResumes}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="resume-list">
      <div className="resume-detail-header">
        <h1>Resumes</h1>
        <button
          className="btn-pill btn-pill-accent"
          onClick={() => setShowUploadModal(true)}
        >
          + Add Resume
        </button>
      </div>

      {resumes.length === 0 ? (
        <div className="settings-loading" style={{ textAlign: "center", padding: "3rem 1rem" }}>
          <p>No resumes yet. Upload your first resume to get started.</p>
          <button
            className="btn-pill btn-pill-accent"
            style={{ marginTop: "1rem" }}
            onClick={() => setShowUploadModal(true)}
          >
            + Upload Resume
          </button>
        </div>
      ) : (
        <table className="resume-table">
          <thead>
            <tr>
              <th>Resume Name</th>
              <th>Target Job Title</th>
              <th>Last Modified</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {resumes.map((resume) => (
              <tr
                key={resume.id}
                onClick={() => navigate(`/app/resume/${resume.id}`)}
              >
                <td>
                  {resume.name}
                  {resume.is_primary && (
                    <span className="badge-primary" style={{ marginLeft: "0.5rem" }}>
                      PRIMARY
                    </span>
                  )}
                </td>
                <td>{resume.target_job_title || "Not set"}</td>
                <td>{new Date(resume.updated_at).toLocaleDateString()}</td>
                <td>
                  {new Date(resume.created_at).toLocaleDateString()}
                  {resume.status === "analyzed" && (
                    <span className="badge-analyzed" style={{ marginLeft: "0.5rem" }}>
                      Analysis Complete
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showUploadModal && (
        <UploadModal
          onClose={() => setShowUploadModal(false)}
          onUploadSuccess={() => fetchResumes()}
        />
      )}
    </div>
  );
}

/* ===== Upload Modal Component ===== */

type ModalState = "upload" | "progress" | "success" | "error";

const ROTATING_TIPS = [
  "Extracting text from your resume...",
  "Identifying your skills and experience...",
  "Analyzing education and certifications...",
  "Building your structured profile...",
];

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const ACCEPTED_EXTENSIONS = [".pdf", ".docx"];

function isValidFileType(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  return ACCEPTED_EXTENSIONS.includes(ext);
}

interface UploadModalProps {
  onClose: () => void;
  onUploadSuccess: () => void;
}

interface UploadResponse {
  id: number;
  profile: {
    name?: string;
    [key: string]: unknown;
  };
}

function UploadModal({ onClose, onUploadSuccess }: UploadModalProps) {
  const [modalState, setModalState] = useState<ModalState>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [tipIndex, setTipIndex] = useState(0);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [resumeName, setResumeName] = useState("");
  const [targetJobTitle, setTargetJobTitle] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tipIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate = useNavigate();

  // Rotate tips every 3 seconds during progress
  useEffect(() => {
    if (modalState === "progress") {
      tipIntervalRef.current = setInterval(() => {
        setTipIndex((prev) => (prev + 1) % ROTATING_TIPS.length);
      }, 3000);
    } else {
      if (tipIntervalRef.current) {
        clearInterval(tipIntervalRef.current);
        tipIntervalRef.current = null;
      }
    }
    return () => {
      if (tipIntervalRef.current) {
        clearInterval(tipIntervalRef.current);
      }
    };
  }, [modalState]);

  const handleFile = useCallback(async (file: File) => {
    setFileError(null);
    setApiError(null);

    if (!isValidFileType(file)) {
      setFileError("Only PDF and DOCX files are accepted.");
      return;
    }

    // Start upload
    setModalState("progress");
    setTipIndex(0);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await api.post("/resumes/upload", formData);

      const data: UploadResponse = res.data;
      setUploadResult(data);
      setResumeName(data.profile?.name || "Untitled Resume");
      setModalState("success");
      onUploadSuccess();
    } catch (err: any) {
      const message = err.response?.data?.detail || err.message || "Upload failed. Please try again.";
      setApiError(message);
      setModalState("error");
    }
  }, [onUploadSuccess]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  }, [handleFile]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
  }, [handleFile]);

  const handleDropZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleViewResume = useCallback(() => {
    if (uploadResult) {
      navigate(`/app/resume/${uploadResult.id}`);
    }
  }, [uploadResult, navigate]);

  const handleUpdateToProfile = useCallback(async () => {
    if (!uploadResult) return;

    try {
      await api.put(`/resumes/${uploadResult.id}/primary`);
      navigate(`/app/resume/${uploadResult.id}`);
    } catch (err: any) {
      setApiError(err.response?.data?.detail || err.message || "Failed to set as primary.");
    }
  }, [uploadResult, navigate]);

  return (
    <div className="upload-modal-overlay" onClick={onClose}>
      <div className="upload-modal" onClick={(e) => e.stopPropagation()}>
        {/* Upload State */}
        {modalState === "upload" && (
          <>
            <h2>Upload Resume</h2>
            <div
              className={`drop-zone${dragOver ? " drag-over" : ""}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleDropZoneClick}
            >
              <div className="drop-icon">📄</div>
              <p><strong>Drop your resume here</strong></p>
              <p>or click to browse (PDF, DOCX)</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />
            {fileError && (
              <p style={{ color: "#dc2626", fontSize: "0.85rem", marginTop: "0.75rem" }}>
                {fileError}
              </p>
            )}
            <div style={{ marginTop: "1.25rem", textAlign: "right" }}>
              <button className="btn-pill" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {/* Progress State */}
        {modalState === "progress" && (
          <>
            <h2>Analyzing Your Resume</h2>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: "80%" }} />
            </div>
            <p className="progress-text">{ROTATING_TIPS[tipIndex]}</p>
          </>
        )}

        {/* Success State */}
        {modalState === "success" && (
          <div className="success-modal">
            <div className="success-icon">✓</div>
            <h3>Upload Success!</h3>
            <input
              type="text"
              placeholder="Resume Name"
              value={resumeName}
              onChange={(e) => setResumeName(e.target.value)}
            />
            <input
              type="text"
              placeholder="Target Job Title"
              value={targetJobTitle}
              onChange={(e) => setTargetJobTitle(e.target.value)}
            />
            <div className="modal-actions">
              <button className="btn-pill" onClick={handleViewResume}>
                View My Resume
              </button>
              <button className="btn-pill btn-pill-accent" onClick={handleUpdateToProfile}>
                Update to Profile
              </button>
            </div>
          </div>
        )}

        {/* Error State */}
        {modalState === "error" && (
          <>
            <h2>Upload Failed</h2>
            <p style={{ color: "#dc2626", fontSize: "0.9rem", margin: "1rem 0" }}>
              {apiError || "An unexpected error occurred."}
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button className="btn-pill" onClick={onClose}>
                Close
              </button>
              <button
                className="btn-pill btn-pill-accent"
                onClick={() => {
                  setModalState("upload");
                  setApiError(null);
                }}
              >
                Try Again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
