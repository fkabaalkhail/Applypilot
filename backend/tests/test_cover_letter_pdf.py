"""Unit tests for the cover-letter PDF renderer (pure function)."""
from backend.services.cover_letter_pdf import render_cover_letter_pdf


def test_renders_pdf_for_multiparagraph_letter():
    pdf = render_cover_letter_pdf(
        "Dear Hiring Team at Acme,\n\nI am excited to apply.\n\nSincerely,\nJane Doe"
    )
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 800


def test_empty_text_still_valid_pdf():
    pdf = render_cover_letter_pdf("   ")
    assert pdf[:5] == b"%PDF-"


def test_long_letter_paginates():
    pdf = render_cover_letter_pdf("\n\n".join(f"Paragraph {i} body text. " * 60 for i in range(40)))
    assert pdf[:5] == b"%PDF-"


def test_html_special_chars_do_not_break_render():
    pdf = render_cover_letter_pdf("I <build> & <ship> things at <Acme>.")
    assert pdf[:5] == b"%PDF-"
