import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  UserCircle,
  PuzzlePiece,
  ShieldCheck,
  ShieldStar,
  SignOut,
  GoogleLogo,
  LinkedinLogo,
  Envelope,
  ArrowRight,
} from "@phosphor-icons/react";
import api from "../auth/api";
import { useAuth } from "../auth/useAuth";
import { useOnboarding } from "../onboarding";
import { pingExtension, type ExtensionState } from "../lib/extensionBridge";
import { CHROME_STORE_URL } from "../lib/extensionStore";
import "../settings.css";
import "../settings-modal.css";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The extension toggles are the only thing this modal edits now.
 *
 * Contact details moved to /app/profile, which genuinely owns them. The columns
 * this modal used to write all still exist and the extension still reads them
 * (backend/routers/extension.py) — we only stopped offering a second, competing
 * editor.
 *
 * job_title and the screening answers live on the same application-profile
 * endpoint and are edited on /app/profile's "Application Answers" card.
 */
interface ExtensionSettings {
  pause_before_submit: boolean;
  smooth_scrolling: boolean;
  follow_companies: boolean;
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

type TabKey = "account" | "extension" | "security";

const SETTINGS_KEYS: (keyof ExtensionSettings)[] = [
  "pause_before_submit",
  "smooth_scrolling",
  "follow_companies",
];

function normalize(data: Partial<ExtensionSettings>): ExtensionSettings {
  return {
    pause_before_submit: data.pause_before_submit ?? false,
    smooth_scrolling: data.smooth_scrolling ?? false,
    follow_companies: data.follow_companies ?? false,
  };
}

function computeDiff(
  original: ExtensionSettings,
  current: ExtensionSettings
): Partial<ExtensionSettings> | null {
  const diff: Partial<ExtensionSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (current[key] !== original[key]) diff[key] = current[key];
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

const PROVIDERS: Record<string, { label: string; icon: ReactNode }> = {
  google: { label: "Google", icon: <GoogleLogo size={18} weight="bold" /> },
  linkedin: { label: "LinkedIn", icon: <LinkedinLogo size={18} weight="fill" /> },
  local: { label: "Email & password", icon: <Envelope size={18} weight="duotone" /> },
};

const EXT_STATUS: Record<Exclude<ExtensionState, "unknown">, string> = {
  "not-installed": "Not installed",
  installed: "Installed — not signed in",
  connected: "Installed and connected",
};

const TABS: { key: TabKey; label: string; title: string; icon: ReactNode }[] = [
  { key: "account", label: "Account", title: "Account details", icon: <UserCircle size={18} weight="duotone" /> },
  { key: "extension", label: "Extension", title: "Extension", icon: <PuzzlePiece size={18} weight="duotone" /> },
  { key: "security", label: "Security", title: "Login & security", icon: <ShieldCheck size={18} weight="duotone" /> },
];

// ─── Row primitive ───────────────────────────────────────────────────────────

/**
 * Every row in every tab is one of these: muted label | value | right-aligned
 * action, closed by a hairline. That single repeated rhythm is the redesign —
 * resist adding bespoke layouts inside a tab.
 */
function SettingRow({
  label,
  children,
  action,
}: {
  label: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="sm-row">
      <span className="sm-row-label">{label}</span>
      <div className="sm-row-value">{children}</div>
      {action ? <div className="sm-row-action">{action}</div> : null}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
    </label>
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
          <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Close notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Main modal ──────────────────────────────────────────────────────────────

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<TabKey>("account");
  const [formData, setFormData] = useState<ExtensionSettings | null>(null);
  const [originalData, setOriginalData] = useState<ExtensionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [extState, setExtState] = useState<ExtensionState>("unknown");

  const { user, logout } = useAuth();
  const { restart: restartTour } = useOnboarding();
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function showToast(type: "success" | "error", message: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }
  const dismissToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  // ─── Data ──────────────────────────────────────────────────────────────
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

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.get("/settings");
        const settings = normalize(res.data);
        setFormData(settings);
        setOriginalData(settings);
      } catch (err: any) {
        setError(
          err.response?.data?.detail || err.message || "Could not load settings. Please check your connection."
        );
      } finally {
        setLoading(false);
      }
    })();
    void loadSessions();
    // Same contract as ExtensionBanner: no explicit timeout (the default lives with
    // its rationale in extensionBridge), guard the setState on unmount, and swallow
    // a rejection that pingExtension promises never to produce but nothing enforces.
    void pingExtension()
      .then((s) => {
        if (alive) setExtState(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

  async function saveSettings() {
    if (!formData || !originalData) return;
    const diff = computeDiff(originalData, formData);
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
      showToast("success", "Settings saved successfully.");
    } catch (err: any) {
      showToast("error", err.response?.data?.detail || err.message || "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  const isDirty = useMemo(
    () => Boolean(originalData && formData && computeDiff(originalData, formData)),
    [originalData, formData]
  );

  function updateField(field: keyof ExtensionSettings, value: boolean) {
    setFormData((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  const goTo = (path: string) => {
    navigate(path);
    onClose();
  };

  // ─── Tabs ──────────────────────────────────────────────────────────────

  function renderAccount() {
    const provider = PROVIDERS[user?.auth_provider ?? "local"] ?? PROVIDERS.local;
    const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
    const initials = (user?.first_name?.[0] || user?.email?.[0] || "U").toUpperCase();

    return (
      <div className="sm-rows">
        <SettingRow
          label="Profile"
          action={
            <button type="button" className="sm-link" onClick={() => goTo("/app/profile")}>
              Update profile <ArrowRight size={13} weight="bold" />
            </button>
          }
        >
          <span className="sm-identity">
            <span className="sm-avatar">
              {user?.profile_image_url ? (
                <img src={user.profile_image_url} alt="" />
              ) : (
                initials
              )}
            </span>
            <span className="sm-identity-name">{fullName || "Your name"}</span>
          </span>
        </SettingRow>

        <SettingRow
          label="Email address"
          action={
            <span className={`sm-pill ${user?.email_verified ? "sm-pill-ok" : "sm-pill-warn"}`}>
              {user?.email_verified ? "Verified" : "Unverified"}
            </span>
          }
        >
          {user?.email ?? "—"}
        </SettingRow>

        {/* Read-only: there is no account-linking flow. auth_provider is set once,
            at signup, and cannot be changed from the app. */}
        <SettingRow label="Connected account">
          <span className="sm-provider">
            {provider.icon}
            {provider.label}
          </span>
        </SettingRow>

        <SettingRow
          label="Profile & résumé"
          action={
            <button type="button" className="sm-link" onClick={() => goTo("/app/profile")}>
              Edit on Profile <ArrowRight size={13} weight="bold" />
            </button>
          }
        >
          {/* Only claim what /app/profile can actually edit. Screening answers
              (work authorization, sponsorship, salary) are now editable there on
              the "Application Answers" card, so we can name them again. */}
          <span className="sm-muted">
            Name, contact details, address, EEO answers and saved screening answers.
          </span>
        </SettingRow>
      </div>
    );
  }

  function renderExtension() {
    // The /settings fetch gates THIS tab only — it is the only tab that reads it.
    // Account renders from useAuth() and Security from /auth/sessions, so a failing
    // GET /settings must not cost the user their identity row and their device list
    // with an error about an endpoint neither tab touches.
    if (loading) return <div className="settings-loading">Loading settings…</div>;
    if (error) return <div className="settings-error">{error}</div>;
    if (!formData) return null;
    return (
      <div className="sm-rows" data-tour="extension-settings">
        <SettingRow
          label="Status"
          action={
            extState === "not-installed" ? (
              <a className="sm-cta" href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer">
                Add to Chrome
              </a>
            ) : extState === "installed" ? (
              <button type="button" className="sm-link" onClick={() => goTo("/extension/connect")}>
                Finish setup <ArrowRight size={13} weight="bold" />
              </button>
            ) : null
          }
        >
          {extState === "unknown" ? "Checking…" : EXT_STATUS[extState]}
        </SettingRow>

        <SettingRow
          label="Pause before submit"
          action={
            <ToggleSwitch
              label="Pause before submit"
              checked={formData.pause_before_submit}
              onChange={(v) => updateField("pause_before_submit", v)}
            />
          }
        >
          <span className="sm-muted">Review each application before it is submitted.</span>
        </SettingRow>

        <SettingRow
          label="Smooth scrolling"
          action={
            <ToggleSwitch
              label="Smooth scrolling"
              checked={formData.smooth_scrolling}
              onChange={(v) => updateField("smooth_scrolling", v)}
            />
          }
        >
          <span className="sm-muted">Scroll smoothly while moving through a form.</span>
        </SettingRow>

        <SettingRow
          label="Follow companies"
          action={
            <ToggleSwitch
              label="Follow companies"
              checked={formData.follow_companies}
              onChange={(v) => updateField("follow_companies", v)}
            />
          }
        >
          <span className="sm-muted">Follow a company automatically when you apply.</span>
        </SettingRow>

        <SettingRow
          label="Product tour"
          action={
            <button
              type="button"
              className="sm-link"
              onClick={() => {
                void restartTour();
                goTo("/app");
              }}
            >
              Restart tour <ArrowRight size={13} weight="bold" />
            </button>
          }
        >
          <span className="sm-muted">Replay the guided walkthrough from the beginning.</span>
        </SettingRow>
      </div>
    );
  }

  function renderSecurity() {
    return (
      <div className="sm-rows">
        <SettingRow label="Devices">
          <span className="sm-muted">
            Browsers and the Tailrd extension currently signed in to your account.
          </span>
        </SettingRow>

        {sessionsLoading ? (
          <SettingRow label="">
            <span className="sm-muted">Loading…</span>
          </SettingRow>
        ) : sessions.length === 0 ? (
          <SettingRow label="">
            <span className="sm-muted">No active sessions.</span>
          </SettingRow>
        ) : (
          sessions.map((s) => (
            <SettingRow
              key={s.sid}
              label={s.client === "extension" ? "Chrome extension" : "Web"}
              action={
                <button
                  type="button"
                  className="device-revoke"
                  onClick={() => void revokeSession(s.sid)}
                  disabled={s.is_current}
                >
                  Revoke
                </button>
              }
            >
              <span className="sm-muted">
                Connected {new Date(s.created_at).toLocaleDateString()} · Last seen{" "}
                {new Date(s.last_seen_at).toLocaleString()}
                {s.last_ip ? ` · ${s.last_ip}` : ""}
                {s.is_current ? " · This device" : ""}
              </span>
            </SettingRow>
          ))
        )}

        <div className="sm-rows-footer">
          <button type="button" className="device-revoke-all" onClick={() => void signOutEverywhere()}>
            Sign out of all devices (except this one)
          </button>
        </div>
      </div>
    );
  }

  function renderTab() {
    switch (activeTab) {
      case "account":
        return renderAccount();
      case "extension":
        return renderExtension();
      case "security":
        return renderSecurity();
    }
  }

  const activeMeta = TABS.find((t) => t.key === activeTab);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <aside className="sm-nav">
          <div className="sm-nav-top">
            <div className="sm-nav-header">
              <h2 className="sm-nav-title">Account</h2>
              <p className="sm-nav-sub">Manage your account info.</p>
            </div>
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`sm-nav-item${activeTab === tab.key ? " active" : ""}`}
                // The selected tab must not be conveyed by background colour alone;
                // aria-label survives the ≤768px rule that hides the label text and
                // leaves an icon-only button.
                aria-current={activeTab === tab.key ? "page" : undefined}
                aria-label={tab.label}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="sm-nav-icon">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div className="sm-nav-bottom">
            <button
              type="button"
              className="sm-nav-item"
              aria-label="Privacy Policy"
              onClick={() => goTo("/privacy")}
            >
              <span className="sm-nav-icon">
                <ShieldStar size={18} weight="duotone" />
              </span>
              <span>Privacy Policy</span>
            </button>
            <button
              type="button"
              className="sm-nav-item sm-nav-danger"
              aria-label="Log Out"
              onClick={logout}
            >
              <span className="sm-nav-icon">
                <SignOut size={18} weight="duotone" />
              </span>
              <span>Log Out</span>
            </button>
          </div>
        </aside>

        <div className="sm-panel">
          <header className="sm-panel-header">
            <h2>{activeMeta?.title ?? "Settings"}</h2>
            <button type="button" className="sm-close" onClick={onClose} aria-label="Close settings">
              <X size={20} weight="bold" />
            </button>
          </header>

          <div className="sm-panel-body">{renderTab()}</div>

          {/* Mounted on the Extension tab (its editor) *and* on any tab while a
              toggle is unsaved — otherwise flipping a toggle and switching tabs
              strands the change: the Save button and its dirty dot would vanish
              while the edit is still pending, and closing the modal would drop it
              silently. */}
          {(activeTab === "extension" || isDirty) && !loading && !error && (
            <div className="sm-save-bar">
              <button
                type="button"
                className="settings-save-btn"
                disabled={saving || !isDirty}
                onClick={saveSettings}
              >
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
