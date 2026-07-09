const NEEDS_INPUT = "Needs your input: ";

/**
 * The rewrite, reviewed before it lands.
 *
 * Two kinds of line come back: what the AI changed, and what it refused to guess.
 * The second kind is the honest one — a metric it left as a placeholder because
 * inventing it would get the candidate caught in an interview.
 */
export default function ImproveModal({
  changes,
  applying,
  onApply,
  onDiscard,
}: {
  changes: string[];
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const applied = changes.filter((c) => !c.startsWith(NEEDS_INPUT));
  const needsInput = changes
    .filter((c) => c.startsWith(NEEDS_INPUT))
    .map((c) => c.slice(NEEDS_INPUT.length));

  return (
    <div className="rd-modal-overlay" onClick={onDiscard} role="dialog" aria-modal="true" aria-label="Review improvements">
      <div className="rd-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{applied.length > 0 ? "Review the rewrite" : "No changes needed"}</h2>
        <p className="rd-prose">
          {applied.length > 0
            ? "Your employers, titles, dates, and existing numbers are unchanged. Only the wording moved."
            : "The rewrite didn't find anything to change. Your resume already reads well."}
        </p>

        {applied.length > 0 && (
          <ul className="rd-modal-changes">
            {applied.map((change, i) => (
              <li key={i}>
                <i className="fa-solid fa-pen-nib" />
                <span>{change}</span>
              </li>
            ))}
          </ul>
        )}

        {needsInput.length > 0 && (
          <>
            <h2 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>Only you can fill these in</h2>
            <p className="rd-prose">
              We left a placeholder instead of guessing a number. Replace each one with your real
              figure after you apply.
            </p>
            <ul className="rd-modal-changes">
              {needsInput.map((change, i) => (
                <li key={i} data-kind="input">
                  <i className="fa-solid fa-triangle-exclamation" />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="rd-modal-actions">
          <button className="rd-btn" onClick={onDiscard} disabled={applying}>
            Discard
          </button>
          {applied.length > 0 && (
            <button className="rd-btn rd-btn-primary" onClick={onApply} disabled={applying}>
              {applying ? "Applying…" : "Apply to my resume"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
