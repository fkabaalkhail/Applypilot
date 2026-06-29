/**
 * Pure builders for the overlay's "Generate Custom Resume" result card.
 * Kept DOM-free so the markup is unit-testable; overlay.ts injects the returned
 * HTML and wires the buttons.
 */
import type { TailorResult } from "../shared/types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "Match 7.2 → 8.5" / "Match held at 8.0" from 0-100 scores. */
export function scoreJumpText(before: number, after: number): string {
  const b = (before / 10).toFixed(1);
  const a = (after / 10).toFixed(1);
  if (after > before) return `Match ${b} → ${a}`;
  if (after === before) return `Match held at ${a}`;
  return `Match ${a}`;
}

/** Inner HTML for the result card. `selected` = keyword chips currently on. */
export function buildTailorCardHtml(result: TailorResult, selected: Set<string>): string {
  const jump = scoreJumpText(result.originalScore, result.newScore);
  const stats = `ATS ${result.atsScore} · ${result.keywordCoverage}% coverage`;
  const chips = result.missingKeywords
    .map(
      (k) =>
        `<button class="ap-kw ${selected.has(k) ? "on" : ""}" data-kw="${esc(k)}" type="button">${esc(k)}</button>`
    )
    .join("");
  const kwBlock = result.missingKeywords.length
    ? `<div class="ap-kw-label">Keywords to weave in</div><div class="ap-kw-row">${chips}</div>`
    : "";
  return (
    `<div class="ap-tailor-scores"><span class="ap-tailor-jump">${esc(jump)}</span>` +
    `<span class="ap-tailor-stats">${esc(stats)}</span></div>` +
    kwBlock +
    `<div class="ap-tailor-actions">` +
    `<button class="ap-btn-soft" id="ap-tailor-regen" type="button">Regenerate</button>` +
    `<button class="ap-btn-upload" id="ap-tailor-attach" type="button">Attach to form</button>` +
    `<button class="ap-btn-soft" id="ap-tailor-download" type="button">Download PDF</button>` +
    `</div>` +
    `<div class="ap-upload-status" id="ap-tailor-status"></div>`
  );
}
