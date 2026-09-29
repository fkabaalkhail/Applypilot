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
# Legend: 🛂 does not sponsor, 🇺🇸 requires U.S. citizenship.
NO_SPONSORSHIP_MARKS = ("\U0001F6C2", "\U0001F1FA\U0001F1F8")

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
# A cell boundary: every pipe but an escaped one ('Intelcom \| Dragonfly' is
# one company cell in negarprh's list).
_CELL_DELIMITER_RE = re.compile(r"(?<!\\)\|")

_DATED_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%b %d, %Y", "%B %d, %Y")
_YEARLESS_FORMATS = ("%b %d", "%B %d", "%m/%d")
# Age columns: '2d', '3w', '1mo' (speedyapply, SimplifyJobs).
_RELATIVE_AGE_RE = re.compile(
    r"^(\d+)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)$",
    re.IGNORECASE,
)
# Clock skew between the list's timezone and UTC: a date written in UTC+14
# runs at most a day ahead of the commit that published it.
_FUTURE_TOLERANCE = datetime.timedelta(days=1)
# A newest-first table that runs past a year boundary: a year-less row dated
# more than _WRAP_JUMP AFTER the row above it belongs to the year before when
# a year earlier puts it at most _WRAP_SLACK after that row. Out-of-order rows
# are days or weeks apart; a wrap is most of a year. A new newest-first run
# (vansh lists its closed rows after the open ones) fails the second test.
_WRAP_JUMP = datetime.timedelta(days=183)
_WRAP_SLACK = datetime.timedelta(days=31)
# Strays: at most this many rows (a mistyped date, a row dated past the
# commit), fewer than the run they break into, that the table then jumps
# back up from by more than _WRAP_JUMP. Taken as the row above, a stray
# would move every row under it back a year.
_STRAY_MAX_ROWS = 3
# Share of consecutive dated rows that must run newest-first before a table
# is treated as sorted that way (alphabetical or oldest-first tables are
# left alone).
_NEWEST_FIRST_SHARE = 0.9
_NEWEST_FIRST_MIN_ROWS = 5


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


def is_yearless_date(date_str: str) -> bool:
    """True for a date cell with a day and month but no year ('Sep 26', '9/26')."""
    date_str = clean_cell_text(date_str)
    if not date_str:
        return False
    for fmt in _DATED_FORMATS:
        try:
            datetime.datetime.strptime(date_str, fmt)
            return False
        except ValueError:
            continue
    for fmt in _YEARLESS_FORMATS:
        try:
            datetime.datetime.strptime(f"{date_str} 2000", f"{fmt} %Y")
            return True
        except ValueError:
            continue
    return False


def unwrap_yearless_dates(rows: list[tuple["ParsedJob", bool]]) -> None:
    """Fix year-less dates in a newest-first table that runs past a year
    boundary, in place. ``rows`` is (job, date_was_yearless) in table order.

    Each year-less date is the latest such day not past the anchor (the
    commit time, plus a day of clock skew), so rows below the wrap whose day
    comes before the anchor's ('Aug 20' under 'Sep 26' 2025 in a list
    committed Aug 21 2026) land a year late. In a table whose dated rows run
    newest first, such a row (more than half a year after the row above it)
    moves back by whole years to the first date at or just below the row
    above, and only when that lands within half a year below it. A row that
    fits nowhere starts a new run and is left alone, and so are tables that
    don't run newest first (alphabetical, oldest first).

    Up to _STRAY_MAX_ROWS rows, fewer than the run they break into, that
    the table then jumps back up from by more than half a year ('Feb 10' on
    top of or among 'Sep 26' rows, 'Sep 30' in a list committed Sep 28) are
    strays: left as they are, and never the row above. Measured from a
    stray, every row under it would pass for a wrap and move back a year.
    """
    dated = [(job, yearless) for job, yearless in rows if job.posted_date is not None]
    if len(dated) < _NEWEST_FIRST_MIN_ROWS:
        return
    pairs = list(zip(dated, dated[1:]))
    # A wrap is itself one row later than the row above; beyond that, later
    # rows must be rare.
    later = sum(1 for (above, _), (below, _) in pairs
                if below.posted_date > above.posted_date)
    if later > max(1, (1 - _NEWEST_FIRST_SHARE) * len(pairs)):
        return

    # Runs of rows less than half a year apart, as listed: a wrap, a long
    # gap and a stray each start a new run.
    runs = [[dated[0]]]
    for (prev, _), (job, yearless) in zip(dated, dated[1:]):
        if abs(job.posted_date - prev.posted_date) > _WRAP_JUMP:
            runs.append([])
        runs[-1].append((job, yearless))

    above = None
    for i, run in enumerate(runs):
        next_run = runs[i + 1] if i + 1 < len(runs) else None
        # A stray is left as it is and is never the row above. The run it
        # breaks into is the one above it, or on top of the table the one below.
        broken_run = runs[i - 1] if i else next_run
        if (next_run is not None
                and next_run[0][0].posted_date > run[-1][0].posted_date
                and len(run) <= _STRAY_MAX_ROWS and len(run) < len(broken_run)):
            continue
        for job, yearless in run:
            if above is not None and yearless and job.posted_date - above > _WRAP_JUMP:
                for years_back in range(1, 8):
                    try:
                        candidate = job.posted_date.replace(year=job.posted_date.year - years_back)
                    except ValueError:  # Feb 29 outside a leap year
                        continue
                    if candidate <= above + _WRAP_SLACK:
                        if above - candidate <= _WRAP_JUMP:
                            job.posted_date = candidate
                        break
            above = job.posted_date


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
    no_sponsorship: bool = False  # legend 🛂 (no sponsorship) or 🇺🇸 (citizens only)


class MarkdownParser:
    """Parses jobright-ai GitHub README markdown into structured job records."""

    def parse(self, content: str, is_mega_repo: bool = False,
              include_closed: bool = False,
              now: Optional[datetime.datetime] = None) -> list[ParsedJob]:
        """Parse full README content. If is_mega_repo, tracks section headers.

        Closed rows are left out unless ``include_closed``; then they come back
        with ``closed=True`` (and usually no url) so the caller can retire the
        rows it stored while they were open.

        ``now`` anchors year-less dates and ages: the time of the commit that
        published the README (default: the wall clock).
        """
        if not is_mega_repo:
            return self.parse_markdown_table(content, include_closed=include_closed, now=now)

        lines = content.strip().split("\n")
        section_headers = self._detect_section_headers(lines)
        jobs: list[ParsedJob] = []

        if not any(category for _, category in section_headers):
            # No known section headers found, parse as a single table
            return self.parse_markdown_table(content, include_closed=include_closed, now=now)

        # Every '## ' header ends the section above it, known or not: an
        # unknown one ('## Data Science, AI & Machine Learning Internship
        # Roles') used to fold its rows into the section before it, so
        # SimplifyJobs' data, quant and hardware roles all read as Product
        # Management. Rows under an unknown header (or above the first one)
        # carry no section category and are classified by title.
        bounds = [(-1, None), *section_headers, (len(lines), None)]
        for (start, category), (end, _next) in zip(bounds, bounds[1:]):
            section_content = "\n".join(lines[start + 1 : end])
            section_jobs = self.parse_markdown_table(
                section_content, section_category=category,
                include_closed=include_closed, now=now,
            )
            jobs.extend(section_jobs)

        return jobs

    def parse_markdown_table(
        self, content: str, section_category: Optional[str] = None,
        include_closed: bool = False, now: Optional[datetime.datetime] = None,
    ) -> list[ParsedJob]:
        """Parse the pipe-delimited tables in ``content``.

        Every header row (a pipe row followed by a |---| separator) starts a
        table with its own column map, so a README that splits roles over
        several tables with different columns parses whole. HTML <table>s are
        converted to pipe tables first. Year-less dates in a newest-first
        table that runs past a year boundary are corrected per table.
        """
        lines = self._html_tables_to_pipes(content).strip().split("\n")
        jobs: list[ParsedJob] = []

        column_map: Optional[dict[int, str]] = None
        width = 0
        prev_company = ""
        date_idx: Optional[int] = None
        # Every extracted row of the current table, in table order, for the
        # year-wrap pass (closed rows too, run as their own sequence).
        table_rows: list[tuple[ParsedJob, bool]] = []

        for i, line in enumerate(lines):
            stripped = line.strip()
            if "|" not in stripped or stripped.startswith("<!--"):
                continue
            if self._is_separator_row(stripped):
                continue

            next_line = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if self._is_separator_row(next_line):
                self._unwrap_table_dates(table_rows)
                table_rows = []
                headers = self._split_row(stripped)
                mapped = self._map_columns_to_fields(headers)
                # Tables without a title column (link indexes, legends) aren't job tables.
                column_map = mapped if "title" in mapped.values() else None
                date_idx = (self._get_field_index(column_map, "posted_date")
                            if column_map else None)
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
            job = self._extract_job_from_cells(cells, column_map, closed=closed, now=now)
            if job is None:
                logger.warning(
                    "Skipping row with missing title or URL: %s", stripped[:100],
                )
                continue
            table_rows.append(
                (job, date_idx is not None and date_idx < len(cells)
                 and is_yearless_date(cells[date_idx]))
            )

            # Track company for continuation rows, closed parents included:
            # a closed row's ↳ children still belong to that company.
            if job.company:
                prev_company = job.company
            if job.closed and not include_closed:
                continue
            job.section_category = section_category
            jobs.append(job)

        self._unwrap_table_dates(table_rows)
        return jobs

    @staticmethod
    def _unwrap_table_dates(rows: list[tuple[ParsedJob, bool]]) -> None:
        """Year-wrap correction, open and closed rows as separate runs: a
        list may group its closed rows after the open ones, each run newest
        first."""
        for closed in (False, True):
            unwrap_yearless_dates([row for row in rows if row[0].closed is closed])

    @staticmethod
    def _split_row(line: str) -> list[str]:
        """The cells of a pipe row, an escaped '\\|' kept inside its cell as
        '|'. Splitting on it shifted every later cell, and the row was
        dropped for a missing title or URL."""
        return [c.strip().replace("\\|", "|") for c in _CELL_DELIMITER_RE.split(line)[1:-1]]

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

    def _detect_section_headers(self, lines: list[str]) -> list[tuple[int, Optional[str]]]:
        """Find every ## header and map it to a role category.

        Returns list of (line_index, category_name or None) tuples.
        """
        headers: list[tuple[int, Optional[str]]] = []

        for i, line in enumerate(lines):
            stripped = line.strip()
            # Match ## Header (level 2 headers)
            if stripped.startswith("## "):
                header_text = stripped[3:].strip()
                # Remove any trailing markdown (like links or anchors)
                header_text = re.sub(r"\s*<.*?>", "", header_text)
                header_text = re.sub(r"\s*\[.*?\].*", "", header_text)
                header_text = header_text.strip()

                headers.append((i, self._match_section_category(header_text)))

        return headers

    def _match_section_category(self, header_text: str) -> Optional[str]:
        """Match a section header text to a known role category."""
        lower = header_text.lower().strip()

        # Direct match
        if lower in SECTION_CATEGORY_MAP:
            return SECTION_CATEGORY_MAP[lower]

        # A known category named inside a longer header ('💻 Software
        # Engineering Internship Roles'). Never the reverse: a short header is
        # not a category because a category name contains it ('AI' is in
        # 'education and training').
        for key, value in SECTION_CATEGORY_MAP.items():
            if key in lower:
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
        self, cells: list[str], column_map: dict[int, str], closed: bool = False,
        now: Optional[datetime.datetime] = None,
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
                data[field] = self._parse_date(cell, now=now)
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
                title = clean_cell_text(text.replace(CLOSED_MARK, ""))
                # Legend marks trail the title ('Software Engineer 🛂 🇺🇸',
                # 'Intern 🎓'): they say something about the posting, not
                # its name, and rendered in the card title.
                if any(mark in title for mark in NO_SPONSORSHIP_MARKS):
                    data["no_sponsorship"] = True
                data[field] = clean_company_name(title)
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
            no_sponsorship=bool(data.get("no_sponsorship")),
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

    def _parse_date(self, date_str: str,
                    now: Optional[datetime.datetime] = None) -> Optional[datetime.datetime]:
        """Parse various date formats from GitHub job tables."""
        return parse_listing_date(date_str, now=now)
