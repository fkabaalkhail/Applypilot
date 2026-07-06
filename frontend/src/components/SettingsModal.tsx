import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  UserCircle,
  Briefcase,
  ChatCircleDots,
  GearSix,
  ShieldCheck,
  ShieldStar,
  SignOut,
  CloudArrowUp,
  Paperclip,
} from "@phosphor-icons/react";
import api from "../auth/api";
import { useAuth } from "../auth/useAuth";
import { useOnboarding } from "../onboarding";
import "../settings.css";
import "../settings-modal.css";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SettingsData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  linkedin_url: string;
  website: string;
  job_title: string;
  location: string;
  remote_only: boolean;
  prefilled_answers: Record<string, string>;
  resume_uploaded: boolean;
  resume_file_name: string;
  pause_before_submit: boolean;
  smooth_scrolling: boolean;
  follow_companies: boolean;
}

interface PrefilledEntry {
  id: string;
  question: string;
  answer: string;
}

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

interface DeviceSession {
  sid: string;
  client: string;
  created_at: string;
  last_seen_at: string;
  last_ip: string | null;
  user_agent: string | null;
  is_current: boolean;
}

type TabKey = "profile" | "jobs" | "answers" | "extension" | "security";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SETTINGS_KEYS: (keyof SettingsData)[] = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "linkedin_url",
  "website",
  "job_title",
  "location",
  "remote_only",
  "pause_before_submit",
  "smooth_scrolling",
  "follow_companies",
];

function entriesToDict(entries: PrefilledEntry[]): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.question.trim()) dict[entry.question] = entry.answer;
  }
  return dict;
}

function dictToEntries(dict: Record<string, string>): PrefilledEntry[] {
  return Object.entries(dict).map(([question, answer]) => ({
    id: crypto.randomUUID(),
    question,
    answer,
  }));
}

function computeDiff(
  original: SettingsData,
  current: SettingsData,
  currentEntries: PrefilledEntry[]
): Partial<SettingsData> | null {
  const diff: Partial<SettingsData> = {};
  const currentPrefilled = entriesToDict(currentEntries);

  for (const key of SETTINGS_KEYS) {
    if (current[key] !== original[key]) (diff as any)[key] = current[key];
  }
  if (
    JSON.stringify(original.prefilled_answers) !== JSON.stringify(currentPrefilled)
  ) {
    diff.prefilled_answers = currentPrefilled;
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

function normalize(data: any): SettingsData {
  return {
    first_name: data.first_name ?? "",
    last_name: data.last_name ?? "",
    email: data.email ?? "",
    phone: data.phone ?? "",
    linkedin_url: data.linkedin_url ?? "",
    website: data.website ?? "",
    job_title: data.job_title ?? "",
    location: data.location ?? "",
    remote_only: data.remote_only ?? false,
    prefilled_answers: data.prefilled_answers ?? {},
    resume_uploaded: data.resume_uploaded ?? false,
    resume_file_name: data.resume_file_name ?? "",
    pause_before_submit: data.pause_before_submit ?? false,
    smooth_scrolling: data.smooth_scrolling ?? false,
    follow_companies: data.follow_companies ?? false,
  };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ToggleSwitch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-label">
        <span className="toggle-label-text">{label}</span>
        {description && <span className="toggle-label-desc">{description}</span>}
      </div>
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-track" />
      </label>
    </div>
  );
}

function KeyValueEditor({
  entries,
  onChange,
}: {
  entries: PrefilledEntry[];
  onChange: (entries: PrefilledEntry[]) => void;
}) {
  const updateEntry = (id: string, field: "question" | "answer", value: string) => {
    onChange(entries.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  };
  const removeEntry = (id: string) => onChange(entries.filter((e) => e.id !== id));
  const addEntry = () =>
    onChange([...entries, { id: crypto.randomUUID(), question: "", answer: "" }]);

  return (
    <div className="kv-editor">
      {entries.map((entry) => (
        <div key={entry.id} className="kv-row">
          <input
            type="text"
            placeholder="Question"
            value={entry.question}
            onChange={(e) => updateEntry(entry.id, "question", e.target.value)}
          />
          <input
            type="text"
            placeholder="Answer"
            value={entry.answer}
            onChange={(e) => updateEntry(entry.id, "answer", e.target.value)}
          />
          <button
            type="button"
            className="kv-remove-btn"
            onClick={() => removeEntry(entry.id)}
            aria-label="Remove entry"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="kv-add-btn" onClick={addEntry}>
        + Add Answer
      </button>
    </div>
  );
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span>{toast.message}</span>
          <button
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Close notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Nav definition ──────────────────────────────────────────────────────────

const TABS: { key: TabKey; label: string; icon: JSX.Element }[] = [
  { key: "profile", label: "Profile & Contact", icon: <UserCircle size={20} weight="duotone" /> },
  { key: "jobs", label: "Job Preferences", icon: <Briefcase size={20} weight="duotone" /> },
  { key: "answers", label: "Autofill & Answers", icon: <ChatCircleDots size={20} weight="duotone" /> },
  { key: "extension", label: "Extension", icon: <GearSix size={20} weight="duotone" /> },
  { key: "security", label: "Login & Security", icon: <ShieldCheck size={20} weight="duotone" /> },
];

// ─── Main modal ──────────────────────────────────────────────────────────────

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<TabKey>("profile");
  const [formData, setFormData] = useState<SettingsData | null>(null);
  const [originalData, setOriginalData] = useState<SettingsData | null>(null);
  const [prefilledEntries, setPrefilledEntries] = useState<PrefilledEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const { logout } = useAuth();
  const { restart: restartTour } = useOnboarding();
  const navigate = useNavigate();

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ─── Toasts ────────────────────────────────────────────────────────────
  function showToast(type: "success" | "error", message: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }
  const dismissToast = (id: string) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  // ─── Sessions ──────────────────────────────────────────────────────────
  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      const { data } = await api.get<{ sessions: DeviceSession[] }>("/auth/sessions");
      setSessions(data.sessions);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  };
  const revokeSession = async (sid: string) => {
    try {
      await api.delete(`/auth/sessions/${sid}`);
      setSessions((prev) => prev.filter((s) => s.sid !== sid));
    } catch {
      showToast("error", "Failed to revoke session.");
    }
  };
  const signOutEverywhere = async () => {
    try {
      await api.post("/auth/sessions/revoke-all", { except_current: true });
      await loadSessions();
    } catch {
      /* no-op */
    }
  };

  // ─── Fetch ─────────────────────────────────────────────────────────────
  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get("/settings");
      const settings = normalize(res.data);
      setFormData(settings);
      setOriginalData(settings);
      setPrefilledEntries(dictToEntries(settings.prefilled_answers));
    } catch (err: any) {
      setError(
        err.response?.data?.detail ||
          err.message ||
          "Could not load settings. Please check your connection."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSettings();
    void loadSessions();
  }, []);

  // ─── Save ──────────────────────────────────────────────────────────────
  async function saveSettings() {
    if (!formData || !originalData) return;
    const diff = computeDiff(originalData, formData, prefilledEntries);
    if (!diff) {
      showToast("success", "No changes to save.");
      return;
    }
    try {
      setSaving(true);
      const res = await api.put("/settings", diff);
      const updated = normalize(res.data);
      setFormData(updated);
      setOriginalData(updated);
      setPrefilledEntries(dictToEntries(updated.prefilled_answers));
      showToast("success", "Settings saved successfully.");
    } catch (err: any) {
      showToast(
        "error",
        err.response?.data?.detail || err.message || "Failed to save settings."
      );
    } finally {
      setSaving(false);
    }
  }

  // ─── Resume upload ─────────────────────────────────────────────────────
  async function uploadResume(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      showToast("error", "File must be under 10MB.");
      return;
    }
    const upload = new FormData();
    upload.append("file", file);
    try {
      const res = await api.post("/settings/resume", upload);
      const fname = res.data.resume_file_name ?? file.name;
      setFormData((prev) =>
        prev ? { ...prev, resume_uploaded: true, resume_file_name: fname } : prev
      );
      setOriginalData((prev) =>
        prev ? { ...prev, resume_uploaded: true, resume_file_name: fname } : prev
      );
      showToast("success", "Resume uploaded successfully.");
    } catch (err: any) {
      if (err.response?.status === 400) {
        showToast("error", "Only PDF and DOCX files are accepted.");
      } else {
        showToast("error", "Resume upload failed.");
      }
    }
  }

  // ─── Dirty tracking ────────────────────────────────────────────────────
  const isDirty = useMemo(() => {
    if (!originalData || !formData) return false;
    const current = { ...formData, prefilled_answers: entriesToDict(prefilledEntries) };
    return JSON.stringify(originalData) !== JSON.stringify(current);
  }, [originalData, formData, prefilledEntries]);

  function updateField(field: keyof SettingsData, value: string | boolean) {
    setFormData((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  // ─── Render body per tab ───────────────────────────────────────────────
  function renderTab() {
    if (loading) return <div className="settings-loading">Loading settings…</div>;
    if (error) return <div className="settings-error">{error}</div>;
    if (!formData) return null;

    switch (activeTab) {
      case "profile":
        return (
          <div className="sm-section">
            <div className="settings-form-grid">
              <div className="settings-field">
                <label htmlFor="first_name">First Name</label>
                <input id="first_name" type="text" value={formData.first_name}
                  onChange={(e) => updateField("first_name", e.target.value)} />
              </div>
              <div className="settings-field">
                <label htmlFor="last_name">Last Name</label>
                <input id="last_name" type="text" value={formData.last_name}
                  onChange={(e) => updateField("last_name", e.target.value)} />
              </div>
              <div className="settings-field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" value={formData.email}
                  onChange={(e) => updateField("email", e.target.value)} />
              </div>
              <div className="settings-field">
                <label htmlFor="phone">Phone</label>
                <input id="phone" type="tel" value={formData.phone}
                  onChange={(e) => updateField("phone", e.target.value)} />
              </div>
              <div className="settings-field">
                <label htmlFor="linkedin_url">LinkedIn URL</label>
                <input id="linkedin_url" type="url" value={formData.linkedin_url}
                  onChange={(e) => updateField("linkedin_url", e.target.value)} />
              </div>
              <div className="settings-field">
                <label htmlFor="website">Website</label>
                <input id="website" type="url" value={formData.website}
                  onChange={(e) => updateField("website", e.target.value)} />
              </div>
            </div>
          </div>
        );

      case "jobs":
        return (
          <div className="sm-section">
            <div className="settings-form-grid">
              <div className="settings-field">
                <label htmlFor="job_title">Job Title</label>
                <input id="job_title" type="text" value={formData.job_title}
                  onChange={(e) => updateField("job_title", e.target.value)} />
              </div>
              <div className="settings-field">
                <label htmlFor="location">Preferred Location</label>
                <input id="location" type="text" value={formData.location}
                  onChange={(e) => updateField("location", e.target.value)} />
              </div>
            </div>
            <ToggleSwitch
              checked={formData.remote_only}
              onChange={(val) => updateField("remote_only", val)}
              label="Remote Only"
              description="Only show remote job opportunities"
            />
          </div>
        );

      case "answers":
        return (
          <div className="sm-section">
            <h3 className="sm-subhead">Pre-filled Answers</h3>
            <p className="settings-section-sub">
              Saved answers Tailrd reuses when auto-filling job applications.
            </p>
            <KeyValueEditor entries={prefilledEntries} onChange={setPrefilledEntries} />

            <h3 className="sm-subhead sm-subhead-spaced">Resume</h3>
            {formData.resume_file_name && (
              <div className="settings-resume-info">
                <Paperclip size={16} weight="bold" />
                <span className="settings-resume-filename">{formData.resume_file_name}</span>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadResume(file);
                e.target.value = "";
              }}
            />
            <button type="button" className="settings-upload-btn"
              onClick={() => fileInputRef.current?.click()}>
              <CloudArrowUp size={16} weight="bold" /> Upload Resume
            </button>
          </div>
        );

      case "extension":
        return (
          <div className="sm-section" data-tour="extension-settings">
            <ToggleSwitch
              checked={formData.pause_before_submit}
              onChange={(val) => updateField("pause_before_submit", val)}
              label="Pause Before Submit"
              description="Pause for review before submitting applications"
            />
            <ToggleSwitch
              checked={formData.smooth_scrolling}
              onChange={(val) => updateField("smooth_scrolling", val)}
              label="Smooth Scrolling"
              description="Use smooth scrolling when navigating forms"
            />
            <ToggleSwitch
              checked={formData.follow_companies}
              onChange={(val) => updateField("follow_companies", val)}
              label="Follow Companies"
              description="Automatically follow companies when applying"
            />

            <h3 className="sm-subhead sm-subhead-spaced">Product Tour</h3>
            <p className="settings-section-sub">
              Replay the guided walkthrough of Tailrd's features from the beginning.
            </p>
            <button type="button" className="settings-upload-btn"
              onClick={() => { void restartTour(); navigate("/app"); onClose(); }}>
              Restart product tour
            </button>
          </div>
        );

      case "security":
        return (
          <div className="sm-section">
            <p className="settings-section-sub">
              Browsers and the Tailrd extension currently signed in to your account.
            </p>
            {sessionsLoading ? (
              <p className="settings-section-sub">Loading…</p>
            ) : sessions.length === 0 ? (
              <p className="settings-section-sub">No active sessions.</p>
            ) : (
              <ul className="device-list">
                {sessions.map((s) => (
                  <li key={s.sid} className="device-row">
                    <div className="device-meta">
                      <span className="device-client">
                        {s.client === "extension" ? "Chrome extension" : "Web"}
                        {s.is_current && <span className="device-current"> · This device</span>}
                      </span>
                      <span className="device-times">
                        Connected {new Date(s.created_at).toLocaleDateString()} · Last seen {new Date(s.last_seen_at).toLocaleString()}
                        {s.last_ip && ` · ${s.last_ip}`}
                      </span>
                    </div>
                    <button type="button" className="device-revoke"
                      onClick={() => void revokeSession(s.sid)} disabled={s.is_current}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="device-revoke-all"
              onClick={() => void signOutEverywhere()}>
              Sign out of all devices (except this one)
            </button>
          </div>
        );
    }
  }

  const activeMeta = TABS.find((t) => t.key === activeTab);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Settings">
        {/* Left nav */}
        <aside className="sm-nav">
          <div className="sm-nav-top">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`sm-nav-item${activeTab === tab.key ? " active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="sm-nav-icon">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div className="sm-nav-bottom">
            <button type="button" className="sm-nav-item"
              onClick={() => { navigate("/privacy"); onClose(); }}>
              <span className="sm-nav-icon"><ShieldStar size={20} weight="duotone" /></span>
              <span>Privacy Policy</span>
            </button>
            <button type="button" className="sm-nav-item sm-nav-danger" onClick={logout}>
              <span className="sm-nav-icon"><SignOut size={20} weight="duotone" /></span>
              <span>Log Out</span>
            </button>
          </div>
        </aside>

        {/* Right panel */}
        <div className="sm-panel">
          <header className="sm-panel-header">
            <h2>{activeMeta?.label ?? "Settings"}</h2>
            <button type="button" className="sm-close" onClick={onClose} aria-label="Close settings">
              <X size={20} weight="bold" />
            </button>
          </header>

          <div className="sm-panel-body">{renderTab()}</div>

          {(activeTab === "profile" ||
            activeTab === "jobs" ||
            activeTab === "answers" ||
            activeTab === "extension") &&
            !loading &&
            !error && (
              <div className="sm-save-bar">
                <button type="button" className="settings-save-btn"
                  disabled={saving || !isDirty} onClick={saveSettings}>
                  {saving ? "Saving…" : "Save Changes"}
                  {isDirty && !saving && <span className="dirty-dot" />}
                </button>
              </div>
            )}
        </div>

        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    </div>
  );
}
