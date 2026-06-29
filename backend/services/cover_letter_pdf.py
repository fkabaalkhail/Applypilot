"""
Render a plain-text cover letter to PDF bytes with reportlab.

Mirrors services/resume_pdf.py's reportlab/Platypus approach: clean, single
column, real selectable text (ATS-friendly). Pure function — no DB, no network,
no file I/O. Used by POST /api/render-cover-letter so the extension can attach a
cover-letter PDF to a file field or download it.
"""
from __future__ import annotations

import io

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

_TEXT = HexColor("#1f2937")


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_cover_letter_pdf(text: str) -> bytes:
    """Render `text` to a one-column business-letter PDF.

    Paragraphs are split on blank lines; single newlines within a paragraph
    are kept as line breaks. Empty/whitespace input yields a valid, near-empty
    single-page PDF rather than raising.
    """
    body = ParagraphStyle(
        "cl_body", fontName="Helvetica", fontSize=11, leading=11 * 1.4,
        textColor=_TEXT, spaceAfter=10,
    )

    story: list = []
    for block in (text or "").split("\n\n"):
        block = block.strip()
        if not block:
            continue
        html = _esc(block).replace("\n", "<br/>")
        story.append(Paragraph(html, body))

    if not story:
        story.append(Spacer(1, 1))

    buf = io.BytesIO()
    pdf = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.8 * inch, rightMargin=0.8 * inch,
        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
        title="Cover Letter",
    )
    pdf.build(story)
    return buf.getvalue()
