import { useApplyTracking } from "../context/ApplyTracking";

export default function ApplyConfirmModal() {
  const { current, confirmYes, confirmNo } = useApplyTracking();

  if (!current) return null;

  return (
    <div className="modal-overlay" onClick={confirmNo}>
      <div className="modal-content apply-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Did you apply?</h2>
        <p>
          Did you apply to <strong>{current.title}</strong> at <strong>{current.company}</strong>?
        </p>
        <div className="apply-confirm-actions">
          <button className="btn-outline" onClick={confirmNo}>
            No
          </button>
          <button className="btn-apply" onClick={confirmYes}>
            Yes, I applied
          </button>
        </div>
      </div>
    </div>
  );
}
