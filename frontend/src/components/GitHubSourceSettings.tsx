import { useState, useEffect } from "react";

const API_BASE = "";

interface GitHubSource {
  id: number;
  repo_url: string;
  repo_owner: string;
  repo_name: string;
  file_path: string;
  poll_interval_minutes: number;
  last_polled_at: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

function isValidGitHubUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?/.test(url.trim());
}

export default function GitHubSourceSettings() {
  const [sources, setSources] = useState<GitHubSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [newInterval, setNewInterval] = useState(60);
  const [formError, setFormError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editFilePath, setEditFilePath] = useState("");
  const [editInterval, setEditInterval] = useState(60);
  const [polling, setPolling] = useState<number | null>(null);

  useEffect(() => {
    fetchSources();
  }, []);

  async function fetchSources() {
    try {
      const res = await fetch(`${API_BASE}/github-sources`);
      if (res.ok) {
        setSources(await res.json());
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmed = newUrl.trim();
    if (!trimmed) {
      setFormError("Please enter a GitHub repository URL.");
      return;
    }
    if (!isValidGitHubUrl(trimmed)) {
      setFormError("Please enter a valid GitHub repository URL (e.g., https://github.com/owner/repo).");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/github-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_url: trimmed,
          file_path: newFilePath.trim() || undefined,
          poll_interval_minutes: newInterval,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setFormError(data?.detail || "Failed to add source.");
        return;
      }

      setNewUrl("");
      setNewFilePath("");
      setNewInterval(60);
      fetchSources();
    } catch {
      setFormError("Failed to connect to the server.");
    }
  }

  async function handleDelete(id: number) {
    try {
      const res = await fetch(`${API_BASE}/github-sources/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSources((prev) => prev.filter((s) => s.id !== id));
      }
    } catch {
      // Silently fail
    }
  }

  async function handleUpdate(id: number) {
    try {
      const res = await fetch(`${API_BASE}/github-sources/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_url: editUrl.trim(),
          file_path: editFilePath.trim() || undefined,
          poll_interval_minutes: editInterval,
        }),
      });
      if (res.ok) {
        setEditingId(null);
        fetchSources();
      }
    } catch {
      // Silently fail
    }
  }

  async function handlePoll(id: number) {
    setPolling(id);
    try {
      await fetch(`${API_BASE}/github-sources/${id}/poll`, { method: "POST" });
      fetchSources();
    } catch {
      // Silently fail
    } finally {
      setPolling(null);
    }
  }

  function startEdit(source: GitHubSource) {
    setEditingId(source.id);
    setEditUrl(source.repo_url);
    setEditFilePath(source.file_path);
    setEditInterval(source.poll_interval_minutes);
  }

  if (loading) {
    return <div className="github-settings"><p>Loading sources...</p></div>;
  }

  return (
    <div className="github-settings">
      <h3>GitHub Job Sources</h3>

      <form onSubmit={handleAdd} className="github-add-form">
        <div className="form-row">
          <input
            type="url"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="form-input"
            aria-label="GitHub repository URL"
          />
          <input
            type="text"
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
            placeholder="File path (optional)"
            className="form-input form-input-sm"
            aria-label="File path"
          />
          <input
            type="number"
            value={newInterval}
            onChange={(e) => setNewInterval(Number(e.target.value))}
            min={5}
            className="form-input form-input-xs"
            aria-label="Poll interval in minutes"
          />
          <button type="submit" className="btn-primary">Add Source</button>
        </div>
        {formError && <div className="form-error">{formError}</div>}
      </form>

      <div className="github-sources-list">
        {sources.length === 0 && (
          <p className="empty-text">No GitHub sources configured. Add one above.</p>
        )}
        {sources.map((source) => (
          <div key={source.id} className="github-source-card">
            {editingId === source.id ? (
              <div className="source-edit-form">
                <input
                  type="url"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="form-input"
                />
                <input
                  type="text"
                  value={editFilePath}
                  onChange={(e) => setEditFilePath(e.target.value)}
                  placeholder="File path"
                  className="form-input form-input-sm"
                />
                <input
                  type="number"
                  value={editInterval}
                  onChange={(e) => setEditInterval(Number(e.target.value))}
                  min={5}
                  className="form-input form-input-xs"
                />
                <div className="source-edit-actions">
                  <button className="btn-sm" onClick={() => handleUpdate(source.id)}>Save</button>
                  <button className="btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="source-info">
                  <span className="source-url">{source.repo_owner}/{source.repo_name}</span>
                  {source.file_path && <span className="source-path">{source.file_path}</span>}
                  <span className={`source-status status-${source.status}`}>{source.status}</span>
                  {source.error_message && (
                    <span className="source-error">{source.error_message}</span>
                  )}
                  {source.last_polled_at && (
                    <span className="source-polled">Last polled: {new Date(source.last_polled_at).toLocaleString()}</span>
                  )}
                </div>
                <div className="source-actions">
                  <button
                    className="btn-sm"
                    onClick={() => handlePoll(source.id)}
                    disabled={polling === source.id}
                  >
                    {polling === source.id ? "Polling..." : "Poll Now"}
                  </button>
                  <button className="btn-sm" onClick={() => startEdit(source)}>Edit</button>
                  <button className="btn-sm btn-danger" onClick={() => handleDelete(source.id)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
