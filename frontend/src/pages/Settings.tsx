import { useState, useEffect, useMemo, useRef } from "react";
import api from "../auth/api";
import "../settings.css";

// ─── TypeScript Interfaces ───────────────────────────────────────────────────

interface SettingsData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  city: string;
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

// ─── Helper Functions ────────────────────────────────────────────────────────

function computeDiff(
  original: SettingsData,
  current: SettingsData,
  currentEntries: PrefilledEntry[]
): Partial<SettingsData> | null {
  const diff: Partial<SettingsData> = {};
  const currentPrefilled = entriesToDict(currentEntries);

  const keys: (keyof SettingsData)[] = [
    "first_name",
    "last_name",
    "email",
    "phone",
    "city",
    "linkedin_url",
    "website",
    "job_title",
    "location",
    "remote_only",
    "pause_before_submit",
    "smooth_scrolling",
    "follow_companies",
  ];

  for (const key of keys) {
    if (current[key] !== original[key]) {
      (diff as any)[key] = current[key];
    }
  }

  // Compare prefilled_answers as JSON
  if (
    JSON.stringify(original.prefilled_answers) !==
    JSON.stringify(currentPrefilled)
  ) {
    diff.prefilled_answers = currentPrefilled;
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

function entriesToDict(entries: PrefilledEntry[]): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.question.trim()) {
      dict[entry.question] = entry.answer;
    }
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

// ─── ToggleSwitch Sub-Component ──────────────────────────────────────────────

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

function ToggleSwitch({ checked, onChange, label, description }: ToggleSwitchProps) {
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

// ─── KeyValueEditor Sub-Component ────────────────────────────────────────────

interface KeyValueEditorProps {
  entries: PrefilledEntry[];
  onChange: (entries: PrefilledEntry[]) => void;
}

function KeyValueEditor({ entries, onChange }: KeyValueEditorProps) {
  const updateEntry = (id: string, field: "question" | "answer", value: string) => {
    onChange(
      entries.map((e) => (e.id === id ? { ...e, [field]: value } : e))
    );
  };

  const removeEntry = (id: string) => {
    onChange(entries.filter((e) => e.id !== id));
  };

  const addEntry = () => {
    onChange([...entries, { id: crypto.randomUUID(), question: "", answer: "" }]);
  };

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

// ─── Toast Notification Component ────────────────────────────────────────────

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
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

// ─── Main Settings Component ─────────────────────────────────────────────────

export default function Settings() {
  const [formData, setFormData] = useState<SettingsData | null>(null);
  const [originalData, setOriginalData] = useState<SettingsData | null>(null);
  const [prefilledEntries, setPrefilledEntries] = useState<PrefilledEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Toast helpers ───────────────────────────────────────────────────────

  function showToast(type: "success" | "error", message: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // ─── Data Fetching ───────────────────────────────────────────────────────

  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get("/settings");
      const data = res.data;
      const settings: SettingsData = {
        first_name: data.first_name ?? "",
        last_name: data.last_name ?? "",
        email: data.email ?? "",
        phone: data.phone ?? "",
        city: data.city ?? "",
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
      setFormData(settings);
      setOriginalData(settings);
      setPrefilledEntries(dictToEntries(settings.prefilled_answers));
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Could not load settings. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSettings();
  }, []);

  // ─── Save Settings ──────────────────────────────────────────────────────

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
      const data = res.data;
      const updated: SettingsData = {
        first_name: data.first_name ?? "",
        last_name: data.last_name ?? "",
        email: data.email ?? "",
        phone: data.phone ?? "",
        city: data.city ?? "",
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
      setFormData(updated);
      setOriginalData(updated);
      setPrefilledEntries(dictToEntries(updated.prefilled_answers));
      showToast("success", "Settings saved successfully.");
    } catch (err: any) {
      showToast("error", err.response?.data?.detail || err.message || "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  // ─── Resume Upload ──────────────────────────────────────────────────────

  async function uploadResume(file: File) {
    // Client-side size check (10MB)
    if (file.size > 10 * 1024 * 1024) {
      showToast("error", "File must be under 10MB.");
      return;
    }

    const formDataUpload = new FormData();
    formDataUpload.append("file", file);

    try {
      const res = await api.post("/settings/resume", formDataUpload);
      const data = res.data;
      setFormData((prev) =>
        prev
          ? {
              ...prev,
              resume_uploaded: true,
              resume_file_name: data.resume_file_name ?? file.name,
            }
          : prev
      );
      setOriginalData((prev) =>
        prev
          ? {
              ...prev,
              resume_uploaded: true,
              resume_file_name: data.resume_file_name ?? file.name,
            }
          : prev
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

  // ─── Dirty Tracking ─────────────────────────────────────────────────────

  const isDirty = useMemo(() => {
    if (!originalData || !formData) return false;
    const currentWithPrefilled = {
      ...formData,
      prefilled_answers: entriesToDict(prefilledEntries),
    };
    return JSON.stringify(originalData) !== JSON.stringify(currentWithPrefilled);
  }, [originalData, formData, prefilledEntries]);

  // ─── Field Update Helper ────────────────────────────────────────────────

  function updateField(field: keyof SettingsData, value: string | boolean) {
    setFormData((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="settings-loading">Loading settings...</div>;
  }

  if (error) {
    return <div className="settings-error">{error}</div>;
  }

  if (!formData) return null;

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h1>Settings</h1>
        <p>Manage your account details, job preferences, and extension configuration.</p>
      </div>

      {/* Personal Info */}
      <div className="settings-section">
        <div className="settings-section-header">
          <i className="fa-solid fa-user"></i>
          <h2>Personal Information</h2>
        </div>
        <div className="settings-form-grid">
          <div className="settings-field">
            <label htmlFor="first_name">First Name</label>
            <input
              id="first_name"
              type="text"
              value={formData.first_name}
              onChange={(e) => updateField("first_name", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="last_name">Last Name</label>
            <input
              id="last_name"
              type="text"
              value={formData.last_name}
              onChange={(e) => updateField("last_name", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => updateField("email", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="phone">Phone</label>
            <input
              id="phone"
              type="tel"
              value={formData.phone}
              onChange={(e) => updateField("phone", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="city">City</label>
            <input
              id="city"
              type="text"
              value={formData.city}
              onChange={(e) => updateField("city", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="linkedin_url">LinkedIn URL</label>
            <input
              id="linkedin_url"
              type="url"
              value={formData.linkedin_url}
              onChange={(e) => updateField("linkedin_url", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="website">Website</label>
            <input
              id="website"
              type="url"
              value={formData.website}
              onChange={(e) => updateField("website", e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Job Preferences */}
      <div className="settings-section">
        <div className="settings-section-header">
          <i className="fa-solid fa-briefcase"></i>
          <h2>Job Preferences</h2>
        </div>
        <div className="settings-form-grid">
          <div className="settings-field">
            <label htmlFor="job_title">Job Title</label>
            <input
              id="job_title"
              type="text"
              value={formData.job_title}
              onChange={(e) => updateField("job_title", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="location">Preferred Location</label>
            <input
              id="location"
              type="text"
              value={formData.location}
              onChange={(e) => updateField("location", e.target.value)}
            />
          </div>
        </div>
        <ToggleSwitch
          checked={formData.remote_only}
          onChange={(val) => updateField("remote_only", val)}
          label="Remote Only"
          description="Only show remote job opportunities"
        />
      </div>

      {/* Pre-filled Answers */}
      <div className="settings-section">
        <div className="settings-section-header">
          <i className="fa-solid fa-comment-dots"></i>
          <h2>Pre-filled Answers</h2>
        </div>
        <KeyValueEditor
          entries={prefilledEntries}
          onChange={setPrefilledEntries}
        />
      </div>

      {/* Resume */}
      <div className="settings-section">
        <div className="settings-section-header">
          <i className="fa-solid fa-file-lines"></i>
          <h2>Resume</h2>
        </div>
        {formData.resume_file_name && (
          <div className="settings-resume-info">
            <i className="fa-solid fa-paperclip"></i>
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
        <button
          type="button"
          className="settings-upload-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          <i className="fa-solid fa-cloud-arrow-up"></i> Upload Resume
        </button>
      </div>

      {/* Extension Settings */}
      <div className="settings-section">
        <div className="settings-section-header">
          <i className="fa-solid fa-gear"></i>
          <h2>Extension Settings</h2>
        </div>
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
      </div>

      {/* Save Bar */}
      <div className="settings-save-bar">
        <button
          type="button"
          className="settings-save-btn"
          disabled={saving || !isDirty}
          onClick={saveSettings}
        >
          {saving ? "Saving..." : "Save Changes"}
          {isDirty && !saving && <span className="dirty-dot" />}
        </button>
      </div>

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
