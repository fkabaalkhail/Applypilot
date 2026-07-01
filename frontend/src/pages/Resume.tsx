import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../hooks/useAuthFetch";
import "../resume.css";
import { PageIntro } from "../onboarding";

const MAX_RESUME_SLOTS = 3;

interface ResumeListItem {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

export default function Resume() {
  const [resumes, setResumes] = useState<ResumeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState<number | null>(null);
  const navigate = useNavigate();

  const fetchResumes = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get("/resumes");
      setResumes(res.data);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Could not load resumes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchResumes(); }, [fetchResumes]);

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this resume?")) return;
    try {
      await api.delete(`/resumes/${id}`);
      setResumes(prev => prev.filter(r => r.id !== id));
    } catch {}
    setMenuOpen(null);
  };

  const handleSetPrimary = async (id: number) => {
    try {
      await api.put(`/resumes/${id}/primary`);
      fetchResumes();
    } catch {}
    setMenuOpen(null);
  };

  if (loading) {
    return (
      <div className="resume-page-new">
        <div className="resume-page-loading"><div className="spinner" /> Loading resumes...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="resume-page-new">
        <div className="resume-page-error">
          <p>{error}</p>
          <button className="btn-pill" onClick={fetchResumes}>Retry</button>
        </div>
      </div>
    );
  }

  const slotsUsed = resumes.length;
  const canUpload = slotsUsed < MAX_RESUME_SLOTS;

  return (
    <div className="resume-page-new" data-tour="resume-page">
      <PageIntro page="resume" />
      {/* Header */}
      <div className="resume-page-header">
        <div>
          <h1>My Resumes</h1>
          <p className="resume-page-subtitle">Manage your resumes and get AI-powered analysis for better job matching.</p>
        </div>
        <button
          className="resume-add-btn"
          onClick={() => setShowUploadModal(true)}
          disabled={!canUpload}
          title={canUpload ? "Add a new resume" : "Maximum 3 resumes reached"}
        >
          <i className="fa-solid fa-plus"></i> Add Resume
        </button>
      </div>

      {/* Slot counter */}
      <div className="resume-slot-bar">
        <div className="resume-slot-indicator">
          <i className="fa-solid fa-circle-check"></i>
          <span>You have <strong>{slotsUsed}</strong> resume{slotsUsed !== 1 ? "s" : ""} saved out of <strong>{MAX_RESUME_SLOTS}</strong> available slots.</span>
        </div>
        <div className="resume-slot-dots">
          {Array.from({ length: MAX_RESUME_SLOTS }).map((_, i) => (
            <span key={i} className={`resume-slot-dot ${i < slotsUsed ? "filled" : ""}`} />
          ))}
        </div>
      </div>

      {/* Resume table */}
      {resumes.length === 0 ? (
        <div className="resume-empty-state">
          <div className="resume-empty-icon"><i className="fa-regular fa-file-lines"></i></div>
          <h3>No resumes yet</h3>
          <p>Upload your first resume to get AI-powered analysis and job matching.</p>
          <button className="resume-add-btn" onClick={() => setShowUploadModal(true)}>
            <i className="fa-solid fa-plus"></i> Upload Resume
          </button>
        </div>
      ) : (
        <div className="resume-table-wrapper">
          <table className="resume-table-new">
            <thead>
              <tr>
                <th>Resume</th>
                <th>Target Job Title</th>
                <th>Last Modified</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {resumes.map((resume) => (
                <tr key={resume.id} onClick={() => navigate(`/app/resume/${resume.id}`)}>
                  <td className="resume-name-cell">
                    <span className="resume-avatar">{resume.name.charAt(0).toUpperCase()}</span>
                    <span className="resume-name-text">
                      {resume.name}
                      {resume.is_primary && <span className="resume-badge-primary"><i className="fa-solid fa-star"></i> Primary</span>}
                      {resume.status === "analyzed" && <span className="resume-badge-analyzed">Analysis Complete</span>}
                    </span>
                  </td>
                  <td className="resume-target-cell">{resume.target_job_title || <span className="text-muted">Not set</span>}</td>
                  <td className="resume-date-cell">{timeAgo(resume.updated_at)}</td>
                  <td className="resume-date-cell">{timeAgo(resume.created_at)}</td>
                  <td className="resume-actions-cell">
                    <button
                      className="resume-menu-btn"
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === resume.id ? null : resume.id); }}
                    >
                      <i className="fa-solid fa-ellipsis"></i>
                    </button>
                    {menuOpen === resume.id && (
                      <div className="resume-menu-dropdown">
                        {!resume.is_primary && (
                          <button onClick={(e) => { e.stopPropagation(); handleSetPrimary(resume.id); }}>
                            <i className="fa-solid fa-star"></i> Set as Primary
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(resume.id); }} className="resume-menu-danger">
                          <i className="fa-solid fa-trash"></i> Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

const ACCEPTED_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
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
  profile: { name?: string; [key: string]: unknown };
}

function UploadModal({ onClose, onUploadSuccess }: UploadModalProps) {
  const [modalState, setModalState] = useState<ModalState>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [tipIndex, setTipIndex] = useState(0);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tipIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (modalState === "progress") {
      tipIntervalRef.current = setInterval(() => setTipIndex((p) => (p + 1) % ROTATING_TIPS.length), 3000);
    } else if (tipIntervalRef.current) { clearInterval(tipIntervalRef.current); tipIntervalRef.current = null; }
    return () => { if (tipIntervalRef.current) clearInterval(tipIntervalRef.current); };
  }, [modalState]);

  const handleFile = useCallback(async (file: File) => {
    setFileError(null); setApiError(null);
    if (!isValidFileType(file)) { setFileError("Only PDF and DOCX files are accepted."); return; }
    setModalState("progress"); setTipIndex(0);
    try {
      const formData = new FormData(); formData.append("file", file);
      const res = await api.post("/resumes/upload", formData);
      const data: UploadResponse = res.data;
      setUploadResult(data);
      setModalState("success"); onUploadSuccess();
    } catch (err: any) { setApiError(err.response?.data?.detail || err.message || "Upload failed."); setModalState("error"); }
  }, [onUploadSuccess]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content upload-modal-new" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><i className="fa-solid fa-xmark"></i></button>

        {modalState === "upload" && (
          <>
            <div className="upload-modal-icon"><i className="fa-solid fa-cloud-arrow-up"></i></div>
            <h2>Upload Resume</h2>
            <p>Drop your PDF or DOCX file below for instant AI analysis</p>
            <div
              className={`upload-drop-zone${dragOver ? " drag-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileInputRef.current?.click()}
            >
              <i className="fa-regular fa-file-pdf"></i>
              <span><strong>Drop file here</strong> or click to browse</span>
              <span className="upload-formats">PDF, DOCX (max 10MB)</span>
            </div>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx" style={{ display: "none" }} onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
            {fileError && <p className="upload-error-text">{fileError}</p>}
          </>
        )}

        {modalState === "progress" && (
          <div className="upload-progress-state">
            <div className="upload-spinner-ring"><div className="spinner" /></div>
            <h2>Analyzing Your Resume</h2>
            <div className="upload-progress-bar"><div className="upload-progress-fill" /></div>
            <p className="upload-tip">{ROTATING_TIPS[tipIndex]}</p>
          </div>
        )}

        {modalState === "success" && (
          <div className="upload-success-state">
            <div className="upload-success-icon"><i className="fa-solid fa-circle-check"></i></div>
            <h2>Resume Uploaded</h2>
            <p>Your resume has been analyzed and is ready to use for job matching.</p>
            <div className="upload-success-actions">
              <button className="resume-add-btn" onClick={() => navigate(`/app/resume/${uploadResult?.id}`)}>
                View Resume
              </button>
            </div>
          </div>
        )}

        {modalState === "error" && (
          <div className="upload-error-state">
            <div className="upload-error-icon"><i className="fa-solid fa-circle-xmark"></i></div>
            <h2>Upload Failed</h2>
            <p>{apiError || "Something went wrong."}</p>
            <div className="upload-success-actions">
              <button className="btn-pill" onClick={onClose}>Close</button>
              <button className="resume-add-btn" onClick={() => { setModalState("upload"); setApiError(null); }}>Try Again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
