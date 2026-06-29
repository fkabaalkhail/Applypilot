"""Unit tests for the structured-document → PDF renderer (pure function)."""
from backend.schemas.resume_document import (
    ResumeDocument, ResumeHeader, Section, SectionItem, Theme,
)
from backend.services.resume_pdf import render_resume_pdf


def _sample_doc(**theme_kw) -> ResumeDocument:
    return ResumeDocument(
        header=ResumeHeader(
            name="Jane Doe", email="jane@example.com", phone="555-1212",
            location="NYC", linkedin_url="linkedin.com/in/jane",
        ),
        sections=[
            Section(type="summary", title="SUMMARY", text="Engineer.\nSecond line."),
            Section(type="skills", title="SKILLS", skills=["Python", "SQL", "AWS"]),
            Section(type="experience", title="WORK EXPERIENCE", items=[
                SectionItem(
                    title="Software Engineer", subtitle="Acme", location="NYC",
                    start_date="2020", end_date="2023",
                    bullets=["Built internal tools used by 500+ employees", "Cut latency 40%"],
                ),
            ]),
            Section(type="technologies", title="TECHNOLOGIES", groups={"Cloud": ["AWS", "GCP"]}),
        ],
        theme=Theme(**theme_kw),
    )


def test_returns_pdf_bytes():
    pdf = render_resume_pdf(_sample_doc())
    assert isinstance(pdf, (bytes, bytearray))
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 800


def test_empty_document_still_renders():
    pdf = render_resume_pdf(ResumeDocument())
    assert pdf[:5] == b"%PDF-"


def test_a4_page_size_renders():
    pdf = render_resume_pdf(_sample_doc(page_size="a4"))
    assert pdf[:5] == b"%PDF-"


def test_multipage_document_paginates():
    big = _sample_doc()
    big.sections[2].items = [
        SectionItem(title=f"Role {i}", subtitle="Company", start_date="2020",
                    end_date="2021", bullets=["Did meaningful things here"] * 6)
        for i in range(40)
    ]
    pdf = render_resume_pdf(big)
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 3000
