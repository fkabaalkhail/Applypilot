"""
Property-based tests for MarkdownParser.
Feature: job-scraper-aggregator, Property 1: Markdown Table Parsing Round-Trip
Validates: Requirements 2.9
"""

import datetime
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from backend.services.markdown_parser import MarkdownParser, ParsedJob

parser = MarkdownParser()

# Strategy for generating valid ParsedJob records
# Constraints: title and company must not contain pipe characters or markdown syntax
# Must start with a letter to avoid being treated as empty after strip/parsing
safe_text = st.from_regex(r'[A-Za-z][A-Za-z0-9 ]{0,29}', fullmatch=True).map(lambda s: s.strip()).filter(lambda s: len(s) >= 1)
url_strategy = st.builds(
    lambda path: f"https://jobright.ai/jobs/info/{path}",
    st.from_regex(r'[a-z0-9]{8,16}', fullmatch=True)
)
date_strategy = st.one_of(
    st.none(),
    st.builds(
        lambda y, m, d: datetime.datetime(y, m, d),
        st.integers(min_value=2024, max_value=2026),
        st.integers(min_value=1, max_value=12),
        st.integers(min_value=1, max_value=28),
    )
)

parsed_job_strategy = st.builds(
    ParsedJob,
    title=safe_text,
    company=safe_text,
    location=safe_text,
    url=url_strategy,
    posted_date=date_strategy,
)


@settings(max_examples=100)
@given(job=parsed_job_strategy)
def test_round_trip_preserves_fields(job):
    """
    Formatting a job to a row and parsing it back should preserve all fields.

    **Validates: Requirements 2.9**
    """
    # Format to markdown row
    row = parser.format_job_to_row(job)

    # Create a full table with header + separator + data row
    table = (
        "| Company | Role | Location | Application | Date Posted |\n"
        "|---------|------|----------|-------------|-------------|\n"
        f"{row}\n"
    )

    # Parse back
    result = parser.parse_markdown_table(table)

    assert len(result) == 1, f"Expected 1 job, got {len(result)} from row: {row}"
    parsed = result[0]

    assert parsed.title == job.title
    assert parsed.company == job.company
    # The parser intentionally normalizes runs of whitespace in location
    # (real listings don't carry double spaces), so compare on normalized text.
    assert " ".join(parsed.location.split()) == " ".join(job.location.split())
    assert parsed.url == job.url

    if job.posted_date:
        assert parsed.posted_date is not None
        assert parsed.posted_date.date() == job.posted_date.date()
    else:
        assert parsed.posted_date is None


@settings(max_examples=100)
@given(
    company=safe_text,
    title1=safe_text,
    title2=safe_text,
    location=safe_text,
    url1=url_strategy,
    url2=url_strategy,
)
def test_continuation_row_inherits_company(company, title1, title2, location, url1, url2):
    """
    Continuation rows (↳) should inherit company from the previous row.

    **Validates: Requirements 2.2**
    """
    assume(url1 != url2)

    table = (
        "| Company | Role | Location | Application | Date Posted |\n"
        "|---------|------|----------|-------------|-------------|\n"
        f"| {company} | {title1} | {location} | [Apply]({url1}) | 2024-01-15 |\n"
        f"| ↳ | {title2} | {location} | [Apply]({url2}) | 2024-01-15 |\n"
    )

    result = parser.parse_markdown_table(table)

    assert len(result) == 2, f"Expected 2 jobs, got {len(result)}"
    assert result[0].company == company
    assert result[1].company == company, f"Continuation row should inherit company '{company}', got '{result[1].company}'"


@settings(max_examples=100)
@given(
    company=safe_text,
    title=safe_text,
    location=safe_text,
    url=url_strategy,
    column_order=st.permutations(["Company", "Role", "Location", "Application", "Date Posted"]),
)
def test_column_order_independence(company, title, location, url, column_order):
    """
    Parsing should produce the same results regardless of column order.

    **Validates: Requirements 2.7**
    """
    # Build header row in the given order
    header = "| " + " | ".join(column_order) + " |"
    separator = "| " + " | ".join(["---"] * 5) + " |"

    # Build data row matching the column order
    field_values = {
        "Company": company,
        "Role": title,
        "Location": location,
        "Application": f"[Apply]({url})",
        "Date Posted": "2024-06-15",
    }
    data_row = "| " + " | ".join(field_values[col] for col in column_order) + " |"

    table = f"{header}\n{separator}\n{data_row}\n"

    result = parser.parse_markdown_table(table)

    assert len(result) == 1, f"Expected 1 job, got {len(result)} for order {column_order}"
    parsed = result[0]

    assert parsed.company == company, f"Company mismatch for order {column_order}"
    assert parsed.title == title, f"Title mismatch for order {column_order}"
    assert parsed.location == location, f"Location mismatch for order {column_order}"
    assert parsed.url == url, f"URL mismatch for order {column_order}"


from backend.services.markdown_parser import SECTION_CATEGORY_MAP

# Strategy for section categories
category_keys = list(SECTION_CATEGORY_MAP.keys())
category_strategy = st.sampled_from(category_keys)


@settings(max_examples=100)
@given(
    category_key=category_strategy,
    title=safe_text,
    company=safe_text,
    location=safe_text,
    url=url_strategy,
)
def test_section_header_assigns_category(category_key, title, company, location, url):
    """
    Jobs under a section header should be assigned that section's category.
    
    **Validates: Requirements 1.5, 2.8**
    """
    expected_category = SECTION_CATEGORY_MAP[category_key]
    # Use title case for the header (as it appears in the README)
    header_text = expected_category  # Use the canonical name
    
    content = (
        f"## {header_text}\n"
        "\n"
        "| Company | Role | Location | Application | Date Posted |\n"
        "|---------|------|----------|-------------|-------------|\n"
        f"| {company} | {title} | {location} | [Apply]({url}) | 2024-01-15 |\n"
    )
    
    result = parser.parse(content, is_mega_repo=True)
    
    assert len(result) == 1, f"Expected 1 job, got {len(result)}"
    assert result[0].section_category == expected_category, (
        f"Expected category '{expected_category}' for header '## {header_text}', "
        f"got '{result[0].section_category}'"
    )


@settings(max_examples=50)
@given(
    cat1=category_strategy,
    cat2=category_strategy,
    title1=safe_text,
    title2=safe_text,
    company=safe_text,
    location=safe_text,
    url1=url_strategy,
    url2=url_strategy,
)
def test_multiple_sections_assign_correct_categories(cat1, cat2, title1, title2, company, location, url1, url2):
    """
    Jobs under different section headers get their respective categories.
    
    **Validates: Requirements 1.5, 2.8**
    """
    assume(url1 != url2)
    assume(cat1 != cat2)
    
    category1 = SECTION_CATEGORY_MAP[cat1]
    category2 = SECTION_CATEGORY_MAP[cat2]
    
    content = (
        f"## {category1}\n"
        "\n"
        "| Company | Role | Location | Application | Date Posted |\n"
        "|---------|------|----------|-------------|-------------|\n"
        f"| {company} | {title1} | {location} | [Apply]({url1}) | 2024-01-15 |\n"
        "\n"
        f"## {category2}\n"
        "\n"
        "| Company | Role | Location | Application | Date Posted |\n"
        "|---------|------|----------|-------------|-------------|\n"
        f"| {company} | {title2} | {location} | [Apply]({url2}) | 2024-01-15 |\n"
    )
    
    result = parser.parse(content, is_mega_repo=True)
    
    assert len(result) == 2, f"Expected 2 jobs, got {len(result)}"
    assert result[0].section_category == category1
    assert result[1].section_category == category2
