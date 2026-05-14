import { useState } from "react";
import api from "../auth/api";
import "../feedback.css";

const CATEGORIES = [
  { value: "bug_report", label: "Bug Report" },
  { value: "feature_request", label: "Feature Request" },
  { value: "ux_feedback", label: "User Experience Feedback" },
  { value: "subscription", label: "Subscription" },
  { value: "other", label: "Other" },
];

export default function Feedback() {
  const [category, setCategory] = useState("");
  const [message, setMessage] = useState("");
  const [wantsFollowup, setWantsFollowup] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category || !message.trim()) {
      setError("Please select a category and enter your feedback.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await api.post("/feedback", { category, message, wants_followup: wantsFollowup });
      setSubmitted(true);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Failed to submit feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="feedback-page">
        <div className="feedback-success">
          <div className="feedback-success-icon">✓</div>
          <h2>Thank you for your feedback!</h2>
          <p>We appreciate you taking the time to help us improve Tailrd.</p>
          <button
            className="btn-primary"
            onClick={() => {
              setSubmitted(false);
              setCategory("");
              setMessage("");
              setWantsFollowup(false);
            }}
          >
            Submit More Feedback
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-page">
      <div className="feedback-header">
        <h1>Share Your Feedback</h1>
        <p>Help us improve Tailrd by sharing your thoughts, reporting bugs, or requesting features.</p>
      </div>

      <form className="feedback-form" onSubmit={handleSubmit}>
        <div className="feedback-field">
          <label className="feedback-label">What type of feedback do you have?</label>
          <div className="feedback-categories">
            {CATEGORIES.map((cat) => (
              <label key={cat.value} className={`feedback-radio${category === cat.value ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="category"
                  value={cat.value}
                  checked={category === cat.value}
                  onChange={(e) => setCategory(e.target.value)}
                />
                <span className="feedback-radio-label">{cat.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="feedback-field">
          <label className="feedback-label" htmlFor="feedback-message">
            Tell us more
          </label>
          <textarea
            id="feedback-message"
            className="feedback-textarea"
            placeholder="Please describe your feedback in detail..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
          />
        </div>

        <div className="feedback-field">
          <label className="feedback-checkbox-label">
            <input
              type="checkbox"
              checked={wantsFollowup}
              onChange={(e) => setWantsFollowup(e.target.checked)}
            />
            <span>I'd like follow-up support via email</span>
          </label>
        </div>

        {error && <div className="feedback-error">{error}</div>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Submitting..." : "Submit Feedback"}
        </button>
      </form>
    </div>
  );
}
