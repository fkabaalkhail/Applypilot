"""
Resume text extraction service.

Supports PDF (via PyMuPDF/fitz primary, pdfplumber fallback) and DOCX (via python-docx).
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
    """Extract text from PDF. Tries PyMuPDF first (better spacing), falls back to pdfplumber."""
    # Try PyMuPDF first (handles word spacing much better)
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=content, filetype="pdf")
        text_parts = []
        for page in doc:
            page_text = page.get_text()
            if page_text:
                text_parts.append(page_text)
        doc.close()
        result = "\n\n".join(text_parts)
        if result.strip():
            return result
    except ImportError:
        logger.info("PyMuPDF not available, falling back to pdfplumber")
    except Exception as e:
        logger.warning(f"PyMuPDF extraction failed: {e}, falling back to pdfplumber")

    # Fallback to pdfplumber
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
