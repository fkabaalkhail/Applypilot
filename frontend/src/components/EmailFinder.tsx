import { useState } from "react";

const API_BASE = "";

function isValidLinkedInUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?$/.test(url.trim());
}

export default function EmailFinder() {
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmail("");
    setError("");

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Please enter a LinkedIn profile URL.");
      return;
    }

    if (!isValidLinkedInUrl(trimmed)) {
      setError("Please enter a valid LinkedIn profile URL (e.g., https://linkedin.com/in/username).");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/connections/email-find`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedin_url: trimmed }),
      });

      if (!res.ok) {
        if (res.status === 422) {
          setError("Invalid LinkedIn URL format.");
        } else {
          setError("Could not find an email for this profile.");
        }
        return;
      }

      const data = await res.json();
      if (data.email) {
        setEmail(data.email);
      } else {
        setError("Could not find an email for this profile.");
      }
    } catch {
      setError("Failed to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="email-finder">
      <h3>Find Any Email</h3>
      <form onSubmit={handleSubmit} className="email-finder-form">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://linkedin.com/in/username"
          className="email-finder-input"
          aria-label="LinkedIn profile URL"
          disabled={loading}
        />
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? "Finding..." : "Find Email"}
        </button>
      </form>

      {error && <div className="email-finder-error">{error}</div>}

      {email && (
        <div className="email-finder-result">
          <span className="email-found">{email}</span>
          <button className="btn-sm" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
