"""
Render a structured ResumeDocument to PDF bytes with reportlab.

Mirrors the structure + theme mapping of the web app's DOCX builder
(frontend/src/lib/resumeExport.ts) so the extension's PDF stays consistent
with the web app's outputs: clean, single-column, real selectable text
(ATS-friendly). Pure function — no DB, no network, no file I/O.
"""
from __future__ import annotations

import io

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from backend.schemas.resume_document import ResumeDocument

_GRAY = HexColor("#4b5563")


def _fonts(family: str) -> tuple[str, str]:
    """Map a CSS font-family to a (regular, bold) built-in PDF font pair."""
    first = (family.split(",")[0] or "").strip().strip("'\"").lower()
    if "times" in first or "georgia" in first:
        return "Times-Roman", "Times-Bold"
    if "courier" in first or "mono" in first:
        return "Courier", "Courier-Bold"
    return "Helvetica", "Helvetica-Bold"  # Calibri/Segoe/Arial/sans-serif


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_resume_pdf(doc: ResumeDocument) -> bytes:
    theme = doc.theme
    base, bold = _fonts(theme.font_family)
    accent_hex = theme.accent_color or "#1f2937"
    accent = HexColor(accent_hex)
    text_color = HexColor(theme.text_color or "#1f2937")
    pagesize = A4 if theme.page_size == "a4" else LETTER
    content_width = pagesize[0] - 1.2 * inch

    body = ParagraphStyle("body", fontName=base, fontSize=theme.base_font_pt,
                          leading=theme.base_font_pt * theme.line_height,
                          textColor=text_color)
    name_style = ParagraphStyle("name", parent=body, fontName=bold,
                                fontSize=theme.name_font_pt,
                                leading=theme.name_font_pt * 1.1,
                                alignment=TA_CENTER, textColor=accent)
    center = ParagraphStyle("center", parent=body, alignment=TA_CENTER)
    heading = ParagraphStyle("heading", parent=body, fontName=bold,
                             fontSize=theme.heading_font_pt, textColor=accent,
                             spaceBefore=theme.section_spacing_pt, spaceAfter=2)
    title_style = ParagraphStyle("title", parent=body, fontName=bold)
    date_style = ParagraphStyle("date", parent=body, alignment=TA_RIGHT, textColor=_GRAY)
    sub_style = ParagraphStyle("sub", parent=body, textColor=_GRAY)
    bullet_style = ParagraphStyle("bullet", parent=body, leftIndent=14,
                                  bulletIndent=2, spaceBefore=1)

    story: list = []
    h = doc.header
    story.append(Paragraph(_esc(h.name) or "Your Name", name_style))
    contact = "  •  ".join(v for v in (h.location, h.email, h.phone) if v)
    if contact:
        story.append(Paragraph(_esc(contact), center))
    links = "  •  ".join(v for v in (h.linkedin_url, h.github_url, h.other_link) if v)
    if links:
        story.append(Paragraph(f'<font color="{accent_hex}">{_esc(links)}</font>', center))

    for section in doc.sections:
        story.append(Paragraph((_esc(section.title) or section.type).upper(), heading))
        story.append(HRFlowable(width="100%", thickness=0.6, color=accent,
                                spaceBefore=1, spaceAfter=4))

        if section.type in ("summary", "custom") and section.text:
            for para in section.text.split("\n"):
                if para.strip():
                    story.append(Paragraph(_esc(para.strip()), body))

        skills = [s for s in section.skills if s.strip()]
        if skills:
            story.append(Paragraph(_esc(", ".join(skills)), body))

        for category, items in (section.groups or {}).items():
            vals = [x for x in items if x.strip()]
            if vals:
                story.append(Paragraph(f"<b>{_esc(category)}:</b> {_esc(', '.join(vals))}", body))

        for item in section.items:
            dates = " – ".join(v for v in (item.start_date, item.end_date) if v)
            title_cell = Paragraph(_esc(item.title), title_style)
            if dates:
                row = Table([[title_cell, Paragraph(_esc(dates), date_style)]],
                            colWidths=[content_width * 0.7, content_width * 0.3])
                row.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]))
                story.append(row)
            else:
                story.append(Spacer(1, 3))
                story.append(title_cell)
            second = "  •  ".join(v for v in (item.subtitle, item.location) if v)
            if second:
                story.append(Paragraph(_esc(second), sub_style))
            if item.link:
                story.append(Paragraph(f'<font color="{accent_hex}">{_esc(item.link)}</font>', body))
            if item.detail:
                story.append(Paragraph(_esc(item.detail), sub_style))
            for b in item.bullets:
                if b.strip():
                    story.append(Paragraph(_esc(b.strip()), bullet_style, bulletText="•"))

    if not story:
        story.append(Spacer(1, 1))

    buf = io.BytesIO()
    pdf = SimpleDocTemplate(
        buf, pagesize=pagesize,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.5 * inch, bottomMargin=0.5 * inch,
        title=(h.name or "Resume"),
    )
    pdf.build(story)
    return buf.getvalue()
