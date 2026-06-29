/**
 * Pure builder for the overlay's "Generate Cover Letter" result card.
 * Kept DOM-free so the markup is unit-testable; overlay.ts injects the returned
 * HTML, reads/edits the textarea, and wires the buttons. Mirrors tailorCard.ts.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Inner HTML for the cover-letter card: an editable preview textarea seeded with
 * `text`, then Regenerate / Insert / Copy / Download actions + a status line.
 * `insertLabel` is "Insert to form" (textarea on page) or "Attach PDF" (file field).
 */
export function buildCoverLetterCardHtml(text: string, insertLabel: string): string {
  return (
    `<textarea class="ap-cover-text" id="ap-cover-text" spellcheck="true">${esc(text)}</textarea>` +
    `<div class="ap-tailor-actions">` +
    `<button class="ap-btn-soft" id="ap-cover-regen" type="button">Regenerate</button>` +
    `<button class="ap-btn-upload" id="ap-cover-insert" type="button">${esc(insertLabel)}</button>` +
    `<button class="ap-btn-soft" id="ap-cover-copy" type="button">Copy</button>` +
    `<button class="ap-btn-soft" id="ap-cover-download" type="button">Download PDF</button>` +
    `</div>` +
    `<div class="ap-upload-status" id="ap-cover-status"></div>`
  );
}
