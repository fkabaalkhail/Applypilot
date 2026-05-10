"""
Resume text extraction service.

Supports PDF (via pdfplumber) and DOCX (via python-docx).
Imports are lazy — these deps are optional for serverless deployment.
"""

import io
import logging

logger = logging.getLogger(__name__)


def extract_text(content: bytes, filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf"):
        return _extract_pdf(content)
    elif lower.endswith(".docx"):
        return _extract_docx(content)
    else:
        raise ValueError(f"Unsupported file format: {filename}")


def _extract_pdf(content: bytes) -> str:
    import pdfplumber
    text_parts = []
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return "\n\n".join(text_parts)


def _extract_docx(content: bytes) -> str:
    from docx import Document
    doc = Document(io.BytesIO(content))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
