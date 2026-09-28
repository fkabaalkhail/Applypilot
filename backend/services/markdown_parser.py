"""
MarkdownParser, parses jobright-ai GitHub README markdown into structured job records.

Handles pipe-delimited markdown tables with support for:
- Section header detection (mega-repo category assignment)
- Continuation rows (↳ symbol for same-company sub-listings)
- Column order independence via keyword-based header detection
- Several tables per README, each with its own header (speedyapply)
- HTML <table> READMEs, converted to pipe tables first (SimplifyJobs)
- Markdown link, badge link, HTML link and image extraction
- Closed rows (🔒 / strikethrough), returned flagged when asked for
- Round-trip formatting for property-based testing
"""

import re
import html
import logging
import datetime
import unicodedata
from dataclasses import dataclass
from typing import Optional

from backend.services.logo_resolver import resolve_logo

logger = logging.getLogger(__name__)


def _utcnow() -> datetime.datetime:
    return datetime.datetime.utcnow()


# The lists' legend for "application closed". The link is dropped on those rows.
CLOSED_MARK = "\U0001F512"

# A URL inside markdown link parens, allowing one level of balanced parens
# ('.../Stagiaire-(hardware)-Quebec/123') that a plain [^)]+ would cut short.
_URL_PATTERN = r"(?:[^()\s]|\([^()\s]*\))+"

# [![Apply](https://img.shields.io/badge/...)](https://job): an image wrapped in
# a link. The job is the OUTER url, never the badge.
_BADGE_LINK_RE = re.compile(
    r"\[\s*!\[[^\]]*\]\(\s*" + _URL_PATTERN + r"\s*\)\s*\]\(\s*(" + _URL_PATTERN + r")\s*\)"
)
_LINK_RE = re.compile(
    r"(?<!!)\[(?P<md_text>[^\]]*)\]\(\s*(?P<md_url>" + _URL_PATTERN + r")\s*\)"
    r"|<a\s[^>]*?href\s*=\s*[\"'](?P<html_url>[^\"']+)[\"'][^>]*>(?P<html_text>.*?)</a>",
    re.IGNORECASE | re.DOTALL,
)

# Links that point at the list vendor's own pages or redirectors rather than
# the employer (zapply.jobs/l/d/... bounces to the ATS through its own host).
_LIST_VENDOR_HOSTS = ("jobright.ai", "simplify.jobs", "zapply.jobs")

# Malformed links ('https:/.workable.com/...') are dead by construction.
_JOB_URL_RE = re.compile(r"^https?://[a-z0-9]", re.IGNORECASE)

_STRIKE_RE = re.compile(r"~~(.+?)~~")
_PAIRED_EMPHASIS_RE = re.compile(r"(\*\*|__|`)(.+?)\1")
_WRAPPED_EMPHASIS_RE = re.compile(r"^([*_])(\S(?:.*\S)?)\1$")

_HTML_TABLE_RE = re.compile(r"<table\b.*?</table>", re.IGNORECASE | re.DOTALL)
_HTML_ROW_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.IGNORECASE | re.DOTALL)
_HTML_CELL_RE = re.compile(r"<t([hd])\b[^>]*>(.*?)</t\1>", re.IGNORECASE | re.DOTALL)

_DATED_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%b %d, %Y", "%B %d, %Y")
_YEARLESS_FORMATS = ("%b %d", "%B %d", "%m/%d")
# Age columns: '2d', '3w', '1mo' (speedyapply, SimplifyJobs).
_RELATIVE_AGE_RE = re.compile(
    r"^(\d+)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)$",
    re.IGNORECASE,
)
# Clock skew between the list's timezone and ours: 'Sep 29' posted late on
# the 28th in US time is not a year-old posting.
_FUTURE_TOLERANCE = datetime.timedelta(days=2)


def is_job_url(url: str) -> bool:
    """True when ``url`` is an absolute http(s) link with a real host."""
    return bool(_JOB_URL_RE.match(url or ""))


def is_list_vendor_url(url: str) -> bool:
    """True for a list vendor's page or redirector, never an employer's posting."""
    return any(host in (url or "") for host in _LIST_VENDOR_HOSTS)


def clean_cell_text(text: str) -> str:
    """Plain text of a company/title cell. Markdown emphasis and HTML are
    stripped ('**Tesla**', '<strong>Tesla</strong>', '`Tesla`', '~~Tesla~~'):
    the UI shows the name verbatim and draws the avatar from its first letter,
    so '**Tesla**' rendered as a '*' avatar."""
    text = text or ""
    if "<" in text:
        text = " ".join(re.sub(r"<[^>]+>", " ", text).split())
    text = _STRIKE_RE.sub(r"\1", text)
    text = _PAIRED_EMPHASIS_RE.sub(r"\2", text)
    if "&" in text:
        text = html.unescape(text)
    text = text.strip()
    return _WRAPPED_EMPHASIS_RE.sub(r"\2", text).strip()


def clean_company_name(text: str) -> str:
    """``clean_cell_text`` plus the lists' legend emoji at either end
    ('🔥 Adobe', 'Tesla 🔒'), so the name starts with the name itself."""
    text = clean_cell_text(text)

    def is_marker(ch: str) -> bool:
        return ch.isspace() or ch in "\ufe0e\ufe0f\u200d" or unicodedata.category(ch) == "So"

    start, end = 0, len(text)
    while start < end and is_marker(text[start]):
        start += 1
    while end > start and is_marker(text[end - 1]):
        end -= 1
    return text[start:end]


def parse_listing_date(date_str: str,
                       now: Optional[datetime.datetime] = None) -> Optional[datetime.datetime]:
    """Parse a list's date cell: full dates, yearless 'Nov 30' / '11/30', and
    relative ages ('2d', '1mo').

    A yearless date is the most recent such day that isn't in the future.
    Stamping the current year turned 2025 postings into Oct-Dec 2026 ones that
    topped the date-sorted feed and never aged out.
    """
    date_str = clean_cell_text(date_str)
    if not date_str:
        return None
    now = now or _utcnow()

    for fmt in _DATED_FORMATS:
        try:
            return datetime.datetime.strptime(date_str, fmt)
        except ValueError:
            continue

    for fmt in _YEARLESS_FORMATS:
        try:
            # 2000 is a leap year, so 'Feb 29' parses; the real year is picked below.
            dt = datetime.datetime.strptime(f"{date_str} 2000", f"{fmt} %Y")
        except ValueError:
            continue
        for year in range(now.year, now.year - 8, -1):
            try:
                candidate = dt.replace(year=year)
            except ValueError:  # Feb 29 outside a leap year
                continue
            if candidate <= now + _FUTURE_TOLERANCE:
                return candidate
        return None

    match = _RELATIVE_AGE_RE.match(date_str)
    if match:
        amount, unit = int(match.group(1)), match.group(2).lower()
        if unit.startswith("h"):
            delta = datetime.timedelta(hours=amount)
        elif unit.startswith("mo"):
            delta = datetime.timedelta(days=30 * amount)
        elif unit.startswith("w"):
            delta = datetime.timedelta(weeks=amount)
        elif unit.startswith("y"):
            delta = datetime.timedelta(days=365 * amount)
        else:
            delta = datetime.timedelta(days=amount)
        # Day precision: re-parsing the same README the same day gives the same date.
        return (now - delta).replace(hour=0, minute=0, second=0, microsecond=0)
    return None


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
    closed: bool = False  # the list marks it closed (🔒 / strikethrough); url is often ""


class MarkdownParser:
    """Parses jobright-ai GitHub README markdown into structured job records."""

    def parse(self, content: str, is_mega_repo: bool = False,
              include_closed: bool = False) -> list[ParsedJob]:
        """Parse full README content. If is_mega_repo, tracks section headers.

        Closed rows are left out unless ``include_closed``; then they come back
        with ``closed=True`` (and usually no url) so the caller can retire the
        rows it stored while they were open.
        """
        if not is_mega_repo:
            return self.parse_markdown_table(content, include_closed=include_closed)

        lines = content.strip().split("\n")
        section_headers = self._detect_section_headers(lines)
        jobs: list[ParsedJob] = []

        if not section_headers:
            # No section headers found, parse as a single table
            return self.parse_markdown_table(content, include_closed=include_closed)

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
                section_content, section_category=category,
                include_closed=include_closed,
            )
            jobs.extend(section_jobs)

        return jobs

    def parse_markdown_table(
        self, content: str, section_category: Optional[str] = None,
        include_closed: bool = False,
    ) -> list[ParsedJob]:
        """Parse the pipe-delimited tables in ``content``.

        Every header row (a pipe row followed by a |---| separator) starts a
        table with its own column map, so a README that splits roles over
        several tables with different columns parses whole. HTML <table>s are
        converted to pipe tables first.
        """
        lines = self._html_tables_to_pipes(content).strip().split("\n")
        jobs: list[ParsedJob] = []

        column_map: Optional[dict[int, str]] = None
        width = 0
        prev_company = ""

        for i, line in enumerate(lines):
            stripped = line.strip()
            if "|" not in stripped or stripped.startswith("<!--"):
                continue
            if self._is_separator_row(stripped):
                continue

            next_line = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if self._is_separator_row(next_line):
                headers = self._split_row(stripped)
                mapped = self._map_columns_to_fields(headers)
                # Tables without a title column (link indexes, legends) aren't job tables.
                column_map = mapped if "title" in mapped.values() else None
                width = len(headers)
                prev_company = ""
                continue

            if column_map is None:
                continue

            cells = self._split_row(stripped)
            if len(cells) < width:
                continue

            # Handle continuation rows
            company_idx = self._get_field_index(column_map, "company")
            if company_idx is not None and company_idx < len(cells):
                company_cell = cells[company_idx]
                if "↳" in company_cell:
                    company_text = self._handle_continuation_row(cells, prev_company)
                    cells[company_idx] = company_text

            closed = self._is_closed_row(cells, column_map)
            job = self._extract_job_from_cells(cells, column_map, closed=closed)
            if job is None:
                logger.warning(
                    "Skipping row with missing title or URL: %s", stripped[:100],
                )
                continue

            # Track company for continuation rows, closed parents included:
            # a closed row's ↳ children still belong to that company.
            if job.company:
                prev_company = job.company
            if job.closed and not include_closed:
                continue
            job.section_category = section_category
            jobs.append(job)

        return jobs

    @staticmethod
    def _split_row(line: str) -> list[str]:
        return [c.strip() for c in line.split("|")[1:-1]]

    @staticmethod
    def _is_separator_row(line: str) -> bool:
        """'|---|:---:|' style rows under a table header."""
        return "---" in line and "|" in line and set(line) <= set("|-: \t")

    @staticmethod
    def _html_tables_to_pipes(content: str) -> str:
        """Rewrite HTML <table>s (SimplifyJobs) as pipe tables so one row
        parser serves both. The first row is the header. Cell HTML is kept
        (links, <br>) with newlines folded and pipes neutralised."""
        if "<table" not in content.lower():
            return content

        def convert(match: re.Match) -> str:
            rows: list[str] = []
            for row in _HTML_ROW_RE.findall(match.group(0)):
                cells = [" ".join(cell.replace("|", "/").split())
                         for _, cell in _HTML_CELL_RE.findall(row)]
                if not cells:
                    continue
                rows.append("| " + " | ".join(cells) + " |")
                if len(rows) == 1:
                    rows.append("|" + "---|" * len(cells))
            return "\n" + "\n".join(rows) + "\n"

        return _HTML_TABLE_RE.sub(convert, content)

    @staticmethod
    def _is_closed_row(cells: list[str], column_map: dict[int, str]) -> bool:
        """The lists mark closed roles with 🔒 (usually in place of the link)
        or strike the company/title through."""
        if any(CLOSED_MARK in cell for cell in cells):
            return True
        for idx, field in column_map.items():
            if field in ("company", "title") and idx < len(cells):
                text = cells[idx].strip("*_ ")
                if len(text) > 4 and text.startswith("~~") and text.endswith("~~"):
                    return True
        return False

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
        Also handles [<img>](url) and [![badge](img)](url) apply buttons (the
        outer url wins), and prefers the employer's link over a list vendor's
        when a cell carries both (Simplify: Apply + 'Simplify' buttons).
        """
        cell = _BADGE_LINK_RE.sub(r"[Apply](\1)", cell)
        links: list[tuple[str, str]] = []
        for match in _LINK_RE.finditer(cell):
            if match.group("md_url"):
                text, url = match.group("md_text"), match.group("md_url")
                # If text contains <img>, it's an apply button, still return the URL
                if "<img" in text:
                    text = "Apply"
            else:
                url = match.group("html_url").replace("&amp;", "&")
                text = clean_cell_text(match.group("html_text")) or "Apply"
            links.append((text, url.strip()))

        if not links:
            return None, None
        for text, url in links:
            if not is_list_vendor_url(url):
                return text, url
        return links[0]

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
            elif "date" not in lower and any(
                kw in lower for kw in ["link", "apply", "application", "url", "posting"]
            ):
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
        self, cells: list[str], column_map: dict[int, str], closed: bool = False
    ) -> Optional[ParsedJob]:
        """Extract a ParsedJob from table cells using the column map.

        A closed row needs only a title: the lists drop its link.
        """
        data: dict = {}

        for idx, field in column_map.items():
            if idx >= len(cells):
                continue
            cell = cells[idx]

            if field == "url":
                _, url = self._extract_markdown_link(cell)
                if not url and (cell.startswith("http://") or cell.startswith("https://")):
                    url = cell.strip()
                url = url if is_job_url(url or "") else ""
                # A title link may already have filled it; never blank it out.
                if url or not data.get(field):
                    data[field] = url
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
                    data[field] = clean_company_name(text)
                    # jobright tables put the company WEBSITE in this link, e.g.
                    # **[Repligen Corporation](http://www.repligen.com)**: this is
                    # the authoritative source for an accurate logo. A vendor
                    # page (simplify.jobs/c/...) is not the company's site.
                    if link and is_job_url(link) and not is_list_vendor_url(link):
                        data["company_url"] = link
                else:
                    # Remove image syntax to get plain company name
                    clean = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", cell)
                    data[field] = clean_company_name(clean)
            elif field == "title":
                # Title might be a link
                text, link = self._extract_markdown_link(cell)
                if text is not None:
                    # If URL field not yet set and title has a link, use it
                    if link and not data.get("url") and is_job_url(link):
                        data["url"] = link
                else:
                    text = cell
                data[field] = clean_cell_text(text.replace(CLOSED_MARK, ""))
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

        if not data.get("title") or not (data.get("url") or closed):
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
            closed=closed,
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
        return parse_listing_date(date_str)
