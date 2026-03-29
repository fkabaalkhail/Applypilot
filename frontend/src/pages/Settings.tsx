/**
 * Settings page — clients configure everything from the browser.
 * Resume upload, LinkedIn creds or cookies, profile info, job filters.
 */

import { useState, useEffect, useRef } from "react";
import { fetchSettings, saveSettings, type Settings } from "../api";
import axios from "axios";

const EXPERIENCE_LEVELS = [
  { value: "intern", label: "Internship" },
  { value: "entry", label: "Entry / Junior" },
  { value: "mid", label: "Mid-Level" },
  { value: "senior", label: "Senior" },
  { value: "director", label: "Director" },
  { value: "executive", label: "Executive" },
];

const WORK_TYPES = [
  { value: "", label: "Any" },
  { value: "remote", label: "Remote" },
  { value: "onsite", label: "On-site" },
  { value: "hybrid", label: "Hybrid" },
];

const NA_REGIONS = [
  "United States",
  "Canada",
  "Toronto, Ontario, Canada",
  "Ottawa, Ontario, Canada",
  "Vancouver, British Columbia, Canada",
  "Montreal, Quebec, Canada",
  "Calgary, Alberta, Canada",
  "New York, New York, United States",
  "San Francisco Bay Area",
  "Los Angeles, California, United States",
  "Seattle, Washington, United States",
  "Austin, Texas, United States",
  "Chicago, Illinois, United States",
  "Boston, Massachusetts, United States",
  "Denver, Colorado, United States",
  "Washington, DC, United States",
  "Atlanta, Georgia, United States",
  "Dallas, Texas, United States",
  "Miami, Florida, United States",
];

const COMMON_QUESTIONS = [
  "Are you legally authorized to work in this country?",
  "Will you now or in the future require sponsorship?",
  "Are you a veteran?",
  "What is your citizenship status?",
  "Do you have a valid driver's license?",
  "Are you 18 years of age or older?",
  "What is your desired salary?",
  "How many years of experience do you have?",
  "What is your highest level of education?",
  "Are you willing to relocate?",
  "Can you commute to this job's location?",
  "Do you have a disability?",
  "What is your gender?",
  "What is your ethnicity?",
];

const EMPTY: Settings = {
  linkedin_email: "",
  linkedin_password_set: false,
  linkedin_cookies_set: false,
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  city: "",
  linkedin_url: "",
  website: "",
  resume_uploaded: false,
  resume_file_name: "",
  job_title: "",
  location: "",
  remote_only: false,
  max_applications_per_run: 25,
  experience_levels: [],
  work_type: "",
  regions: [],
  prefilled_answers: {},
  autopilot_enabled: false,
  company_blacklist: [],
  keyword_blacklist: [],
  min_salary: null,
  max_salary: null,
  min_experience_years: null,
  max_experience_years: null,
  daily_apply_limit: 50,
  weekly_apply_limit: 200,
  apply_delay_min: 30,
  apply_delay_max: 120,
  pause_before_submit: false,
  follow_companies: false,
  hr_outreach_enabled: false,
  hr_daily_connect_limit: 10,
  smooth_scrolling: false,
  resume_tailoring_enabled: false,
};

function ConnectLinkedIn() {
  const [cookie, setCookie] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  const handleSave = async () => {
    if (!cookie.trim()) return;
    setSaving(true);
    try {
      await axios.put("/api/settings", { linkedin_cookie: cookie.trim() });
      setStatus("saved");
      setCookie("");
      setTimeout(() => setStatus(""), 3000);
    } catch {
      setStatus("error");
    }
    setSaving(false);
  };

  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={labelStyle}>LinkedIn Session Cookie (li_at)</label>
      <p style={{ fontSize: "0.8rem", color: "#888", margin: "0 0 0.5rem 0" }}>
        1. Open <a href="https://www.linkedin.com" target="_blank" rel="noopener noreferrer" style={{ color: "#4361ee" }}>linkedin.com</a> in your browser (make sure you're logged in)<br/>
        2. Press F12 → Application tab → Cookies → linkedin.com<br/>
        3. Find the cookie named <code style={{ background: "#f0f0f0", padding: "0.1rem 0.3rem", borderRadius: "3px" }}>li_at</code> and copy its value<br/>
        4. Paste it below
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          placeholder="Paste li_at cookie value here..."
          style={{ ...inputStyle, flex: 1, fontFamily: "monospace", fontSize: "0.8rem" }}
        />
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ whiteSpace: "nowrap" }}>
          {saving ? "Saving..." : "Connect"}
        </button>
      </div>
      {status === "saved" && <p style={{ color: "#155724", fontSize: "0.85rem", marginTop: "0.3rem" }}>Connected ✓</p>}
      {status === "error" && <p style={{ color: "#dc3545", fontSize: "0.85rem", marginTop: "0.3rem" }}>Failed to save</p>}
    </div>
  );
}

function TagListInput({ label, hint, tags, onChange }: {
  label: string; hint: string; tags: string[]; onChange: (v: string[]) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={labelStyle}>{label}</label>
      <p style={{ fontSize: "0.8rem", color: "#888", margin: "0 0 0.4rem 0" }}>{hint}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginBottom: "0.4rem" }}>
        {tags.map((tag) => (
          <span key={tag} style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", padding: "0.2rem 0.5rem", borderRadius: "6px", background: "#f0f0f0", fontSize: "0.8rem" }}>
            {tag}
            <button onClick={() => onChange(tags.filter((t) => t !== tag))} style={{ border: "none", background: "none", cursor: "pointer", color: "#999", fontSize: "0.9rem", padding: 0, lineHeight: 1 }} aria-label={`Remove ${tag}`}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              e.preventDefault();
              if (!tags.includes(input.trim())) onChange([...tags, input.trim()]);
              setInput("");
            }
          }}
          placeholder="Type and press Enter..."
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          className="btn"
          style={{ background: "#f0f0f0", whiteSpace: "nowrap" }}
          onClick={() => {
            if (input.trim() && !tags.includes(input.trim())) onChange([...tags, input.trim()]);
            setInput("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem", cursor: "pointer" }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 40, height: 22, borderRadius: 11, background: checked ? "#4361ee" : "#ccc",
          position: "relative", transition: "background 0.2s", flexShrink: 0,
        }}
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked); } }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: "50%", background: "#fff",
          position: "absolute", top: 2, left: checked ? 20 : 2, transition: "left 0.2s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }} />
      </div>
      <div>
        <div style={{ fontSize: "0.9rem", fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: "0.8rem", color: "#888" }}>{hint}</div>
      </div>
    </label>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resumeMsg, setResumeMsg] = useState("");
  const [customQ, setCustomQ] = useState("");
  const [customA, setCustomA] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchSettings().then(setSettings);
  }, []);

  const [saveError, setSaveError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError("");
    const payload: Record<string, unknown> = {
      linkedin_email: settings.linkedin_email,
      first_name: settings.first_name,
      last_name: settings.last_name,
      email: settings.email,
      phone: settings.phone,
      city: settings.city,
      linkedin_url: settings.linkedin_url,
      website: settings.website,
      job_title: settings.job_title,
      location: settings.location,
      remote_only: settings.remote_only,
      max_applications_per_run: settings.max_applications_per_run,
      experience_levels: settings.experience_levels,
      work_type: settings.work_type,
      regions: settings.regions,
      company_blacklist: settings.company_blacklist,
      keyword_blacklist: settings.keyword_blacklist,
      min_salary: settings.min_salary,
      max_salary: settings.max_salary,
      min_experience_years: settings.min_experience_years,
      max_experience_years: settings.max_experience_years,
      daily_apply_limit: settings.daily_apply_limit,
      weekly_apply_limit: settings.weekly_apply_limit,
      apply_delay_min: settings.apply_delay_min,
      apply_delay_max: settings.apply_delay_max,
      pause_before_submit: settings.pause_before_submit,
      follow_companies: settings.follow_companies,
      hr_outreach_enabled: settings.hr_outreach_enabled,
      hr_daily_connect_limit: settings.hr_daily_connect_limit,
      smooth_scrolling: settings.smooth_scrolling,
      resume_tailoring_enabled: settings.resume_tailoring_enabled,
    };
    if (password) payload.linkedin_password = password;
    try {
      const updated = await saveSettings(payload);
      setSettings(updated);
      setPassword("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setSaveError("Could not save — is the backend running?");
      setTimeout(() => setSaveError(""), 5000);
    } finally {
      setSaving(false);
    }
  };

  const handleResumeUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "pdf" && ext !== "docx") {
      setResumeMsg("Only PDF and DOCX files are accepted.");
      setTimeout(() => setResumeMsg(""), 5000);
      return;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const { data } = await axios.post("/api/settings/resume", form);
      setSettings(data);
      setResumeMsg("Resume uploaded ✓");
      setTimeout(() => setResumeMsg(""), 3000);
    } catch (err: unknown) {
      const detail =
        axios.isAxiosError(err) && err.response?.data?.detail
          ? String(err.response.data.detail)
          : "Upload failed";
      setResumeMsg(detail);
      setTimeout(() => setResumeMsg(""), 5000);
    }
  };

  const toggleExpLevel = (val: string) => {
    setSettings((s) => ({
      ...s,
      experience_levels: s.experience_levels.includes(val)
        ? s.experience_levels.filter((v) => v !== val)
        : [...s.experience_levels, val],
    }));
  };

  const toggleRegion = (val: string) => {
    setSettings((s) => ({
      ...s,
      regions: s.regions.includes(val)
        ? s.regions.filter((v) => v !== val)
        : [...s.regions, val],
    }));
  };

  const field = (label: string, key: keyof Settings, type = "text") => (
    <div style={{ marginBottom: "0.75rem" }}>
      <label htmlFor={key} style={labelStyle}>{label}</label>
      <input
        id={key}
        type={type}
        value={String(settings[key] ?? "")}
        onChange={(e) =>
          setSettings((s) => ({
            ...s,
            [key]: type === "number" ? Number(e.target.value) : e.target.value,
          }))
        }
        style={inputStyle}
      />
    </div>
  );

  return (
    <div style={{ paddingTop: "1.5rem", maxWidth: "650px" }}>
      <h2 style={{ marginBottom: "1.5rem" }}>Settings</h2>

      {/* Resume Upload */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Resume</h3>
        <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: "0.75rem" }}>
          Upload your resume (PDF or DOCX). The bot will attach it to applications.
          {settings.resume_uploaded && (
            <span style={{ color: "#155724" }}>
              {" — "}Currently uploaded: {settings.resume_file_name || "✓"}
            </span>
          )}
        </p>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label="Upload resume file (PDF or DOCX)"
          />
          <button className="btn btn-primary" onClick={handleResumeUpload}>Upload</button>
        </div>
        {resumeMsg && (
          <p style={{
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: resumeMsg.includes("✓") ? "#155724" : "#dc3545",
          }}>
            {resumeMsg}
          </p>
        )}
      </div>

      {/* LinkedIn Auth */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>LinkedIn Account</h3>
        <ConnectLinkedIn />
        {settings.linkedin_cookies_set && (
          <p style={{ fontSize: "0.85rem", color: "#155724", marginBottom: "0.5rem" }}>✓ LinkedIn session connected</p>
        )}
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "#888" }}>
            Advanced: Email & Password (fallback)
          </summary>
          <div style={{ marginTop: "0.5rem" }}>
            {field("LinkedIn Email", "linkedin_email", "email")}
            <div style={{ marginBottom: "0.75rem" }}>
              <label htmlFor="linkedin_password" style={labelStyle}>
                LinkedIn Password {settings.linkedin_password_set && "(saved ✓)"}
              </label>
              <input
                id="linkedin_password"
                type="password"
                value={password}
                placeholder={settings.linkedin_password_set ? "••••••••" : "Enter password"}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>
        </details>
      </div>

      {/* Personal Info */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Personal Info (for form filling)</h3>
        {field("First Name", "first_name")}
        {field("Last Name", "last_name")}
        {field("Email", "email", "email")}
        {field("Phone", "phone", "tel")}
        {field("City", "city")}
        {field("LinkedIn Profile URL", "linkedin_url", "url")}
        {field("Website", "website", "url")}
      </div>

      {/* Job Search Filters */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Job Search</h3>
        {field("Job Title", "job_title")}
        {field("Default Location", "location")}
        {field("Max Applications Per Run", "max_applications_per_run", "number")}

        <div style={{ marginBottom: "1rem" }}>
          <label style={labelStyle}>Experience Level</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {EXPERIENCE_LEVELS.map((lvl) => (
              <label
                key={lvl.value}
                style={{
                  display: "flex", alignItems: "center", gap: "0.3rem",
                  padding: "0.3rem 0.6rem", borderRadius: "6px", cursor: "pointer",
                  background: settings.experience_levels.includes(lvl.value) ? "#4361ee" : "#f0f0f0",
                  color: settings.experience_levels.includes(lvl.value) ? "#fff" : "#333",
                  fontSize: "0.85rem", fontWeight: 500,
                }}
              >
                <input
                  type="checkbox"
                  checked={settings.experience_levels.includes(lvl.value)}
                  onChange={() => toggleExpLevel(lvl.value)}
                  style={{ display: "none" }}
                />
                {lvl.label}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="work_type" style={labelStyle}>Work Type</label>
          <select
            id="work_type"
            value={settings.work_type}
            onChange={(e) => setSettings((s) => ({ ...s, work_type: e.target.value }))}
            style={inputStyle}
          >
            {WORK_TYPES.map((wt) => (
              <option key={wt.value} value={wt.value}>{wt.label}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label style={labelStyle}>
            Target Regions (select multiple — bot searches each one)
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {NA_REGIONS.map((region) => (
              <label
                key={region}
                style={{
                  display: "flex", alignItems: "center", gap: "0.3rem",
                  padding: "0.25rem 0.5rem", borderRadius: "6px", cursor: "pointer",
                  background: settings.regions.includes(region) ? "#4361ee" : "#f0f0f0",
                  color: settings.regions.includes(region) ? "#fff" : "#333",
                  fontSize: "0.8rem", fontWeight: 500,
                }}
              >
                <input
                  type="checkbox"
                  checked={settings.regions.includes(region)}
                  onChange={() => toggleRegion(region)}
                  style={{ display: "none" }}
                />
                {region}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Prefilled Answers */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Pre-fill Common Questions</h3>
        <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: "1rem" }}>
          Most applications ask the same questions. Pre-fill them here so the bot
          doesn't have to ask you every time.
        </p>
        {COMMON_QUESTIONS.map((q) => (
          <div key={q} style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>{q}</label>
            <input
              type="text"
              value={settings.prefilled_answers[q] || ""}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  prefilled_answers: { ...s.prefilled_answers, [q]: e.target.value },
                }))
              }
              placeholder="Your answer..."
              style={inputStyle}
            />
          </div>
        ))}
        {/* Custom Q&A */}
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.9rem", color: "#4361ee" }}>
            Add custom question/answer
          </summary>
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
            <input
              type="text"
              placeholder="Question text..."
              value={customQ}
              onChange={(e) => setCustomQ(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              type="text"
              placeholder="Answer..."
              value={customA}
              onChange={(e) => setCustomA(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              className="btn btn-primary"
              style={{ whiteSpace: "nowrap" }}
              onClick={() => {
                if (customQ && customA) {
                  setSettings((s) => ({
                    ...s,
                    prefilled_answers: { ...s.prefilled_answers, [customQ]: customA },
                  }));
                  setCustomQ("");
                  setCustomA("");
                }
              }}
            >
              Add
            </button>
          </div>
        </details>
      </div>

      {/* Smart Filtering */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Smart Filtering</h3>

        <TagListInput
          label="Company Blacklist"
          hint="Jobs from these companies will be skipped"
          tags={settings.company_blacklist}
          onChange={(v) => setSettings((s) => ({ ...s, company_blacklist: v }))}
        />

        <TagListInput
          label="Keyword Blacklist"
          hint="Jobs containing these keywords in the description will be skipped"
          tags={settings.keyword_blacklist}
          onChange={(v) => setSettings((s) => ({ ...s, keyword_blacklist: v }))}
        />

        <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Min Salary ($)</label>
            <input
              type="number"
              value={settings.min_salary ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, min_salary: e.target.value ? Number(e.target.value) : null }))}
              placeholder="e.g. 50000"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Max Salary ($)</label>
            <input
              type="number"
              value={settings.max_salary ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, max_salary: e.target.value ? Number(e.target.value) : null }))}
              placeholder="e.g. 200000"
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Min Years of Experience</label>
            <input
              type="number"
              value={settings.min_experience_years ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, min_experience_years: e.target.value ? Number(e.target.value) : null }))}
              placeholder="e.g. 2"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Max Years of Experience</label>
            <input
              type="number"
              value={settings.max_experience_years ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, max_experience_years: e.target.value ? Number(e.target.value) : null }))}
              placeholder="e.g. 10"
              style={inputStyle}
            />
          </div>
        </div>
      </div>

      {/* Autopilot Configuration */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Autopilot Configuration</h3>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Daily Apply Limit</label>
            <input
              type="number"
              value={settings.daily_apply_limit}
              onChange={(e) => setSettings((s) => ({ ...s, daily_apply_limit: Number(e.target.value) }))}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Weekly Apply Limit</label>
            <input
              type="number"
              value={settings.weekly_apply_limit}
              onChange={(e) => setSettings((s) => ({ ...s, weekly_apply_limit: Number(e.target.value) }))}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Min Delay Between Apps (seconds)</label>
            <input
              type="number"
              value={settings.apply_delay_min}
              onChange={(e) => setSettings((s) => ({ ...s, apply_delay_min: Number(e.target.value) }))}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Max Delay Between Apps (seconds)</label>
            <input
              type="number"
              value={settings.apply_delay_max}
              onChange={(e) => setSettings((s) => ({ ...s, apply_delay_max: Number(e.target.value) }))}
              style={inputStyle}
            />
          </div>
        </div>
      </div>

      {/* Toggles */}
      <div className="stat-card" style={cardStyle}>
        <h3 style={sectionTitle}>Features</h3>

        <ToggleRow
          label="Pause Before Submit"
          hint="Review each application before the bot submits it"
          checked={settings.pause_before_submit}
          onChange={(v) => setSettings((s) => ({ ...s, pause_before_submit: v }))}
        />
        <ToggleRow
          label="Follow Companies"
          hint="Automatically follow companies on LinkedIn after applying"
          checked={settings.follow_companies}
          onChange={(v) => setSettings((s) => ({ ...s, follow_companies: v }))}
        />
        <ToggleRow
          label="Smooth Scrolling"
          hint="Scroll pages like a human instead of instant jumps"
          checked={settings.smooth_scrolling}
          onChange={(v) => setSettings((s) => ({ ...s, smooth_scrolling: v }))}
        />
        <ToggleRow
          label="Resume Tailoring"
          hint="AI generates a tailored resume summary for each job"
          checked={settings.resume_tailoring_enabled}
          onChange={(v) => setSettings((s) => ({ ...s, resume_tailoring_enabled: v }))}
        />

        <div style={{ borderTop: "1px solid #eee", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
          <ToggleRow
            label="HR Outreach"
            hint="Send connection requests to hiring managers after applying"
            checked={settings.hr_outreach_enabled}
            onChange={(v) => setSettings((s) => ({ ...s, hr_outreach_enabled: v }))}
          />
          {settings.hr_outreach_enabled && (
            <div style={{ marginLeft: "1rem", marginTop: "0.5rem" }}>
              <label style={labelStyle}>Daily Connect Limit</label>
              <input
                type="number"
                value={settings.hr_daily_connect_limit}
                onChange={(e) => setSettings((s) => ({ ...s, hr_daily_connect_limit: Number(e.target.value) }))}
                style={{ ...inputStyle, maxWidth: "120px" }}
              />
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "2rem" }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {saved && <span style={{ color: "#155724", fontSize: "0.9rem" }}>Settings saved ✓</span>}
        {saveError && <span style={{ color: "#dc3545", fontSize: "0.9rem" }}>{saveError}</span>}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.85rem", color: "#666", marginBottom: "0.25rem",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "0.5rem", borderRadius: "6px",
  border: "1px solid #ddd", fontSize: "0.9rem",
};
const sectionTitle: React.CSSProperties = {
  marginBottom: "1rem", fontSize: "1rem", color: "#333",
};
const cardStyle: React.CSSProperties = { marginBottom: "1.5rem" };
