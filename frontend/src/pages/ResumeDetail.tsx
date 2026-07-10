import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import api from "../auth/api";
import ResumeRenderer, { FittedResume } from "../components/ResumeRenderer";
import AnalysisReportView from "../components/resume/AnalysisReportView";
import ImproveModal from "../components/resume/ImproveModal";
import ResumeForm from "../components/resume/ResumeForm";
import ResumeScoreStrip, { UnanalyzedStrip } from "../components/resume/ResumeScoreStrip";
import { profileToDocument } from "../lib/resumeProfile";
import type {
  AnalysisReport,
  ResumeDetailData,
  ResumeProfile,
  Severity,
} from "../lib/resumeProfile";
import { printResume } from "../lib/resumeExport";
import "../resume-detail.css";

type View = "resume" | "report";
type Toast = { message: string; type: "success" | "error" } | null;

export default function ResumeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [resume, setResume] = useState<ResumeDetailData | null>(null);
  const [profile, setProfile] = useState<ResumeProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState<ResumeProfile | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [improving, setImproving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const [view, setView] = useState<View>("resume");
  const [focusSeverity, setFocusSeverity] = useState<Severity | null>(null);
  const [improvement, setImprovement] = useState<{ profile: ResumeProfile; changes: string[] } | null>(null);
  const [pane, setPane] = useState<"edit" | "preview">("edit");

  const printRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.get(`/resumes/${id}`);
        if (cancelled) return;
        const data: ResumeDetailData = res.data;
        setResume(data);
        setProfile(data.profile);
        setSavedProfile(data.profile);
        setReport(data.analysis_report);
      } catch (err: any) {
        if (!cancelled) setError(err.response?.data?.detail || err.message || "Could not load this resume.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const dirty = useMemo(
    () => !!profile && !!savedProfile && JSON.stringify(profile) !== JSON.stringify(savedProfile),
    [profile, savedProfile],
  );

  // A half-edited resume is worth warning about.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = useCallback((patch: Partial<ResumeProfile>) => {
    setProfile((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const save = useCallback(async (next?: ResumeProfile) => {
    const payload = next ?? profile;
    if (!payload || !id) return false;
    setSaving(true);
    try {
      await api.put(`/resumes/${id}`, { profile: payload });
      setProfile(payload);
      setSavedProfile(payload);
      showToast("Resume saved.", "success");
      return true;
    } catch (err: any) {
      showToast(err.response?.data?.detail || "Couldn't save your resume. Try again.", "error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [profile, id, showToast]);

  const analyze = useCallback(async () => {
    if (!id) return;
    setAnalyzing(true);
    try {
      const res = await api.post(`/resumes/${id}/analyze`);
      setReport(res.data);
      setFocusSeverity(null);
      setView("report");
    } catch (err: any) {
      showToast(err.response?.data?.detail || "Analysis couldn't be completed.", "error");
    } finally {
      setAnalyzing(false);
    }
  }, [id, showToast]);

  const improve = useCallback(async () => {
    if (!id) return;
    setImproving(true);
    try {
      const res = await api.post(`/resumes/${id}/improve`);
      setImprovement({ profile: res.data.profile, changes: res.data.changes });
    } catch (err: any) {
      showToast(err.response?.data?.detail || "The rewrite couldn't be completed.", "error");
    } finally {
      setImproving(false);
    }
  }, [id, showToast]);

  const applyImprovement = useCallback(async () => {
    if (!improvement) return;
    const ok = await save(improvement.profile);
    if (ok) {
      setImprovement(null);
      setView("resume");
    }
  }, [improvement, save]);

  const setPrimary = useCallback(async () => {
    if (!id) return;
    try {
      await api.put(`/resumes/${id}/primary`);
      setResume((prev) => (prev ? { ...prev, is_primary: true } : prev));
      showToast("This is now your primary CV.", "success");
    } catch (err: any) {
      showToast(err.response?.data?.detail || "Couldn't set this as primary.", "error");
    }
  }, [id, showToast]);

  const remove = useCallback(async () => {
    if (!id || !confirm("Delete this resume? This can't be undone.")) return;
    try {
      await api.delete(`/resumes/${id}`);
      navigate("/app/resume");
    } catch (err: any) {
      showToast(err.response?.data?.detail || "Couldn't delete this resume.", "error");
    }
  }, [id, navigate, showToast]);

  const exportPdf = useCallback(() => {
    if (printRef.current) printResume(printRef.current);
  }, []);

  const openReport = useCallback((severity: Severity | null) => {
    setFocusSeverity(severity);
    setView("report");
  }, []);

  if (loading) return <div className="rd"><div className="rd-state">Loading your resume…</div></div>;
  if (error) return <div className="rd"><div className="rd-state">{error}</div></div>;
  if (!profile || !resume) return null;

  const doc = profileToDocument(profile);

  return (
    <div className="rd">
      {toast && <div className={`rd-toast rd-toast-${toast.type}`}>{toast.message}</div>}

      <div className="rd-topbar">
        <button className="rd-btn" onClick={() => navigate("/app/resume")} aria-label="Back to all resumes">
          <i className="fa-solid fa-xmark" />
        </button>

        <span className="rd-topbar-name">
          <i className={`fa-solid fa-star rd-star${resume.is_primary ? "" : " is-off"}`} />
          {resume.name}
        </span>

        <div className="rd-topbar-spacer" />

        {dirty && <span className="rd-score-when">Unsaved changes</span>}

        {!resume.is_primary && (
          <button className="rd-btn" onClick={setPrimary}>
            <i className="fa-regular fa-star" /> Set as primary
          </button>
        )}
        <button className="rd-btn" onClick={exportPdf}>
          <i className="fa-solid fa-file-arrow-down" /> Export PDF
        </button>
        <button className="rd-btn rd-btn-danger" onClick={remove}>
          <i className="fa-regular fa-trash-can" /> Delete
        </button>
        <button className="rd-btn rd-btn-primary" onClick={() => save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      {view === "report" && report ? (
        <AnalysisReportView
          report={report}
          resumeName={resume.name}
          isPrimary={resume.is_primary}
          improving={improving}
          focusSeverity={focusSeverity}
          onBack={() => setView("resume")}
          onImprove={improve}
          onSetPrimary={setPrimary}
        />
      ) : (
        <div className="rd-workspace-wrap">
          {report ? (
            <ResumeScoreStrip
              report={report}
              analyzedAt={report.analyzed_at}
              analyzing={analyzing}
              onAnalyze={analyze}
              onViewReport={() => openReport(null)}
              onFocusSeverity={(severity) => openReport(severity as Severity)}
            />
          ) : (
            <UnanalyzedStrip onAnalyze={analyze} analyzing={analyzing} />
          )}

          <div className="rd-pane-toggle" role="tablist" aria-label="Editor or preview">
            <button role="tab" aria-selected={pane === "edit"} onClick={() => setPane("edit")}>Edit</button>
            <button role="tab" aria-selected={pane === "preview"} onClick={() => setPane("preview")}>Preview</button>
          </div>

          <div className="rd-workspace" data-pane={pane}>
            <div className="rd-editor-pane">
              <ResumeForm profile={profile} report={report} onChange={update} onFlagClick={(severity) => openReport(severity)} />
            </div>
            <aside className="rd-preview-pane" aria-label="Live preview">
              <FittedResume document={doc} />
            </aside>
          </div>
        </div>
      )}

      {improvement && (
        <ImproveModal
          changes={improvement.changes}
          applying={saving}
          onApply={applyImprovement}
          onDiscard={() => setImprovement(null)}
        />
      )}

      {/* Off-screen, print-only: the same renderer the PDF and DOCX exports use,
          so the exported file matches the canvas the user just edited. */}
      <div style={{ position: "fixed", left: "-10000px", top: 0 }} aria-hidden="true">
        <ResumeRenderer ref={printRef} document={doc} screen={false} />
      </div>
    </div>
  );
}
