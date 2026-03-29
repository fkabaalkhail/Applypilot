"""
Tests for the resume text extraction service.
"""

import io
import pytest
from docx import Document
from reportlab.pdfgen import canvas

from backend.services.resume_parser import extract_text


def _make_pdf(text: str) -> bytes:
    """Create a minimal PDF with the given text."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    y = 750
    for line in text.split("\n"):
        c.drawString(72, y, line)
        y -= 15
    c.save()
    return buf.getvalue()


def _make_docx(text: str) -> bytes:
    """Create a minimal DOCX with the given text."""
    doc = Document()
    for line in text.split("\n"):
        if line.strip():
            doc.add_paragraph(line)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


class TestPDFExtraction:
    """Tests for PDF text extraction."""

    def test_extracts_text_from_pdf(self):
        content = _make_pdf("John Doe\nSoftware Engineer\nPython, JavaScript")
        result = extract_text(content, "resume.pdf")
        assert "John Doe" in result
        assert "Software Engineer" in result

    def test_empty_pdf_returns_empty(self):
        content = _make_pdf("")
        result = extract_text(content, "empty.pdf")
        assert result.strip() == "" or len(result) < 5


class TestDOCXExtraction:
    """Tests for DOCX text extraction."""

    def test_extracts_text_from_docx(self):
        content = _make_docx("Jane Smith\nData Scientist\nPython, R, SQL")
        result = extract_text(content, "resume.docx")
        assert "Jane Smith" in result
        assert "Data Scientist" in result

    def test_empty_docx_returns_empty(self):
        content = _make_docx("")
        result = extract_text(content, "empty.docx")
        assert result.strip() == ""


class TestUnsupportedFormat:
    """Tests for unsupported file formats."""

    def test_raises_on_unsupported_format(self):
        with pytest.raises(ValueError, match="Unsupported"):
            extract_text(b"data", "resume.txt")
