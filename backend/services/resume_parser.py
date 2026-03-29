"""
Resume text extraction service.

Supports PDF (via pdfplumber) and DOCX (via python-docx).
"""

import io
import logging

import pdfplumber
from docx import Document

logger = logging.getLogger(__name__)


def extract_text(content: bytes, filename: str) -> str:
    """
    Extract raw text from a resume file.

    Args:
        content: Raw file bytes.
        filename: Original filename (used to detect format).

    Returns:
        Extracted plain text string.

    Raises:
        ValueError: If the file format is unsupported.
    """
    lower = filename.lower()

    if lower.endswith(".pdf"):
        return _extract_pdf(content)
    elif lower.endswith(".docx"):
        return _extract_docx(content)
    else:
        raise ValueError(f"Unsupported file format: {filename}")


def _extract_pdf(content: bytes) -> str:
    """Extract text from all pages of a PDF."""
    text_parts = []
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    result = "\n\n".join(text_parts)
    logger.info("Extracted %d characters from PDF (%d pages)", len(result), len(text_parts))
    return result


def _extract_docx(content: bytes) -> str:
    """Extract text from all paragraphs of a DOCX."""
    doc = Document(io.BytesIO(content))
    text_parts = [p.text for p in doc.paragraphs if p.text.strip()]
    result = "\n".join(text_parts)
    logger.info("Extracted %d characters from DOCX (%d paragraphs)", len(result), len(text_parts))
    return result
