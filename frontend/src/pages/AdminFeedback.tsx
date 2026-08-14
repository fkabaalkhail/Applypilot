import { useCallback, useEffect, useState } from "react";
import api from "../auth/api";
import "../admin.css";

const PAGE_SIZE = 100;

/** The wording the Feedback form itself uses, so both pages name things alike. */
const CATEGORY_LABELS: Record<string, string> = {
  bug_report: "Bug Report",
  feature_request: "Feature Request",
  ux_feedback: "User Experience",
  subscription: "Subscription",
  other: "Other",
};

const categoryLabel = (value: string) => CATEGORY_LABELS[value] || value || "Uncategorised";

interface FeedbackRow {
  id: number;
  user_id: string;
  email: string | null;
  category: string;
  message: string;
  created_at: string | null;
}

type Status = "loading" | "ready" | "forbidden" | "error";

/** Render a naive-UTC timestamp from the API in the reader's own timezone. */
function when(iso: string | null): string {
  if (!iso) return "no date";
  const stamped = /[Z+]|-\d\d:\d\d$/.test(iso.slice(10)) ? iso : `${iso}Z`;
  const date = new Date(stamped);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function AdminFeedback() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState("all");

  const load = useCallback(async (offset: number) => {
    try {
      const { data } = await api.get("/feedback", { params: { limit: PAGE_SIZE, offset } });
      setRows((prev) => (offset === 0 ? data.items : [...prev, ...data.items]));
      setTotal(data.total);
      setStatus("ready");
    } catch (err: any) {
      // A signed-in non-admin gets the same nothing an unknown URL gets.
      if (err?.response?.status === 403) {
        setStatus("forbidden");
        return;
      }
      setNotice(err?.response?.data?.detail || err?.message || "Could not load feedback.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  const remove = async (row: FeedbackRow) => {
    const who = row.email || "an anonymous visitor";
    if (!window.confirm(`Delete this feedback from ${who}? It cannot be recovered.`)) return;

    const snapshot = rows;
    setNotice("");
    setRows(rows.filter((r) => r.id !== row.id));
    setTotal((t) => Math.max(0, t - 1));
    try {
      await api.delete(`/feedback/${row.id}`);
    } catch (err: any) {
      setRows(snapshot);
      setTotal((t) => t + 1);
      setNotice(
        err?.response?.status === 404
          ? "That item was already deleted. Reload to refresh the list."
          : "Delete failed. The item is still here."
      );
    }
  };

  if (status === "forbidden") {
    return (
      <main className="admin-blank">
        <p>Page not found</p>
      </main>
    );
  }

  if (status === "loading") {
    return (
      <main className="admin-blank">
        <p>Loading</p>
      </main>
    );
  }

  const categories = Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort();
  const visible = rows.filter((r) => category === "all" || r.category === category);

  return (
    <main className="admin">
      <header className="admin-head">
        <p className="admin-eyebrow">tailrd · internal</p>
        <h1>Feedback</h1>
        <p className="admin-count">
          {rows.length} of {total} loaded
        </p>
      </header>

      <div className="admin-filters">
        <label className="admin-filter">
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {notice && <p className="admin-notice">{notice}</p>}

      {status === "error" && rows.length === 0 && (
        <p className="admin-empty">Could not reach the server. Reload to try again.</p>
      )}

      {status === "ready" && rows.length === 0 && (
        <p className="admin-empty">
          Nothing yet. Submissions from the Feedback and Interview pages land here.
        </p>
      )}

      {rows.length > 0 && visible.length === 0 && (
        <p className="admin-empty">No feedback matches these filters.</p>
      )}

      <ul className="admin-list">
        {visible.map((row) => (
          <li key={row.id} className="admin-item">
            <div className="admin-row">
              <div className="admin-body">
                <div className="admin-meta">
                  <span className="admin-category">{categoryLabel(row.category)}</span>
                  {row.email ? (
                    <a className="admin-who" href={`mailto:${row.email}`}>
                      {row.email}
                    </a>
                  ) : (
                    <span className="admin-who admin-anon">
                      {row.user_id ? `user ${row.user_id}` : "anonymous"}
                    </span>
                  )}
                  <span className="admin-when">{when(row.created_at)}</span>
                </div>
                <p className="admin-message">{row.message}</p>
              </div>
              <button className="admin-delete" type="button" onClick={() => remove(row)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {rows.length < total && (
        <button className="admin-more" type="button" onClick={() => load(rows.length)}>
          Load more
        </button>
      )}
    </main>
  );
}
