import { useCallback, useEffect, useState } from "react";
import api from "../auth/api";
import type { ResumeDocument } from "../lib/resumeDocument";

// Version history (Phase 4 / spec Step 8 + 10). Lists saved versions for this
// job + resume, lets the user save the current edited document, and restore any
// version (including the untouched original) back into the editor.

interface VersionItem {
  id: number;
  resume_id: number | null;
  job_id: number | null;
  label: string;
  source: string;
  document: ResumeDocument;
  created_at: string;
}

interface VersionsPanelProps {
  jobId: number;
  resumeId: number | null;
  currentDoc: ResumeDocument;
  originalDoc: ResumeDocument;
  /** Bump to force a reload (e.g. after a new AI version is generated). */
  refreshKey?: number | null;
  onRestore: (doc: ResumeDocument) => void;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function VersionsPanel({
  jobId,
  resumeId,
  currentDoc,
  originalDoc,
  refreshKey,
  onRestore,
}: VersionsPanelProps) {
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<VersionItem[]>("/ai/resume-versions", {
        params: { job_id: jobId, resume_id: resumeId ?? undefined },
      });
      setVersions(res.data);
    } catch {
      setVersions([]);
    }
  }, [jobId, resumeId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function save() {
    setSaving(true);
    try {
      await api.post("/ai/resume-versions", {
        resume_id: resumeId,
        job_id: jobId,
        source: "user",
        label: "Your edits",
        document: currentDoc,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      await load();
    } catch {
      /* non-fatal */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ver-panel">
      <div className="ver-head">
        <span className="ats-title">Versions</span>
        <button className="ver-save" onClick={save} disabled={saving}>
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save current"}
        </button>
      </div>
      <ul className="ver-list">
        <li className="ver-item">
          <div className="ver-meta">
            <span className="ver-badge original">original</span>
            <span className="ver-label">Original resume</span>
          </div>
          <button className="ver-restore" onClick={() => onRestore(originalDoc)}>
            Restore
          </button>
        </li>
        {versions.map((v) => (
          <li key={v.id} className="ver-item">
            <div className="ver-meta">
              <span className={`ver-badge ${v.source}`}>{v.source}</span>
              <span className="ver-label">{v.label || (v.source === "ai" ? "AI version" : "Saved version")}</span>
              <span className="ver-time">{timeAgo(v.created_at)}</span>
            </div>
            <button className="ver-restore" onClick={() => onRestore(v.document)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
