import { useState } from "react";

interface Props {
  original: string;
  tailored: string;
  onAccept: () => void;
  onReject: () => void;
  onEdit?: (edited: string) => void;
}

type ViewMode = "side-by-side" | "inline";

function computeLineDiff(original: string, tailored: string): { type: "same" | "removed" | "added"; text: string }[] {
  const origLines = original.split("\n");
  const tailLines = tailored.split("\n");
  const result: { type: "same" | "removed" | "added"; text: string }[] = [];

  let i = 0;
  let j = 0;

  while (i < origLines.length || j < tailLines.length) {
    if (i < origLines.length && j < tailLines.length) {
      if (origLines[i] === tailLines[j]) {
        result.push({ type: "same", text: origLines[i] });
        i++;
        j++;
      } else {
        result.push({ type: "removed", text: origLines[i] });
        result.push({ type: "added", text: tailLines[j] });
        i++;
        j++;
      }
    } else if (i < origLines.length) {
      result.push({ type: "removed", text: origLines[i] });
      i++;
    } else {
      result.push({ type: "added", text: tailLines[j] });
      j++;
    }
  }

  return result;
}

export default function ResumeDiffView({ original, tailored, onAccept, onReject, onEdit }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("side-by-side");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(tailored);

  const diff = computeLineDiff(original, tailored);

  function handleSaveEdit() {
    if (onEdit) {
      onEdit(editText);
    }
    setEditing(false);
  }

  return (
    <div className="resume-diff-view">
      <div className="diff-header">
        <h3>Resume Changes</h3>
        <div className="diff-view-toggle">
          <button
            className={`btn-sm ${viewMode === "side-by-side" ? "active" : ""}`}
            onClick={() => setViewMode("side-by-side")}
          >
            Side by Side
          </button>
          <button
            className={`btn-sm ${viewMode === "inline" ? "active" : ""}`}
            onClick={() => setViewMode("inline")}
          >
            Inline
          </button>
        </div>
      </div>

      {editing ? (
        <div className="diff-editor">
          <textarea
            className="diff-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={20}
          />
          <div className="diff-actions">
            <button className="btn-primary" onClick={handleSaveEdit}>Save</button>
            <button className="btn-outline" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : viewMode === "side-by-side" ? (
        <div className="diff-side-by-side">
          <div className="diff-panel">
            <h4>Original</h4>
            <pre className="diff-content">{original}</pre>
          </div>
          <div className="diff-panel">
            <h4>Tailored</h4>
            <pre className="diff-content">{tailored}</pre>
          </div>
        </div>
      ) : (
        <div className="diff-inline">
          {diff.map((line, idx) => (
            <div
              key={idx}
              className={`diff-line diff-line-${line.type}`}
            >
              <span className="diff-marker">
                {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
              </span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      )}

      {!editing && (
        <div className="diff-actions">
          <button className="btn-primary" onClick={onAccept}>Accept</button>
          <button className="btn-outline" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn-outline btn-danger" onClick={onReject}>Reject</button>
        </div>
      )}
    </div>
  );
}
