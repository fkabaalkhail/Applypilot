"""
MarkdownParser — parses jobright-ai GitHub README markdown into structured job records.

Handles pipe-delimited markdown tables with support for:
- Section header detection (mega-repo category assignment)
- Continuation rows (↳ symbol for same-company sub-listings)
- Column order independence via keyword-based header detection
- Markdown link and image extraction
- Round-trip formatting for property-based testing
"""

import re
import logging
import datetime
from dataclasses import dataclass
from typing import Optional

from backend.services.logo_resolver import resolve_logo

logger = logging.getLogger(__name__)


# Maps lowercase section header text to canonical role category names
SECTION_CATEGORY_MAP = {
    "software engineering": "Software Engineering",
    "data analysis": "Data Analysis",
    "business analyst": "Business Analyst",
    "management and executive": "Management and Executive",
    "engineering and development": "Engineering and Development",
    "creatives and design": "Creatives and Design",
    "product management": "Product Management",
    "sales": "Sales",
    "accounting and finance": "Accounting and Finance",
    "arts and entertainment": "Arts and Entertainment",
    "legal and compliance": "Legal and Compliance",
    "human resources": "Human Resources",
    "public sector and government": "Public Sector and Government",
    "education and training": "Education and Training",
    "customer service and support": "Customer Service and Support",
    "marketing": "Marketing",
    "consultant": "Consultant",
}


@dataclass
class ParsedJob:
    """A job record parsed from a GitHub markdown table."""

    title: str
    company: str
    location: str
    url: str
    posted_date: Optional[datetime.datetime] = None
    company_logo: Optional[str] = None
    company_url: Optional[str] = None  # company website URL (e.g., https://www.tiktok.com)
    company_domain: Optional[str] = None  # registrable domain resolved from company_url/name
    work_model: Optional[str] = None  # parsed "Work Model" column: remote/hybrid/onsite
    section_category: Optional[str] = None  # from section headers (mega-repo)


class MarkdownParser:
    """Parses jobright-ai GitHub README markdown into structured job records."""

    def parse(self, content: str, is_mega_repo: bool = False) -> list[ParsedJob]:
        """Parse full README content. If is_mega_repo, tracks section headers."""
        if not is_mega_repo:
            return self.parse_markdown_table(content)

        lines = content.strip().split("\n")
        section_headers = self._detect_section_headers(lines)
        jobs: list[ParsedJob] = []

        if not section_headers:
            # No section headers found, parse as a single table
            return self.parse_markdown_table(content)

        # Process content between section headers
        for i, (line_idx, category) in enumerate(section_headers):
            # Determine the end of this section
            if i + 1 < len(section_headers):
                end_idx = section_headers[i + 1][0]
            else:
                end_idx = len(lines)

            # Extract the section content
            section_content = "\n".join(lines[line_idx + 1 : end_idx])
            section_jobs = self.parse_markdown_table(
                section_content, section_category=category
            )
            jobs.extend(section_jobs)

        return jobs

    def parse_markdown_table(
        self, content: str, section_category: Optional[str] = None
    ) -> list[ParsedJob]:
        """Parse a single pipe-delimited markdown table."""
        lines = content.strip().split("\n")
        jobs: list[ParsedJob] = []

        # Find header row
        header_idx = None
        for i, line in enumerate(lines):
            if "|" in line and "---" not in line:
                lower = line.lower()
                if any(
                    kw in lower
                    for kw in ["company", "role", "title", "location", "link", "apply", "date"]
                ):
                    header_idx = i
                    break

        if header_idx is None:
            return []

        # Parse header columns
        headers = [h.strip() for h in lines[header_idx].split("|")[1:-1]]
        column_map = self._map_columns_to_fields(headers)

        # Parse data rows (skip header + separator)
        start_idx = header_idx + 2  # skip header and separator row
        prev_company = ""

        for line in lines[start_idx:]:
            if "|" not in line or line.strip().startswith("<!--"):
                continue

            cells = [c.strip() for c in line.split("|")[1:-1]]
            if len(cells) < len(headers):
                continue

            # Handle continuation rows
            company_idx = self._get_field_index(column_map, "company")
            if company_idx is not None and company_idx < len(cells):
                company_cell = cells[company_idx]
                if "↳" in company_cell:
                    company_text = self._handle_continuation_row(cells, prev_company)
                    cells[company_idx] = company_text

            job = self._extract_job_from_cells(cells, column_map)
            if job and job.url and job.title:
                job.section_category = section_category
                jobs.append(job)
                # Track company for continuation rows
                if company_idx is not None and company_idx < len(cells):
                    prev_company = job.company
            else:
                if not job or not job.url or not job.title:
                    logger.warning(
                        "Skipping row with missing title or URL: %s",
                        line.strip()[:100],
                    )

        return jobs

    def _detect_section_headers(self, lines: list[str]) -> list[tuple[int, str]]:
        """Find ## headers and map them to role categories.

        Returns list of (line_index, category_name) tuples.
        """
        headers: list[tuple[int, str]] = []

        for i, line in enumerate(lines):
            stripped = line.strip()
            # Match ## Header (level 2 headers)
            if stripped.startswith("## "):
                header_text = stripped[3:].strip()
                # Remove any trailing markdown (like links or anchors)
                header_text = re.sub(r"\s*<.*?>", "", header_text)
                header_text = re.sub(r"\s*\[.*?\].*", "", header_text)
                header_text = header_text.strip()

                # Try to match to a known category
                category = self._match_section_category(header_text)
                if category:
                    headers.append((i, category))

        return headers

    def _match_section_category(self, header_text: str) -> Optional[str]:
        """Match a section header text to a known role category."""
        lower = header_text.lower().strip()

        # Direct match
        if lower in SECTION_CATEGORY_MAP:
            return SECTION_CATEGORY_MAP[lower]

        # Substring/fuzzy match
        for key, value in SECTION_CATEGORY_MAP.items():
            if key in lower or lower in key:
                return value

        return None

    def _handle_continuation_row(self, cells: list[str], prev_company: str) -> str:
        """Handle ↳ continuation rows by inheriting company from previous row.

        Returns the company name to use for this row.
        """
        if prev_company:
            return prev_company
        return ""

    def _extract_markdown_link(self, cell: str) -> tuple[Optional[str], Optional[str]]:
        """Extract (text, url) from markdown link syntax [text](url) or HTML <a href="url">.

        Skips image syntax ![alt](url). Returns (None, None) if no link found.
        Also handles [<img>](url) pattern used by some repos for apply buttons.
        """
        # Match [text](url) but NOT ![alt](url) — use negative lookbehind for !
        match = re.search(r"(?<!!)\[([^\]]*)\]\(([^)]+)\)", cell)
        if match:
            text = match.group(1)
            url = match.group(2)
            # If text contains <img>, it's an apply button — still return the URL
            if "<img" in text:
                text = "Apply"
            return text, url

        # Match HTML <a href="url">text</a>
        html_match = re.search(r'<a\s+href="([^"]+)"[^>]*>', cell)
        if html_match:
            url = html_match.group(1)
            # Try to get text content
            text_match = re.search(r'<a[^>]*>([^<]*)</a>', cell)
            text = text_match.group(1).strip() if text_match else "Apply"
            return text, url

        return None, None

    def _extract_image_url(self, cell: str) -> Optional[str]:
        """Extract image URL from markdown image syntax ![alt](url)."""
        match = re.search(r"!\[[^\]]*\]\(([^)]+)\)", cell)
        if match:
            return match.group(1)
        return None

    def format_job_to_row(self, job: ParsedJob) -> str:
        """Format a ParsedJob back to a markdown table row (for round-trip testing).

        Uses standard column order: Company | Role | Location | Application | Date Posted
        """
        # Format company (plain text)
        company = job.company

        # Format title/role (plain text)
        title = job.title

        # Format location (plain text)
        location = job.location

        # Format application link as markdown link
        if job.url:
            application = f"[Apply]({job.url})"
        else:
            application = ""

        # Format date
        if job.posted_date:
            date_str = job.posted_date.strftime("%Y-%m-%d")
        else:
            date_str = ""

        return f"| {company} | {title} | {location} | {application} | {date_str} |"

    def _map_columns_to_fields(self, headers: list[str]) -> dict[int, str]:
        """Map column indices to field names using keyword matching."""
        column_map: dict[int, str] = {}
        for i, header in enumerate(headers):
            lower = header.lower().strip()
            if any(kw in lower for kw in ["company", "org"]):
                column_map[i] = "company"
            elif any(kw in lower for kw in ["role", "title", "position", "job"]):
                column_map[i] = "title"
            elif any(kw in lower for kw in ["location", "loc"]):
                column_map[i] = "location"
            elif any(kw in lower for kw in ["link", "apply", "application", "url"]):
                column_map[i] = "url"
            elif any(kw in lower for kw in ["date", "posted", "age"]):
                column_map[i] = "posted_date"
            elif any(kw in lower for kw in ["work model", "model", "type"]):
                column_map[i] = "work_model"
            elif any(kw in lower for kw in ["logo", "image", "img"]):
                column_map[i] = "company_logo"
        return column_map

    def _get_field_index(
        self, column_map: dict[int, str], field_name: str
    ) -> Optional[int]:
        """Get the column index for a given field name."""
        for idx, name in column_map.items():
            if name == field_name:
                return idx
        return None

    def _extract_job_from_cells(
        self, cells: list[str], column_map: dict[int, str]
    ) -> Optional[ParsedJob]:
        """Extract a ParsedJob from table cells using the column map."""
        data: dict = {}

        for idx, field in column_map.items():
            if idx >= len(cells):
                continue
            cell = cells[idx]

            if field == "url":
                _, url = self._extract_markdown_link(cell)
                if url:
                    data[field] = url
                elif cell.startswith("http://") or cell.startswith("https://"):
                    data[field] = cell.strip()
                else:
                    data[field] = ""
            elif field == "posted_date":
                data[field] = self._parse_date(cell)
            elif field == "company":
                # Company cell may contain image (logo) and/or link
                logo_url = self._extract_image_url(cell)
                if logo_url:
                    data["company_logo"] = logo_url

                # Extract text from link or use raw text
                text, link = self._extract_markdown_link(cell)
                if text is not None:
                    data[field] = text
                    # jobright tables put the company WEBSITE in this link, e.g.
                    # **[Repligen Corporation](http://www.repligen.com)** — this is
                    # the authoritative source for an accurate logo.
                    if link and not link.startswith("https://jobright.ai"):
                        data["company_url"] = link
                else:
                    # Remove image syntax to get plain company name
                    clean = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", cell).strip()
                    data[field] = clean
            elif field == "title":
                # Title might be a link
                text, link = self._extract_markdown_link(cell)
                if text is not None:
                    data[field] = text
                    # If URL field not yet set and title has a link, use it
                    if link and "url" not in data:
                        data["url"] = link
                else:
                    data[field] = cell
            elif field == "company_logo":
                logo_url = self._extract_image_url(cell)
                if logo_url:
                    data[field] = logo_url
            elif field == "work_model":
                # jobright's "Work Model" column: Remote / Hybrid / On Site
                clean = re.sub(r'<[^>]+>', ' ', cell).strip()
                clean = re.sub(r'\s{2,}', ' ', clean)
                data[field] = self._normalize_work_model(clean)
            else:
                # For location and other text fields, strip HTML tags
                clean = re.sub(r'<[^>]+>', ' ', cell).strip()
                clean = re.sub(r'\s{2,}', ' ', clean)
                data[field] = clean

        if not data.get("url") or not data.get("title"):
            return None

        # Resolve an accurate, stable logo from the company website URL the
        # jobright table provides (falling back to a known map / name guess).
        # Only override the logo if the table did not embed an explicit image.
        company_url = data.get("company_url")
        company_name = data.get("company", "")
        resolved_logo, resolved_domain = resolve_logo(company_name, company_url)
        company_logo = data.get("company_logo") or resolved_logo or None

        return ParsedJob(
            title=data.get("title", ""),
            company=company_name,
            location=data.get("location", ""),
            url=data.get("url", ""),
            posted_date=data.get("posted_date"),
            company_logo=company_logo,
            company_url=company_url,
            company_domain=resolved_domain or None,
            work_model=data.get("work_model"),
        )

    @staticmethod
    def _normalize_work_model(value: str) -> Optional[str]:
        """Normalize a Work Model cell to 'remote' / 'hybrid' / 'onsite'.

        Returns None when the cell is empty or unrecognized so callers can
        fall back to inferring work type from the location.
        """
        if not value:
            return None
        lower = value.lower()
        if "remote" in lower:
            return "remote"
        if "hybrid" in lower:
            return "hybrid"
        if "on" in lower and "site" in lower:  # "On Site", "On-Site", "Onsite"
            return "onsite"
        if "in office" in lower or "in-person" in lower or "in person" in lower:
            return "onsite"
        return None

    def _parse_date(self, date_str: str) -> Optional[datetime.datetime]:
        """Parse various date formats from GitHub job tables."""
        date_str = date_str.strip()
        if not date_str:
            return None

        formats = [
            "%Y-%m-%d",
            "%m/%d/%Y",
            "%b %d, %Y",
            "%B %d, %Y",
            "%b %d",
            "%m/%d",
        ]
        for fmt in formats:
            try:
                dt = datetime.datetime.strptime(date_str, fmt)
                # If year is 1900 (no year in format), use current year
                if dt.year == 1900:
                    dt = dt.replace(year=datetime.datetime.utcnow().year)
                return dt
            except ValueError:
                continue
        return None
